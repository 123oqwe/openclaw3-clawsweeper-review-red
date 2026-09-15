import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import test from "node:test";
import YAML from "yaml";
import { ExactReviewQueue, MemoryDurableStorage, leasedExactReviewPublicationItem } from "./dashboard-worker-harness.ts";

// Planner-owned. Publisher claim consumer only: no artifact download or publication.
const targetRepo = "123oqwe/openclaw3-clawsweeper-sandbox";
const baseItemKey = `${targetRepo}#41`;
const producerRunId = "31001";
const publisherRunId = "41001";
const publicationKey = `${baseItemKey}@publish:${producerRunId}:1`;
type Step = { name?: string; run?: string; env?: Record<string, string> };
function claimStep(path: string) {
  const workflow = YAML.parse(readFileSync(path, "utf8"));
  const job = workflow.jobs?.["event-review-publish"];
  assert.ok(job, `publisher entrypoint missing in ${path}; this is not provenance-behavior RED`);
  const steps = job.steps as Step[];
  assert.ok(Array.isArray(steps), `publisher steps missing in ${path}`);
  const claim = steps.find((step) => step.name === "Claim durable exact review publication");
  assert.ok(claim?.run, `actual publisher claim run missing in ${path}`);
  // Honor inherited values consumed by this extracted claim body without
  // importing unrelated upstream model/secret environment into the harness.
  // This remains a frozen shell/Node claim surface, not a general Actions runner.
  const referenced = new Set(Array.from(claim.run.matchAll(/\$(?:\{)?([A-Z][A-Z0-9_]*)|process\.env\.([A-Z][A-Z0-9_]*)/g), (match) => match[1] || match[2]));
  const scoped = { ...workflow.env, ...job.env, ...claim.env };
  const env = Object.fromEntries(Object.entries(scoped).filter(([name]) => referenced.has(name) || Object.hasOwn(claim.env || {}, name))) as Record<string, string>;
  return { ...claim, env };
}
const upstream = claimStep("fixtures/upstream-16505cf/.github/workflows/sweep.yml");

function fixture() {
  const item = leasedExactReviewPublicationItem(41, producerRunId);
  const producerDecision = {
    ...item.decision.publication.producerDecision,
    targetRepo,
    itemKind: "pull_request",
    sourceEvent: "pull_request",
    sourceAction: "manual_explicit_review",
    publicationPolicy: "record_comment_only",
    sourceHeadSha: "b".repeat(40),
  };
  const publication = { ...item.decision.publication, itemKey: baseItemKey, producerDecision };
  const decision = { ...producerDecision, sourceAction: "exact_review_artifact_publish", publication };
  return {
    ...item,
    key: publicationKey,
    state: "dispatching",
    decision,
    leaseDecision: { ...decision },
    claimedRunId: undefined,
    claimedRunAttempt: undefined,
    claimGeneration: undefined,
    claimProtocolVersion: undefined,
  };
}
type Receipt = { lease_id: string; item_key: string; lease_revision: number; run_id: string; run_attempt: number };
type ClaimResponse = {
  claimed: boolean;
  protocol_version: number;
  item_key: string;
  lease_revision: number;
  claim_generation: number;
  repeat_revision: boolean;
  decision: ReturnType<typeof fixture>["decision"];
};
type Scenario = {
  name: string;
  allowed: boolean;
  queueStatus: 200 | 409;
  changeReceipt?: (receipt: Receipt) => void;
  corruptResponse?: (response: ClaimResponse) => void;
};

async function execute(step: Step, scenario: Scenario) {
  const root = mkdtempSync(join(tmpdir(), "oc3-publisher-claim-"));
  const output = join(root, "outputs");
  writeFileSync(output, "");
  cpSync("scripts/control-plane-curl.sh", join(root, "control-plane-curl.sh"));
  const item = fixture();
  const receipt: Receipt = { lease_id: item.leaseId, item_key: publicationKey, lease_revision: 1, run_id: publisherRunId, run_attempt: 1 };
  scenario.changeReceipt?.(receipt);
  const storage = new MemoryDurableStorage();
  await storage.put("exact-review-queue", { deliveries: {}, items: { [item.key]: item } });
  const queue = new ExactReviewQueue({ storage }, {
    hostedTargetPredicate: () => true,
    hostedPublicTargetProbe: async () => "public",
    EXACT_REVIEW_MANUAL_PUBLICATION_ENABLED: "1",
  });
  const trace: Array<{ request: unknown; status: number; response: unknown }> = [];
  let serverError: unknown;
  const server = createServer(async (req, res) => {
    try {
      assert.equal(req.method, "POST");
      assert.equal(req.url, "/internal/exact-review/claim");
      let body = "";
      for await (const chunk of req) body += chunk;
      const response = await queue.fetch(new Request("https://clawsweeper-exact-review-queue/claim", { method: "POST", body }));
      const payload = await response.json();
      trace.push({ request: JSON.parse(body), status: response.status, response: structuredClone(payload) });
      // Corruption cases isolate the real publisher consumer parser. All source
      // responses still originate in the real queue; 409s are never synthesized.
      if (scenario.corruptResponse) scenario.corruptResponse(payload as ClaimResponse);
      res.writeHead(response.status, { "content-type": "application/json" });
      res.end(JSON.stringify(payload));
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
    const queueUrl = `http://127.0.0.1:${address.port}`;
    const values: Record<string, string> = {
      "github.event.client_payload.queue_claim.item_key": receipt.item_key,
      "github.event.client_payload.queue_lease_id": receipt.lease_id,
      "github.event.client_payload.queue_claim.lease_revision": String(receipt.lease_revision),
      "vars.CLAWSWEEPER_EXACT_REVIEW_QUEUE_URL || 'https://clawsweeper.openclaw.ai'": queueUrl,
      "vars.CLAWSWEEPER_EXACT_REVIEW_QUEUE_URL": queueUrl,
      "vars.EXACT_REVIEW_QUEUE_URL": queueUrl,
      "github.run_attempt": String(receipt.run_attempt),
    };
    const render = (value: string) => String(value).replace(/\$\{\{\s*([\s\S]*?)\s*\}\}/g, (_match, expression: string) => {
      assert.ok(Object.hasOwn(values, expression.trim()), `unfrozen workflow expression: ${expression}`);
      return values[expression.trim()];
    });
    const declaredEnv = Object.fromEntries(Object.entries(step.env || {}).map(([key, value]) => [key, render(value)]));
    const child = spawn("/bin/bash", ["--noprofile", "--norc", "-e", "-o", "pipefail", "-c", render(step.run!)], {
      cwd: root,
      env: { PATH: [dirname(process.execPath), "/usr/bin", "/bin"].join(delimiter), HOME: root, RUNNER_TEMP: root, GITHUB_OUTPUT: output, GITHUB_RUN_ID: publisherRunId, ...declaredEnv },
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
    assert.notEqual(code, null, "a killed child is not a valid rejection");
    assert.equal(trace.length, 1, `publisher must POST the real queue once: ${stderr}\n${stdout}`);
    assert.deepEqual(trace[0].request, receipt);
    assert.equal(trace[0].status, scenario.queueStatus);
    if (scenario.queueStatus === 409) assert.deepEqual(trace[0].response, { error: "lease_not_active" });
    const outputs = Object.fromEntries(readFileSync(output, "utf8").split("\n").filter(Boolean).map((line) => {
      const at = line.indexOf("=");
      return [line.slice(0, at), line.slice(at + 1)];
    }));
    assert.equal(outputs.claimed, String(scenario.allowed), `${scenario.name}: ${stderr}\n${stdout}`);
    assert.equal(code, scenario.allowed || scenario.queueStatus === 409 ? 0 : 1, stderr);
    if (scenario.allowed) {
      const publication = item.leaseDecision.publication;
      assert.deepEqual(JSON.parse(outputs.decision), publication.producerDecision);
      const expected = {
        artifact_name: publication.artifactName, producer_run_id: producerRunId, generation_attempt: "1",
        source_sha: publication.sourceSha, item_key: baseItemKey, protocol_version: "2", lease_revision: "1", claim_generation: "1",
        target_repo: targetRepo, target_branch: "main", item_number: "41", item_kind: "pull_request",
        publisher_lease_id: receipt.lease_id, publisher_item_key: publicationKey, publisher_lease_revision: "1", publisher_claim_generation: "1",
        repeat_revision: "false", direct_lifecycle_recovery: "false", live_proceeded: "true",
      };
      for (const [key, value] of Object.entries(expected)) assert.equal(outputs[key], value, key);
      const state = await storage.get("exact-review-queue") as { items: Record<string, { claimedRunId: string }> };
      assert.equal(state.items[publicationKey].claimedRunId, publisherRunId);
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

const valid: Scenario = { name: "valid deferred publication preserves producer and artifact provenance", allowed: true, queueStatus: 200 };
test("publisher claim positive control: immutable upstream script claims a real publication lease", async () => { await execute(upstream, valid); });
const scenarios: Scenario[] = [
  valid,
  { name: "forged lease", allowed: false, queueStatus: 409, changeReceipt: (receipt) => { receipt.lease_id = "forged"; } },
  { name: "wrong requested item tuple", allowed: false, queueStatus: 409, changeReceipt: (receipt) => { receipt.item_key = `${targetRepo}#42@publish:${producerRunId}:1`; } },
  { name: "missing producer decision", allowed: false, queueStatus: 200, corruptResponse: (response) => { Reflect.deleteProperty(response.decision.publication, "producerDecision"); } },
  { name: "forged producer target", allowed: false, queueStatus: 200, corruptResponse: (response) => { response.decision.publication.producerDecision.targetRepo = "example/foreign"; } },
  { name: "artifact producer run does not match durable publication key", allowed: false, queueStatus: 200, corruptResponse: (response) => { response.decision.publication.producerRunId = "999"; } },
];
for (const scenario of scenarios) test(`candidate publisher claim: ${scenario.name}`, async () => {
  const candidate = claimStep("candidate/receiver/.github/workflows/sweep.yml");
  await execute(candidate, scenario);
});
