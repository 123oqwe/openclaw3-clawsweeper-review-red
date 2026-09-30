import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test, { type TestContext } from "node:test";
import YAML from "yaml";
import worker, { ExactReviewQueue } from "../dashboard/worker.ts";
import { createExactReviewAdmissionHarness, MemoryDurableNamespace, jsonResponse, signedStateAppendRequest, ExactReviewLifecycleProjectionStore, lifecycleState } from "./dashboard-worker-harness.ts";
import { recoveryGithubFixture as publicationGithubFixture } from "./helpers/openclaw3-recovery-gh.ts";

// Actual upstream/candidate workflow bodies -> real CLI -> stock gh transport,
// actual Worker/Queue/SQLite and canonical receipts. Model report, Actions
// checkout/build/mint/download and empty initial hydration are controlled inputs.
// This is NOT an Actions runner or live deployment. R06-D adds actual durable
// direct-lifecycle replay and attempt/run recovery below the frozen R06-C cases.
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
async function session(pullRequest = false, competingReviewLease = false, direct = false, commandContext = false) {
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
  const controls = { canonicalFailure: false, corruptReceipt: "" as "" | "canonical-receipt" | "router-receipt" | "terminal-disposition", receiptFailure: false, corruptComplete: false };
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
      assert.ok(/^\/internal\/(?:exact-review\/(?:claim|complete|heartbeat|publication-authority|publication-results|publication-batch-results|github-etag-cache\/(?:lookup|store|confirm)|github-read-model\/item|lifecycle\/(?:canonical-receipt|router-receipt|terminal-disposition))|state\/(?:github-read-model\/(?:item|comments|activity|repair)|records\/openclaw-openclaw\/items\/41))(?:\?.*)?$/.test(path), `HARNESS_ERROR: unallowed coordinator route ${path}`);
      if (controls.receiptFailure && path.includes("/lifecycle/")) {
        const value = { error: "synthetic_lifecycle_unavailable" };
        queueTrace.push({ path, request: body, status: 503, response: value, injected: true });
        response.writeHead(503, { "content-type": "application/json", "retry-after": "0" }); response.end(JSON.stringify(value)); return;
      }
      if (controls.canonicalFailure && path.endsWith("/publication-batch-results")) {
        const value = { error: "synthetic_state_contention" };
        queueTrace.push({ path, request: body, status: 503, response: value, injected: true });
        response.writeHead(503, { "content-type": "application/json" }); response.end(JSON.stringify(value)); return;
      }
      const headers = Object.fromEntries(Object.entries(request.headers).filter(([name]) => !["host", "connection", "content-length", "transfer-encoding"].includes(name))) as Record<string, string>;
      const result = await worker.fetch(new Request(`https://manual-queue.invalid${path}`, { method: request.method, headers, ...(bytes.length ? { body: bytes } : {}) }), workerEnv);
      const sourceResponse = await result.json() as any;
      const corrupt = (controls.corruptReceipt && path.endsWith(`/lifecycle/${controls.corruptReceipt}`)) || (controls.corruptComplete && path.endsWith("/complete"));
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
    let commandStatus: { commandStatusMarker: string; statusCommentId: number } | undefined;
    if (commandContext) {
      const marker = `<!-- clawsweeper-command-status:${number}:re_review:r06d -->`;
      const createdStatus = await command("gh", ["api", `repos/${repo}/issues/${number}/comments`, "--method", "POST", "-f", `body=Review requested.\n\n${marker}`], { GH_TOKEN: "synthetic-only-token" }, "create real command status address");
      assert.equal(createdStatus.code, 0, createdStatus.stderr);
      const status = JSON.parse(createdStatus.stdout); assert.ok(Number.isSafeInteger(status.id) && status.id > 0);
      assert.equal(status.user.login, "clawsweeper[bot]"); assert.ok(status.body.includes(marker));
      commandStatus = { commandStatusMarker: marker, statusCommentId: status.id };
    }
    const requested = { targetRepo: repo, targetBranch: "main", itemNumber: number, itemKind: pullRequest ? "pull_request" : "issue", sourceEvent: pullRequest ? "pull_request" : "issues", sourceAction: "manual_explicit_review", publicationPolicy: "record_comment_only", supersedesInProgress: false, ...(pullRequest ? { sourceHeadSha: gh.pulls.get(number).head.sha } : {}), ...commandStatus };
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
    if (!direct) leaseComment.body = expireReviewStartStatusLease(leaseComment.body, "2000-01-01T00:00:00.000Z", number);
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
    if (direct) {
      const mutationOutput = ".artifacts/direct-publication-outcome.json";
      const prepared = await command(process.execPath, ["dist/repair/publish-event-result.js"], {
        ...ownerEnv, REVIEW_ONLY: "true", MIN_AGE_MINUTES: "0", EXACT_REVIEW_CLOSE_COVERAGE_DEFERRED: "true",
        EXACT_REVIEW_BATCH_ITEM_KEY: key, EXACT_REVIEW_BATCH_REVISION: String(producer.lease_revision), EXACT_REVIEW_BATCH_CLAIM_GENERATION: String(producer.claim_generation),
        EXACT_REVIEW_BATCH_MUTATION_OUTPUT: mutationOutput, EXACT_REVIEW_PUBLICATION_ARTIFACT_DIR: ".artifacts/exact-review-bundle/review",
      }, "real direct mutation preparation");
      assert.equal(prepared.code, 0, prepared.stderr); assert.equal(JSON.parse(readFileSync(join(root, mutationOutput), "utf8")).kind, "eligible");
      const accepted = await command(process.execPath, ["dist/repair/exact-review-direct-publication.js"], {
        ...ownerEnv, EXACT_REVIEW_DIRECT_PUBLICATION_ENABLED: "1", EXACT_REVIEW_DIRECT_MUTATION_OUTPUT: mutationOutput,
        EXACT_REVIEW_DIRECT_REVISION: String(producer.lease_revision), EXACT_REVIEW_DIRECT_SOURCE_ACTION: producer.decision.sourceAction,
      }, "real direct canonical acceptance");
      assert.equal(accepted.code, 0, accepted.stderr); assert.equal(accepted.outputs.accepted, "true");
      assert.equal(gh.completedComments().length, 1);
      const converted = (await storage.get("exact-review-queue")).items[key];
      assert.equal(converted.state, "leased"); assert.equal(converted.decision.sourceAction, "exact_review_artifact_publish");
      assert.deepEqual(converted.leaseDecision.publication.directLifecycle, { plan: { kind: "router_not_required" }, receiptOutcome: "accepted" });
      assert.ok(queueTrace.some((entry) => entry.path.endsWith("/publication-results") && entry.status === 202 && entry.sourceResponse?.accepted === true));
    } else {
      const enqueued = await post("enqueue", { delivery_id: `publisher:${producerRun}:1`, decision: { ...producer.decision, sourceAction: "exact_review_artifact_publish", supersedesInProgress: false, publication } }, true); assert.equal(enqueued.queued, true);
      await post("complete", { ...producerTuple, claim_generation: producer.claim_generation, outcome: "success" });
      await queue.alarm();
    }
    const publicationKey = direct ? key : `${key}@publish:${producerRun}:1`, publicationItem = (await storage.get("exact-review-queue")).items[publicationKey];
    assert.ok(publicationItem); assert.equal(publicationItem.state, direct ? "leased" : "dispatching", "real Queue must own the publisher");
    const dispatch = { item_key: publicationKey, lease_id: publicationItem.leaseId, lease_revision: publicationItem.leaseRevision, run_id: publisherRun, run_attempt: 1 };
    gh.trace.length = 0; queueTrace.length = 0;
    const state = async () => await storage.get("exact-review-queue");
    return { root, gh, queue, storage, post, command, state, queueTrace, controls, dispatch, producer, producerTuple, publicationKey, report, reportPath, diagnostics, blockingReviewLease, direct,
      close: async () => { server.closeAllConnections(); gh.server.closeAllConnections(); await Promise.all([new Promise<void>((done) => server.close(() => done())), new Promise<void>((done) => gh.server.close(() => done()))]); admission.restore(); storage.sql.close(); rmSync(root, { recursive: true, force: true }); },
    };
  } catch (error) {
    server.closeAllConnections(); gh.server.closeAllConnections(); server.close(); gh.server.close(); admission.restore(); storage.sql.close(); rmSync(root, { recursive: true, force: true }); attachDiagnostics(error, diagnostics());
  }
}
type Session = Awaited<ReturnType<typeof session>>;
function scenarioRunner(s: Session, steps: Step[], owner = { runId: publisherRun, runAttempt: 1 }) {
  const stages: Record<string, Stage> = Object.fromEntries(steps.filter((entry) => entry.id).map((entry) => [entry.id!, { outputs: {}, outcome: "skipped" }]));
  if (!s.direct) {
    for (const id of ["source-checkout", "setup-publish-pnpm", "setup-state", "download-exact-review-bundle"]) stages[id] = { outputs: {}, outcome: "success" };
    for (const id of ["reviewer-token", "target-write-token"]) stages[id] = { outputs: { token: "synthetic-only-token" }, outcome: "success" };
  }
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
      "github.run_attempt": String(owner.runAttempt), "github.run_id": owner.runId, "github.repository": "openclaw/clawsweeper", "github.sha": sourceSha,
      "vars.CLAWSWEEPER_COMMENT_LOOKBACK_MINUTES || '180'": "180", "vars.CLAWSWEEPER_COMMENT_MAX_COMMENTS || '1000'": "1000",
      "github.token": "synthetic-read-token", "job.status": jobStatus,
      "secrets.CLAWSWEEPER_WEBHOOK_SECRET": secret,
      "steps.publication-context.outputs.target_repo == 'openclaw/openclaw' && github.token || ''": "synthetic-read-token",
      "(fromJSON(steps.publication-context.outputs.decision).sourceAction == 'failed_review_shard_recovery' || fromJSON(steps.publication-context.outputs.decision).publicationPolicy == 'record_comment_only') && 'true' || 'false'": "true",
      "steps.exact-review-publication-result.outputs.outcome || 'failure'": stages["exact-review-publication-result"]?.outputs.outcome || "failure",
      "steps.direct-lifecycle-result.outputs.outcome || 'failure'": stages["direct-lifecycle-result"]?.outputs.outcome || "failure",
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
    const result = await s.command("/bin/bash", ["--noprofile", "--norc", "-e", "-o", "pipefail", "-c", render(step.run, jobStatus)], { GITHUB_RUN_ID: owner.runId, GITHUB_RUN_ATTEMPT: String(owner.runAttempt), ...env }, step.id || step.name || "workflow step");
    if (step.id) stages[step.id] = { outputs: result.outputs, outcome: result.code === 0 ? "success" : "failure" };
    return result;
  }
  const execute = (id: string, status = "success") => run(getStep(steps, id), status);
  async function claim() {
    const claimed = await execute("publication-context"); assert.equal(claimed.code, 0, claimed.stderr); assert.equal(claimed.outputs.claimed, "true");
    assert.equal(claimed.outputs.publisher_item_key, s.publicationKey); assert.equal(claimed.outputs.item_key, key);
    assert.equal(claimed.outputs.publisher_lease_id, s.dispatch.lease_id); if (!s.direct) assert.notEqual(claimed.outputs.publisher_lease_id, s.producerTuple.lease_id);
    assert.deepEqual(JSON.parse(claimed.outputs.decision), s.producer.decision);
    return claimed.outputs;
  }
  async function prepare() {
    const claimed = await claim();
    const validated = await execute("validate-exact-review-bundle"); assert.equal(validated.code, 0, validated.stderr);
    const stage = steps.find((entry) => entry.id === "stage-validated-exact-review-artifact" || entry.name === "Stage validated exact review artifact");
    assert.ok(stage?.run, "missing publisher topology: stage validated artifact");
    // Producer diagnostics are not present in the trusted staged directory.
    rmSync(join(s.root, "artifacts/event"), { recursive: true, force: true });
    const staged = await run(stage); assert.equal(staged.code, 0, staged.stderr);
    assert.equal(readFileSync(s.reportPath, "utf8"), s.report);
    return claimed;
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
  return { stages, claim, prepare, execute, finish };
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
async function withSession(use: (s: Session) => Promise<void>, pullRequest = false, competingReviewLease = false, direct = false, commandContext = false) {
  const s = await session(pullRequest, competingReviewLease, direct, commandContext); try { await use(s); } catch (error) { attachDiagnostics(error, s.diagnostics()); } finally { await s.close(); }
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

// R06-D: all pre-existing R06-C scenarios above retain their assertions.
const directOwner = { runId: producerRun, runAttempt: 2 };
function recoveryIds(workflow: string) {
  return workflow === upstream
    ? { result: "exact-review-publication-result", complete: "complete-exact-review-publication" }
    : { result: "direct-lifecycle-result", complete: "complete-direct-lifecycle" };
}
async function beginRecovery(s: Session, workflow: string, owner = directOwner) {
  assert.equal(s.direct, true);
  const runner = scenarioRunner(s, publisher(workflow), owner);
  const claim = await runner.claim(); assert.equal(claim.direct_lifecycle_recovery, "true");
  assert.deepEqual(JSON.parse(claim.direct_lifecycle_plan), { kind: "router_not_required" });
  assert.equal(claim.direct_lifecycle_receipt_outcome, "accepted");
  const current = (await s.state()).items[s.publicationKey];
  assert.equal(current.claimedRunId, owner.runId); assert.equal(current.claimedRunAttempt, owner.runAttempt);
  assert.equal(current.claimGeneration, Number(claim.publisher_claim_generation));
  const canonical = await canonicalRecord(s); assert.ok(canonical);
  const comments = JSON.stringify(s.gh.comments.get(number));
  rmSync(join(s.root, ".artifacts"), { recursive: true, force: true });
  rmSync(join(s.root, "artifacts"), { recursive: true, force: true });
  s.gh.trace.length = 0; s.queueTrace.length = 0;
  return { runner, canonical, comments };
}
async function assertRecoveryDidNotRepublish(s: Session, checkpoint: Awaited<ReturnType<typeof beginRecovery>>) {
  assert.deepEqual(await canonicalRecord(s), checkpoint.canonical);
  assert.equal(JSON.stringify(s.gh.comments.get(number)), checkpoint.comments);
  assert.deepEqual(s.gh.trace, [], "direct replay must not read or mutate GitHub");
  assert.equal(s.queueTrace.some((entry) => /\/publication(?:-batch)?-results$/.test(entry.path)), false);
  for (const id of ["source-checkout", "setup-publish-pnpm", "setup-state", "download-exact-review-bundle", "validate-exact-review-bundle", "stage-validated-exact-review-artifact", "reviewer-token", "publish-event-result"]) {
    const stage = checkpoint.runner.stages[id]; if (stage) assert.equal(stage.outcome, "skipped", `${id} is not part of direct replay`);
  }
}
async function completeRecovery(s: Session, checkpoint: Awaited<ReturnType<typeof beginRecovery>>, workflow: string, owner = directOwner) {
  const ids = recoveryIds(workflow), runner = checkpoint.runner;
  const result = await runner.execute(ids.result); assert.equal(result.code, 0, result.stderr);
  // Fixed upstream's final classification block overwrites a valid direct
  // replay with superseded/live_terminal because ordinary publish was skipped.
  // Characterize that source defect; it is not the candidate's required result.
  const classification = workflow === upstream
    ? { kind: "superseded", reason: "live_terminal" }
    : { kind: "published", reason: "publication_applied" };
  assert.equal(result.outputs.outcome, "success"); assert.equal(result.outputs.completion_kind, classification.kind); assert.equal(result.outputs.reason_code, classification.reason);
  const completed = await runner.execute(ids.complete); assert.equal(completed.code, 0, completed.stderr);
  const trace = s.queueTrace.at(-1)!; assert.equal(trace.path, "/internal/exact-review/complete");
  assert.equal(trace.status, 200); assert.equal(trace.response.ok, true); assert.equal(trace.response.requeued, false);
  assert.equal(trace.request.item_key, s.publicationKey); assert.equal(trace.request.lease_id, s.dispatch.lease_id);
  assert.equal(trace.request.lease_revision, s.dispatch.lease_revision); assert.equal(trace.request.claim_generation, Number(runner.stages["publication-context"].outputs.publisher_claim_generation));
  assert.equal(trace.request.run_id, owner.runId); assert.equal(trace.request.run_attempt, owner.runAttempt);
  assert.equal(trace.request.outcome, "success"); assert.equal(trace.request.completion_kind, classification.kind); assert.equal(trace.request.reason_code, classification.reason);
  assert.equal((await s.state()).items[s.publicationKey], undefined);
  const lifecycle = new ExactReviewLifecycleProjectionStore(s.storage).read(key, s.publicationKey, s.dispatch.lease_revision);
  assert.ok(lifecycle); assert.equal(lifecycle.routerReceipt?.outcome, "not_required"); assert.equal(lifecycleState(lifecycle), "completed");
  await assertRecoveryDidNotRepublish(s, checkpoint);
}
async function dispatchPendingRecovery(s: Session, t: TestContext) {
  const pending = (await s.state()).items[key]; assert.equal(pending.state, "pending"); assert.equal(pending.leaseId, undefined);
  assert.deepEqual(pending.decision.publication.directLifecycle, { plan: { kind: "router_not_required" }, receiptOutcome: "accepted" });
  // Advance only platform time to the real retry deadline. Storage, alarm,
  // dispatch and the generated successor lease remain production behavior.
  const clock = t.mock.method(Date, "now", () => Math.max(pending.nextAttemptAt, pending.updatedAt) + 1);
  try { await s.queue.alarm(); } finally { clock.mock.restore(); }
  const dispatched = (await s.state()).items[key]; assert.equal(dispatched.state, "dispatching");
  assert.notEqual(dispatched.leaseId, s.dispatch.lease_id);
  Object.assign(s.dispatch, { item_key: key, lease_id: dispatched.leaseId, lease_revision: dispatched.leaseRevision });
}

for (const [label, workflow] of [["fixed upstream protocol control (classification defect characterized)", upstream], ["candidate", candidate]] as const) {
  test(`R06-D ${label} recovers actual direct PR canonical acceptance in a later run attempt`, async () => {
    await withSession(async (s) => {
      const checkpoint = await beginRecovery(s, workflow);
      assert.ok(Number(checkpoint.runner.stages["publication-context"].outputs.publisher_claim_generation) > s.producer.claim_generation);
      const replay = await checkpoint.runner.execute("replay-direct-lifecycle"); assert.equal(replay.code, 0, replay.stderr);
      assert.equal(replay.outputs.outcome, "success"); assert.equal(replay.outputs.completion_kind, "published"); assert.equal(replay.outputs.reason_code, "publication_applied");
      assert.equal(replay.outputs.requeue_latest, "false"); assert.equal(replay.outputs.direct_requeue, "false");
      const receipt = s.queueTrace.find((entry) => entry.path.endsWith("/lifecycle/router-receipt"));
      assert.ok(receipt); assert.equal(receipt.status, 200); assert.equal(receipt.response.ok, true); assert.equal(receipt.request.outcome, "not_required");
      if (workflow === candidate) {
        const heartbeat = s.queueTrace.find((entry) => entry.path.endsWith("/heartbeat")); assert.ok(heartbeat);
        assert.equal(heartbeat.status, 200); assert.equal(heartbeat.response.ok, true); assert.equal(heartbeat.response.phase, "finalizing");
        assert.equal(heartbeat.request.phase, "finalizing"); assert.equal(heartbeat.request.source_head_sha, s.producer.decision.sourceHeadSha);
        assert.equal(heartbeat.request.run_id, directOwner.runId); assert.equal(heartbeat.request.run_attempt, directOwner.runAttempt);
        assert.equal(heartbeat.request.claim_generation, Number(checkpoint.runner.stages["publication-context"].outputs.publisher_claim_generation));
        assert.ok(s.queueTrace.indexOf(heartbeat) < s.queueTrace.indexOf(receipt));
      }
      await completeRecovery(s, checkpoint, workflow);
    }, true, false, true);
  });
}

for (const [label, workflow] of [["fixed upstream protocol control (classification defect characterized)", upstream], ["candidate", candidate]] as const) test(`R06-D ${label} recovers a direct issue publication in a new run after real signed reconciliation and dispatch`, async (t) => {
  await withSession(async (s) => {
    const reconciled = await s.post("reconcile", { terminal_runs: [{ run_id: producerRun, run_attempt: 1, claimed_run_attempt: 1, claim_generation: s.producer.claim_generation, outcome: "failure" }] }, true);
    assert.deepEqual(reconciled, { ok: true, reconciled: 1, requeued: 1, completed: 0 });
    await dispatchPendingRecovery(s, t);
    const owner = { runId: "61002", runAttempt: 1 }, checkpoint = await beginRecovery(s, workflow, owner);
    const replay = await checkpoint.runner.execute("replay-direct-lifecycle"); assert.equal(replay.code, 0, replay.stderr);
    await completeRecovery(s, checkpoint, workflow, owner);
  }, false, false, true);
});

test("R06-D candidate rejects an old owner before lifecycle effects and cannot complete its successor", async () => {
  await withSession(async (s) => {
    const checkpoint = await beginRecovery(s, candidate), runner = checkpoint.runner;
    await s.post("claim", { ...s.dispatch, run_id: producerRun, run_attempt: 3 });
    const before = JSON.stringify((await s.state()).items[key]);
    const replay = await runner.execute("replay-direct-lifecycle"); assert.notEqual(replay.code, 0);
    assert.ok(s.queueTrace.some((entry) => entry.path.endsWith("/heartbeat") && entry.status === 409));
    assert.equal(s.queueTrace.some((entry) => entry.path.includes("/lifecycle/")), false);
    const result = await runner.execute("direct-lifecycle-result", "failure"); assert.equal(result.code, 0, result.stderr);
    assert.equal(result.outputs.outcome, "failure"); assert.equal(result.outputs.completion_kind, "retryable_failure"); assert.equal(result.outputs.reason_code, "state_contention");
    const completed = await runner.execute("complete-direct-lifecycle", "failure"); assert.notEqual(completed.code, 0);
    assert.equal(s.queueTrace.at(-1)?.status, 409);
    const gate = await runner.execute("fail-direct-lifecycle", "failure"); assert.notEqual(gate.code, 0);
    assert.equal(JSON.stringify((await s.state()).items[key]), before); await assertRecoveryDidNotRepublish(s, checkpoint);
  }, false, false, true);
});

test("R06-D candidate rejects forbidden or malformed replay inputs without lifecycle effects", async () => {
  await withSession(async (s) => {
    const checkpoint = await beginRecovery(s, candidate), runner = checkpoint.runner;
    const context = runner.stages["publication-context"].outputs, original = { ...context };
    // Invalid env is a shell trust-boundary test, not a claim that Queue stores
    // these plans. Every baseline claim and its saved plan was created by APIs.
    const invalid = [
      ...["router", "router_deferred_coverage", "requeue", "unknown"].map((kind) => ({ direct_lifecycle_plan: JSON.stringify({ kind }) })),
      { direct_lifecycle_plan: "[]" }, { direct_lifecycle_plan: "{" }, { direct_lifecycle_plan: '{"kind":"router_not_required","extra":true}' },
      { direct_lifecycle_receipt_outcome: "unconfirmed" },
      { decision: JSON.stringify({ ...s.producer.decision, publicationPolicy: "other" }) },
      { decision: JSON.stringify({ ...s.producer.decision, sourceAction: "issues_opened" }) },
      { decision: JSON.stringify({ ...s.producer.decision, targetRepo: "openclaw/other" }) },
      { decision: JSON.stringify({ ...s.producer.decision, itemNumber: number + 1 }) },
      { publisher_item_key: `${repo}#${number + 1}` },
      { publisher_lease_revision: String(Number(original.publisher_lease_revision) + 1) },
    ];
    for (const fields of invalid) {
      Object.assign(context, original, fields);
      const replay = await runner.execute("replay-direct-lifecycle"); assert.notEqual(replay.code, 0, JSON.stringify(fields));
    }
    Object.assign(context, original);
    assert.equal(s.queueTrace.some((entry) => entry.path.includes("/lifecycle/") || entry.path.endsWith("/complete")), false);
    await assertRecoveryDidNotRepublish(s, checkpoint);
  }, false, false, true);
});

for (const input of [
  ...["target_missing", "target_closed", "guarded_open", "policy_noop"].map((kind) => ({ kind, receipt: "accepted" })),
  { kind: "router_not_required", receipt: "deduped" },
  { kind: "router_not_required", receipt: "superseded" },
]) test(`R06-D candidate shell input routes ${input.kind}/${input.receipt} without a GitHub effect`, async () => {
  await withSession(async (s) => {
    const checkpoint = await beginRecovery(s, candidate), runner = checkpoint.runner;
    // Routing-only evidence: the real saved plan is router_not_required/accepted.
    // Override extracted shell inputs, never Queue storage or canonical facts.
    // This does not prove a producer persisted these alternative plans/receipts.
    Object.assign(runner.stages["publication-context"].outputs, { direct_lifecycle_plan: JSON.stringify({ kind: input.kind }), direct_lifecycle_receipt_outcome: input.receipt });
    const replayed = await runner.execute("replay-direct-lifecycle"); assert.equal(replayed.code, 0, replayed.stderr);
    const superseded = input.receipt === "superseded";
    assert.equal(replayed.outputs.outcome, "success"); assert.equal(replayed.outputs.completion_kind, superseded ? "superseded" : "published");
    assert.equal(replayed.outputs.reason_code, superseded ? "remote_newer_tuple" : "publication_applied");
    assert.equal(replayed.outputs.requeue_latest, "false"); assert.equal(replayed.outputs.direct_requeue, "false");
    const receipts = s.queueTrace.filter((entry) => entry.path.includes("/lifecycle/"));
    if (superseded) assert.deepEqual(receipts, []);
    else {
      assert.equal(receipts.length, 1); const receipt = receipts[0];
      assert.equal(receipt.status, 200); assert.equal(receipt.sourceResponse.ok, true);
      assert.equal(receipt.path, `/internal/exact-review/lifecycle/${input.kind === "router_not_required" ? "router-receipt" : "terminal-disposition"}`);
      assert.equal(receipt.request.canonical_target_key, key); assert.equal(receipt.request.fence_key, s.publicationKey); assert.equal(receipt.request.revision, s.dispatch.lease_revision);
      if (input.kind === "router_not_required") assert.equal(receipt.request.outcome, "not_required");
      else assert.equal(receipt.request.kind, input.kind);
    }
    const result = await runner.execute("direct-lifecycle-result"); assert.equal(result.code, 0, result.stderr);
    assert.equal(result.outputs.outcome, "success"); assert.equal(result.outputs.completion_kind, replayed.outputs.completion_kind); assert.equal(result.outputs.reason_code, replayed.outputs.reason_code);
    assert.equal(s.queueTrace.some((entry) => entry.path.endsWith("/complete")), false);
    await assertRecoveryDidNotRepublish(s, checkpoint);
  }, false, false, true);
});

for (const fault of ["http-503", "unconfirmed-200"] as const) test(`R06-D candidate ${fault} receipt never becomes successful direct completion`, async (t) => {
  await withSession(async (s) => {
    const checkpoint = await beginRecovery(s, candidate), runner = checkpoint.runner;
    if (fault === "http-503") s.controls.receiptFailure = true; else s.controls.corruptReceipt = "router-receipt";
    const replay = await runner.execute("replay-direct-lifecycle"); assert.notEqual(replay.code, 0);
    const receipt = s.queueTrace.filter((entry) => entry.path.endsWith("/lifecycle/router-receipt")).at(-1)!; assert.ok(receipt);
    assert.equal(receipt.status, fault === "http-503" ? 503 : 200);
    if (fault === "unconfirmed-200") { assert.equal(receipt.sourceResponse.ok, true); assert.equal(receipt.response.ok, false); }
    const result = await runner.execute("direct-lifecycle-result", "failure"); assert.equal(result.code, 0, result.stderr);
    assert.equal(result.outputs.outcome, "failure"); assert.equal(result.outputs.completion_kind, "retryable_failure"); assert.equal(result.outputs.reason_code, "state_contention");
    const completed = await runner.execute("complete-direct-lifecycle", "failure"); assert.equal(completed.code, 0, completed.stderr);
    assert.equal(s.queueTrace.at(-1)?.response.ok, true); assert.equal((await s.state()).items[key].state, "pending");
    const gate = await runner.execute("fail-direct-lifecycle", "failure"); assert.notEqual(gate.code, 0);
    await assertRecoveryDidNotRepublish(s, checkpoint);
    if (fault === "unconfirmed-200") {
      // The source really recorded the first receipt before its wire response
      // was lost. A new lease must safely replay that already durable receipt.
      s.controls.corruptReceipt = "";
      await dispatchPendingRecovery(s, t);
      const owner = { runId: "61002", runAttempt: 1 }, recovered = await beginRecovery(s, candidate, owner);
      assert.deepEqual(recovered.canonical, checkpoint.canonical); assert.equal(recovered.comments, checkpoint.comments);
      const replayed = await recovered.runner.execute("replay-direct-lifecycle"); assert.equal(replayed.code, 0, replayed.stderr);
      assert.ok(s.queueTrace.some((entry) => entry.path.endsWith("/lifecycle/router-receipt") && entry.status === 200 && entry.response.ok === true));
      await completeRecovery(s, recovered, candidate, owner);
    }
  }, false, false, true);
});

for (const timing of ["before-replay", "after-replay"] as const) test(`R06-D candidate cancellation ${timing} completes as cancelled and permits durable recovery`, async (t) => {
  await withSession(async (s) => {
    const checkpoint = await beginRecovery(s, candidate), runner = checkpoint.runner;
    if (timing === "after-replay") {
      const replayed = await runner.execute("replay-direct-lifecycle"); assert.equal(replayed.code, 0, replayed.stderr);
      assert.equal(replayed.outputs.outcome, "success");
    }
    const result = await runner.execute("direct-lifecycle-result", "cancelled"); assert.equal(result.code, 0, result.stderr);
    assert.equal(result.outputs.outcome, "cancelled"); assert.equal(result.outputs.completion_kind, "retryable_failure"); assert.equal(result.outputs.reason_code, "workflow_cancelled");
    const completed = await runner.execute("complete-direct-lifecycle", "cancelled"); assert.equal(completed.code, 0, completed.stderr);
    const completion = s.queueTrace.at(-1)!; assert.equal(completion.path, "/internal/exact-review/complete");
    assert.equal(completion.request.outcome, "cancelled"); assert.equal(completion.status, 200); assert.equal(completion.response.ok, true);
    assert.equal(completion.response.requeued, true); assert.equal((await s.state()).items[key].state, "pending");
    if (timing === "before-replay") assert.equal(s.queueTrace.some((entry) => entry.path.includes("/lifecycle/")), false);
    const gate = await runner.execute("fail-direct-lifecycle", "cancelled"); assert.notEqual(gate.code, 0);
    await assertRecoveryDidNotRepublish(s, checkpoint);
    await dispatchPendingRecovery(s, t);
    const owner = { runId: "61002", runAttempt: 1 }, recovered = await beginRecovery(s, candidate, owner);
    assert.deepEqual(recovered.canonical, checkpoint.canonical); assert.equal(recovered.comments, checkpoint.comments);
    const replayed = await recovered.runner.execute("replay-direct-lifecycle"); assert.equal(replayed.code, 0, replayed.stderr);
    await completeRecovery(s, recovered, candidate, owner);
  }, false, false, true);
});

for (const fault of ["new-owner", "unconfirmed-200"] as const) test(`R06-D candidate completion ${fault} fails its final gate after successful replay`, async () => {
  await withSession(async (s) => {
    const checkpoint = await beginRecovery(s, candidate), runner = checkpoint.runner;
    const replay = await runner.execute("replay-direct-lifecycle"); assert.equal(replay.code, 0, replay.stderr);
    const result = await runner.execute("direct-lifecycle-result"); assert.equal(result.code, 0, result.stderr); assert.equal(result.outputs.outcome, "success");
    if (fault === "new-owner") await s.post("claim", { ...s.dispatch, run_id: producerRun, run_attempt: 3 }); else s.controls.corruptComplete = true;
    const completed = await runner.execute("complete-direct-lifecycle"); assert.notEqual(completed.code, 0);
    const trace = s.queueTrace.at(-1)!; assert.equal(trace.path, "/internal/exact-review/complete");
    if (fault === "new-owner") { assert.equal(trace.status, 409); assert.equal((await s.state()).items[key].claimedRunAttempt, 3); }
    else { assert.equal(trace.status, 200); assert.equal(trace.sourceResponse.ok, true); assert.equal(trace.response.ok, false); }
    const gate = await runner.execute("fail-direct-lifecycle", "failure"); assert.notEqual(gate.code, 0);
    await assertRecoveryDidNotRepublish(s, checkpoint);
  }, false, false, true);
});

for (const [label, workflow] of [["fixed upstream control", upstream], ["candidate", candidate]] as const) test(`R06-D ${label} readback unavailable defers behind the interrupted owner's lease and recovers after explicit owner cleanup`, async (t) => {
  await withSession(async (s) => {
    const first = scenarioRunner(s, publisher(workflow)); await first.prepare();
    s.gh.controls.lostAcknowledgement = true; s.gh.recoveryControls.readbackUnavailable = true;
    const failed = await first.execute("publish-event-result"); assert.notEqual(failed.code, 0);
    assert.ok(s.gh.recoveryControls.readbackFailures > 0, "a real post-mutation readback must fail");
    assert.equal(s.gh.completedComments().length, 1); const commentId = s.gh.completedComments()[0].id;
    assert.notEqual(failed.outputs.remote_tuple_verified, "true"); assert.notEqual(failed.outputs.completion_kind, "published"); assert.equal(await canonicalRecord(s), null);
    const result = await first.execute("exact-review-publication-result", "failure"); assert.equal(result.code, 0, result.stderr);
    assert.equal(result.outputs.outcome, "failure"); assert.notEqual(result.outputs.completion_kind, "published");
    // Model an Actions retry before its interrupted completion callback. Claim
    // through the real API; no same-owner shell replay or edited Queue state.
    s.gh.recoveryControls.readbackUnavailable = false;
    const second = scenarioRunner(s, publisher(workflow), { runId: publisherRun, runAttempt: 2 });
    const claim = await second.prepare(); assert.ok(Number(claim.publisher_claim_generation) > Number(first.stages["publication-context"].outputs.publisher_claim_generation));
    const deferred = await second.execute("publish-event-result"); assert.equal(deferred.code, 0, deferred.stderr);
    assert.equal(deferred.outputs.completion_kind, "retryable_failure"); assert.equal(deferred.outputs.reason_code, "review_lease_active");
    assert.notEqual(deferred.outputs.remote_tuple_verified, "true"); assert.ok(Date.parse(deferred.outputs.retry_at) > Date.now());
    assert.equal(await canonicalRecord(s), null); assert.equal(s.gh.completedComments().length, 1); assert.equal(s.gh.completedComments()[0].id, commentId);
    const deferredResult = await second.execute("exact-review-publication-result"); assert.equal(deferredResult.code, 0, deferredResult.stderr);
    assert.equal(deferredResult.outputs.outcome, "success"); assert.equal(deferredResult.outputs.completion_kind, "retryable_failure");
    assert.equal(deferredResult.outputs.reason_code, "review_lease_active"); assert.equal(deferredResult.outputs.retry_at, deferred.outputs.retry_at);
    const deferredComplete = await second.execute("complete-exact-review-publication"); assert.equal(deferredComplete.code, 0, deferredComplete.stderr);
    const completion = s.queueTrace.at(-1)!; assert.equal(completion.path, "/internal/exact-review/complete");
    assert.equal(completion.status, 200); assert.deepEqual(completion.response, { ok: true, requeued: true });
    assert.equal(completion.request.run_id, publisherRun); assert.equal(completion.request.run_attempt, 2);
    assert.equal(completion.request.item_key, s.publicationKey); assert.equal(completion.request.lease_id, s.dispatch.lease_id);
    assert.equal(completion.request.lease_revision, s.dispatch.lease_revision); assert.equal(completion.request.claim_generation, Number(claim.publisher_claim_generation));
    assert.equal(completion.request.outcome, "success");
    assert.equal(completion.request.completion_kind, "retryable_failure"); assert.equal(completion.request.reason_code, "review_lease_active");
    assert.equal(completion.request.retry_at, deferred.outputs.retry_at);
    const pending = (await s.state()).items[s.publicationKey]; assert.equal(pending.state, "pending"); assert.equal(pending.leaseId, undefined);
    assert.ok(pending.nextAttemptAt >= Date.parse(deferred.outputs.retry_at));

    // Explicit cleanup by the interrupted owner is a controlled recovery input,
    // not an automatic candidate feature. The expiry CLI itself has no owner
    // fence, so establish its exact original owner/id/revision before calling it.
    const { itemSourceRevisionSha256ForTest } = await import(pathToFileURL(join(source, "dist/clawsweeper.js")).href);
    const { freshExactHeadReviewStartLease } = await import(pathToFileURL(join(source, "dist/repair/comment-router-core.js")).href);
    const { expireReviewStartStatusLease } = await import(pathToFileURL(join(source, "dist/clawsweeper-review-comment-state.js")).href);
    const revision = itemSourceRevisionSha256ForTest(s.gh.item, s.gh.comments.get(number));
    assert.equal(revision, /^item_source_revision: (.+)$/m.exec(s.report)?.[1]);
    const leaseOptions = { comments: s.gh.comments.get(number), itemNumber: number, headSha: revision, trustedAuthors: new Set(["clawsweeper[bot]"]) };
    const active = freshExactHeadReviewStartLease(leaseOptions); assert.ok(active);
    assert.equal(active.owner, `github-run-${publisherRun}-1`); assert.ok(Number.isSafeInteger(active.commentId));
    assert.equal(active.expiresAt, deferred.outputs.retry_at);
    const leaseComment = s.gh.comments.get(number)!.find((entry) => entry.id === active.commentId); assert.ok(leaseComment);
    assert.equal(leaseComment.user.login, "clawsweeper[bot]"); assert.ok(leaseComment.body.includes(`sha=${revision}`));
    const bodyBefore = leaseComment.body, commentsBefore = s.gh.comments.get(number)!.map((entry) => ({ id: entry.id, body: entry.body }));
    const queueBeforeCleanup = JSON.stringify(await s.state()), cleanupStartedAt = Date.now();
    const cleanup = await s.command(process.execPath, ["dist/clawsweeper.js", "expire-review-lease", "--target-repo", repo, "--item-number", String(number), "--comment-id", String(active.commentId)], { GH_TOKEN: "synthetic-only-token", GITHUB_RUN_ID: publisherRun, GITHUB_RUN_ATTEMPT: "1" }, "explicit interrupted-owner lease cleanup");
    assert.equal(cleanup.code, 0, cleanup.stderr);
    const expiry = /\slease_expires_at=([^\s>]+)/.exec(leaseComment.body)?.[1]; assert.ok(expiry);
    assert.ok(Date.parse(expiry) >= cleanupStartedAt && Date.parse(expiry) <= Date.now());
    assert.equal(leaseComment.body, expireReviewStartStatusLease(bodyBefore, expiry, number)); assert.notEqual(leaseComment.body, bodyBefore);
    assert.deepEqual(s.gh.comments.get(number)!.map((entry) => ({ id: entry.id, body: entry.body })), commentsBefore.map((entry) => entry.id === active.commentId ? { ...entry, body: expireReviewStartStatusLease(entry.body, expiry, number) } : entry));
    assert.equal(freshExactHeadReviewStartLease(leaseOptions), null);
    assert.equal(JSON.stringify(await s.state()), queueBeforeCleanup); assert.equal(await canonicalRecord(s), null);
    assert.equal(s.gh.completedComments().length, 1); assert.equal(s.gh.completedComments()[0].id, commentId);

    // Honor the actual Queue retry schedule and obtain a newly generated lease.
    // Only the platform clock around alarm advances; no stored state is edited.
    const clock = t.mock.method(Date, "now", () => Math.max(pending.nextAttemptAt, pending.updatedAt) + 1);
    try { await s.queue.alarm(); } finally { clock.mock.restore(); }
    const dispatched = (await s.state()).items[s.publicationKey]; assert.equal(dispatched.state, "dispatching");
    assert.notEqual(dispatched.leaseId, s.dispatch.lease_id);
    Object.assign(s.dispatch, { lease_id: dispatched.leaseId, lease_revision: dispatched.leaseRevision });
    const third = scenarioRunner(s, publisher(workflow), { runId: publisherRun, runAttempt: 3 }); await third.prepare();
    const recovered = await third.execute("publish-event-result"); assert.equal(recovered.code, 0, recovered.stderr);
    assert.equal(recovered.outputs.remote_tuple_verified, "true"); assertCommentOnly(s); assert.equal(s.gh.completedComments()[0].id, commentId);
    const record = await canonicalRecord(s); assert.ok(record); assert.match(record.content, /^publication_policy: record_comment_only$/m);
    const finished = await third.finish(recovered, true); assert.equal(finished.completion.request.run_attempt, 3);
  });
});

// Isolate the shared Queue retry-closure contract from candidate workflow IDs.
// All stored claims/retries/receipts are obtained through real Worker APIs;
// canonical data, when present, was produced by the session's actual two CLIs.
async function ownedRetryClosure(s: Session, t: TestContext) {
  if (!s.direct) await scenarioRunner(s, publisher(upstream)).claim();
  const original = (await s.state()).items[s.publicationKey]; assert.equal(original.state, "leased");
  const previousTuple = { item_key: s.publicationKey, lease_id: original.leaseId, lease_revision: original.leaseRevision, claim_generation: original.claimGeneration, run_id: original.claimedRunId, run_attempt: original.claimedRunAttempt };
  const failed = await s.post("complete", { ...previousTuple, outcome: "failure", completion_kind: "retryable_failure", reason_code: "state_contention", lifecycle_terminal_disposition: "requeue" });
  assert.deepEqual(failed, { ok: true, requeued: true });
  const projection = () => new ExactReviewLifecycleProjectionStore(s.storage).read(key, s.publicationKey, previousTuple.lease_revision)!;
  assert.equal(lifecycleState(projection()), "requeue");
  const pending = (await s.state()).items[s.publicationKey]; assert.equal(pending.state, "pending"); assert.equal(pending.leaseId, undefined);
  const clock = t.mock.method(Date, "now", () => Math.max(pending.nextAttemptAt, pending.updatedAt) + 1);
  try { await s.queue.alarm(); } finally { clock.mock.restore(); }
  const dispatched = (await s.state()).items[s.publicationKey]; assert.equal(dispatched.state, "dispatching");
  assert.notEqual(dispatched.leaseId, previousTuple.lease_id); assert.equal(dispatched.leaseRevision, previousTuple.lease_revision);
  Object.assign(s.dispatch, { lease_id: dispatched.leaseId, lease_revision: dispatched.leaseRevision });
  const owner = { runId: "71001", runAttempt: 1 }, runner = scenarioRunner(s, publisher(upstream), owner);
  const claim = await runner.claim();
  const tuple = { item_key: claim.publisher_item_key, lease_id: claim.publisher_lease_id, lease_revision: Number(claim.publisher_lease_revision), claim_generation: Number(claim.publisher_claim_generation), run_id: owner.runId, run_attempt: owner.runAttempt };
  assert.equal((await s.state()).items[s.publicationKey].revision, tuple.lease_revision);
  assert.equal(lifecycleState(projection()), "requeue");
  const canonical = await canonicalRecord(s), comments = JSON.stringify(s.gh.comments.get(number));
  assert.equal(Boolean(canonical), s.direct);
  if (s.direct) assert.ok(projection().canonicalReceipts.some((receipt) => ["accepted", "deduped"].includes(receipt.outcome)));
  return { runner, tuple, projection, canonical, comments };
}
async function replayRetryReceipt(s: Session, retry: Awaited<ReturnType<typeof ownedRetryClosure>>) {
  assert.equal(s.direct, true);
  const replayed = await retry.runner.execute("replay-direct-lifecycle"); assert.equal(replayed.code, 0, replayed.stderr);
  assert.equal(replayed.outputs.completion_kind, "published"); assert.equal(replayed.outputs.reason_code, "publication_applied");
  const receipt = retry.projection().routerReceipt; assert.ok(receipt);
  assert.equal(receipt.outcome, "not_required"); assert.equal(retry.projection().routerReceipts.find((entry) => entry.receiptId === receipt.receiptId)?.operationComplete, true);
  // Even a real confirmed receipt must not override a committed retry before
  // the currently owned completion has checked its tuple and transition.
  assert.equal(lifecycleState(retry.projection()), "requeue");
  assert.deepEqual(await canonicalRecord(s), retry.canonical); assert.equal(JSON.stringify(s.gh.comments.get(number)), retry.comments);
}

test("R06-D Queue closes a same-revision retry only at owned published completion, not duplicate receipts", async (t) => {
  await withSession(async (s) => {
    const retry = await ownedRetryClosure(s, t);
    await replayRetryReceipt(s, retry); await replayRetryReceipt(s, retry);
    assert.equal((await s.state()).items[s.publicationKey].state, "leased");
    const completed = await s.post("complete", { ...retry.tuple, outcome: "success", completion_kind: "published", reason_code: "publication_applied" });
    assert.deepEqual(completed, { ok: true, requeued: false }); assert.equal((await s.state()).items[s.publicationKey], undefined);
    assert.equal(lifecycleState(retry.projection()), "completed");
    assert.ok(retry.projection().canonicalReceipts.some((receipt) => ["accepted", "deduped"].includes(receipt.outcome)));
    assert.deepEqual(await canonicalRecord(s), retry.canonical); assert.equal(JSON.stringify(s.gh.comments.get(number)), retry.comments);
  }, false, false, true);
});

test("R06-D Queue rejects a stale completion before it can close a durable retry", async (t) => {
  await withSession(async (s) => {
    const retry = await ownedRetryClosure(s, t); await replayRetryReceipt(s, retry);
    const successor = await s.post("claim", { ...retry.tuple, run_attempt: 2 }); assert.equal(successor.claimed, true);
    assert.ok(successor.claim_generation > retry.tuple.claim_generation);
    const before = JSON.stringify(await s.state()), projectionBefore = JSON.stringify(retry.projection());
    await assert.rejects(s.post("complete", { ...retry.tuple, outcome: "success", completion_kind: "published", reason_code: "publication_applied" }), /complete: 409/);
    assert.equal(JSON.stringify(await s.state()), before); assert.equal(JSON.stringify(retry.projection()), projectionBefore);
    assert.equal(lifecycleState(retry.projection()), "requeue");
    assert.deepEqual(await canonicalRecord(s), retry.canonical); assert.equal(JSON.stringify(s.gh.comments.get(number)), retry.comments);
  }, false, false, true);
});

test("R06-D Queue cannot promote a retry without a confirmed router receipt", async (t) => {
  await withSession(async (s) => {
    const retry = await ownedRetryClosure(s, t); assert.ok(retry.canonical); assert.equal(retry.projection().routerReceipt, null);
    // A syntactically valid owner's claim of publication is insufficient to
    // close lifecycle without durable evidence. No successful CLI is invented.
    const completed = await s.post("complete", { ...retry.tuple, outcome: "success", completion_kind: "published", reason_code: "publication_applied" });
    assert.deepEqual(completed, { ok: true, requeued: false });
    assert.equal(lifecycleState(retry.projection()), "requeue"); assert.equal(retry.projection().routerReceipt, null);
    assert.deepEqual(await canonicalRecord(s), retry.canonical); assert.equal(JSON.stringify(s.gh.comments.get(number)), retry.comments);
  }, false, false, true);
});

test("R06-D Queue preserves an explicitly requested retry despite confirmed publication receipts", async (t) => {
  await withSession(async (s) => {
    const retry = await ownedRetryClosure(s, t); await replayRetryReceipt(s, retry);
    const completed = await s.post("complete", { ...retry.tuple, outcome: "success", completion_kind: "published", reason_code: "publication_applied", lifecycle_terminal_disposition: "requeue" });
    assert.deepEqual(completed, { ok: true, requeued: false }); assert.equal(lifecycleState(retry.projection()), "requeue");
    assert.deepEqual(await canonicalRecord(s), retry.canonical); assert.equal(JSON.stringify(s.gh.comments.get(number)), retry.comments);
  }, false, false, true);
});

test("R06-D Queue cannot promote a retry without an accepted or deduped canonical receipt", async (t) => {
  await withSession(async (s) => {
    const retry = await ownedRetryClosure(s, t); assert.equal(retry.canonical, null); assert.deepEqual(retry.projection().canonicalReceipts, []);
    // A real signed router receipt is independent of canonical acceptance; this
    // negative case never fabricates a canonical receipt or a published CLI.
    const received = await s.post("lifecycle/router-receipt", { canonical_target_key: key, fence_key: s.publicationKey, revision: retry.tuple.lease_revision, outcome: "not_required", receipt_id: "r06d-missing-canonical-router" }, true);
    assert.equal(received.ok, true); assert.equal(retry.projection().routerReceipts.find((entry) => entry.receiptId === "r06d-missing-canonical-router")?.operationComplete, true); assert.equal(lifecycleState(retry.projection()), "requeue");
    const completed = await s.post("complete", { ...retry.tuple, outcome: "success", completion_kind: "published", reason_code: "publication_applied" });
    assert.deepEqual(completed, { ok: true, requeued: false }); assert.equal(lifecycleState(retry.projection()), "requeue");
    assert.deepEqual(retry.projection().canonicalReceipts, []); assert.equal(await canonicalRecord(s), null);
    assert.equal(JSON.stringify(s.gh.comments.get(number)), retry.comments);
  });
});

test("R06-D Queue closes an owned command retry and atomically schedules its acknowledgement finalizer", async (t) => {
  await withSession(async (s) => {
    const retry = await ownedRetryClosure(s, t);
    const marker = s.producer.decision.commandStatusMarker, statusCommentId = s.producer.decision.statusCommentId;
    assert.ok(marker && Number.isSafeInteger(statusCommentId));
    assert.equal(retry.projection().admission.commandOriginated, true);
    assert.equal(retry.projection().admission.statusMarker, marker); assert.equal(retry.projection().admission.statusCommentId, statusCommentId);
    assert.equal(retry.projection().acknowledgement.required, true); assert.equal(retry.projection().acknowledgement.observed, null);
    await replayRetryReceipt(s, retry);
    const driverKey = `terminal-finalization:${s.publicationKey}:${retry.tuple.lease_revision}`;
    assert.equal((await s.state()).items[driverKey], undefined, "receipt alone cannot schedule a finalizer for an outstanding retry");
    const completed = await s.post("complete", { ...retry.tuple, outcome: "success", completion_kind: "published", reason_code: "publication_applied" });
    assert.deepEqual(completed, { ok: true, requeued: false, terminal_finalization: true });
    const state = await s.state(); assert.equal(state.items[s.publicationKey], undefined);
    const driver = state.items[driverKey]; assert.ok(driver); assert.equal(driver.state, "pending"); assert.equal(driver.leaseId, undefined);
    assert.equal(driver.decision.publication, undefined); assert.equal(driver.decision.commandStatusMarker, marker); assert.equal(driver.decision.statusCommentId, statusCommentId);
    assert.equal(driver.terminalFinalization.disposition, "review_completed_routed");
    assert.deepEqual(driver.terminalFinalization.projection, { canonicalTargetKey: key, fenceKey: s.publicationKey, revision: retry.tuple.lease_revision });
    assert.equal(retry.projection().terminalDisposition?.kind, "review_completed_routed");
    assert.equal(lifecycleState(retry.projection()), "acknowledgement_pending"); assert.equal(retry.projection().acknowledgement.observed, null);
    assert.deepEqual(await canonicalRecord(s), retry.canonical); assert.equal(JSON.stringify(s.gh.comments.get(number)), retry.comments);
  }, false, false, true, true);
});
