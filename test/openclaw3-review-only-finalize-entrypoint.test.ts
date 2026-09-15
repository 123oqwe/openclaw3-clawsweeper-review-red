import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import YAML from "yaml";
import worker, { ExactReviewQueue } from "../dashboard/worker.ts";
import { MemoryDurableNamespace, MemoryDurableStorage, unclaimedExactReviewQueueItem, createExactReviewAdmissionHarness, signedStateAppendRequest, jsonResponse } from "./dashboard-worker-harness.ts";
import { ExactReviewLifecycleProjectionStore, lifecycleState } from "../dashboard/exact-review-lifecycle.ts";

// Planner-owned R06-B. Actual workflow shell -> actual Worker -> actual Queue.
// Reports, stage outcomes and artifact transfer are controlled inputs; no model,
// GitHub mutation, Actions scheduler or hosted artifact service is exercised.
const upstream = "fixtures/upstream-16505cf/.github/workflows/sweep.yml";
const candidate = "candidate/receiver/.github/workflows/sweep.yml";
const repository = "123oqwe/openclaw3-clawsweeper-review-red";
const runId = "41001", sourceSha = "a".repeat(40), itemKey = "openclaw/openclaw#41";
const secret = "synthetic-r06-finalizer-signature-secret";
const decision = {
  targetRepo: "openclaw/openclaw", targetBranch: "main", itemNumber: 41, itemKind: "issue",
  sourceEvent: "issues", sourceAction: "manual_explicit_review", publicationPolicy: "record_comment_only",
  supersedesInProgress: false,
};
type ReviewDecision = typeof decision & { sourceHeadSha?: string };
const prDecision: ReviewDecision = { ...decision, itemKind: "pull_request", sourceEvent: "pull_request", sourceHeadSha: sourceSha };
const report = "---\npublication_policy: record_comment_only\nreviewed_at: 2026-08-01T01:02:03.000Z\n---\n# Review\n\nKeep open for maintainer follow-up.\n";
type Outputs = Record<string, string>;
type Step = { id?: string; name?: string; run?: string; env?: Outputs };
type Job = { steps?: Step[]; outputs?: Outputs };
type Stage = { outputs: Outputs; outcome: string };
type Trace = { path: string; request: Record<string, unknown>; sentRequest: Record<string, unknown>; status: number; response: Record<string, unknown>; sourceResponse: Record<string, unknown>; signed: boolean };
const corepackHome = process.env.COREPACK_HOME ?? join(
  process.env.XDG_CACHE_HOME ?? process.env.LOCALAPPDATA ?? join(homedir(), process.platform === "win32" ? "AppData/Local" : ".cache"), "node/corepack",
);
const normalize = (value: string) => value.replace(/\s+/g, "");
function render(value: string, values: Outputs): string {
  const entries = Object.fromEntries(Object.entries(values).map(([key, result]) => [normalize(key), result]));
  return String(value).replace(/\$\{\{\s*([\s\S]*?)\s*\}\}/g, (_match, expression: string) => {
    assert.ok(Object.hasOwn(entries, normalize(expression)), `unfrozen finalizer expression: ${expression}`);
    return entries[normalize(expression)];
  });
}
function parseOutputs(raw: string): Outputs {
  return Object.fromEntries(raw.split("\n").filter(Boolean).map((line) => {
    const at = line.indexOf("=");
    assert.ok(at > 0, `expected single-line Actions output: ${line}`);
    return [line.slice(0, at), line.slice(at + 1)];
  }));
}
function jobs(path: string): Record<string, Job> { return YAML.parse(readFileSync(path, "utf8")).jobs; }
function step(job: Job | undefined, id: string, label: string): Step {
  const found = job?.steps?.find((entry) => entry.id === id);
  assert.ok(found?.run, `missing finalizer topology: ${label}/${id}`);
  return found;
}
function upstreamStep(id: string, job = "event-review-apply"): Step { return step(jobs(upstream)[job], id, `fixed upstream ${job}`); }

async function session(admitted = false, rawDecision: ReviewDecision = decision, trailingQueueUrl = false) {
  const root = mkdtempSync(join(tmpdir(), "oc3-finalizer-entrypoint-"));
  mkdirSync(join(root, "scripts"));
  cpSync("scripts/control-plane-curl.sh", join(root, "scripts/control-plane-curl.sh"));
  cpSync("scripts/control-plane-curl.sh", join(root, "control-plane-curl.sh"));
  cpSync("dist", join(root, "dist"), { recursive: true });
  cpSync("package.json", join(root, "package.json"));
  symlinkSync(resolve("node_modules"), join(root, "node_modules"), "dir");
  mkdirSync(join(root, "artifacts/event"), { recursive: true });
  writeFileSync(join(root, "artifacts/event/41.md"), report);
  const cliTrace = join(root, "cli.jsonl"), observer = join(root, "observe.mjs");
  writeFileSync(cliTrace, "");
  writeFileSync(observer, `import fs from "node:fs"; import path from "node:path";
if (process.argv[1] && path.resolve(process.argv[1]) === ${JSON.stringify(join(root, "dist/repair/exact-review-bundle-cli.js"))}) {
  fs.appendFileSync(${JSON.stringify(cliTrace)}, JSON.stringify({ command: process.argv[2] }) + "\\n");
}
`);
  // Existing external GitHub fixture supplies dispatch transport only. The
  // replacement Queue uses its real implementation plus manual admission flag.
  const admission = admitted ? createExactReviewAdmissionHarness((_repo, _number, kind) => jsonResponse({
    state: "open", locked: false,
    ...(kind === "pull_request" ? { head: { sha: rawDecision.sourceHeadSha || sourceSha }, base: { ref: "main", sha: "b".repeat(40) }, draft: false, additions: 1, deletions: 1, changed_files: 1 } : {}),
  })) : undefined;
  const storage = admission?.storage ?? new MemoryDurableStorage();
  try {
  let owned = { ...unclaimedExactReviewQueueItem(41), decision: { ...rawDecision }, leaseDecision: { ...rawDecision }, attempts: 3, reviewFailureAttempts: 2 };
  if (!admitted) await storage.put("exact-review-queue", { deliveries: {}, items: { [itemKey]: owned } });
  const dispatchEnv = admitted ? {
    CLAWSWEEPER_APP_CLIENT_ID: "Iv23test",
    CLAWSWEEPER_APP_PRIVATE_KEY: generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } }).privateKey,
    EXACT_REVIEW_DISPATCH_DEBOUNCE_MS: "0", EXACT_REVIEW_QUEUE_MAX_CONCURRENT: "1",
  } : {};
  const queue = new ExactReviewQueue({ storage }, {
    hostedTargetPredicate: () => true, hostedPublicTargetProbe: async () => "public",
    EXACT_REVIEW_MANUAL_PUBLICATION_ENABLED: "1", EXACT_REVIEW_HOSTED_TARGET_ADMISSION_MAX_STALE_MS: "0",
    ...dispatchEnv,
  }, () => 0);
  const workerEnv = {
    EXACT_REVIEW_QUEUE: new MemoryDurableNamespace(queue), CLAWSWEEPER_WEBHOOK_SECRET: secret,
    hostedTargetPredicate: () => true, hostedPublicTargetProbe: async () => "public",
  };
  if (admission) {
    const accepted = await worker.fetch(signedStateAppendRequest("/internal/exact-review/enqueue", { delivery_id: `manual-control:${runId}`, decision: rawDecision }, secret), workerEnv);
    assert.equal(accepted.status, 202); assert.equal((await accepted.json()).queued, true);
    // Real alarm reserves and dispatches the lease. Do not seed a lifecycle row
    // or copy a leased fixture over the normally admitted item.
    await queue.alarm(); assert.equal(admission.dispatched.length, 1, "normal admission must actually dispatch a lease");
    const current = await storage.get("exact-review-queue");
    owned = current.items[itemKey]; assert.equal(owned.state, "dispatching"); assert.ok(owned.leaseId);
    assert.ok(new ExactReviewLifecycleProjectionStore(storage).read(itemKey, itemKey, 1), "normal enqueue must create producer admission fact");
  }
  const trace: Trace[] = [];
  // A corrupt-wire test first obtains a genuine Queue ownership conflict, then
  // changes only that response's error label. It cannot manufacture acceptance.
  const wire = { unknownConflictPath: "", heartbeatHead: "" as "" | "omit" | "wrong" };
  let serverError: unknown, sequence = 0;
  const server = createServer(async (request, response) => {
    try {
      assert.equal(request.method, "POST");
      const routes = ["/internal/exact-review/claim", "/internal/exact-review/heartbeat", "/internal/exact-review/enqueue", "/internal/exact-review/complete", "/internal/exact-review/lifecycle/terminal-disposition"];
      // In this configuration only, forward the exact accidental double slash
      // to the real Worker as well. Never normalize it or fake a route failure.
      const malformedRoutes = ["//internal/exact-review/heartbeat", "//internal/exact-review/complete", "//internal/exact-review/lifecycle/terminal-disposition"];
      assert.ok(routes.includes(request.url || "") || (trailingQueueUrl && malformedRoutes.includes(request.url || "")), `unexpected fixture route ${request.url}`);
      let bytes = "";
      for await (const chunk of request) { bytes += chunk; assert.ok(bytes.length < 128 * 1024); }
      const sentRequest = JSON.parse(bytes), forwarded = structuredClone(sentRequest);
      if (request.url === "/internal/exact-review/heartbeat" && wire.heartbeatHead) {
        if (wire.heartbeatHead === "omit") delete forwarded.source_head_sha;
        else forwarded.source_head_sha = "c".repeat(40);
      }
      const headers = new Headers({ "content-type": "application/json" });
      const signature = request.headers["x-clawsweeper-exact-review-signature"];
      if (typeof signature === "string") headers.set("x-clawsweeper-exact-review-signature", signature);
      const result = await worker.fetch(new Request(`https://worker.invalid${request.url}`, { method: "POST", headers, body: wire.heartbeatHead && request.url === "/internal/exact-review/heartbeat" ? JSON.stringify(forwarded) : bytes }), workerEnv);
      const sourceResponse = await result.json() as Record<string, unknown>;
      if (wire.unknownConflictPath === request.url) assert.equal(result.status, 409);
      const body = wire.unknownConflictPath === request.url ? { error: "r06_unknown_conflict" } : sourceResponse;
      trace.push({ path: request.url!, request: forwarded, sentRequest, status: result.status, response: body, sourceResponse, signed: typeof signature === "string" });
      response.writeHead(result.status, { "content-type": "application/json" }); response.end(JSON.stringify(body));
    } catch (error) { serverError = error; response.writeHead(400); response.end("fixture transport failure"); }
  });
  await new Promise<void>((accept) => server.listen(0, "127.0.0.1", accept));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const queueUrl = `http://127.0.0.1:${address.port}${trailingQueueUrl ? "/" : ""}`;
  async function run(actual: Step, values: Outputs, attempt = 1) {
    assert.ok(actual.run);
    const output = join(root, `outputs-${++sequence}`); writeFileSync(output, "");
    // Only actual step.env declarations become product variables. Runtime below
    // is an explicit tool/Actions allowlist, never inherited user credentials.
    const declared = Object.fromEntries(Object.entries(actual.env || {}).map(([key, value]) => [key, render(value, values)]));
    const child = spawn("/bin/bash", ["--noprofile", "--norc", "-e", "-o", "pipefail", "-c", render(actual.run, values)], {
      cwd: root, detached: true, stdio: ["ignore", "pipe", "pipe"],
      env: {
        PATH: process.env.PATH, HOME: root, RUNNER_TEMP: root, GITHUB_OUTPUT: output,
        GITHUB_REPOSITORY: repository, GITHUB_RUN_ID: runId, GITHUB_RUN_ATTEMPT: String(attempt), GITHUB_SHA: sourceSha,
        COREPACK_HOME: corepackHome, COREPACK_ENV_FILE: "0", COREPACK_ENABLE_NETWORK: "0",
        COREPACK_ENABLE_DOWNLOAD_PROMPT: "0", COREPACK_DEFAULT_TO_LATEST: "0",
        NODE_OPTIONS: `--import=${pathToFileURL(observer).href}`, ...declared,
      },
    });
    let stdout = "", stderr = "", timedOut = false;
    const kill = () => { if (child.pid) { try { process.kill(-child.pid, "SIGKILL"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; } } };
    child.stdout.on("data", (chunk) => { stdout += chunk; if (stdout.length > 2 * 1024 * 1024) kill(); });
    child.stderr.on("data", (chunk) => { stderr += chunk; if (stderr.length > 2 * 1024 * 1024) kill(); });
    const timer = setTimeout(() => { timedOut = true; kill(); }, 20_000);
    const code = await new Promise<number | null>((accept, reject) => { child.once("error", reject); child.once("close", accept); }).finally(() => { clearTimeout(timer); kill(); });
    assert.equal(timedOut, false, "deadline is a harness failure, never a product rejection");
    assert.notEqual(code, null); assert.equal(serverError, undefined);
    const raw = readFileSync(output, "utf8");
    return { code, stdout, stderr, raw, outputs: parseOutputs(raw) };
  }
  async function claim(actual = upstreamStep("claim-exact-review-queue"), attempt = 1, denied = false) {
    const before = trace.length;
    const leaseId = denied ? "not-the-active-lease" : owned.leaseId;
    const payload = { target_repo: rawDecision.targetRepo, item_number: 41, source_action: rawDecision.sourceAction, publication_policy: rawDecision.publicationPolicy, queue_lease_id: leaseId, queue_claim: { item_key: itemKey, lease_revision: 1, ...(rawDecision.sourceHeadSha ? { source_head_sha: rawDecision.sourceHeadSha } : {}) } };
    const result = await run(actual, {
      "toJSON(github.event.client_payload)": JSON.stringify(payload),
      "github.event.client_payload.queue_claim.item_key || github.event.client_payload.item_key": itemKey,
      "github.event.client_payload.queue_lease_id": leaseId,
      "github.event.client_payload.queue_claim.lease_revision || github.event.client_payload.lease_revision": "1",
      "vars.CLAWSWEEPER_EXACT_REVIEW_QUEUE_URL || 'https://clawsweeper.openclaw.ai'": queueUrl,
      "vars.CLAWSWEEPER_EXACT_REVIEW_QUEUE_URL": queueUrl,
      "github.run_attempt": String(attempt),
    }, attempt);
    assert.equal(result.code, 0, result.stderr); assert.equal(trace.length, before + 1);
    assert.equal(trace[before].path, "/internal/exact-review/claim");
    assert.deepEqual(trace[before].request, { lease_id: leaseId, item_key: itemKey, lease_revision: 1, run_id: runId, run_attempt: attempt });
    if (denied) {
      assert.equal(trace[before].status, 409); assert.deepEqual(trace[before].response, { error: "lease_not_active" });
      assert.equal(result.outputs.claimed, "false"); return result.outputs;
    }
    assert.equal(trace[before].status, 200); assert.equal(result.outputs.claimed, "true");
    assert.equal(result.outputs.protocol_version, "2"); assert.equal(result.outputs.item_key, itemKey);
    assert.equal(result.outputs.lease_id, owned.leaseId); assert.equal(result.outputs.lease_revision, "1");
    assert.equal(result.outputs.claim_generation, String(attempt));
    assert.deepEqual(JSON.parse(result.outputs.decision), rawDecision);
    return result.outputs;
  }
  const state = async () => await storage.get("exact-review-queue") as { items: Record<string, Record<string, any>> };
  const publications = async () => Object.values((await state()).items).filter((item) => item.decision.publication);
  const cliCommands = (): string[] => readFileSync(cliTrace, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line).command);
  return { root, owned, storage, queue, workerEnv, trace, wire, queueUrl, run, claim, state, publications, cliCommands, close: async () => {
    server.closeAllConnections(); await new Promise<void>((accept) => server.close(() => accept()));
    admission?.restore(); storage.sql.close(); rmSync(root, { recursive: true, force: true });
  } };
  } catch (error) {
    admission?.restore(); storage.sql.close(); rmSync(root, { recursive: true, force: true }); throw error;
  }
}
type Session = Awaited<ReturnType<typeof session>>;
async function withSession(use: (s: Session) => Promise<void>, admitted = false, rawDecision: ReviewDecision = decision, trailingQueueUrl = false) {
  const s = await session(admitted, rawDecision, trailingQueueUrl); try { await use(s); } finally { await s.close(); }
}

function stages(claim: Outputs, effectiveDecision: ReviewDecision = decision): Record<string, Stage> {
  const empty = (): Stage => ({ outputs: {}, outcome: "skipped" });
  return {
    "claim-exact-review-queue": { outputs: claim, outcome: "success" },
    target: { outputs: { target_enabled: "true", target_repo: effectiveDecision.targetRepo, item_number: "41", has_command_context: "false" }, outcome: "success" },
    "live-item": { outputs: { decision: JSON.stringify(effectiveDecision), target_branch: effectiveDecision.targetBranch, proceed: "true", terminal_noop: "false", terminal_missing: "false", guarded_open: "false", admission_retry: "false", scheduled_semantic_noop: "false", retry_kind: "", retry_at: "" }, outcome: "success" },
    "reserve-exact-review-lease": { outputs: { status: "posted", owner: `github-run-${runId}-1`, comment_id: "41010", retry_kind: "", retry_at: "" }, outcome: "success" },
    "review-exact-event-item": { outputs: { terminal_during_review: "false", superseded: "false", retry_kind: "", retry_at: "", failure_reason: "", failure_stage: "", failure_reason_code: "", failure_retryable: "" }, outcome: "success" },
    "source-checkout": { outputs: {}, outcome: "success" },
    "create-exact-review-bundle": empty(), "upload-exact-review-bundle": empty(), "queue-exact-review-publication": empty(),
    "exact-review-generation-result": empty(), "complete-exact-review-queue": empty(),
    "prepare-direct-exact-review-publication": { outputs: { failure_kind: "", retry_at: "" }, outcome: "skipped" },
    "direct-exact-review-publication": { outputs: { accepted: "", superseded: "" }, outcome: "skipped" },
    "finalize-direct-exact-review-lifecycle": { outputs: { direct_lifecycle_requeue: "false" }, outcome: "skipped" },
    "automatic-review-status": { outputs: { status_comment_id: "" }, outcome: "skipped" },
    "terminal-review-status": { outputs: { review_status_verified: "false", review_status_comment_id: "", review_status_completed_at: "" }, outcome: "skipped" },
  };
}
function expressions(s: Session, inputs: Record<string, Stage>, attempt = 1): Outputs {
  const values: Outputs = {
    "vars.CLAWSWEEPER_EXACT_REVIEW_QUEUE_URL || 'https://clawsweeper.openclaw.ai'": s.queueUrl,
    "secrets.CLAWSWEEPER_WEBHOOK_SECRET": secret, "github.run_attempt": String(attempt),
    "env.CLAWSWEEPER_ACTION_LEDGER_OUTPUT_ROOT": "",
    "fromJSON(steps.claim-exact-review-queue.outputs.decision).itemKind": inputs["claim-exact-review-queue"].outputs.decision ? JSON.parse(inputs["claim-exact-review-queue"].outputs.decision).itemKind : "",
  };
  for (const [id, stage] of Object.entries(inputs)) {
    values[`steps.${id}.outcome`] = stage.outcome;
    for (const [key, value] of Object.entries(stage.outputs)) {
      values[`steps.${id}.outputs.${key}`] = value;
      values[`steps.${id}.outputs.${key} || ''`] = value || "";
      values[`steps.${id}.outputs.${key} || 'false'`] = value || "false";
    }
  }
  const live = inputs["live-item"].outputs, review = inputs["review-exact-event-item"].outputs;
  values["steps.live-item.outputs.retry_kind || steps.reserve-exact-review-lease.outputs.retry_kind || steps.review-exact-event-item.outputs.retry_kind"] = live.retry_kind || inputs["reserve-exact-review-lease"].outputs.retry_kind || review.retry_kind;
  values["steps.live-item.outputs.retry_at || steps.reserve-exact-review-lease.outputs.retry_at || steps.review-exact-event-item.outputs.retry_at"] = live.retry_at || inputs["reserve-exact-review-lease"].outputs.retry_at || review.retry_at;
  values["steps.review-exact-event-item.outputs.terminal_during_review == 'true' && 'false' || steps.live-item.outputs.proceed"] = review.terminal_during_review === "true" ? "false" : live.proceed;
  values["steps.review-exact-event-item.outputs.terminal_during_review == 'true' && 'true' || steps.live-item.outputs.terminal_noop"] = review.terminal_during_review === "true" ? "true" : live.terminal_noop;
  values["steps.review-exact-event-item.outputs.superseded == 'true' || steps.review-status-fence.outputs.superseded == 'true' || steps.release-review-status-fence.outputs.superseded == 'true' || steps.review-complete-status-fence.outputs.superseded == 'true' || steps.release-review-complete-status-fence.outputs.superseded == 'true'"] = review.superseded;
  values["steps.exact-review-generation-result.outputs.outcome || 'failure'"] = inputs["exact-review-generation-result"].outputs.outcome || "failure";
  values["steps.terminal-review-status.outcome || 'skipped'"] = inputs["terminal-review-status"].outcome || "skipped";
  return values;
}
async function runStage(s: Session, inputs: Record<string, Stage>, actual: Step, attempt = 1) {
  const result = await s.run(actual, expressions(s, inputs, attempt), attempt);
  assert.ok(actual.id); inputs[actual.id] = { outputs: result.outputs, outcome: result.code === 0 ? "success" : "failure" };
  return result;
}
async function bundle(s: Session, inputs: Record<string, Stage>) {
  const created = await runStage(s, inputs, upstreamStep("create-exact-review-bundle"));
  assert.equal(created.code, 0, created.stderr);
  assert.equal(created.outputs.artifact_name, `exact-review-${runId}-1`);
  const claim = inputs["claim-exact-review-queue"].outputs, live = inputs["live-item"].outputs;
  // Independent trusted consumer inputs: never derive authority from the manifest.
  const trusted = { claim_generation: claim.claim_generation, decision: JSON.stringify(decision), generation_attempt: "1", item_key: itemKey, item_kind: "issue", item_number: "41", lease_revision: claim.lease_revision, live_guarded_open: live.guarded_open, live_proceeded: live.proceed, live_terminal_missing: live.terminal_missing, live_terminal_noop: live.terminal_noop, producer_run_id: runId, protocol_version: "2", source_sha: sourceSha, target_branch: "main", target_repo: decision.targetRepo };
  const validated = await s.run(upstreamStep("validate-exact-review-bundle", "event-review-publish"), Object.fromEntries(Object.entries(trusted).map(([key, value]) => [`steps.publication-context.outputs.${key}`, value])));
  assert.equal(validated.code, 0, validated.stderr); assert.deepEqual(s.cliCommands(), ["create", "validate"]);
  assert.equal(JSON.parse(validated.stdout).review.artifact_present, live.proceed === "true");
  inputs["upload-exact-review-bundle"].outcome = "success"; // Controlled transport receipt only.
}
async function resultAndComplete(s: Session, inputs: Record<string, Stage>) {
  const result = await runStage(s, inputs, upstreamStep("exact-review-generation-result"));
  assert.equal(result.code, 0, result.stderr);
  const before = s.trace.length;
  const complete = await runStage(s, inputs, upstreamStep("complete-exact-review-queue"));
  assert.equal(s.trace.length, before + 1);
  assert.equal(s.trace.at(-1)?.path, "/internal/exact-review/complete");
  return { result, complete, transport: s.trace.at(-1)! };
}

test("R06-B fixed upstream: real bundle validate, signed enqueue, dedup and successful completion", async () => {
  await withSession(async (s) => {
    const inputs = stages(await s.claim()); await bundle(s, inputs);
    for (let repetition = 0; repetition < 2; repetition++) {
      const queued = await runStage(s, inputs, upstreamStep("queue-exact-review-publication"));
      assert.equal(queued.code, 0, queued.stderr);
      const receipt = s.trace.at(-1)!;
      assert.equal(receipt.path, "/internal/exact-review/enqueue"); assert.equal(receipt.signed, true);
      assert.equal(receipt.status, 202); assert.equal(receipt.response.ok, true);
      assert.equal(receipt.response[repetition === 0 ? "queued" : "deduped"], true);
      assert.equal(receipt.request.delivery_id, `publisher:${runId}:1`);
      const items = await s.publications(); assert.equal(items.length, 1);
      assert.deepEqual(items[0].decision.publication, {
        artifactName: `exact-review-${runId}-1`, producerRunId: runId, producerRunAttempt: 1,
        sourceSha, itemKey, protocolVersion: 2, leaseRevision: 1, claimGeneration: 1,
        liveProceeded: true, liveTerminalNoop: false, liveTerminalMissing: false, liveGuardedOpen: false,
        producerDecision: decision,
      });
    }
    const done = await resultAndComplete(s, inputs);
    assert.equal(done.result.outputs.outcome, "success"); assert.equal(done.complete.code, 0, done.complete.stderr);
    assert.equal(done.transport.status, 200);
    assert.deepEqual(done.transport.request, { lease_id: s.owned.leaseId, item_key: itemKey, lease_revision: 1, claim_generation: 1, run_id: runId, run_attempt: 1, outcome: "success" });
    assert.deepEqual(done.transport.response, { ok: true, requeued: false });
    assert.equal((await s.state()).items[itemKey], undefined); assert.equal((await s.publications()).length, 1);
  });
});
test("R06-B fixed upstream: actual Worker 401 cannot become generation success", async () => {
  await withSession(async (s) => {
    const inputs = stages(await s.claim()); await bundle(s, inputs);
    s.workerEnv.CLAWSWEEPER_WEBHOOK_SECRET = "synthetic-different-verifier-secret";
    const before = s.trace.length;
    const queued = await runStage(s, inputs, upstreamStep("queue-exact-review-publication"));
    assert.equal(s.trace.length, before + 1, "401 must not be retried as a transport outage");
    assert.equal(queued.code, 1); assert.equal(s.trace.at(-1)?.status, 401);
    assert.deepEqual(s.trace.at(-1)?.response, { error: "invalid_signature" });
    assert.equal((await s.publications()).length, 0);
    const done = await resultAndComplete(s, inputs);
    assert.equal(done.result.outputs.outcome, "failure"); assert.equal(done.complete.code, 0, done.complete.stderr);
    assert.deepEqual(done.transport.response, { ok: true, requeued: true });
    const pending = (await s.state()).items[itemKey]; assert.equal(pending.state, "pending"); assert.equal(pending.leaseId, undefined);
  });
});
for (const kind of ["coordination", "throttle"] as const) test(`R06-B fixed upstream: ${kind} releases the lease without spending ordinary failures`, async () => {
  await withSession(async (s) => {
    const inputs = stages(await s.claim()), retryAt = new Date(Date.now() + 45 * 60_000).toISOString();
    inputs["reserve-exact-review-lease"].outputs = { status: "held", owner: "", comment_id: "", retry_kind: kind, retry_at: retryAt };
    inputs["review-exact-event-item"].outcome = "skipped";
    const before = (await s.state()).items[itemKey];
    const done = await resultAndComplete(s, inputs);
    assert.equal(done.result.outputs.outcome, "failure"); assert.equal(done.result.outputs.retry_kind, kind); assert.equal(done.result.outputs.retry_at, retryAt);
    assert.equal(done.complete.code, 0, done.complete.stderr); assert.deepEqual(done.transport.response, { ok: true, requeued: true });
    const pending = (await s.state()).items[itemKey];
    assert.equal(pending.state, "pending"); assert.equal(pending.backoffReason, `${kind}_retry`);
    assert.equal(pending.attempts, before.attempts); assert.equal(pending.reviewFailureAttempts, before.reviewFailureAttempts);
    assert.equal(pending.leaseId, undefined); assert.equal(pending.claimedRunId, undefined); assert.equal(pending.reviewRecoveryReason, undefined);
    assert.ok(pending.nextAttemptAt > Date.now()); assert.ok(pending.nextAttemptAt <= Date.parse(retryAt));
    assert.equal(s.trace.filter((entry) => entry.path.endsWith("/enqueue")).length, 0);
  });
});
test("R06-B fixed upstream: cancelled review returns durable retry ownership", async () => {
  await withSession(async (s) => {
    const inputs = stages(await s.claim()); inputs["review-exact-event-item"].outcome = "cancelled";
    const done = await resultAndComplete(s, inputs);
    assert.equal(done.result.outputs.outcome, "cancelled"); assert.equal(done.complete.code, 0, done.complete.stderr);
    assert.deepEqual(done.transport.response, { ok: true, requeued: true });
    const pending = (await s.state()).items[itemKey];
    assert.equal(pending.state, "pending"); assert.equal(pending.reviewRecoveryReason, "workflow_cancelled");
    for (const field of ["leaseId", "claimedRunId", "claimedRunAttempt", "claimGeneration"]) assert.equal(pending[field], undefined);
    assert.equal((await s.publications()).length, 0);
  });
});
test("R06-B fixed upstream: a new attempt fences old-generation enqueue and completion", async () => {
  await withSession(async (s) => {
    const inputs = stages(await s.claim()); await bundle(s, inputs); await s.claim(upstreamStep("claim-exact-review-queue"), 2);
    const newer = (await s.state()).items[itemKey];
    const queued = await runStage(s, inputs, upstreamStep("queue-exact-review-publication"));
    assert.equal(queued.code, 1); assert.equal(s.trace.at(-1)?.status, 409);
    assert.deepEqual(s.trace.at(-1)?.response, { error: "exact_review_delivery_conflict" });
    const done = await resultAndComplete(s, inputs);
    assert.equal(done.result.outputs.outcome, "failure"); assert.equal(done.complete.code, 1);
    assert.equal(done.transport.status, 409); assert.deepEqual(done.transport.response, { error: "lease_not_claimed" });
    assert.deepEqual((await s.state()).items[itemKey], newer); assert.equal((await s.publications()).length, 0);
  });
});
test("R06-B fixed upstream: disabled target completes without a model or publication", async () => {
  await withSession(async (s) => {
    const inputs = stages(await s.claim()); inputs.target.outputs.target_enabled = "false";
    inputs["review-exact-event-item"].outcome = "skipped";
    const done = await resultAndComplete(s, inputs);
    assert.equal(done.result.outputs.outcome, "success"); assert.equal(done.complete.code, 0, done.complete.stderr);
    assert.deepEqual(done.transport.response, { ok: true, requeued: false });
    assert.equal((await s.state()).items[itemKey], undefined); assert.equal((await s.publications()).length, 0);
    assert.deepEqual(s.cliCommands(), []);
  });
});

test("R06-B real normal manual admission persists terminal kinds before producer completion", async (t) => {
  await t.test("actual safe claim conflict supplies a legitimate unclaimed receipt", async () => {
    await withSession(async (s) => {
      const before = (await s.state()).items[itemKey];
      const receipt = await s.claim(upstreamStep("claim-exact-review-queue"), 1, true);
      assert.equal(receipt.claimed, "false"); assert.deepEqual((await s.state()).items[itemKey], before);
      assert.equal(s.trace.length, 1); assert.equal(s.trace[0].status, 409);
    }, true);
  });
  for (const kind of ["target_closed", "target_missing", "guarded_open", "policy_noop"]) await t.test(kind, async () => {
    await withSession(async (s) => {
      const claimed = await s.claim();
      for (let retry = 0; retry < 2; retry++) {
        const terminal = await worker.fetch(signedStateAppendRequest("/internal/exact-review/lifecycle/terminal-disposition", {
          canonical_target_key: itemKey, fence_key: itemKey, revision: 1, kind,
        }, secret), s.workerEnv);
        assert.equal(terminal.status, 200); assert.equal((await terminal.json()).lifecycle_state, kind);
      }
      const completed = await worker.fetch(new Request("https://worker.invalid/internal/exact-review/complete", {
        method: "POST", body: JSON.stringify({ lease_id: claimed.lease_id, item_key: itemKey, lease_revision: 1, claim_generation: 1, run_id: runId, run_attempt: 1, outcome: "success", lifecycle_terminal_disposition: kind }),
      }), s.workerEnv);
      assert.equal(completed.status, 200); assert.deepEqual(await completed.json(), { ok: true, requeued: false });
      const row = new ExactReviewLifecycleProjectionStore(s.storage).read(itemKey, itemKey, 1);
      assert.ok(row); assert.equal(lifecycleState(row), kind); assert.equal(row.terminalDisposition?.kind, kind);
      assert.deepEqual(row.canonicalReceipts, []); assert.equal((await s.publications()).length, 0);
      assert.equal((await s.state()).items[itemKey], undefined);
    }, true);
  });
  await t.test("legacy seed has no admission fact; completion alone is insufficient", async () => {
    await withSession(async (s) => {
      await s.claim();
      const store = new ExactReviewLifecycleProjectionStore(s.storage);
      assert.equal(store.read(itemKey, itemKey, 1), null);
      const terminal = await worker.fetch(signedStateAppendRequest("/internal/exact-review/lifecycle/terminal-disposition", { canonical_target_key: itemKey, fence_key: itemKey, revision: 1, kind: "target_closed" }, secret), s.workerEnv);
      assert.equal(terminal.status, 409); assert.deepEqual(await terminal.json(), { error: "invalid_lifecycle_terminal_disposition" });
      const inputs = stages({ ...(await s.claim()) }); inputs.target.outputs.target_enabled = "false";
      assert.equal((await resultAndComplete(s, inputs)).complete.code, 0);
      assert.equal(store.read(itemKey, itemKey, 1), null, "a seeded completion is not terminal persistence evidence");
    });
  });
});

test("R06-B fixed upstream PR finalizing fence uses normally admitted source-head authority", async (t) => {
  for (const fault of ["", "omit", "wrong"] as const) await t.test(fault || "valid head", async () => {
    await withSession(async (s) => {
      const claim = await s.claim();
      s.wire.heartbeatHead = fault;
      const values = expressions(s, stages(claim, prDecision));
      values["fromJSON(steps.claim-exact-review-queue.outputs.decision).sourceHeadSha || ''"] = sourceSha;
      const result = await s.run(upstreamStep("release-review-complete-status-fence"), values);
      const response = s.trace.at(-1)!;
      assert.equal(response.path, "/internal/exact-review/heartbeat"); assert.equal(response.sentRequest.source_head_sha, sourceSha);
      assert.equal(response.sentRequest.phase, "finalizing"); assert.equal(result.code, 0, result.stderr);
      assert.equal(response.status, fault ? 409 : 200); assert.equal(result.outputs.authorized, fault ? "false" : "true");
      if (fault) assert.deepEqual(response.sourceResponse, { error: "lease_not_active" });
      else assert.equal(response.sourceResponse.ok, true);
      assert.equal(s.trace.length, 2); assert.equal((await s.publications()).length, 0);
    }, true, prDecision);
  });
});

const contextFields = ["claimed", "protocol_version", "item_key", "lease_id", "lease_revision", "claim_generation", "raw_decision", "decision", "reservation_status", "reservation_owner", "reservation_comment_id", "reservation_head_sha", "retry_kind", "retry_at", "target_repo", "target_branch", "item_number", "item_kind", "target_repo_owner", "target_repo_name"];
const resultFields = ["outcome", "requeue_latest", "retry_kind", "retry_at", "lifecycle_terminal_disposition", "cleanup_mode", "failed", "completion_required"];
const extraStages: Record<string, Outputs> = {
  "finalize-preparation-context": Object.fromEntries(contextFields.map((key) => [key, ""])),
  "fence-finalize-authority": { authorized: "", reason: "" }, "fence-finalize-handoff": { authorized: "", reason: "" },
  "claim-finalize-authority": { claimed: "" }, "fresh-finalize-live": {},
  "validate-finalize-bundle": {}, "record-finalize-terminal": { recorded: "", terminal_disposition: "" },
  "finalize-owner-cleanup": {},
};
type Scenario = {
  rawBranch?: string; mutateReceipt?: (receipt: Outputs) => void; unclaimed?: boolean;
  trailingQueueUrl?: boolean;
  unresolvedBranch?: "coordination" | "throttle";
  held?: "coordination" | "throttle"; model?: "success" | "failure" | "cancelled";
  terminal?: "target_closed" | "target_missing" | "guarded_open" | "policy_noop";
  noAdmission?: boolean; firstLost?: boolean; unknownFirst?: boolean;
  secondLost?: boolean; unknownSecond?: boolean;
  headFault?: "omit" | "wrong"; headFaultAt?: "first" | "second";
  corruptBundle?: "report" | "producer" | "decision" | "terminal";
  deniedEnqueue?: boolean; completeLost?: boolean; cleanupFailure?: boolean;
};
function candidateExpressions(s: Session, inputs: Record<string, Stage>, receipt: Outputs, scenario: Scenario): Outputs {
  const values = expressions(s, inputs);
  const dispatchDecision = s.owned.decision;
  Object.assign(values, {
    "toJSON(needs.event-review-prepare.outputs)": JSON.stringify(receipt),
    "needs.event-review-prepare.result": "success", "needs.event-review-apply.result": scenario.model ?? (scenario.held || scenario.unresolvedBranch || scenario.terminal || scenario.unclaimed ? "skipped" : "success"),
    "toJSON(steps.finalize-preparation-context.outputs)": JSON.stringify(inputs["finalize-preparation-context"].outputs),
    "vars.CLAWSWEEPER_EXACT_REVIEW_QUEUE_URL": s.queueUrl,
    "vars.CLAWSWEEPER_ENABLE_CLAWHUB": "",
    "github.run_id": runId, "github.sha": sourceSha, "github.repository": repository,
    "toJSON(github.event.client_payload)": JSON.stringify({ target_repo: dispatchDecision.targetRepo, item_number: 41, source_action: dispatchDecision.sourceAction, publication_policy: dispatchDecision.publicationPolicy, queue_lease_id: s.owned.leaseId, queue_claim: { item_key: itemKey, lease_revision: 1, ...(dispatchDecision.sourceHeadSha ? { source_head_sha: dispatchDecision.sourceHeadSha } : {}) } }),
  });
  // Missing Actions outputs render empty; only keys in the frozen interface are
  // eligible. No arbitrary expression evaluation or hidden product env exists.
  for (const [id, defaults] of Object.entries(extraStages)) for (const key of Object.keys(defaults)) {
    values[`steps.${id}.outputs.${key}`] = inputs[id]?.outputs[key] ?? "";
  }
  const fresh = inputs["fresh-finalize-live"].outputs, context = inputs["finalize-preparation-context"].outputs;
  for (const key of ["retry_kind", "retry_at"]) values[`steps.fresh-finalize-live.outputs.${key} || steps.finalize-preparation-context.outputs.${key}`] = fresh[key] || context[key] || "";
  values["steps.exact-review-generation-result.outputs.outcome || 'failure'"] = inputs["exact-review-generation-result"].outputs.outcome || "failure";
  return values;
}
async function candidateScenario(s: Session, allJobs: Record<string, Job>, scenario: Scenario = {}) {
  const decision: ReviewDecision = { ...s.owned.decision, targetBranch: scenario.unresolvedBranch ? s.owned.decision.targetBranch : "main" };
  const finalize = allJobs["event-review-finalize"];
  const actual = (id: string) => step(finalize, id, "candidate event-review-finalize");
  const initial = await s.claim(step(allJobs["event-review-prepare"], "claim-exact-review-queue", "candidate prepare"), 1, scenario.unclaimed);
  const inputs = stages(initial, decision);
  for (const [id, outputs] of Object.entries(extraStages)) inputs[id] = { outputs: { ...outputs }, outcome: "skipped" };
  const retryAt = scenario.held || scenario.unresolvedBranch ? new Date(Date.now() + 45 * 60_000).toISOString() : "";
  if (scenario.unresolvedBranch) {
    Object.assign(inputs["live-item"].outputs, { proceed: "false", admission_retry: "true", retry_kind: scenario.unresolvedBranch, retry_at: retryAt });
    inputs["reserve-exact-review-lease"] = { outcome: "skipped", outputs: {} };
  }
  const noReservation = scenario.held || scenario.terminal || scenario.unresolvedBranch;
  const trustedReservation = { status: scenario.held ? "held" : noReservation ? "" : "posted", owner: noReservation ? "" : `github-run-${runId}-1`, comment_id: noReservation ? "" : "41010", head_sha: noReservation ? "" : sourceSha, retry_kind: scenario.held || "", retry_at: scenario.held ? retryAt : "" };
  // Trusted preparation transport is synthetic, but its claim was just obtained
  // from the actual Queue. Actual prepare output mappings supply needs strings.
  const preparationValues: Outputs = {};
  const claimOutputs = { ...Object.fromEntries(["claimed", "protocol_version", "item_key", "lease_id", "lease_revision", "claim_generation", "decision", "repeat_revision"].map((key) => [key, ""])), ...initial };
  const reservationOutputs = scenario.unclaimed ? Object.fromEntries(Object.keys(trustedReservation).map((key) => [key, ""])) : trustedReservation;
  for (const [id, outputs] of Object.entries({ "claim-exact-review-queue": claimOutputs, "live-item": { decision: scenario.unclaimed ? "" : JSON.stringify(decision), retry_kind: scenario.unresolvedBranch || "", retry_at: scenario.unresolvedBranch ? retryAt : "" }, "reserve-exact-review-lease": reservationOutputs })) {
    for (const [key, value] of Object.entries(outputs)) preparationValues[`steps.${id}.outputs.${key}`] = value;
  }
  preparationValues["steps.live-item.outputs.retry_kind || steps.reserve-exact-review-lease.outputs.retry_kind"] = scenario.unresolvedBranch || trustedReservation.retry_kind;
  preparationValues["steps.live-item.outputs.retry_at || steps.reserve-exact-review-lease.outputs.retry_at"] = retryAt;
  const receipt = Object.fromEntries(Object.entries(allJobs["event-review-prepare"].outputs || {}).map(([key, expression]) => [key, render(expression, preparationValues)]));
  scenario.mutateReceipt?.(receipt);
  async function execute(id: string) {
    const result = await s.run(actual(id), candidateExpressions(s, inputs, receipt, scenario));
    inputs[id] = { outputs: result.outputs, outcome: result.code === 0 ? "success" : "failure" };
    return result;
  }
  async function finish() {
    const result = await execute("exact-review-generation-result");
    assert.equal(result.code, 0, result.stderr); assert.deepEqual(Object.keys(result.outputs).sort(), [...resultFields].sort());
    // The independent R02 suite runs the actual cleanup shell and helpers. Here
    // only its stage outcome is a controlled input to result propagation.
    inputs["finalize-owner-cleanup"] = { outputs: { status: result.outputs.cleanup_mode === "none" ? "skipped" : result.outputs.cleanup_mode === "expire" ? "expired" : "deleted" }, outcome: scenario.cleanupFailure ? "failure" : "success" };
    let completed: Awaited<ReturnType<Session["run"]>> | undefined;
    if (result.outputs.completion_required === "true") {
      if (scenario.completeLost) {
        await s.claim(upstreamStep("claim-exact-review-queue"), 2);
        s.wire.unknownConflictPath = "/internal/exact-review/complete";
      }
      completed = await execute("complete-exact-review-queue");
      assert.equal(s.trace.at(-1)?.path, "/internal/exact-review/complete");
    }
    const failed = await execute("fail-finalize");
    return { result, completed, failed };
  }
  const start = s.trace.length;
  const context = await execute("finalize-preparation-context");
  if (scenario.mutateReceipt) {
    assert.equal(context.code, 1); assert.doesNotMatch(context.raw, /^claimed=true$/m); assert.equal(s.trace.length, start);
    return { inputs, receipt, context };
  }
  assert.equal(context.code, 0, context.stderr);
  if (scenario.unclaimed) {
    assert.deepEqual(context.outputs, { claimed: "false" });
    const done = await finish(); assert.equal(done.result.outputs.completion_required, "false"); assert.equal(done.result.outputs.cleanup_mode, "none"); assert.equal(done.failed.code, 0, done.failed.stderr);
    assert.equal(s.trace.length, start); return { inputs, receipt, ...done };
  }
  assert.deepEqual(Object.keys(context.outputs).sort(), [...contextFields].sort());
  assert.deepEqual(JSON.parse(context.outputs.raw_decision), s.owned.decision);
  assert.deepEqual(JSON.parse(context.outputs.decision), decision);
  for (const key of ["claimed", "protocol_version", "item_key", "lease_id", "lease_revision", "claim_generation", "reservation_status", "reservation_owner", "reservation_comment_id", "reservation_head_sha", "retry_kind", "retry_at"]) assert.equal(context.outputs[key], receipt[key]);
  assert.deepEqual([context.outputs.target_repo_owner, context.outputs.target_repo_name], ["openclaw", "openclaw"]);
  if (scenario.firstLost) {
    await s.claim(upstreamStep("claim-exact-review-queue"), 2);
    if (scenario.unknownFirst) s.wire.unknownConflictPath = "/internal/exact-review/heartbeat";
  }
  if (scenario.headFaultAt === "first") s.wire.heartbeatHead = scenario.headFault!;
  const firstDenied = scenario.firstLost || scenario.headFaultAt === "first";
  const fencedState = firstDenied ? structuredClone((await s.state()).items[itemKey]) : undefined;
  const fenceStart = s.trace.length, fenced = await execute("fence-finalize-authority");
  assert.equal(s.trace.length, fenceStart + 1); assert.equal(s.trace.at(-1)?.path, "/internal/exact-review/heartbeat");
  const heartbeat = { lease_id: receipt.lease_id, item_key: itemKey, lease_revision: 1, claim_generation: 1, run_id: runId, run_attempt: 1, phase: "finalizing", ...(decision.sourceHeadSha ? { source_head_sha: decision.sourceHeadSha } : {}) };
  assert.deepEqual(s.trace.at(-1)?.sentRequest, heartbeat, "actual fence must carry the raw PR source head");
  if (firstDenied) {
    assert.equal(s.trace.at(-1)?.status, 409);
    assert.equal(s.trace.at(-1)?.sourceResponse.error, "lease_not_active");
    assert.equal(fenced.outputs.authorized, "false"); assert.equal(fenced.code, scenario.unknownFirst ? 1 : 0);
    const done = await finish(); assert.equal(done.result.outputs.completion_required, "false"); assert.equal(done.failed.code, scenario.unknownFirst ? 1 : 0);
    assert.equal(done.result.outputs.failed, String(Boolean(scenario.unknownFirst)));
    assert.equal(s.trace.length, fenceStart + 1, "loss must not trigger another claim, signature or completion");
    assert.equal(done.result.outputs.cleanup_mode, "none");
    assert.deepEqual((await s.state()).items[itemKey], fencedState);
    assert.equal((await s.publications()).length, 0); return { inputs, receipt, ...done };
  }
  assert.equal(fenced.code, 0, fenced.stderr); assert.equal(fenced.outputs.authorized, "true"); assert.equal(s.trace.at(-1)?.status, 200);
  const claimed = await execute("claim-finalize-authority");
  assert.equal(claimed.code, 0, claimed.stderr); assert.equal(s.trace.at(-1)?.path, "/internal/exact-review/claim");
  assert.equal(s.trace.at(-1)?.status, 200);
  assert.deepEqual(s.trace.at(-1)?.request, { lease_id: receipt.lease_id, item_key: itemKey, lease_revision: 1, run_id: runId, run_attempt: 1 });
  assert.equal(s.trace.at(-1)?.response.claim_generation, 1);
  assert.deepEqual(claimed.outputs, initial, "same attempt may not replace the prepared generation or raw decision");
  // Fresh state classification is explicitly covered by R02's actual shell/gh
  // suite. This fixture supplies its frozen output, not model-controlled flags.
  // The actual producer retry outputs are independently exercised in the GH
  // suite. The frozen fresh guard skips known preparation deferral and held.
  inputs["fresh-finalize-live"] = scenario.held || scenario.unresolvedBranch ? { outcome: "skipped", outputs: {} } : { outcome: "success", outputs: {
    proceed: scenario.terminal ? "false" : "true", terminal_noop: scenario.terminal ? "true" : "false",
    terminal_missing: scenario.terminal === "target_missing" ? "true" : "false", guarded_open: scenario.terminal === "guarded_open" ? "true" : "false",
    admission_retry: "false", retry_kind: "", retry_at: "", target_branch: "main", decision: JSON.stringify(decision),
    terminal_disposition: scenario.terminal || "", head_sha: sourceSha,
  } };
  if (!scenario.held && !scenario.unresolvedBranch && !scenario.terminal && (!scenario.model || scenario.model === "success")) {
    const created = await runStage(s, inputs, step(allJobs["event-review-apply"], "create-exact-review-bundle", "candidate model"));
    assert.equal(created.code, 0, created.stderr); assert.deepEqual(s.cliCommands(), ["create"]);
    const directory = join(s.root, ".artifacts/exact-review-bundle"), manifestPath = join(directory, "manifest.json");
    if (scenario.corruptBundle === "report") writeFileSync(join(directory, "review/41.md"), report + "tampered\n");
    else if (scenario.corruptBundle) {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      if (scenario.corruptBundle === "producer") manifest.workflow.run_id = "99999999";
      if (scenario.corruptBundle === "decision") manifest.review.decision_sha256 = "f".repeat(64);
      if (scenario.corruptBundle === "terminal") {
        manifest.review.live_proceeded = false;
        manifest.review.live_terminal_noop = true;
      }
      writeFileSync(manifestPath, JSON.stringify(manifest));
    }
    const validated = await execute("validate-finalize-bundle");
    assert.deepEqual(s.cliCommands(), ["create", "validate"], "actual candidate validator CLI must run");
    assert.equal(validated.code, scenario.corruptBundle ? 1 : 0, validated.stderr);
    if (scenario.corruptBundle) assert.match(validated.stderr, /does not match the trusted workflow context|file inventory does not match its manifest/);
  }
  if (scenario.secondLost) {
    await s.claim(upstreamStep("claim-exact-review-queue"), 2);
    if (scenario.unknownSecond) s.wire.unknownConflictPath = "/internal/exact-review/heartbeat";
  }
  if (scenario.headFaultAt === "second") s.wire.heartbeatHead = scenario.headFault!;
  const secondDenied = scenario.secondLost || scenario.headFaultAt === "second";
  const handoffState = secondDenied ? structuredClone((await s.state()).items[itemKey]) : undefined;
  const secondStart = s.trace.length, second = await execute("fence-finalize-handoff");
  assert.equal(s.trace.length, secondStart + 1); assert.equal(s.trace.at(-1)?.path, "/internal/exact-review/heartbeat");
  assert.deepEqual(s.trace.at(-1)?.sentRequest, heartbeat);
  if (secondDenied) {
    assert.equal(s.trace.at(-1)?.status, 409); assert.equal(s.trace.at(-1)?.sourceResponse.error, "lease_not_active");
    assert.equal(second.outputs.authorized, "false"); assert.equal(second.code, scenario.unknownSecond ? 1 : 0);
    const done = await finish();
    assert.equal(done.result.outputs.completion_required, "false"); assert.equal(done.result.outputs.cleanup_mode, "none");
    assert.equal(done.result.outputs.failed, String(Boolean(scenario.unknownSecond)));
    assert.equal(done.failed.code, scenario.unknownSecond ? 1 : 0, done.failed.stderr);
    assert.equal(s.trace.length, secondStart + 1, "handoff loss must not sign enqueue/terminal or complete the old tuple");
    assert.deepEqual((await s.state()).items[itemKey], handoffState); assert.equal((await s.publications()).length, 0);
    return { inputs, receipt, ...done };
  }
  assert.equal(second.code, 0, second.stderr); assert.equal(second.outputs.authorized, "true");
  assert.equal(s.trace.at(-1)?.status, 200);
  if (scenario.terminal) {
    const recorded = await execute("record-finalize-terminal");
    if (scenario.noAdmission) assert.notEqual(recorded.code, 0, recorded.stderr);
    else assert.equal(recorded.code, 0, recorded.stderr);
    assert.equal(s.trace.at(-1)?.path, "/internal/exact-review/lifecycle/terminal-disposition");
    assert.equal(s.trace.at(-1)?.signed, true);
    assert.deepEqual(s.trace.at(-1)?.request, { canonical_target_key: itemKey, fence_key: itemKey, revision: 1, kind: scenario.terminal });
    if (scenario.noAdmission) {
      assert.equal(s.trace.at(-1)?.status, 409);
      assert.deepEqual(s.trace.at(-1)?.response, { error: "invalid_lifecycle_terminal_disposition" });
      assert.notEqual(recorded.outputs.recorded, "true");
      assert.equal(new ExactReviewLifecycleProjectionStore(s.storage).read(itemKey, itemKey, 1), null);
      assert.equal((await s.publications()).length, 0);
    }
    else { assert.equal(s.trace.at(-1)?.status, 200); assert.equal(s.trace.at(-1)?.response.lifecycle_state, scenario.terminal); assert.equal(recorded.outputs.recorded, "true"); assert.equal(recorded.outputs.terminal_disposition, scenario.terminal); }
  } else if (!scenario.held && !scenario.unresolvedBranch && (!scenario.model || scenario.model === "success") && !scenario.corruptBundle) {
    if (scenario.deniedEnqueue) s.workerEnv.CLAWSWEEPER_WEBHOOK_SECRET = "synthetic-different-verifier-secret";
    const queued = await execute("queue-exact-review-publication");
    assert.equal(queued.code, scenario.deniedEnqueue ? 1 : 0, queued.stderr);
    const entry = s.trace.at(-1)!; assert.equal(entry.path, "/internal/exact-review/enqueue"); assert.equal(entry.signed, true);
    if (scenario.deniedEnqueue) { assert.equal(entry.status, 401); assert.deepEqual(entry.response, { error: "invalid_signature" }); }
    else {
      assert.equal(entry.status, 202); assert.equal(entry.response.queued, true);
      const repeated = await execute("queue-exact-review-publication"); assert.equal(repeated.code, 0, repeated.stderr);
      assert.equal(s.trace.at(-1)?.response.deduped, true); assert.equal((await s.publications()).length, 1);
      const publication = (await s.publications())[0].decision.publication;
      assert.deepEqual(publication.producerDecision, decision); assert.equal(publication.producerRunId, runId); assert.equal(publication.producerRunAttempt, 1);
      assert.equal(publication.claimGeneration, 1); assert.equal(publication.sourceSha, sourceSha); assert.equal(publication.artifactName, `exact-review-${runId}-1`);
    }
  }
  const done = await finish();
  const primaryFailure = Boolean(scenario.corruptBundle || scenario.deniedEnqueue || scenario.noAdmission || scenario.model === "failure" || scenario.model === "cancelled");
  assert.equal(done.result.outputs.failed, String(primaryFailure));
  assert.equal(done.result.outputs.completion_required, "true");
  assert.equal(done.failed.code, primaryFailure || scenario.completeLost || scenario.cleanupFailure ? 1 : 0, done.failed.stderr);
  if (scenario.completeLost) {
    assert.equal(done.completed?.code, 1); assert.equal(s.trace.at(-1)?.status, 409);
    assert.equal(s.trace.at(-1)?.sourceResponse.error, "lease_not_claimed"); assert.equal(s.trace.at(-1)?.response.error, "r06_unknown_conflict");
    assert.equal((await s.state()).items[itemKey].claimGeneration, 2);
  } else {
    assert.equal(done.completed?.code, 0, done.completed?.stderr); assert.equal(s.trace.at(-1)?.status, 200);
    if (scenario.held || scenario.unresolvedBranch || scenario.corruptBundle || scenario.noAdmission || scenario.deniedEnqueue || scenario.model === "failure" || scenario.model === "cancelled") {
      const pending = (await s.state()).items[itemKey]; assert.equal(pending.state, "pending"); assert.equal(pending.leaseId, undefined);
      if (scenario.held || scenario.unresolvedBranch || scenario.corruptBundle || scenario.noAdmission) {
        assert.equal(done.result.outputs.retry_kind, scenario.held || scenario.unresolvedBranch || "coordination");
        assert.ok(Date.parse(done.result.outputs.retry_at) > Date.now());
        assert.equal(pending.attempts, s.owned.attempts); assert.equal(pending.reviewFailureAttempts || 0, s.owned.reviewFailureAttempts || 0);
      }
      assert.equal(done.result.outputs.outcome, scenario.model === "cancelled" ? "cancelled" : "failure");
      assert.equal((await s.publications()).length, 0);
      if (scenario.unresolvedBranch) {
        assert.deepEqual(JSON.parse(receipt.effective_decision), s.owned.decision, "unresolved branch authority stays raw");
        assert.equal(receipt.reservation_status, ""); assert.equal(inputs["fresh-finalize-live"].outcome, "skipped");
        assert.equal(done.result.outputs.retry_at, receipt.retry_at); assert.equal(done.result.outputs.cleanup_mode, "none");
        assert.deepEqual(s.cliCommands(), [], "skipped model path cannot build or validate a bundle");
        assert.ok(s.trace.every((entry) => !entry.signed), "preparation deferral cannot sign any handoff");
        assert.deepEqual(s.trace.map((entry) => entry.path), ["claim", "heartbeat", "claim", "heartbeat", "complete"].map((path) => `/internal/exact-review/${path}`));
      }
    } else {
      assert.equal(done.result.outputs.outcome, "success"); assert.equal((await s.state()).items[itemKey], undefined);
      assert.equal(done.result.outputs.cleanup_mode, scenario.terminal ? "none" : "expire");
      assert.equal(s.trace.at(-1)?.request.completion_kind, undefined, "producer completion must not claim publisher delivery");
    }
    if (scenario.terminal && !scenario.noAdmission) {
      assert.equal(s.trace.at(-1)?.request.lifecycle_terminal_disposition, scenario.terminal);
      const row = new ExactReviewLifecycleProjectionStore(s.storage).read(itemKey, itemKey, 1); assert.ok(row);
      assert.equal(lifecycleState(row), scenario.terminal); assert.deepEqual(row.canonicalReceipts, []);
    }
  }
  return { inputs, receipt, ...done };
}

test("R06-B candidate actual trusted finalizer against real Worker/Queue", async (t) => {
  // All lookups are inside the candidate parent. Missing topology does not hide
  // independent real-source controls and is not a behavioral rejection result.
  const allJobs = jobs(candidate), finalize = allJobs["event-review-finalize"];
  assert.ok(finalize, "missing finalizer topology: event-review-finalize");
  for (const id of ["finalize-preparation-context", "fence-finalize-authority", "claim-finalize-authority", "validate-finalize-bundle", "fence-finalize-handoff", "queue-exact-review-publication", "record-finalize-terminal", "exact-review-generation-result", "complete-exact-review-queue", "fail-finalize"]) step(finalize, id, "candidate event-review-finalize");
  const cases: Array<[string, Scenario]> = [
    ["accepted publication replay remains one durable item", {}],
    ["trailing queue URL preserves exact routes for signed enqueue and completion", { trailingQueueUrl: true }],
    ["trailing queue URL preserves exact routes for signed terminal and completion", { trailingQueueUrl: true, terminal: "target_closed" }],
    ["effective branch correction preserves raw Queue authority", { rawBranch: "41" }],
    ["unresolved preparation branch defers with raw authority and releases the lease", { rawBranch: "41", unresolvedBranch: "coordination" }],
    ["legitimate unclaimed receipt is a no-op", { unclaimed: true }],
    ["first real heartbeat loses without taking over the newer generation", { firstLost: true }],
    ["unknown first-fence conflict cannot become a safe no-op", { firstLost: true, unknownFirst: true }],
    ["second real heartbeat loses after validation without handing off the old generation", { secondLost: true }],
    ["unknown second-fence conflict remains failure without completing the old generation", { secondLost: true, unknownSecond: true }],
    ["held coordination does not spend ordinary failures", { held: "coordination" }],
    ["trusted throttle does not spend ordinary failures", { held: "throttle" }],
    ["platform cancelled preserves cancelled completion", { model: "cancelled" }],
    ["platform failure cannot adopt model terminal claims", { model: "failure" }],
    ["Worker HMAC rejection cannot become success", { deniedEnqueue: true }],
    ["unknown completion conflict stays a failure", { completeLost: true }],
    ["cleanup error does not retract accepted publication, but fails final gate", { cleanupFailure: true }],
    ...(["report", "producer", "decision", "terminal"] as const).map((corruptBundle): [string, Scenario] => [`real validator rejects ${corruptBundle} tampering before enqueue`, { corruptBundle }]),
    ...(["target_closed", "target_missing", "guarded_open", "policy_noop"] as const).map((terminal): [string, Scenario] => [`normal manual admission records ${terminal} before completion`, { terminal }]),
    ["missing lifecycle admission cannot become terminal success", { terminal: "target_closed", noAdmission: true }],
  ];
  for (const [name, scenario] of cases) await t.test(name, async () => {
    await withSession(async (s) => { await candidateScenario(s, allJobs, scenario); }, !scenario.noAdmission, { ...decision, targetBranch: scenario.rawBranch || "main" }, scenario.trailingQueueUrl);
  });
  for (const [name, scenario] of [
    ["normally admitted PR carries source head through both fences and publication", {}],
    ...(["first", "second"] as const).flatMap((headFaultAt) => (["omit", "wrong"] as const).map((headFault): [string, Scenario] => [`real Queue rejects ${headFault} PR head at ${headFaultAt} fence`, { headFaultAt, headFault }])),
  ] as Array<[string, Scenario]>) await t.test(name, async () => {
    await withSession(async (s) => { await candidateScenario(s, allJobs, scenario); }, true, prDecision);
  });
  for (const [name, mutateReceipt] of [
    ["effective policy", (r: Outputs) => { r.effective_decision = JSON.stringify({ ...decision, publicationPolicy: "ordinary" }); }],
    ["effective target", (r: Outputs) => { r.effective_decision = JSON.stringify({ ...decision, itemNumber: 42 }); }],
    ["invalid posted owner", (r: Outputs) => { r.reservation_owner = "invalid owner"; }],
    ["malformed trusted retry", (r: Outputs) => { r.retry_kind = "throttle"; r.retry_at = "not-a-timestamp"; }],
  ] as Array<[string, (receipt: Outputs) => void]>) await t.test(`context rejects ${name} before first Queue operation`, async () => {
    await withSession(async (s) => { await candidateScenario(s, allJobs, { mutateReceipt }); }, true);
  });
  for (const [name, mutateReceipt] of [
    ["unresolved branch without typed retry", (r: Outputs) => { r.retry_kind = ""; r.retry_at = ""; }],
    ["unresolved branch with a posted reservation", (r: Outputs) => { r.reservation_status = "posted"; r.reservation_owner = `github-run-${runId}-1`; r.reservation_comment_id = "41010"; r.reservation_head_sha = sourceSha; }],
    ["missing effective decision is not a retry fallback", (r: Outputs) => { r.effective_decision = ""; }],
  ] as Array<[string, (receipt: Outputs) => void]>) await t.test(`context rejects ${name}`, async () => {
    await withSession(async (s) => { await candidateScenario(s, allJobs, { rawBranch: "41", unresolvedBranch: "coordination", mutateReceipt }); }, true, { ...decision, targetBranch: "41" });
  });
});
