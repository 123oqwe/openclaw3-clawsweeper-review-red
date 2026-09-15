import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import test from "node:test";
import YAML from "yaml";
import { ExactReviewQueue, MemoryDurableStorage, unclaimedExactReviewQueueItem } from "./dashboard-worker-harness.ts";

// Planner-owned; apply under test/. Execute only on authorized Hosted infrastructure.
// This is an executable consumer-admission test, not a model-start integration proof.
const targetRepo = "123oqwe/openclaw3-clawsweeper-sandbox";
const itemKey = `${targetRepo}#41`;
const runId = "41001";
type Step = { name?: string; run?: string; if?: string; uses?: string; env?: Record<string, string> };
function claimScript(path: string) {
  const workflow = YAML.parse(readFileSync(path, "utf8"));
  const steps = workflow.jobs["event-review-apply"].steps as Step[];
  const claim = steps.find((step) => step.name === "Claim exact-review queue lease");
  assert.ok(claim?.run, `actual claim run missing in ${path}`);
  return claim;
}
const upstreamRun = claimScript("fixtures/upstream-16505cf/.github/workflows/sweep.yml");
const candidateRun = claimScript("candidate/receiver/.github/workflows/sweep.yml");

function fixture() {
  const decision = {
    targetRepo,
    targetBranch: "main",
    itemNumber: 41,
    itemKind: "pull_request",
    sourceEvent: "pull_request",
    sourceAction: "manual_explicit_review",
    publicationPolicy: "record_comment_only",
    supersedesInProgress: false,
    sourceHeadSha: "a".repeat(40),
  };
  return {
    ...unclaimedExactReviewQueueItem(41),
    key: itemKey,
    decision,
    leaseDecision: { ...decision },
  };
}
type Fixture = ReturnType<typeof fixture>;
type Receipt = { lease_id: string; item_key: string; lease_revision: number; run_id: string; run_attempt: number };
type Scenario = {
  name: string;
  allowed: boolean;
  queueStatus: number;
  exitCode?: number;
  error?: string;
  mutate?: (item: Fixture, receipt: Receipt) => void;
  corruptResponse?: (body: Record<string, unknown>) => Record<string, unknown>;
};

async function execute(step: Step, scenario: Scenario) {
  const root = mkdtempSync(join(tmpdir(), "oc3-claim-entrypoint-"));
  const output = join(root, "outputs");
  writeFileSync(output, "");
  cpSync("scripts/control-plane-curl.sh", join(root, "control-plane-curl.sh"));
  const item = fixture();
  const receipt: Receipt = { lease_id: item.leaseId, item_key: itemKey, lease_revision: 1, run_id: runId, run_attempt: 1 };
  scenario.mutate?.(item, receipt);
  const storage = new MemoryDurableStorage();
  await storage.put("exact-review-queue", { deliveries: {}, items: { [item.key]: item } });
  const queue = new ExactReviewQueue({ storage }, {
    hostedTargetPredicate: () => true,
    hostedPublicTargetProbe: async () => "public",
    EXACT_REVIEW_MANUAL_PUBLICATION_ENABLED: "1",
  });
  const trace: Array<{ request: unknown; status: number; response: Record<string, unknown> }> = [];
  let serverError: unknown;
  const server = createServer(async (req, res) => {
    try {
      assert.equal(req.method, "POST");
      assert.equal(req.url, "/internal/exact-review/claim");
      let body = "";
      for await (const chunk of req) body += chunk;
      const response = await queue.fetch(new Request("https://clawsweeper-exact-review-queue/claim", { method: "POST", body }));
      const payload = await response.json() as Record<string, unknown>;
      trace.push({ request: JSON.parse(body), status: response.status, response: payload });
      res.writeHead(response.status, { "content-type": "application/json" });
      res.end(JSON.stringify(scenario.corruptResponse?.(payload) ?? payload));
    } catch (error) {
      serverError = error;
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "fixture_transport_error" }));
    }
  });
  await new Promise<void>((accept) => server.listen(0, "127.0.0.1", accept));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    // The receipt advertises safe manual metadata. Queue-owned decision remains
    // authoritative, including wrong-source and wrong-policy negative controls.
    const dispatch = { target_repo: targetRepo, item_number: 41, source_action: "manual_explicit_review", publication_policy: "record_comment_only", queue_lease_id: receipt.lease_id, queue_claim: { item_key: receipt.item_key, lease_revision: receipt.lease_revision, source_head_sha: "a".repeat(40) } };
    const values: Record<string, string> = {
      "toJSON(github.event.client_payload)": JSON.stringify(dispatch),
      "github.event.client_payload.queue_claim.item_key || github.event.client_payload.item_key": receipt.item_key,
      "github.event.client_payload.queue_claim.item_key": receipt.item_key,
      "github.event.client_payload.queue_lease_id": receipt.lease_id,
      "github.event.client_payload.queue_claim.lease_revision || github.event.client_payload.lease_revision": String(receipt.lease_revision),
      "github.event.client_payload.queue_claim.lease_revision": String(receipt.lease_revision),
      "vars.CLAWSWEEPER_EXACT_REVIEW_QUEUE_URL || 'https://clawsweeper.openclaw.ai'": `http://127.0.0.1:${address.port}`,
      "vars.CLAWSWEEPER_EXACT_REVIEW_QUEUE_URL": `http://127.0.0.1:${address.port}`,
      "vars.EXACT_REVIEW_QUEUE_URL": `http://127.0.0.1:${address.port}`,
      "secrets.EXACT_REVIEW_QUEUE_SHARED_SECRET": "synthetic-claim-secret",
      "github.run_attempt": String(receipt.run_attempt),
    };
    const render = (value: string) => String(value).replace(/\$\{\{\s*([\s\S]*?)\s*\}\}/g, (_match, expression: string) => {
      assert.ok(Object.hasOwn(values, expression.trim()), `unfrozen workflow expression: ${expression}`);
      return values[expression.trim()];
    });
    const declaredEnv = Object.fromEntries(Object.entries(step.env || {}).map(([key, value]) => [key, render(value)]));
    const child = spawn("/bin/bash", ["--noprofile", "--norc", "-e", "-o", "pipefail", "-c", render(step.run!)], {
      cwd: root,
      env: {
        PATH: [dirname(process.execPath), "/usr/bin", "/bin"].join(delimiter),
        HOME: root,
        RUNNER_TEMP: root,
        GITHUB_OUTPUT: output,
        GITHUB_RUN_ID: receipt.run_id,
        ...declaredEnv,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
    const code = await new Promise<number | null>((accept, reject) => {
      child.once("error", reject);
      child.once("close", accept);
    }).finally(() => clearTimeout(timer));
    assert.equal(serverError, undefined);
    assert.equal(trace.length, 1, `claim must reach the real queue once: ${stderr}\n${stdout}`);
    assert.deepEqual(trace[0].request, receipt);
    assert.equal(trace[0].status, scenario.queueStatus);
    if (scenario.error) assert.equal(trace[0].response.error, scenario.error);
    const outputs = Object.fromEntries(readFileSync(output, "utf8").split("\n").filter(Boolean).map((line) => {
      const at = line.indexOf("=");
      return [line.slice(0, at), line.slice(at + 1)];
    }));
    assert.equal(outputs.claimed, scenario.allowed ? "true" : "false", `${scenario.name}: ${stderr}\n${stdout}`);
    assert.notEqual(code, null, "a killed or timed-out child is not a valid rejection");
    if (scenario.exitCode !== undefined) assert.equal(code, scenario.exitCode, "unexpected conflict must remain a visible error");
    else if (scenario.queueStatus === 409) assert.equal(code, 0, "known lost-claim conflicts must terminate safely");
    if (scenario.allowed) {
      assert.equal(code, 0, stderr);
      assert.equal(outputs.protocol_version, "2");
      assert.equal(outputs.item_key, itemKey);
      assert.equal(outputs.lease_revision, "1");
      assert.equal(outputs.claim_generation, "1");
      assert.equal(outputs.repeat_revision, "false");
      assert.deepEqual(JSON.parse(outputs.decision), item.leaseDecision);
      const persisted = await storage.get("exact-review-queue") as { items: Record<string, { claimedRunId: string }> };
      assert.equal(persisted.items[itemKey].claimedRunId, runId);
    }
  } finally {
    try {
      await new Promise<void>((accept, reject) => server.close((error) => error ? reject(error) : accept()));
    } finally {
      storage.sql.close();
      rmSync(root, { recursive: true, force: true });
    }
  }
}

const valid: Scenario = { name: "valid authoritative protocol-2 tuple", allowed: true, queueStatus: 200 };
test("claim harness positive control executes the immutable upstream script against the real queue", async () => {
  await execute(upstreamRun, valid);
});

const scenarios: Scenario[] = [
  valid,
  { name: "forged lease id", allowed: false, queueStatus: 409, error: "lease_not_active", mutate: (_item, receipt) => { receipt.lease_id = "forged-lease"; } },
  { name: "wrong target receipt", allowed: false, queueStatus: 409, error: "lease_not_active", mutate: (_item, receipt) => { receipt.item_key = `${targetRepo}#42`; } },
  { name: "replaced lease revision", allowed: false, queueStatus: 409, error: "lease_not_active", mutate: (item) => { item.leaseRevision = 2; item.revision = 2; } },
  { name: "expired lease", allowed: false, queueStatus: 409, error: "lease_not_active", mutate: (item) => { item.leaseExpiresAt = Date.now() - 86_400_000; } },
  { name: "another run already owns claim", allowed: false, queueStatus: 409, error: "lease_already_claimed", mutate: (item) => { Object.assign(item, { state: "leased", claimedRunId: "777", claimedRunAttempt: 1, claimGeneration: 1, claimProtocolVersion: 2 }); } },
  { name: "stale run attempt", allowed: false, queueStatus: 409, error: "stale_run_attempt", mutate: (item) => { Object.assign(item, { state: "leased", claimedRunId: runId, claimedRunAttempt: 2, claimGeneration: 1, claimProtocolVersion: 2 }); } },
  { name: "mismatched successful response tuple", allowed: false, queueStatus: 200, corruptResponse: (body) => ({ ...body, lease_revision: 99 }) },
  { name: "authoritative decision repo conflicts with canonical item key", allowed: false, queueStatus: 200, corruptResponse: (body) => ({ ...body, decision: { ...(body.decision as Record<string, unknown>), targetRepo: "example/foreign" } }) },
  { name: "authoritative decision item conflicts with canonical item key", allowed: false, queueStatus: 200, corruptResponse: (body) => ({ ...body, decision: { ...(body.decision as Record<string, unknown>), itemNumber: 42 } }) },
  { name: "authoritative decision has unsupported item kind", allowed: false, queueStatus: 200, corruptResponse: (body) => ({ ...body, decision: { ...(body.decision as Record<string, unknown>), itemKind: "unknown" } }) },
  { name: "unknown conflict reason is not silently acknowledged", allowed: false, queueStatus: 409, error: "lease_not_active", exitCode: 1, mutate: (_item, receipt) => { receipt.lease_id = "forged-lease"; }, corruptResponse: (body) => ({ ...body, error: "unknown_protocol_conflict" }) },
  { name: "authoritative wrong publication policy despite safe dispatch metadata", allowed: false, queueStatus: 200, mutate: (item) => { item.decision.publicationPolicy = "ordinary"; item.leaseDecision.publicationPolicy = "ordinary"; } },
  { name: "authoritative wrong source despite safe dispatch metadata", allowed: false, queueStatus: 200, mutate: (item) => { item.decision.sourceAction = "opened"; item.leaseDecision.sourceAction = "opened"; } },
];
for (const scenario of scenarios) {
  test(`candidate claim consumer: ${scenario.name}`, async () => {
    await execute(candidateRun, scenario);
  });
}
