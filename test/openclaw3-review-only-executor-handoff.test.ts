import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import YAML from "yaml";
import worker from "../dashboard/worker.ts";
import { ExactReviewQueue, MemoryDurableNamespace, MemoryDurableStorage, leasedExactReviewQueueItem } from "./dashboard-worker-harness.ts";

// W3-A only: real CLI handoff and lease-loss termination before model generation.
// A controlled metadata refusal is expected, never counted as successful review.
const targetRepo = "openclaw/clawsweeper"; // Supported upstream profile; no live GitHub access.
const itemKey = `${targetRepo}#41`;
const runId = "41001";
const leaseOwner = "oc3-executor-41001";
type Step = { id?: string; name?: string; run?: string; env?: Record<string, string> };
type Event = { event?: string; pid?: number; processGroup?: number; argv?: string[]; env?: Record<string, string>; args?: string[] };
function reviewStep(path: string) {
  const workflow = YAML.parse(readFileSync(path, "utf8"));
  const job = workflow.jobs?.["event-review-apply"];
  const steps = job?.steps as Step[] | undefined;
  const step = steps?.find((entry) => entry.id === "review-exact-event-item" || entry.name === "Review exact event item" || entry.name === "Run the existing review executor");
  assert.ok(step?.run, `actual executor run missing: ${path}`);
  // Inherit this production control only where declared, workflow then job.
  // The existing step-env renderer below applies the final override. Do not
  // render unrelated workflow secrets or supply an undeclared tool-env default.
  const inheritedEnv: Record<string, string> = {};
  for (const scope of [workflow.env, job?.env]) {
    if (scope && Object.hasOwn(scope, "CLAWSWEEPER_CODEX_REASONING_EFFORT")) inheritedEnv.CLAWSWEEPER_CODEX_REASONING_EFFORT = scope.CLAWSWEEPER_CODEX_REASONING_EFFORT;
  }
  return { step, inheritedEnv };
}
const upstream = "fixtures/upstream-16505cf/.github/workflows/sweep.yml";
const candidate = "candidate/receiver/.github/workflows/sweep.yml";
const readEvents = (path: string): Event[] => readFileSync(path, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
const delay = (ms: number) => new Promise<void>((accept) => setTimeout(accept, ms));
function killGroup(group?: number) {
  if (!group) return;
  try { process.kill(-group, "SIGKILL"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
}
function active(pid: number) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0] !== "Z";
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}
function restoreOwnedModes(path: string) {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) return;
  chmodSync(path, stat.mode | (stat.isDirectory() ? 0o700 : 0o600));
  if (stat.isDirectory()) for (const name of readdirSync(path)) restoreOwnedModes(join(path, name));
}

async function execute(path: string, scenario: "metadata-denied" | "revoked") {
  assert.equal(process.platform, "linux", "this package requires the existing Ubuntu Hosted lane");
  const { step, inheritedEnv } = reviewStep(path);
  const root = mkdtempSync(join(tmpdir(), "oc3-executor-"));
  const work = join(root, "work");
  const target = join(root, "target");
  for (const directory of [work, target, join(work, "scripts")]) mkdirSync(directory, { recursive: true });
  cpSync("dist", join(work, "dist"), { recursive: true });
  cpSync("package.json", join(work, "package.json"));
  cpSync("scripts/control-plane-curl.sh", join(work, "scripts/control-plane-curl.sh"));
  const modelSentinel = join(root, "model-sentinel.mjs");
  cpSync("test/fixtures/openclaw3-executor-model.mjs", modelSentinel);
  chmodSync(modelSentinel, 0o755);
  for (const name of ["node_modules", "config", "schema", "prompts"]) symlinkSync(resolve(name), join(work, name), "dir");
  const cliTrace = join(root, "cli.jsonl");
  const ghTrace = join(root, "gh.jsonl");
  const modelTrace = join(root, "model.jsonl");
  const output = join(root, "outputs");
  for (const file of [cliTrace, ghTrace, modelTrace, output]) writeFileSync(file, "");
  const gitEnv = { PATH: process.env.PATH, HOME: root, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" };
  const git = (...args: string[]) => execFileSync("git", args, { cwd: target, env: gitEnv, encoding: "utf8" }).trim();
  git("init", "-q", "-b", "main");
  writeFileSync(join(target, "tracked.txt"), "synthetic executor handoff\n");
  git("add", "tracked.txt");
  git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "-qm", "fixture");
  git("remote", "add", "origin", target); // Real git fetch, entirely within the owned temporary fixture.
  const head = git("rev-parse", "HEAD");
  const decision = { targetRepo, targetBranch: "main", itemNumber: 41, itemKind: "pull_request", sourceEvent: "pull_request", sourceAction: "manual_explicit_review", publicationPolicy: "record_comment_only", supersedesInProgress: false, sourceHeadSha: head };
  const leased = { ...leasedExactReviewQueueItem(41, runId), key: itemKey, decision, leaseDecision: { ...decision } };
  const storage = new MemoryDurableStorage();
  await storage.put("exact-review-queue", { deliveries: {}, items: { [itemKey]: leased } });
  const queue = new ExactReviewQueue({ storage }, { hostedTargetPredicate: () => true, hostedPublicTargetProbe: async () => "public", EXACT_REVIEW_MANUAL_PUBLICATION_ENABLED: "1" });
  const readModelEnv = { EXACT_REVIEW_QUEUE: new MemoryDurableNamespace(queue) };
  const queueTrace: Array<{ body: Record<string, unknown>; status: number }> = [];
  const readModelTrace: Array<{ body: Record<string, unknown>; status: number; snapshot: Record<string, unknown> }> = [];
  let takeover: Record<string, unknown> | undefined;
  let serverError: unknown;
  const server = createServer(async (req, res) => {
    try {
      assert.equal(req.method, "POST");
      assert.ok(req.url === "/internal/exact-review/heartbeat" || req.url === "/internal/exact-review/github-read-model/item", `unexpected queue route: ${req.url}`);
      let bytes = "";
      for await (const chunk of req) bytes += chunk;
      const body = JSON.parse(bytes);
      // The real CLI synchronously reads this lease-scoped cache before gh.
      // Dispatch before the heartbeat barrier; waiting for metadata here deadlocks.
      if (req.url === "/internal/exact-review/github-read-model/item") {
        const response = await worker.fetch(new Request(`https://clawsweeper.openclaw.ai${req.url}`, { method: "POST", headers: { "content-type": "application/json" }, body: bytes }), readModelEnv);
        const responseText = await response.text();
        readModelTrace.push({ body, status: response.status, snapshot: JSON.parse(responseText) });
        res.writeHead(response.status, { "content-type": "application/json" });
        res.end(responseText);
        return;
      }
      if (scenario === "revoked" && !takeover) {
        const deadline = Date.now() + 8_000;
        while (!readEvents(ghTrace).some((entry) => entry.event === "metadata-ready") && Date.now() < deadline) await delay(10);
        assert.ok(readEvents(ghTrace).some((entry) => entry.event === "metadata-ready"), "lease takeover must follow real CLI metadata access");
        const changed = await queue.fetch(new Request("https://queue/claim", { method: "POST", body: JSON.stringify({ item_key: itemKey, lease_id: leased.leaseId, lease_revision: 1, run_id: runId, run_attempt: 2 }) }));
        assert.equal(changed.status, 200);
        takeover = await changed.json() as Record<string, unknown>;
        assert.equal(takeover.claim_generation, 2);
      }
      const response = await queue.fetch(new Request("https://queue/heartbeat", { method: "POST", body: bytes }));
      queueTrace.push({ body, status: response.status });
      res.writeHead(response.status, { "content-type": "application/json" });
      res.end(await response.text());
    } catch (error) {
      serverError = error;
      res.writeHead(400); res.end("fixture transport failure");
    }
  });
  await new Promise<void>((accept) => server.listen(0, "127.0.0.1", accept));
  let group: number | undefined;
  let timedOut = false;
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const queueUrl = `http://127.0.0.1:${address.port}`;
    const values: Record<string, string> = {
      "steps.live-item.outputs.pr_admission_file": "", "steps.live-item.outputs.oversized": "false",
      "steps.target-read-token.outputs.token": "synthetic-read-token",
      "fromJSON(steps.claim-exact-review-queue.outputs.decision).additionalPrompt || ''": "",
      "vars.CLAWSWEEPER_RELATED_GITHUB_SEARCH || '1'": "0",
      // Unset repository variable: use the fixed upstream's declared fallback.
      "vars.CLAWSWEEPER_CODEX_REASONING_EFFORT || 'high'": "high",
      "steps.claim-exact-review-queue.outputs.item_key": itemKey,
      "fromJSON(steps.claim-exact-review-queue.outputs.decision).itemKind": "pull_request",
      "steps.claim-exact-review-queue.outputs.lease_id": leased.leaseId,
      "steps.claim-exact-review-queue.outputs.lease_revision": "1",
      "steps.claim-exact-review-queue.outputs.claim_generation": "1",
      "fromJSON(steps.claim-exact-review-queue.outputs.decision).sourceHeadSha || ''": head,
      "vars.CLAWSWEEPER_EXACT_REVIEW_QUEUE_URL || 'https://clawsweeper.openclaw.ai'": queueUrl,
      "vars.CLAWSWEEPER_EXACT_REVIEW_QUEUE_URL": queueUrl,
      "steps.reserve-exact-review-lease.outputs.owner": leaseOwner,
      "steps.reserve-exact-review-lease.outputs.comment_id": "41010",
      "fromJSON(steps.claim-exact-review-queue.outputs.decision).sourceAction || ''": "manual_explicit_review",
      "steps.claim-exact-review-queue.outputs.decision": JSON.stringify(decision),
      "steps.target.outputs.target_repo": targetRepo, "steps.target.outputs.target_checkout_dir": target,
      "steps.target.outputs.item_number": "41", "steps.target.outputs.codex_timeout_ms": "10000",
      "steps.target.outputs.media_proof_timeout_ms": "0",
    };
    const render = (value: string) => String(value).replace(/\$\{\{\s*([\s\S]*?)\s*\}\}/g, (_match, expression: string) => {
      assert.ok(Object.hasOwn(values, expression.trim()), `unfrozen executor expression: ${expression}`);
      return values[expression.trim()];
    });
    const declaredEnv = Object.fromEntries(Object.entries({ ...inheritedEnv, ...step.env }).map(([key, value]) => [key, render(value)]));
    const fixtures = resolve("test/fixtures");
    const env = {
      PATH: process.env.PATH, HOME: root, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0",
      GITHUB_RUN_ID: runId, GITHUB_RUN_ATTEMPT: "1", RUNNER_TEMP: root, GITHUB_OUTPUT: output,
      NODE_OPTIONS: `--import=${pathToFileURL(join(fixtures, "openclaw3-executor-observer.mjs")).href}`,
      GH_BIN: process.execPath, GH_BIN_ARGS: JSON.stringify([join(fixtures, "openclaw3-executor-gh.mjs")]),
      CODEX_BIN: modelSentinel,
      OC3_EXPECTED_CLI: join(work, "dist/clawsweeper.js"), OC3_CLI_TRACE: cliTrace,
      OC3_GH_TRACE: ghTrace, OC3_MODEL_TRACE: modelTrace, OC3_SCENARIO: scenario, OC3_TARGET_REPO: targetRepo,
      ...declaredEnv,
    };
    const child = spawn("/bin/bash", ["--noprofile", "--norc", "-e", "-o", "pipefail", "-c", render(step.run!)], { cwd: work, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    group = child.pid;
    let stdout = "", stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    // Upstream cleanup kills the heartbeat shell but may leave its sleep(60).
    // Only remove that outer group after the production shell itself has exited.
    child.once("exit", () => killGroup(group));
    const timer = setTimeout(() => {
      timedOut = true; killGroup(group);
      for (const entry of readEvents(cliTrace)) killGroup(entry.processGroup);
    }, 20_000);
    const code = await new Promise<number | null>((accept, reject) => { child.once("error", reject); child.once("close", accept); }).finally(() => clearTimeout(timer));
    assert.equal(timedOut, false, `hard deadline is a harness failure: ${stderr}`);
    assert.equal(serverError, undefined);
    const starts = readEvents(cliTrace);
    assert.equal(starts.length, 1, `exactly one real CLI must start: ${stderr}`);
    const observed = starts[0];
    assert.notEqual(observed.processGroup, group, "review group must be separate from outer heartbeat cleanup");
    const args = observed.argv!;
    const flag = (name: string) => args[args.indexOf(name) + 1];
    assert.equal(args[0], "review");
    for (const [name, value] of Object.entries({ "--target-repo": targetRepo, "--target-dir": target, "--item-numbers": "41", "--review-source-action": "manual_explicit_review", "--review-lease-owner": leaseOwner, "--review-lease-comment-id": "41010" })) { assert.ok(args.includes(name), name); assert.equal(flag(name), value, name); }
    for (const name of ["--readonly-openclaw", "--skip-start-comment"]) assert.ok(args.includes(name), name);
    assert.deepEqual(JSON.parse(observed.env!.EXACT_REVIEW_DECISION), decision);
    for (const [name, value] of Object.entries({ EXACT_REVIEW_ITEM_KEY: itemKey, EXACT_REVIEW_ITEM_KIND: "pull_request", EXACT_REVIEW_LEASE_ID: leased.leaseId, EXACT_REVIEW_LEASE_REVISION: "1", EXACT_REVIEW_CLAIM_GENERATION: "1", EXACT_REVIEW_SOURCE_HEAD_SHA: head, SOURCE_ACTION: "manual_explicit_review" })) assert.equal(observed.env![name], value, name);
    const github = readEvents(ghTrace);
    assert.ok(github.some((entry) => entry.event === "metadata-ready"), `real exact metadata access required: ${stderr}`);
    for (const entry of github.filter((entry) => entry.event === "metadata-ready")) {
      assert.equal(entry.processGroup, observed.processGroup, "metadata transport must belong to the real review group");
      assert.notEqual(entry.processGroup, group, "outer sleep cleanup must not stand in for production lease-loss termination");
    }
    assert.equal(github.some((entry) => entry.event === "unexpected-gh" || entry.event === "barrier-timeout"), false, JSON.stringify(github));
    assert.equal(readEvents(modelTrace).length, 0, "metadata-stage fixture must not launch a provider");
    assert.equal(readModelTrace.length, 1, "real CLI must perform its lease-scoped read-model lookup before gh fallback");
    assert.deepEqual(readModelTrace[0].body, { repository: targetRepo, number: 41, item_key: itemKey, lease_id: leased.leaseId, lease_revision: 1, claim_generation: 1, run_id: runId, run_attempt: 1, source_head_sha: head });
    assert.equal(readModelTrace[0].status, 200);
    for (const [name, value] of Object.entries({ ok: true, lease_authorized: true, hit: false, usable: false })) assert.equal(readModelTrace[0].snapshot[name], value, `real empty read-model ${name}`);
    assert.equal(Object.hasOwn(readModelTrace[0].snapshot, "item"), false);
    assert.ok(queueTrace.length >= 1, "actual executor must heartbeat its real queue lease");
    for (const entry of queueTrace) assert.deepEqual(entry.body, { item_key: itemKey, lease_id: leased.leaseId, lease_revision: 1, claim_generation: 1, run_id: runId, run_attempt: 1, source_head_sha: head });
    const result = readFileSync(output, "utf8");
    assert.equal(queueTrace.some((entry) => entry.body.phase === "finalizing"), false);
    if (scenario === "metadata-denied") {
      assert.equal(code, 1, stderr);
      assert.ok(github.some((entry) => entry.event === "metadata-denied"));
      assert.match(stderr, /OC3_EXECUTOR_METADATA_DENIED/);
      assert.match(result, /^exit_code=1$/m);
      assert.doesNotMatch(result, /^superseded=true$/m);
      assert.ok(queueTrace.every((entry) => entry.status === 200));
    } else {
      assert.equal(code, 0, stderr);
      assert.ok(takeover);
      assert.ok(queueTrace.some((entry) => entry.status === 409));
      assert.match(result, /^superseded=true$/m);
      assert.match(result, /^exit_code=0$/m);
      assert.ok(existsSync(join(root, `exact-review-superseded-${runId}-1`)));
      assert.match(stdout, /stopped because another worker owns/);
      for (const entry of [...starts, ...github.filter((entry) => entry.event === "metadata-ready")]) {
        const until = Date.now() + 1_000;
        while (active(entry.pid!) && Date.now() < until) await delay(10);
        assert.equal(active(entry.pid!), false, "production lease-loss path must stop the actual process before test cleanup");
      }
    }
  } finally {
    killGroup(group);
    for (const entry of [...readEvents(cliTrace), ...readEvents(ghTrace)]) killGroup(entry.processGroup);
    server.closeAllConnections();
    await new Promise<void>((accept) => server.close(() => accept()));
    storage.sql.close();
    restoreOwnedModes(target);
    rmSync(root, { recursive: true, force: true });
  }
}
for (const scenario of ["metadata-denied", "revoked"] as const) {
  test(`W3-A upstream control: real CLI handoff ${scenario}`, async () => { await execute(upstream, scenario); });
  test(`W3-A candidate: real CLI handoff ${scenario}`, async () => { await execute(candidate, scenario); });
}
