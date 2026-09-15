import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import test from "node:test";
import YAML from "yaml";
import { ExactReviewQueue, MemoryDurableStorage, unclaimedExactReviewQueueItem } from "./dashboard-worker-harness.ts";

// Planner-owned R05-B: real claim scripts + real Queue + actual preparation bridge run.
// The reservation receipt is a trusted synthetic input, not evidence that the
// reserve CLI posted a comment. No model, token acquisition or job scheduling is proved.
const upstreamPath = "fixtures/upstream-16505cf/.github/workflows/sweep.yml";
const candidatePath = "candidate/receiver/.github/workflows/sweep.yml";
const targetRepo = "123oqwe/openclaw3-clawsweeper-sandbox";
const itemKey = `${targetRepo}#41`;
const runId = "41001";
const preparedFields = ["claimed", "protocol_version", "item_key", "lease_id", "lease_revision", "claim_generation", "decision", "reservation_status", "reservation_owner", "reservation_comment_id"];
type Outputs = Record<string, string>;
type Step = { id?: string; name?: string; run?: string; env?: Outputs };
type Job = { steps?: Step[]; outputs?: Outputs };
type Trace = { request: Record<string, unknown>; status: number; response: Record<string, unknown> };
const parseOutputs = (text: string): Outputs => Object.fromEntries(text.split("\n").filter(Boolean).map((line) => {
  const at = line.indexOf("=");
  assert.ok(at > 0, "expected single-line Actions output");
  return [line.slice(0, at), line.slice(at + 1)];
}));
function render(value: string, values: Outputs): string {
  return String(value).replace(/\$\{\{\s*([\s\S]*?)\s*\}\}/g, (_match, expression: string) => {
    assert.ok(Object.hasOwn(values, expression.trim()), `unfrozen handoff expression: ${expression}`);
    return values[expression.trim()];
  });
}
function claimStep(job: Job | undefined, label: string): Step {
  const step = job?.steps?.find((entry) => entry.id === "claim-exact-review-queue" || entry.name === "Claim exact-review queue lease");
  assert.ok(step?.run, `missing actual claim run: ${label}`);
  return step;
}
function fixture() {
  const decision = { targetRepo, targetBranch: "main", itemNumber: 41, itemKind: "pull_request", sourceEvent: "pull_request", sourceAction: "manual_explicit_review", publicationPolicy: "record_comment_only", supersedesInProgress: false, sourceHeadSha: "a".repeat(40) };
  return { ...unclaimedExactReviewQueueItem(41), key: itemKey, decision, leaseDecision: { ...decision } };
}

async function withQueue(use: (session: Awaited<ReturnType<typeof sessionFor>>) => Promise<void>, expired = false) {
  const session = await sessionFor(expired);
  try { await use(session); } finally { await session.close(); }
}
async function sessionFor(expired: boolean) {
  const root = mkdtempSync(join(tmpdir(), "oc3-preparation-handoff-"));
  cpSync("scripts/control-plane-curl.sh", join(root, "control-plane-curl.sh"));
  const owned = fixture();
  if (expired) owned.leaseExpiresAt = Date.now() - 86_400_000;
  const storage = new MemoryDurableStorage();
  await storage.put("exact-review-queue", { deliveries: {}, items: { [itemKey]: owned } });
  const queue = new ExactReviewQueue({ storage }, { hostedTargetPredicate: () => true, hostedPublicTargetProbe: async () => "public", EXACT_REVIEW_MANUAL_PUBLICATION_ENABLED: "1" });
  const trace: Trace[] = [];
  let serverError: unknown, sequence = 0;
  const server = createServer(async (req, res) => {
    try {
      assert.equal(req.method, "POST");
      assert.equal(req.url, "/internal/exact-review/claim");
      let bytes = "";
      for await (const chunk of req) bytes += chunk;
      const response = await queue.fetch(new Request("https://queue/claim", { method: "POST", body: bytes }));
      const body = await response.json() as Record<string, unknown>;
      trace.push({ request: JSON.parse(bytes), status: response.status, response: body });
      res.writeHead(response.status, { "content-type": "application/json" }); res.end(JSON.stringify(body));
    } catch (error) { serverError = error; res.writeHead(400); res.end("fixture transport failure"); }
  });
  await new Promise<void>((accept) => server.listen(0, "127.0.0.1", accept));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const queueUrl = `http://127.0.0.1:${address.port}`;
  async function run(step: Step, values: Outputs, attempt = 1) {
    assert.ok(step.run);
    const output = join(root, `outputs-${++sequence}`);
    writeFileSync(output, "");
    const declaredEnv = Object.fromEntries(Object.entries(step.env || {}).map(([key, value]) => [key, render(value, values)]));
    const child = spawn("/bin/bash", ["--noprofile", "--norc", "-e", "-o", "pipefail", "-c", render(step.run, values)], {
      cwd: root, detached: true,
      env: { PATH: [dirname(process.execPath), "/usr/bin", "/bin"].join(delimiter), HOME: root, RUNNER_TEMP: root, GITHUB_OUTPUT: output, GITHUB_RUN_ID: runId, GITHUB_RUN_ATTEMPT: String(attempt), ...declaredEnv },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "", stderr = "", timedOut = false;
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const kill = () => { if (child.pid) { try { process.kill(-child.pid, "SIGKILL"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; } } };
    const timer = setTimeout(() => { timedOut = true; kill(); }, 10_000);
    const code = await new Promise<number | null>((accept, reject) => { child.once("error", reject); child.once("close", accept); }).finally(() => { clearTimeout(timer); kill(); });
    assert.equal(timedOut, false, "a deadline is a harness failure, not receipt rejection");
    assert.notEqual(code, null);
    assert.equal(serverError, undefined);
    const raw = readFileSync(output, "utf8");
    return { code, outputs: parseOutputs(raw), raw, stdout, stderr };
  }
  async function claim(step: Step, attempt = 1, leaseId = owned.leaseId) {
    const request = { lease_id: leaseId, item_key: itemKey, lease_revision: 1, run_id: runId, run_attempt: attempt };
    const dispatch = { target_repo: targetRepo, item_number: 41, source_action: "manual_explicit_review", publication_policy: "record_comment_only", queue_lease_id: leaseId, queue_claim: { item_key: itemKey, lease_revision: 1, source_head_sha: owned.decision.sourceHeadSha } };
    const before = trace.length;
    const result = await run(step, {
      "toJSON(github.event.client_payload)": JSON.stringify(dispatch),
      "github.event.client_payload.queue_claim.item_key || github.event.client_payload.item_key": itemKey,
      "github.event.client_payload.queue_claim.item_key": itemKey,
      "github.event.client_payload.queue_lease_id": leaseId,
      "github.event.client_payload.queue_claim.lease_revision || github.event.client_payload.lease_revision": "1",
      "github.event.client_payload.queue_claim.lease_revision": "1",
      "vars.CLAWSWEEPER_EXACT_REVIEW_QUEUE_URL || 'https://clawsweeper.openclaw.ai'": queueUrl,
      "vars.CLAWSWEEPER_EXACT_REVIEW_QUEUE_URL": queueUrl,
      "github.run_attempt": String(attempt),
    }, attempt);
    assert.equal(trace.length, before + 1, `actual claim must reach real Queue once: ${result.stderr}`);
    assert.deepEqual(trace[before].request, request);
    return { ...result, transport: trace[before] };
  }
  return { owned, queue, trace, run, claim, close: async () => {
    server.closeAllConnections();
    await new Promise<void>((accept) => server.close(() => accept()));
    storage.sql.close(); rmSync(root, { recursive: true, force: true });
  } };
}
function claimed(result: Awaited<ReturnType<Awaited<ReturnType<typeof sessionFor>>["claim"]>>, generation: number) {
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.transport.status, 200);
  assert.equal(result.outputs.claimed, "true");
  assert.equal(result.outputs.protocol_version, "2");
  assert.equal(result.outputs.item_key, itemKey);
  assert.equal(result.outputs.lease_revision, "1");
  assert.equal(result.outputs.claim_generation, String(generation));
  assert.deepEqual(JSON.parse(result.outputs.decision), fixture().decision);
}
const upstreamClaim = () => claimStep(YAML.parse(readFileSync(upstreamPath, "utf8")).jobs["event-review-apply"], "fixed upstream");

test("R05-B fixed upstream controls: repeated same-run/attempt/protocol claim preserves authority", async () => {
  await withQueue(async (s) => {
    const prepare = await s.claim(upstreamClaim());
    const model = await s.claim(upstreamClaim());
    claimed(prepare, 1); claimed(model, 1);
    assert.deepEqual(model.outputs, prepare.outputs);
    assert.deepEqual(s.trace[1].response, s.trace[0].response);
  });
});
test("R05-B real Queue accepts a newer attempt and rejects the stale attempt", async () => {
  await withQueue(async (s) => {
    claimed(await s.claim(upstreamClaim()), 1);
    claimed(await s.claim(upstreamClaim(), 2), 2);
    const stale = await s.claim(upstreamClaim(), 1);
    assert.equal(stale.code, 0); assert.equal(stale.outputs.claimed, "false");
    assert.equal(stale.transport.status, 409); assert.equal(stale.transport.response.error, "stale_run_attempt");
  });
});
for (const invalid of ["forged lease", "expired lease"] as const) {
  test(`R05-B real Queue rejects ${invalid} before handoff`, async () => {
    await withQueue(async (s) => {
      const result = await s.claim(upstreamClaim(), 1, invalid === "forged lease" ? "forged-lease" : s.owned.leaseId);
      assert.equal(result.code, 0); assert.equal(result.outputs.claimed, "false");
      assert.equal(result.transport.status, 409); assert.equal(result.transport.response.error, "lease_not_active");
    }, invalid === "expired lease");
  });
}

test("R05-B candidate preparation/model bridge consumes a real repeated claim", async (t) => {
  // Deliberately inside this parent test: absent prepare/bridge topology is one
  // explicit topology RED; the independent Queue controls still execute.
  const jobs = YAML.parse(readFileSync(candidatePath, "utf8")).jobs as Record<string, Job>;
  const prepare = jobs["event-review-prepare"], model = jobs["event-review-apply"];
  assert.ok(prepare, "missing topology: event-review-prepare has not been implemented");
  const prepareClaim = claimStep(prepare, "candidate prepare"), modelClaim = claimStep(model, "candidate model");
  const bridge = model?.steps?.find((step) => step.id === "reserve-exact-review-lease");
  assert.equal(bridge?.name, "Restore trusted preparation receipt", "missing topology: model still reserves instead of restoring preparation");
  assert.ok(bridge?.run, "missing actual preparation bridge run");
  const cases: Array<{ name: string; allowed?: boolean; safeNoop?: boolean; modelAttempt?: number; lostClaim?: boolean; mutate?: (receipt: Outputs) => void }> = [
    { name: "valid posted receipt", allowed: true },
    { name: "equivalent decision with reordered keys", allowed: true, mutate: (r) => { r.decision = JSON.stringify(Object.fromEntries(Object.entries(JSON.parse(r.decision)).reverse())); } },
    { name: "wrong item", mutate: (r) => { r.item_key = `${targetRepo}#42`; } },
    { name: "wrong item decision", mutate: (r) => { r.decision = JSON.stringify({ ...JSON.parse(r.decision), itemNumber: 42 }); } },
    { name: "wrong repository decision", mutate: (r) => { r.decision = JSON.stringify({ ...JSON.parse(r.decision), targetRepo: "example/foreign" }); } },
    { name: "changed source head", mutate: (r) => { r.decision = JSON.stringify({ ...JSON.parse(r.decision), sourceHeadSha: "b".repeat(40) }); } },
    { name: "changed publication policy", mutate: (r) => { r.decision = JSON.stringify({ ...JSON.parse(r.decision), publicationPolicy: "ordinary" }); } },
    { name: "wrong lease", mutate: (r) => { r.lease_id = "forged-lease"; } },
    { name: "wrong revision", mutate: (r) => { r.lease_revision = "2"; } },
    { name: "wrong generation", mutate: (r) => { r.claim_generation = "2"; } },
    { name: "wrong protocol", mutate: (r) => { r.protocol_version = "1"; } },
    { name: "preparation not claimed", mutate: (r) => { r.claimed = "false"; } },
    { name: "held preparation", safeNoop: true, mutate: (r) => { r.reservation_status = "held"; } },
    { name: "superseded preparation", safeNoop: true, mutate: (r) => { r.reservation_status = "superseded"; } },
    { name: "invalid owner", mutate: (r) => { r.reservation_owner = "invalid owner"; } },
    { name: "invalid comment id", mutate: (r) => { r.reservation_comment_id = "41x"; } },
    { name: "new attempt cannot reuse an old preparation generation", modelAttempt: 2 },
    { name: "a lost current model claim cannot restore a posted receipt", lostClaim: true },
  ];
  for (const scenario of cases) await t.test(scenario.name, async () => {
    await withQueue(async (s) => {
      const preparedClaim = await s.claim(prepareClaim);
      claimed(preparedClaim, 1);
      if (scenario.lostClaim) claimed(await s.claim(modelClaim, 2), 2);
      const currentClaim = await s.claim(modelClaim, scenario.modelAttempt ?? 1);
      if (scenario.lostClaim) {
        assert.equal(currentClaim.code, 0); assert.equal(currentClaim.outputs.claimed, "false");
        assert.equal(currentClaim.transport.status, 409); assert.equal(currentClaim.transport.response.error, "stale_run_attempt");
      } else claimed(currentClaim, scenario.modelAttempt ?? 1);
      const expressions: Outputs = {};
      for (const [key, value] of Object.entries(preparedClaim.outputs)) expressions[`steps.claim-exact-review-queue.outputs.${key}`] = value;
      // Existing reserve CLI's posted-output shape, not an executed comment mutation.
      for (const [key, value] of Object.entries({ status: "posted", owner: "oc3-prepared-41001", comment_id: "41010" })) expressions[`steps.reserve-exact-review-lease.outputs.${key}`] = value;
      assert.deepEqual(Object.keys(prepare.outputs || {}).sort(), [...preparedFields].sort());
      const receipt = Object.fromEntries(Object.entries(prepare.outputs || {}).map(([key, value]) => [key, render(value, expressions)]));
      scenario.mutate?.(receipt);
      const before = s.trace.length;
      const restored = await s.run(bridge, {
        "toJSON(needs.event-review-prepare.outputs)": JSON.stringify(receipt),
        "toJSON(steps.claim-exact-review-queue.outputs)": JSON.stringify(currentClaim.outputs),
      }, scenario.modelAttempt ?? 1);
      assert.equal(s.trace.length, before, "receipt bridge must not acquire another Queue claim");
      if (scenario.allowed) {
        assert.equal(restored.code, 0, restored.stderr);
        assert.deepEqual(restored.outputs, { status: "posted", owner: "oc3-prepared-41001", comment_id: "41010" });
      } else {
        assert.doesNotMatch(restored.raw, /^status=posted$/m, "rejected preparation must never emit a posted receipt, even transiently");
        if (scenario.safeNoop) assert.ok(restored.code === 0 || restored.code === 1);
        else assert.equal(restored.code, 1, "invalid preparation must remain an explicit failure");
      }
    });
  });
});
