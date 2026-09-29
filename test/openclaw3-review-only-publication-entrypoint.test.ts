import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import YAML from "yaml";
import worker, { ExactReviewQueue } from "../dashboard/worker.ts";
import { createExactReviewAdmissionHarness, MemoryDurableNamespace, jsonResponse, signedStateAppendRequest, ExactReviewLifecycleProjectionStore, lifecycleState } from "./dashboard-worker-harness.ts";
import { publicationGithubFixture } from "./helpers/openclaw3-publication-gh.ts";

// Actual upstream/candidate workflow bodies -> real CLI -> stock gh transport,
// actual Worker/Queue/SQLite and canonical receipts. Model report, Actions
// checkout/build/mint/download and empty initial hydration are controlled inputs.
// This is NOT an Actions runner, live deployment, or direct-lifecycle recovery.
const source = process.cwd(), repo = "openclaw/openclaw", number = 41;
const key = `${repo}#${number}`, producerRun = "51001", publisherRun = "61001";
const sourceSha = "a".repeat(40), secret = "synthetic-r06c-secret";
const candidate = "candidate/receiver/.github/workflows/sweep.yml";
const upstream = "fixtures/upstream-16505cf/.github/workflows/sweep.yml";
type Outputs = Record<string, string>;
type Step = { id?: string; name?: string; run?: string; env?: Record<string, unknown>; if?: unknown };
type Stage = { outputs: Outputs; outcome: string };
const normalize = (v: string) => v.replace(/\s+/g, "");
function publisher(path: string): Step[] { return YAML.parse(readFileSync(path, "utf8")).jobs["event-review-publish"].steps; }
function getStep(steps: Step[], id: string): Step {
  const result = steps.find((entry) => entry.id === id);
  assert.ok(result?.run, `missing publisher topology: ${id}`); return result;
}
function parseOutputs(raw: string): Outputs {
  return Object.fromEntries(raw.split("\n").filter(Boolean).map((line) => {
    const split = line.indexOf("="); assert.ok(split > 0, "HARNESS_ERROR: unsupported Actions output encoding");
    return [line.slice(0, split), line.slice(split + 1)];
  }));
}
type QueueTrace = { path: string; request: any; status: number; response: any; sourceResponse?: any; injected?: boolean };
type CommandDiagnostic = { stage: string; code: number | null; stdout: string; stderr: string; outputs: Outputs };
// Failure-only diagnostics: these are synthetic runtime facts, never env,
// request headers, full reports/comments, or private signing material.
function diagnosticText(value: unknown, limit: number) {
  const text = String(value ?? "")
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, "[redacted private key]")
    .replaceAll(secret, "[redacted synthetic secret]")
    .replace(/synthetic-(?:only|read)-token/g, "[redacted synthetic token]")
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+)\b/g, "[redacted token]")
    .replace(/\b(?:Bearer|token)\s+[A-Za-z0-9._~+\/-]+=*/gi, "[redacted authorization]")
    .replace(/\bsha256=[a-f0-9]{64}\b/gi, "[redacted signature]");
  return text.length > limit ? `[tail; ${text.length - limit} chars omitted]\n${text.slice(-limit)}` : text;
}
function diagnosticFields(value: any, keys: string[]) {
  return Object.fromEntries(keys.filter((key) => ["string", "number", "boolean"].includes(typeof value?.[key])).map((key) => [key, diagnosticText(value[key], 180)]));
}
function attachDiagnostics(error: unknown, diagnostics: string): never {
  // Report the already bounded/redacted payload independently of the reporter's
  // rendering of a previously created AssertionError, then preserve that error.
  process.stderr.write(`${diagnostics}\n`);
  throw error;
}
async function session(pullRequest = false, competingReviewLease = false) {
  const root = mkdtempSync(join(tmpdir(), "oc3-pub-")), bin = join(root, "bin");
  mkdirSync(bin); mkdirSync(join(root, "scripts")); mkdirSync(join(root, "artifacts/event"), { recursive: true });
  cpSync(join(source, "dist"), join(root, "dist"), { recursive: true });
  cpSync(join(source, "config"), join(root, "config"), { recursive: true });
  // Real apply-decisions eagerly reads its upstream proof prompt even in comment-only mode.
  cpSync(join(source, "prompts"), join(root, "prompts"), { recursive: true });
  cpSync(join(source, "package.json"), join(root, "package.json"));
  cpSync(join(source, "scripts/control-plane-curl.sh"), join(root, "scripts/control-plane-curl.sh"));
  cpSync(join(source, "scripts/control-plane-curl.sh"), join(root, "control-plane-curl.sh"));
  symlinkSync(join(source, "node_modules"), join(root, "node_modules"), "dir");
  const gh = publicationGithubFixture(number, pullRequest);
  const admission = createExactReviewAdmissionHarness((_repo, _number, kind) => jsonResponse(kind === "pull_request" ? gh.pulls.get(number) : gh.item), {
    targetRepository: () => jsonResponse({ full_name: repo, private: false, visibility: "public", default_branch: "main" }),
    targetComments: () => jsonResponse(gh.comments.get(number)),
    producerRun: (runId, attempt) => jsonResponse({ id: runId, run_attempt: attempt || 1, status: "completed", conclusion: "success", head_sha: sourceSha }),
  });
  const storage = admission.storage;
  const queue = new ExactReviewQueue({ storage }, {
    hostedTargetPredicate: () => true, hostedPublicTargetProbe: async () => "public",
    EXACT_REVIEW_MANUAL_PUBLICATION_ENABLED: "1", EXACT_REVIEW_HOSTED_TARGET_ADMISSION_MAX_STALE_MS: "0",
    CLAWSWEEPER_APP_CLIENT_ID: "Iv23test", CLAWSWEEPER_APP_PRIVATE_KEY: generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } }).privateKey,
    EXACT_REVIEW_DISPATCH_DEBOUNCE_MS: "0", EXACT_REVIEW_QUEUE_MAX_CONCURRENT: "1",
    EXACT_REVIEW_PUBLICATION_BATCHING_ENABLED: "0", EXACT_REVIEW_DIRECT_PUBLICATION_ENABLED: "1",
  }, () => 0);
  const workerEnv = { EXACT_REVIEW_QUEUE: new MemoryDurableNamespace(queue), CLAWSWEEPER_WEBHOOK_SECRET: secret, hostedTargetPredicate: () => true, hostedPublicTargetProbe: async () => "public" };
  const queueTrace: QueueTrace[] = [], errors: string[] = [];
  const controls = { canonicalFailure: false, corruptReceipt: "" as "" | "canonical-receipt" | "router-receipt" };
  const commands: CommandDiagnostic[] = [];
  function diagnostics() {
    const outputKeys = ["claimed", "remote_tuple_verified", "routable_sync_verified", "outcome", "completion_kind", "reason_code", "error_fingerprint", "retry_at", "canonical_outcome", "receipt_outcome"];
    const responseKeys = ["ok", "claimed", "accepted", "outcome", "reason", "error", "message", "completion_kind", "reason_code", "claim_generation", "lease_revision"];
    const trace = {
      gh: gh.trace.slice(-10).map(({ method, path, readOnlyGraphql }) => ({ method, path: diagnosticText(path, 180), ...(readOnlyGraphql ? { readOnlyGraphql } : {}) })),
      queue: queueTrace.slice(-8).map((entry) => ({ path: diagnosticText(entry.path, 180), status: entry.status, injected: entry.injected || false,
        request: diagnosticFields(entry.request, ["item_key", "run_id", "run_attempt", "lease_revision", "claim_generation", "outcome", "completion_kind", "reason_code"]),
        response: diagnosticFields(entry.response, responseKeys), sourceResponse: diagnosticFields(entry.sourceResponse, responseKeys) })),
      commands: commands.slice(-2).map((entry) => ({ stage: diagnosticText(entry.stage, 120), code: entry.code,
        stdout: diagnosticText(entry.stdout, 2200), stderr: diagnosticText(entry.stderr, 1000), outputs: diagnosticFields(entry.outputs, outputKeys) })),
    };
    const body = JSON.stringify(trace, null, 2);
    return `R06-C synthetic runtime diagnostics (bounded):\n${body.length > 16000 ? body.slice(0, 16000) + "\n[diagnostics truncated]" : body}`;
  }
  async function post(route: string, body: any, signed = false) {
    const request = signed ? signedStateAppendRequest(`/internal/exact-review/${route}`, body, secret) : new Request(`https://manual-queue.invalid/internal/exact-review/${route}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const response = await worker.fetch(request, workerEnv); const value = await response.json() as any;
    assert.ok(response.ok, `${route}: ${response.status} ${JSON.stringify(value)}`); return value;
  }
  const server = createServer(async (request, response) => {
    try {
      assert.ok(request.url?.startsWith("/queue/internal/"), "HARNESS_ERROR: unexpected coordinator path");
      const path = request.url!.slice(6), chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const bytes = Buffer.concat(chunks); assert.ok(bytes.byteLength < 2 * 1024 * 1024);
      const body = bytes.length ? JSON.parse(bytes.toString()) : {};
      assert.ok(/^\/internal\/(?:exact-review\/(?:claim|complete|heartbeat|publication-authority|publication-batch-results|github-etag-cache\/(?:lookup|store|confirm)|github-read-model\/item|lifecycle\/(?:canonical-receipt|router-receipt))|state\/(?:github-read-model\/(?:item|comments|activity|repair)|records\/openclaw-openclaw\/items\/41))(?:\?.*)?$/.test(path), `HARNESS_ERROR: unallowed coordinator route ${path}`);
      if (controls.canonicalFailure && path.endsWith("/publication-batch-results")) {
        const value = { error: "synthetic_state_contention" };
        queueTrace.push({ path, request: body, status: 503, response: value, injected: true });
        response.writeHead(503, { "content-type": "application/json" }); response.end(JSON.stringify(value)); return;
      }
      const headers = Object.fromEntries(Object.entries(request.headers).filter(([name]) => !["host", "connection", "content-length", "transfer-encoding"].includes(name))) as Record<string, string>;
      const result = await worker.fetch(new Request(`https://manual-queue.invalid${path}`, { method: request.method, headers, ...(bytes.length ? { body: bytes } : {}) }), workerEnv);
      const sourceResponse = await result.json() as any;
      const corrupt = controls.corruptReceipt && path.endsWith(`/lifecycle/${controls.corruptReceipt}`);
      if (corrupt) assert.equal(result.status, 200, "receipt fault requires an actual accepted source response");
      const value = corrupt ? { ...sourceResponse, ok: false } : sourceResponse;
      queueTrace.push({ path, request: body, status: result.status, response: value, sourceResponse, ...(corrupt ? { injected: true } : {}) });
      response.writeHead(result.status, { "content-type": "application/json" }); response.end(JSON.stringify(value));
    } catch (error) {
      errors.push(String(error)); response.writeHead(500, { "content-type": "application/json" }); response.end(JSON.stringify({ error: "HARNESS_ERROR" }));
    }
  });
  let sequence = 0;
  try {
    await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
    const address = server.address(); assert.ok(address && typeof address !== "string");
    const socket = join(root, "gh.sock"); await new Promise<void>((ready) => gh.server.listen(socket, ready));
    const stockGh = execFileSync("which", ["gh"], { encoding: "utf8" }).trim(); assert.ok(stockGh.startsWith("/"));
    symlinkSync(stockGh, join(bin, "gh"));
    const transport = join(source, "test/helpers/openclaw3-publication-transport.mjs");
    writeFileSync(join(bin, "curl"), `#!/usr/bin/env bash\nargs=()\nfor arg in "$@"; do\n  if [[ "$arg" == --data ]]; then arg=--data-binary; fi\n  args+=("$arg")\ndone\nexec '${process.execPath}' '${transport}' curl "\${args[@]}"\n`, { mode: 0o755 });
    mkdirSync(join(root, "gh-config")); writeFileSync(join(root, "gh-config/config.yml"), `http_unix_socket: ${JSON.stringify(socket)}\n`);
    const runtime: Outputs = {
      PATH: `${bin}:${process.env.PATH}`, HOME: root, RUNNER_TEMP: root, TMPDIR: root,
      GITHUB_WORKSPACE: root, GITHUB_REPOSITORY: "openclaw/clawsweeper", GITHUB_SHA: sourceSha, GITHUB_RUN_ID: publisherRun, GITHUB_RUN_ATTEMPT: "1",
      GH_CONFIG_DIR: join(root, "gh-config"), GH_HOST: "proof.invalid", GH_ENTERPRISE_TOKEN: "synthetic-only-token", GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1", GH_NO_EXTENSION_UPDATE_NOTIFIER: "1",
      NODE_OPTIONS: `--import=${transport}`, MANUAL_PUBLICATION_LOOPBACK: `http://127.0.0.1:${address.port}`,
      CLAWSWEEPER_ACTION_LEDGER_DISABLED: "1", CLAWSWEEPER_GH_RETRY_ATTEMPTS: "1", CI: "true",
      COREPACK_HOME: process.env.COREPACK_HOME || join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "node/corepack"), COREPACK_ENABLE_NETWORK: "0", COREPACK_ENV_FILE: "0", COREPACK_ENABLE_DOWNLOAD_PROMPT: "0", COREPACK_DEFAULT_TO_LATEST: "0",
    };
    async function command(command: string, args: string[], env: Outputs = {}, stage = "bootstrap") {
      const output = join(root, `outputs-${++sequence}`); writeFileSync(output, "");
      const child = spawn(command, args, { cwd: root, detached: true, env: { ...runtime, GITHUB_OUTPUT: output, ...env }, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "", stderr = "", expired = false;
      const kill = () => { if (child.pid) { try { process.kill(-child.pid, "SIGKILL"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; } } };
      child.stdout.on("data", (v) => { stdout += v; if (stdout.length > 4 * 1024 * 1024) kill(); });
      child.stderr.on("data", (v) => { stderr += v; if (stderr.length > 4 * 1024 * 1024) kill(); });
      const timer = setTimeout(() => { expired = true; kill(); }, 45_000);
      const code = await new Promise<number | null>((accept, reject) => { child.once("error", reject); child.once("close", accept); }).finally(() => { clearTimeout(timer); kill(); });
      const diagnostic: CommandDiagnostic = { stage, code, stdout, stderr, outputs: {} };
      commands.push(diagnostic); if (commands.length > 2) commands.shift();
      assert.equal(expired, false, "HARNESS_ERROR: timeout is not product rejection"); assert.notEqual(code, null, "HARNESS_ERROR: killed child");
      assert.deepEqual(errors, []); gh.assertNoForbidden();
      const outputs = parseOutputs(readFileSync(output, "utf8")); diagnostic.outputs = outputs;
      return { code, stdout, stderr, outputs };
    }
    const requested = { targetRepo: repo, targetBranch: "main", itemNumber: number, itemKind: pullRequest ? "pull_request" : "issue", sourceEvent: pullRequest ? "pull_request" : "issues", sourceAction: "manual_explicit_review", publicationPolicy: "record_comment_only", supersedesInProgress: false, ...(pullRequest ? { sourceHeadSha: gh.pulls.get(number).head.sha } : {}) };
    await post("enqueue", { delivery_id: "r06c-producer-admission", decision: requested }, true);
    await queue.alarm();
    const producerItem = (await storage.get("exact-review-queue")).items[key]; assert.equal(producerItem.state, "dispatching");
    const producerTuple = { item_key: key, lease_id: producerItem.leaseId, lease_revision: producerItem.leaseRevision, run_id: producerRun, run_attempt: 1 };
    const producer = await post("claim", producerTuple); assert.equal(producer.claimed, true);
    const ownerEnv = { GH_TOKEN: "synthetic-only-token", CLAWSWEEPER_WEBHOOK_SECRET: secret, EXACT_REVIEW_QUEUE_URL: "https://manual-queue.invalid", GITHUB_RUN_ID: producerRun, EXACT_REVIEW_ITEM_KEY: key, EXACT_REVIEW_LEASE_ID: producerTuple.lease_id, EXACT_REVIEW_LEASE_REVISION: String(producer.lease_revision), EXACT_REVIEW_CLAIM_GENERATION: String(producer.claim_generation), EXACT_REVIEW_DECISION: JSON.stringify(producer.decision), TARGET_REPO: repo, ITEM_NUMBER: String(number), EXACT_EVENT_PUBLICATION: "true" };
    const reserved = await command(process.execPath, ["dist/clawsweeper.js", "reserve-review-lease", "--target-repo", repo, "--item-number", String(number), "--review-timeout-ms", "60000"], ownerEnv);
    assert.equal(reserved.code, 0, reserved.stderr); const lease = JSON.parse(reserved.stdout.trim()); assert.equal(lease.status, "posted");
    const { itemSourceRevisionSha256ForTest } = await import(pathToFileURL(join(source, "dist/clawsweeper.js")).href);
    const sourceRevision = itemSourceRevisionSha256ForTest(gh.item, gh.comments.get(number));
    let cursor: string | undefined;
    if (pullRequest) {
      const { reviewedPrActivityCursorV2Query, reviewedPrActivityCursorsV2FromGraphql } = await import(pathToFileURL(join(source, "dist/review-activity-cursor.js")).href);
      const activity = await command("gh", ["api", "graphql", "-f", `query=${reviewedPrActivityCursorV2Query("openclaw", "openclaw", [number])}`]);
      assert.equal(activity.code, 0, activity.stderr); const parsed = reviewedPrActivityCursorsV2FromGraphql(JSON.parse(activity.stdout), [number]);
      assert.deepEqual(parsed.failures, {}); cursor = parsed.cursors[String(number)]; assert.ok(cursor);
    }
    const fields = { number, repository: repo, type: producer.decision.itemKind, title: gh.item.title, reviewed_at: new Date().toISOString(), item_updated_at: gh.item.updated_at, state_at_review: "open", review_status: "complete", local_checkout_access: "verified", local_checkout_access_source: "runner_preflight_v1", decision: "keep_open", close_reason: "none", action_taken: "kept_open", confidence: "high", triage_priority: "P2", labels: '["bug"]', item_source_revision: sourceRevision, ...(cursor ? { review_activity_cursor: cursor } : {}), item_snapshot_hash: "synthetic-reviewed-snapshot", ...(pullRequest ? { pull_head_sha: gh.pulls.get(number).head.sha } : {}), review_lease_owner: lease.owner, review_lease_comment_id: lease.commentId, publication_policy: "record_comment_only", work_candidate: "queue_fix_pr", work_confidence: "high", work_validation: '["pnpm run check"]', work_likely_files: '["src/clawsweeper.ts"]', item_category: "bug", reproduction_status: "reproduced", reproduction_confidence: "high", requires_new_feature: "false", requires_new_config_option: "false", requires_product_decision: "false" };
    const report = `---\n${Object.entries(fields).map(([k,v]) => `${k}: ${v}`).join("\n")}\n---\n\n## Summary\n\nBounded synthetic review.\n`;
    const reportPath = join(root, "artifacts/event/41.md"); writeFileSync(reportPath, report);
    const bundleEnv = { ...ownerEnv, EXACT_REVIEW_BUNDLE_DIR: ".artifacts/exact-review-bundle", EXACT_REVIEW_REPORT_PATH: reportPath, EXACT_REVIEW_GENERATION_ATTEMPT: "1", EXACT_REVIEW_PRODUCER_JOB: "event-review-apply", EXACT_REVIEW_PRODUCER_RUN_ID: producerRun, EXACT_REVIEW_SOURCE_SHA: sourceSha, EXACT_REVIEW_PROTOCOL_VERSION: "2", EXACT_REVIEW_TARGET_REPO: repo, EXACT_REVIEW_TARGET_BRANCH: "main", EXACT_REVIEW_ITEM_NUMBER: String(number), EXACT_REVIEW_ITEM_KIND: producer.decision.itemKind, EXACT_REVIEW_LIVE_PROCEEDED: "true", EXACT_REVIEW_LIVE_TERMINAL_NOOP: "false", EXACT_REVIEW_LIVE_TERMINAL_MISSING: "false", EXACT_REVIEW_LIVE_GUARDED_OPEN: "false" };
    const created = await command(process.execPath, ["dist/repair/exact-review-bundle-cli.js", "create"], bundleEnv); assert.equal(created.code, 0, created.stderr);
    // Controlled GH state after the separately accepted R06-B exact-owner expiry.
    // Use the production marker helper, preserve identity/body, never forge a
    // completed review comment or a Queue/lifecycle fact.
    const { expireReviewStartStatusLease } = await import(pathToFileURL(join(source, "dist/clawsweeper-review-comment-state.js")).href);
    const leaseComment = gh.comments.get(number)!.find((entry) => entry.id === lease.commentId); assert.ok(leaseComment);
    leaseComment.body = expireReviewStartStatusLease(leaseComment.body, "2000-01-01T00:00:00.000Z", number);
    let blockingReviewLease: { owner: string | null; commentId: number | null; expiresAt: string } | undefined;
    if (competingReviewLease) {
      // Same-owner active leases are adoptable by their matching report. Create
      // a real competing standalone reservation; keep the original report and
      // bundle tuple intact. This preparation is outside publisher trace counts.
      const reserved = await command(process.execPath, ["dist/clawsweeper.js", "reserve-review-lease", "--target-repo", repo, "--item-number", String(number), "--review-timeout-ms", "60000"], { GH_TOKEN: "synthetic-only-token", GITHUB_RUN_ID: "51002" }, "reserve competing review lease");
      assert.equal(reserved.code, 0, reserved.stderr);
      const acquired = JSON.parse(reserved.stdout.trim()); assert.equal(acquired.status, "posted"); assert.notEqual(acquired.owner, lease.owner);
      assert.equal(acquired.headSha, pullRequest ? gh.pulls.get(number).head.sha : sourceRevision);
      assert.equal(itemSourceRevisionSha256ForTest(gh.item, gh.comments.get(number)), sourceRevision);
      const { freshExactHeadReviewStartLease } = await import(pathToFileURL(join(source, "dist/repair/comment-router-core.js")).href);
      const active = freshExactHeadReviewStartLease({ comments: gh.comments.get(number), itemNumber: number, headSha: acquired.headSha, trustedAuthors: new Set(["clawsweeper[bot]"]) });
      assert.ok(active); assert.equal(active.owner, acquired.owner); assert.equal(active.commentId, acquired.commentId);
      assert.ok(Date.parse(active.expiresAt) > Date.now()); blockingReviewLease = active;
    }
    const publication = { artifactName: `exact-review-${producerRun}-1`, producerRunId: producerRun, producerRunAttempt: 1, sourceSha, itemKey: key, protocolVersion: 2, leaseRevision: producer.lease_revision, claimGeneration: producer.claim_generation, liveProceeded: true, liveTerminalNoop: false, liveTerminalMissing: false, liveGuardedOpen: false, producerDecision: producer.decision };
    const enqueued = await post("enqueue", { delivery_id: `publisher:${producerRun}:1`, decision: { ...producer.decision, sourceAction: "exact_review_artifact_publish", supersedesInProgress: false, publication } }, true); assert.equal(enqueued.queued, true);
    await post("complete", { ...producerTuple, claim_generation: producer.claim_generation, outcome: "success" });
    await queue.alarm();
    const publicationKey = `${key}@publish:${producerRun}:1`, publicationItem = (await storage.get("exact-review-queue")).items[publicationKey];
    assert.ok(publicationItem); assert.equal(publicationItem.state, "dispatching", "real Queue must dispatch the publisher");
    const dispatch = { item_key: publicationKey, lease_id: publicationItem.leaseId, lease_revision: publicationItem.leaseRevision, run_id: publisherRun, run_attempt: 1 };
    gh.trace.length = 0; queueTrace.length = 0;
    const state = async () => await storage.get("exact-review-queue");
    return { root, gh, queue, storage, post, command, state, queueTrace, controls, dispatch, producer, producerTuple, publicationKey, report, reportPath, diagnostics, blockingReviewLease,
      close: async () => { server.closeAllConnections(); gh.server.closeAllConnections(); await Promise.all([new Promise<void>((done) => server.close(() => done())), new Promise<void>((done) => gh.server.close(() => done()))]); admission.restore(); storage.sql.close(); rmSync(root, { recursive: true, force: true }); },
    };
  } catch (error) {
    server.closeAllConnections(); gh.server.closeAllConnections(); server.close(); gh.server.close(); admission.restore(); storage.sql.close(); rmSync(root, { recursive: true, force: true }); attachDiagnostics(error, diagnostics());
  }
}
type Session = Awaited<ReturnType<typeof session>>;
function scenarioRunner(s: Session, steps: Step[]) {
  const stages: Record<string, Stage> = Object.fromEntries(steps.filter((entry) => entry.id).map((entry) => [entry.id!, { outputs: {}, outcome: "skipped" }]));
  for (const id of ["source-checkout", "setup-publish-pnpm", "setup-state", "download-exact-review-bundle"]) stages[id] = { outputs: {}, outcome: "success" };
  for (const id of ["reviewer-token", "target-write-token"]) stages[id] = { outputs: { token: "synthetic-only-token" }, outcome: "success" };
  // Inputs only for legacy upstream branches excluded by this manual case.
  for (const id of ["legacy-exact-artifact", "fold-exact-live-proof", "queue-source-drift-review", "queue-deferred-verdict-router", "replay-direct-lifecycle"]) stages[id] ||= { outputs: {}, outcome: "skipped" };
  const values = (jobStatus = "success"): Outputs => {
    const context = stages["publication-context"].outputs;
    const map: Outputs = {
      "github.event.client_payload.queue_claim.item_key": s.dispatch.item_key,
      "github.event.client_payload.queue_lease_id": s.dispatch.lease_id,
      "github.event.client_payload.queue_claim.lease_revision": String(s.dispatch.lease_revision),
      "vars.CLAWSWEEPER_EXACT_REVIEW_QUEUE_URL || 'https://clawsweeper.openclaw.ai'": "https://manual-queue.invalid",
      "vars.CLAWSWEEPER_EXACT_REVIEW_QUEUE_URL": "https://manual-queue.invalid",
      "github.run_attempt": "1", "github.run_id": publisherRun, "github.repository": "openclaw/clawsweeper", "github.sha": sourceSha,
      "github.token": "synthetic-read-token", "job.status": jobStatus,
      "secrets.CLAWSWEEPER_WEBHOOK_SECRET": secret,
      "steps.publication-context.outputs.target_repo == 'openclaw/openclaw' && github.token || ''": "synthetic-read-token",
      "(fromJSON(steps.publication-context.outputs.decision).sourceAction == 'failed_review_shard_recovery' || fromJSON(steps.publication-context.outputs.decision).publicationPolicy == 'record_comment_only') && 'true' || 'false'": "true",
      "steps.exact-review-publication-result.outputs.outcome || 'failure'": stages["exact-review-publication-result"]?.outputs.outcome || "failure",
    };
    for (const [id, stage] of Object.entries(stages)) {
      map[`steps.${id}.outcome`] = stage.outcome;
      for (const [key, value] of Object.entries(stage.outputs)) map[`steps.${id}.outputs.${key}`] = value;
    }
    const d = context.decision ? JSON.parse(context.decision) : {};
    for (const key of ["sourceAction", "publicationPolicy", "itemKind"]) map[`fromJSON(steps.publication-context.outputs.decision).${key}`] = String(d[key] || "");
    return map;
  };
  function render(value: unknown, jobStatus: string) {
    const known = Object.fromEntries(Object.entries(values(jobStatus)).map(([k,v]) => [normalize(k), v]));
    return String(value).replace(/\$\{\{([\s\S]*?)\}\}/g, (_match, expression: string) => {
      const normalized = normalize(expression);
      if (Object.hasOwn(known, normalized)) return known[normalized];
      const optional = normalized.match(/^steps\.([A-Za-z0-9_-]+)\.outputs\.([A-Za-z0-9_]+)$/);
      if (optional && Object.hasOwn(stages, optional[1])) return stages[optional[1]].outputs[optional[2]] || "";
      assert.fail(`HARNESS_ERROR: unfrozen publisher expression ${expression}`);
    });
  }
  async function run(step: Step, jobStatus = "success") {
    assert.ok(step.run);
    const env = Object.fromEntries(Object.entries(step.env || {}).map(([name, value]) => [name, render(value, jobStatus)]));
    const result = await s.command("/bin/bash", ["--noprofile", "--norc", "-e", "-o", "pipefail", "-c", render(step.run, jobStatus)], env, step.id || step.name || "workflow step");
    if (step.id) stages[step.id] = { outputs: result.outputs, outcome: result.code === 0 ? "success" : "failure" };
    return result;
  }
  const execute = (id: string, status = "success") => run(getStep(steps, id), status);
  async function prepare() {
    const claimed = await execute("publication-context"); assert.equal(claimed.code, 0, claimed.stderr); assert.equal(claimed.outputs.claimed, "true");
    assert.equal(claimed.outputs.publisher_item_key, s.publicationKey); assert.equal(claimed.outputs.item_key, key);
    assert.equal(claimed.outputs.publisher_lease_id, s.dispatch.lease_id); assert.notEqual(claimed.outputs.publisher_lease_id, s.producerTuple.lease_id);
    assert.deepEqual(JSON.parse(claimed.outputs.decision), s.producer.decision);
    const validated = await execute("validate-exact-review-bundle"); assert.equal(validated.code, 0, validated.stderr);
    const stage = steps.find((entry) => entry.id === "stage-validated-exact-review-artifact" || entry.name === "Stage validated exact review artifact");
    assert.ok(stage?.run, "missing publisher topology: stage validated artifact");
    // Producer diagnostics are not present in the trusted staged directory.
    rmSync(join(s.root, "artifacts/event"), { recursive: true, force: true });
    const staged = await run(stage); assert.equal(staged.code, 0, staged.stderr);
    assert.equal(readFileSync(s.reportPath, "utf8"), s.report);
    return claimed.outputs;
  }
  async function finish(published: Awaited<ReturnType<typeof execute>>, expectSuccess: boolean, options: { receiptFailed?: boolean; completionLost?: boolean } = {}) {
    if (!options.receiptFailed && published.code === 0 && published.outputs.remote_tuple_verified === "true") {
      const canonical = await execute("record-fallback-canonical-lifecycle-receipt"); assert.equal(canonical.code, 0, canonical.stderr);
      const noRouter = await execute("record-no-router-lifecycle-receipt"); assert.equal(noRouter.code, 0, noRouter.stderr);
    }
    const result = await execute("exact-review-publication-result", published.code === 0 && !options.receiptFailed ? "success" : "failure");
    assert.equal(result.code, 0, result.stderr); assert.equal(result.outputs.outcome, expectSuccess ? "success" : "failure");
    if (expectSuccess) { assert.equal(result.outputs.completion_kind, "published"); assert.equal(result.outputs.reason_code, "publication_applied"); }
    const completed = await execute("complete-exact-review-publication", expectSuccess ? "success" : "failure");
    const completion = s.queueTrace.at(-1)!; assert.equal(completion.path, "/internal/exact-review/complete");
    assert.equal(completion.request.item_key, s.publicationKey); assert.equal(completion.request.lease_id, s.dispatch.lease_id);
    assert.equal(completion.request.claim_generation, Number(stages["publication-context"].outputs.publisher_claim_generation));
    assert.equal(completion.request.run_id, publisherRun); assert.equal(completion.request.outcome, result.outputs.outcome);
    assert.equal(completion.request.completion_kind, result.outputs.completion_kind); assert.equal(completion.request.reason_code, result.outputs.reason_code);
    const failed = !expectSuccess || completed.code !== 0;
    const gate = steps.find((entry) => entry.id === "fail-exact-review-publication" || entry.name === "Fail unsuccessful exact review publication");
    assert.ok(gate?.run, "missing publisher failure gate");
    // Fixed upstream gate is conditionally exit 1; its if is independently
    // covered by the frozen topology suite. Execute the actual body on failure.
    if (failed) { const failure = await run(gate, "failure"); assert.notEqual(failure.code, 0, "publication failure cannot disappear at final gate"); }
    if (options.completionLost) {
      assert.notEqual(completed.code, 0); assert.equal(completion.status, 409);
      assert.equal((await s.state()).items[s.publicationKey].claimedRunAttempt, 2);
    } else if (expectSuccess) {
      assert.equal(completed.code, 0, completed.stderr); assert.equal(completion.status, 200);
      assert.equal((await s.state()).items[s.publicationKey], undefined);
      const lifecycle = new ExactReviewLifecycleProjectionStore(s.storage).read(key, s.publicationKey, s.dispatch.lease_revision);
      assert.ok(lifecycle); assert.equal(lifecycleState(lifecycle), "completed");
      assert.ok(lifecycle.canonicalReceipts.some((receipt) => ["accepted", "deduped"].includes(receipt.outcome)));
      assert.equal(lifecycle.routerReceipt?.outcome, "not_required");
    }
    return { result, completed, completion };
  }
  return { stages, prepare, execute, finish };
}
async function canonicalRecord(s: Session) {
  const { ExactReviewDirectPublicationStore } = await import("../dashboard/exact-review-direct-publication.ts");
  const store = new ExactReviewDirectPublicationStore(s.storage); store.ensureSchemaSync();
  return store.readCanonical("openclaw-openclaw", "items", number);
}
function assertCommentOnly(s: Session) {
  assert.equal(s.gh.item.state, "open"); assert.deepEqual(s.gh.item.labels, [{ name: "bug" }]);
  if (s.gh.pulls.has(number)) { assert.equal(s.gh.pulls.get(number).state, "open"); assert.equal(s.gh.pulls.get(number).merged, false); }
  const comments = s.gh.completedComments(); assert.equal(comments.length, 1);
  assert.deepEqual(comments[0].user, { login: "clawsweeper[bot]", type: "Bot" });
  assert.doesNotMatch(comments[0].body, /clawsweeper-(?:action|verdict|repair|security|review-state|close-applied):/);
  assert.ok(s.gh.trace.some((entry) => ["POST", "PATCH"].includes(entry.method || "") && entry.body?.body?.includes("clawsweeper-review-version")), "actual GH comment mutation required");
  s.gh.assertNoForbidden();
}
async function withSession(use: (s: Session) => Promise<void>, pullRequest = false, competingReviewLease = false) {
  const s = await session(pullRequest, competingReviewLease); try { await use(s); } catch (error) { attachDiagnostics(error, s.diagnostics()); } finally { await s.close(); }
}

// Upstream control is independent of candidate lookups. A control/harness
// failure invalidates the run as product RED instead of hiding behind missing IDs.
test("R06-C fixed upstream actual publication shell writes one restricted issue review and completes real Queue", async () => {
  await withSession(async (s) => {
    const runner = scenarioRunner(s, publisher(upstream)); await runner.prepare();
    const published = await runner.execute("publish-event-result"); assert.equal(published.code, 0, published.stderr);
    assert.equal(published.outputs.remote_tuple_verified, "true"); assertCommentOnly(s);
    const record = await canonicalRecord(s); assert.ok(record); assert.match(record.content, /^publication_policy: record_comment_only$/m);
    await runner.finish(published, true);
  });
});

for (const [label, workflow] of [["fixed upstream control", upstream], ["candidate", candidate]] as const) {
  test(`R06-C ${label} defers to a real competing review lease and releases its publisher claim`, async () => {
    await withSession(async (s) => {
      const runner = scenarioRunner(s, publisher(workflow)); await runner.prepare();
      const before = (await s.state()).items[s.publicationKey]; assert.equal(before.state, "leased");
      const commentsBefore = JSON.stringify(s.gh.comments.get(number));
      assert.ok(s.blockingReviewLease);
      const published = await runner.execute("publish-event-result"); assert.equal(published.code, 0, published.stderr);
      assert.equal(published.outputs.completion_kind, "retryable_failure"); assert.equal(published.outputs.reason_code, "review_lease_active");
      assert.equal(published.outputs.retry_at, s.blockingReviewLease.expiresAt);
      assert.ok(Date.parse(published.outputs.retry_at) > Date.now());
      assert.notEqual(published.outputs.remote_tuple_verified, "true");
      assert.equal(s.gh.mutationCount(), 0); assert.equal(await canonicalRecord(s), null);
      assert.equal(runner.stages["record-fallback-canonical-lifecycle-receipt"].outcome, "skipped");
      assert.equal(runner.stages["record-no-router-lifecycle-receipt"].outcome, "skipped");
      if (workflow === candidate) {
        // Reuse the actual CLI receipt to check cancellation priority without
        // changing Queue state. The frozen upstream has an older branch order.
        const cancelled = await runner.execute("exact-review-publication-result", "cancelled");
        assert.equal(cancelled.code, 0, cancelled.stderr); assert.equal(cancelled.outputs.outcome, "cancelled");
        assert.equal(cancelled.outputs.completion_kind, "retryable_failure"); assert.equal(cancelled.outputs.reason_code, "workflow_cancelled");
        assert.equal(s.queueTrace.some((entry) => entry.path.endsWith("/complete")), false);
      }
      const result = await runner.execute("exact-review-publication-result"); assert.equal(result.code, 0, result.stderr);
      assert.equal(result.outputs.outcome, "success", "Queue accepts review_lease_active deferral as success, never published");
      assert.equal(result.outputs.completion_kind, "retryable_failure"); assert.equal(result.outputs.reason_code, "review_lease_active");
      assert.equal(result.outputs.retry_at, published.outputs.retry_at); assert.equal(result.outputs.failure_kind, undefined);
      const completed = await runner.execute("complete-exact-review-publication"); assert.equal(completed.code, 0, completed.stderr);
      const completion = s.queueTrace.at(-1)!; assert.equal(completion.path, "/internal/exact-review/complete");
      assert.equal(completion.status, 200); assert.deepEqual(completion.response, { ok: true, requeued: true });
      assert.equal(completion.request.item_key, s.publicationKey); assert.equal(completion.request.lease_id, s.dispatch.lease_id);
      assert.equal(completion.request.lease_revision, s.dispatch.lease_revision);
      assert.equal(completion.request.claim_generation, Number(runner.stages["publication-context"].outputs.publisher_claim_generation));
      assert.equal(completion.request.run_id, publisherRun); assert.equal(completion.request.run_attempt, 1);
      assert.equal(completion.request.outcome, "success"); assert.equal(completion.request.completion_kind, "retryable_failure");
      assert.equal(completion.request.reason_code, "review_lease_active"); assert.equal(completion.request.retry_at, published.outputs.retry_at);
      const pending = (await s.state()).items[s.publicationKey]; assert.ok(pending); assert.equal(pending.state, "pending");
      for (const field of ["leaseId", "leaseRevision", "leaseExpiresAt", "claimedRunId", "claimedRunAttempt", "claimGeneration"]) assert.equal(pending[field], undefined, `${field} must be released`);
      assert.equal(pending.lastFailureReason, "review_lease_active"); assert.ok(pending.nextAttemptAt >= Date.parse(published.outputs.retry_at));
      // Preserve existing OSS retry accounting; this is not an exemption from
      // the publication retry budget and not a completed publication.
      assert.equal(pending.publicationFailureAttempts, Number(before.publicationFailureAttempts || 0) + 1);
      assert.equal(s.gh.mutationCount(), 0); assert.equal(s.gh.completedComments().length, 0);
      assert.equal(JSON.stringify(s.gh.comments.get(number)), commentsBefore); assert.equal(await canonicalRecord(s), null);
      assert.equal(s.queueTrace.some((entry) => entry.path.endsWith("/publication-batch-results") || entry.path.includes("/lifecycle/")), false);
    }, false, true);
  });
}

test("R06-C candidate actual deferred publisher runtime", async (t) => {
  const steps = publisher(candidate);
  for (const id of ["publication-context", "validate-exact-review-bundle", "publish-event-result", "record-fallback-canonical-lifecycle-receipt", "record-no-router-lifecycle-receipt", "exact-review-publication-result", "complete-exact-review-publication"]) getStep(steps, id);
  for (const pullRequest of [false, true]) await t.test(`${pullRequest ? "PR" : "issue"} publishes restricted comment, canonical tuple and real completion`, async () => {
    await withSession(async (s) => {
      const runner = scenarioRunner(s, steps); await runner.prepare();
      const published = await runner.execute("publish-event-result"); assert.equal(published.code, 0, published.stderr);
      assert.equal(published.outputs.remote_tuple_verified, "true"); assertCommentOnly(s);
      const record = await canonicalRecord(s); assert.ok(record); assert.match(record.content, /^publication_policy: record_comment_only$/m);
      assert.match(record.content, /^review_comment_id: [1-9][0-9]*$/m);
      assert.ok(s.queueTrace.some((entry) => entry.path.endsWith("/publication-authority") && entry.status === 200), "real ownership checks required");
      await runner.finish(published, true);
    }, pullRequest);
  });
  for (const kind of ["stale-owner", "mixed-producer-tuple"] as const) await t.test(`${kind} cannot comment or complete another publisher generation`, async () => {
    await withSession(async (s) => {
      const runner = scenarioRunner(s, steps); await runner.prepare();
      if (kind === "stale-owner") await s.post("claim", { ...s.dispatch, run_attempt: 2 });
      else Object.assign(runner.stages["publication-context"].outputs, { publisher_item_key: key, publisher_lease_id: s.producerTuple.lease_id, publisher_lease_revision: String(s.producer.lease_revision), publisher_claim_generation: String(s.producer.claim_generation) });
      const before = JSON.stringify((await s.state()).items[s.publicationKey]);
      const published = await runner.execute("publish-event-result"); assert.notEqual(published.code, 0);
      assert.match(published.stderr + published.stdout, /manual publication fence is unavailable or expired/);
      assert.equal(s.gh.mutationCount(), 0); assert.equal(await canonicalRecord(s), null);
      assert.ok(s.queueTrace.some((entry) => entry.path.endsWith("/publication-authority") && entry.status >= 400));
      const result = await runner.execute("exact-review-publication-result", "failure");
      assert.equal(result.code, 0, result.stderr); assert.equal(result.outputs.outcome, "failure");
      const completed = await runner.execute("complete-exact-review-publication", "failure");
      assert.notEqual(completed.code, 0); assert.equal(s.queueTrace.at(-1)?.status, 409);
      assert.equal(s.queueTrace.at(-1)?.path, "/internal/exact-review/complete");
      const gate = await runner.execute("fail-exact-review-publication", "failure"); assert.notEqual(gate.code, 0);
      // Actual rejection cannot release or otherwise change the current owner.
      assert.equal(JSON.stringify((await s.state()).items[s.publicationKey]), before);
    });
  });
  for (const kind of ["missing-policy", "unknown-policy", "duplicate-policy", "unselected-inventory"] as const) await t.test(`${kind} is rejected by actual CLI after staging`, async () => {
    await withSession(async (s) => {
      const runner = scenarioRunner(s, steps); await runner.prepare();
      if (kind === "unselected-inventory") writeFileSync(join(s.root, "artifacts/event/99.md"), "unselected");
      else writeFileSync(s.reportPath, kind === "missing-policy" ? s.report.replace("publication_policy: record_comment_only\n", "") : kind === "unknown-policy" ? s.report.replace("publication_policy: record_comment_only", "publication_policy: future_policy") : s.report.replace("publication_policy: record_comment_only", "publication_policy: record_comment_only\npublication_policy: record_comment_only"));
      const published = await runner.execute("publish-event-result"); assert.notEqual(published.code, 0);
      assert.match(published.stderr + published.stdout, /publication policy|artifact directory must contain only the selected report/);
      assert.equal(s.gh.mutationCount(), 0); assert.equal(await canonicalRecord(s), null);
      const done = await runner.finish(published, false); assert.notEqual(done.result.outputs.completion_kind, "published");
    });
  });
  for (const httpStatus of [429, 503]) await t.test(`GitHub ${httpStatus} stays retryable without comment or canonical success`, async () => {
    await withSession(async (s) => {
      const runner = scenarioRunner(s, steps); await runner.prepare(); s.gh.controls.githubFailure = httpStatus;
      const published = await runner.execute("publish-event-result"); assert.notEqual(published.code, 0);
      assert.equal(s.gh.completedComments().length, 0); assert.equal(await canonicalRecord(s), null);
      const done = await runner.finish(published, false);
      assert.equal(done.result.outputs.completion_kind, "retryable_failure"); assert.equal(done.result.outputs.reason_code, httpStatus === 429 ? "github_rate_limit" : "github_transient");
      assert.equal(done.completed.code, 0, done.completed.stderr);
      assert.equal((await s.state()).items[s.publicationKey].state, "pending");
    });
  });
  // Known upstream source gap: its receipt shells discard bodies and only
  // check HTTP. These new candidate assertions deliberately have no upstream
  // passing oracle. Faults alter only the wire after real Worker acceptance.
  for (const route of ["canonical-receipt", "router-receipt"] as const) await t.test(`${route} HTTP 200 with unconfirmed payload cannot report published`, async () => {
    await withSession(async (s) => {
      const runner = scenarioRunner(s, steps); await runner.prepare();
      const published = await runner.execute("publish-event-result"); assert.equal(published.code, 0, published.stderr);
      if (route === "router-receipt") {
        const canonical = await runner.execute("record-fallback-canonical-lifecycle-receipt"); assert.equal(canonical.code, 0, canonical.stderr);
      }
      s.controls.corruptReceipt = route;
      const id = route === "canonical-receipt" ? "record-fallback-canonical-lifecycle-receipt" : "record-no-router-lifecycle-receipt";
      const rejected = await runner.execute(id); assert.notEqual(rejected.code, 0, "HTTP 200 alone is not a confirmed receipt");
      const receipt = s.queueTrace.at(-1)!; assert.equal(receipt.status, 200); assert.equal(receipt.sourceResponse.ok, true); assert.equal(receipt.response.ok, false);
      if (route === "canonical-receipt") assert.equal(runner.stages["record-no-router-lifecycle-receipt"].outcome, "skipped");
      const done = await runner.finish(published, false, { receiptFailed: true });
      assert.notEqual(done.result.outputs.completion_kind, "published");
    });
  });
  await t.test("completion losing to an actual newer attempt fails the final gate after otherwise successful publication", async () => {
    await withSession(async (s) => {
      const runner = scenarioRunner(s, steps); await runner.prepare();
      const published = await runner.execute("publish-event-result"); assert.equal(published.code, 0, published.stderr);
      await s.post("claim", { ...s.dispatch, run_attempt: 2 });
      await runner.finish(published, true, { completionLost: true });
    });
  });
  await t.test("canonical transport failure never completes early; same-owner replay reuses the verified comment", async () => {
    await withSession(async (s) => {
      const runner = scenarioRunner(s, steps); await runner.prepare(); s.controls.canonicalFailure = true;
      const failed = await runner.execute("publish-event-result"); assert.notEqual(failed.code, 0);
      assert.equal(failed.outputs.completion_kind, "retryable_failure"); assert.equal(failed.outputs.reason_code, "state_contention");
      assert.equal(s.gh.completedComments().length, 1); assert.equal(await canonicalRecord(s), null);
      assert.equal(s.queueTrace.some((entry) => entry.path.endsWith("/complete")), false);
      const commentId = s.gh.completedComments()[0].id;
      s.controls.canonicalFailure = false;
      // Bounded re-invocation under the SAME still-active owner; this does not
      // claim automatic Actions retry or the later direct-recovery workflow.
      const replay = await runner.execute("publish-event-result"); assert.equal(replay.code, 0, replay.stderr);
      assertCommentOnly(s); assert.equal(s.gh.completedComments()[0].id, commentId); assert.ok(await canonicalRecord(s));
      await runner.finish(replay, true);
    });
  });
});
