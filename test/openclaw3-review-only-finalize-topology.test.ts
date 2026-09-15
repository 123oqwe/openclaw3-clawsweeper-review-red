import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import YAML from "yaml";

// R06-B topology only: this frozen conjunction grammar is not an Actions
// interpreter. Queue/CLI behavior and actual GH cleanup have separate suites.
const root = resolve(process.env.OC3_REVIEW_CANDIDATE_DIR || "candidate/receiver");
const sweep = YAML.parse(readFileSync(join(root, ".github/workflows/sweep.yml"), "utf8"));
const compact = (s: unknown) => String(s ?? "").replace(/\s+/g, "");
const expr = (s: string) => "${{" + compact(s) + "}}";
const C = "steps.finalize-preparation-context.outputs";
const claimed = `${C}.claimed == 'true'`;
const first = "steps.fence-finalize-authority.outputs.authorized == 'true'";
const current = "steps.claim-finalize-authority.outputs.claimed == 'true'";
const last = "steps.fence-finalize-handoff.outputs.authorized == 'true'";
const fresh = "steps.fresh-finalize-live.outcome == 'success'";
const proceed = "steps.fresh-finalize-live.outputs.proceed == 'true'";
const noRetry = "steps.fresh-finalize-live.outputs.admission_retry != 'true'";
const posted = `${C}.reservation_status == 'posted'`;
const modelSuccess = "needs.event-review-apply.result == 'success'";
const downloaded = "steps.download-finalize-bundle.outcome == 'success'";
const valid = "steps.validate-finalize-bundle.outcome == 'success'";
const completed = "steps.exact-review-generation-result.outputs.completion_required == 'true'";
const cleanupWanted = "steps.exact-review-generation-result.outputs.cleanup_mode != 'none'";
const buildSuccess = "steps.setup-pnpm.outcome == 'success'";
const eventAtoms = ["always()", "github.event_name == 'repository_dispatch'", "github.event.client_payload.queue_lease_id != ''", "github.event.client_payload.source_action == 'manual_explicit_review'"];
function guard(value: unknown, required: string[], optional: string[] = []) {
  const atoms = compact(value).replace(/^\$\{\{/, "").replace(/\}\}$/, "").split("&&");
  const allowed = new Set([...required, ...optional].map(compact));
  assert.ok(atoms.every((a) => allowed.has(a)), `unsupported/false/OR boundary ${value}`);
  for (const atom of required) assert.ok(atoms.includes(compact(atom)), `missing boundary ${atom}`);
}
function job() {
  const result = sweep.jobs?.["event-review-finalize"];
  assert.ok(result && Array.isArray(result.steps), "missing topology: event-review-finalize");
  assert.equal(result["continue-on-error"] ?? false, false);
  return result;
}
function step(j: any, id: string) {
  const matches = j.steps.filter((s: any) => s.id === id);
  assert.equal(matches.length, 1, `require unique ${id}`);
  const value = matches[0];
  assert.equal(value["continue-on-error"] ?? false, false, `${id} must propagate failure`);
  assert.equal(value["working-directory"] || ".", ".");
  return value;
}
function env(s: any, expected: Record<string, string>, optional: Record<string, string> = {}) {
  for (const key of Object.keys(s.env || {})) assert.ok(Object.hasOwn(expected, key) || Object.hasOwn(optional, key), `undeclared interface env ${key}`);
  for (const [key, value] of Object.entries(expected)) assert.equal(compact(s.env?.[key]), compact(value), key);
  for (const [key, value] of Object.entries(optional)) if (Object.hasOwn(s.env || {}, key)) assert.equal(compact(s.env[key]), compact(value), key);
}
const context = (output: string) => expr(`${C}.${output}`);
const queue = expr("vars.CLAWSWEEPER_EXACT_REVIEW_QUEUE_URL");
const freshOutput = (name: string) => expr(`steps.fresh-finalize-live.outputs.${name}`);
const resultOutput = (name: string) => expr(`steps.exact-review-generation-result.outputs.${name}`);
function before(j: any, a: any, b: any) { assert.ok(j.steps.indexOf(a) < j.steps.indexOf(b), `${a.id || a.name} must precede ${b.id || b.name}`); }
function sourceBuild(j: any, claim: any, download: any) {
  assert.equal(j.defaults?.run?.["working-directory"] || sweep.defaults?.run?.["working-directory"] || ".", ".");
  const checkouts = j.steps.filter((s: any) => s.uses?.startsWith("actions/checkout@"));
  assert.equal(checkouts.length, 1, "finalizer has one trusted executable checkout, never target/artifact checkout");
  const checkout = checkouts[0]; assert.equal(checkout.id, "source-checkout", "reuse the upstream source-checkout ID shared with the dynamic suite");
  before(j, claim, checkout); before(j, checkout, download);
  assert.ok(!checkout.with?.repository || compact(checkout.with.repository) === expr("github.repository"));
  assert.equal(compact(checkout.with?.ref), expr("github.sha"));
  assert.equal(checkout.with?.path || ".", "."); assert.equal(checkout.with?.["persist-credentials"], false);
  assert.equal(checkout["continue-on-error"] ?? false, false);
  guard(checkout.if, [current], [first, claimed]);
  const build = step(j, "setup-pnpm"); before(j, checkout, build); before(j, build, download);
  assert.equal(build.uses, "./.github/actions/setup-pnpm");
  assert.ok(["build:node", "build:all"].includes(build.with?.["build-script"]), "main marker modules and real repair CLI must both exist");
  assert.equal(build.with?.["working-directory"] || ".", "."); guard(build.if, [current], [first, claimed]);
  return { checkout, build };
}

test("R06-B finalizer waits for both jobs and fences old authority before claim or executable checkout", () => {
  const j = job(); guard(j.if, eventAtoms);
  assert.ok(Array.isArray(j.needs), "finalizer needs must name both actual jobs");
  assert.deepEqual([...j.needs].sort(), ["event-review-apply", "event-review-prepare"]);
  assert.deepEqual(j.permissions, { contents: "read", actions: "read" });
  assert.doesNotMatch(JSON.stringify({ workflowEnv: sweep.env, jobEnv: j.env }), /secrets\.|private-key|WEBHOOK_SECRET|RECORDS_SECRET|target-write-token|toJSON\(secrets|secrets\[/);
  const c = step(j, "finalize-preparation-context"), fence = step(j, "fence-finalize-authority"), claim = step(j, "claim-finalize-authority");
  if (c.if !== undefined) guard(c.if, ["always()"]);
  env(c, { PREPARATION_RECEIPT: expr("toJSON(needs.event-review-prepare.outputs)"), PREPARE_RESULT: expr("needs.event-review-prepare.result"), MODEL_RESULT: expr("needs.event-review-apply.result") });
  before(j, c, fence); before(j, fence, claim); guard(fence.if, [claimed]); guard(claim.if, [first], [claimed]);
  const fenceEnv = { PREPARATION_CONTEXT: expr("toJSON(steps.finalize-preparation-context.outputs)"), QUEUE_URL: queue, RUN_ATTEMPT: expr("github.run_attempt") };
  env(fence, fenceEnv); env(step(j, "fence-finalize-handoff"), fenceEnv);
  env(claim, { ITEM_KEY: context("item_key"), QUEUE_LEASE_ID: context("lease_id"), QUEUE_LEASE_REVISION: context("lease_revision"), QUEUE_URL: queue, RUN_ATTEMPT: expr("github.run_attempt"), PREPARATION_CONTEXT: expr("toJSON(steps.finalize-preparation-context.outputs)") }, { DISPATCH_PAYLOAD: expr("toJSON(github.event.client_payload)") });
  const earlier = j.steps.slice(0, j.steps.indexOf(fence));
  const helper = earlier.find((s: any) => /raw\.githubusercontent\.com\/\$\{GITHUB_REPOSITORY\}\/\$\{GITHUB_SHA\}\/scripts\/control-plane-curl\.sh/.test(s.run || ""));
  assert.ok(helper, "first fence fetches the existing helper at this receiver's immutable runtime SHA before checkout");
  assert.match(helper.run, /RUNNER_TEMP[\s\S]*control-plane-curl\.sh/);
  assert.match(helper.run, /test\s+-s/); assert.equal(helper["continue-on-error"] ?? false, false);
  if (helper.if !== undefined) guard(helper.if, [claimed]);
  for (const s of earlier) assert.doesNotMatch(JSON.stringify(s), /\/internal\/exact-review\/(?:claim|enqueue)|create-github-app-token|CLAWSWEEPER_WEBHOOK_SECRET/);
  assert.match(fence.run, /\/internal\/exact-review\/heartbeat/); assert.match(claim.run, /\/internal\/exact-review\/claim/);
});

test("R06-B trusted build and fresh live supply bundle expectations before signed handoff", () => {
  const j = job(), claim = step(j, "claim-finalize-authority"), live = step(j, "fresh-finalize-live");
  const download = step(j, "download-finalize-bundle"), validate = step(j, "validate-finalize-bundle"), fence = step(j, "fence-finalize-handoff");
  const { build } = sourceBuild(j, claim, download); before(j, build, live); before(j, live, download); before(j, download, validate); before(j, validate, fence);
  guard(live.if, [current], [first, claimed, buildSuccess]);
  env(live, { CLAIM_DECISION: context("decision"), RAW_CLAIM_DECISION: context("raw_decision"), TARGET_REPO: context("target_repo"), ITEM_NUMBER: context("item_number"), CLAIM_TARGET_BRANCH: context("target_branch"), RESERVATION_HEAD_SHA: context("reservation_head_sha"), GH_TOKEN: expr("secrets.CLAWSWEEPER_TARGET_READ_TOKEN") });
  const eligible = [current, posted, modelSuccess, fresh, proceed, noRetry];
  guard(download.if, eligible, [first, claimed, buildSuccess, "!cancelled()"]);
  assert.equal(download.uses, "actions/download-artifact@v8");
  assert.deepEqual(Object.keys(download.with || {}).sort(), ["github-token", "name", "path", "repository", "run-id"]);
  for (const [key, value] of Object.entries({ name: `exact-review-${expr("github.run_id")}-${expr("github.run_attempt")}`, path: ".artifacts/exact-review-bundle", "run-id": expr("github.run_id"), repository: expr("github.repository"), "github-token": expr("github.token") }))
    assert.equal(compact(download.with[key]), compact(value), key);
  guard(validate.if, [...eligible, downloaded], [first, claimed, buildSuccess, "!cancelled()"]);
  const fields: Record<string, string> = { CLAIM_GENERATION: "claim_generation", DECISION: "decision", ITEM_KEY: "item_key", ITEM_KIND: "item_kind", ITEM_NUMBER: "item_number", LEASE_REVISION: "lease_revision", PROTOCOL_VERSION: "protocol_version", TARGET_BRANCH: "target_branch", TARGET_REPO: "target_repo" };
  env(validate, {
    EXACT_REVIEW_BUNDLE_DIR: ".artifacts/exact-review-bundle", EXACT_REVIEW_PRODUCER_JOB: "event-review-apply",
    EXACT_REVIEW_PRODUCER_RUN_ID: expr("github.run_id"), EXACT_REVIEW_GENERATION_ATTEMPT: expr("github.run_attempt"), EXACT_REVIEW_SOURCE_SHA: expr("github.sha"),
    ...Object.fromEntries(Object.entries(fields).map(([key, value]) => [`EXACT_REVIEW_${key}`, context(value)])),
    EXACT_REVIEW_LIVE_GUARDED_OPEN: freshOutput("guarded_open"), EXACT_REVIEW_LIVE_PROCEEDED: freshOutput("proceed"), EXACT_REVIEW_LIVE_TERMINAL_MISSING: freshOutput("terminal_missing"), EXACT_REVIEW_LIVE_TERMINAL_NOOP: freshOutput("terminal_noop"),
  });
  assert.equal(String(validate.run).trim(), "pnpm run --silent repair:exact-review-bundle validate");
  guard(fence.if, ["always()", first, current], [claimed]);
  assert.match(fence.run, /\/internal\/exact-review\/heartbeat/);
  for (const s of j.steps) {
    for (const m of JSON.stringify(s).matchAll(/\bsteps\.([A-Za-z0-9_-]+)\.(?:outputs|outcome)\b/g)) {
      const producer = j.steps.find((p: any) => p.id === m[1]); assert.ok(producer, `missing producer ${m[1]}`); before(j, producer, s);
    }
    assert.doesNotMatch(JSON.stringify(s), /needs\.event-review-apply\.outputs\./, "model outputs cannot supply finalizer authority");
    assert.doesNotMatch(JSON.stringify(s), /setup-codex|setup-openclaw|\bpnpm\s+(?:run\s+)?review\b|repair:publish-event-result|repair:exact-review-direct-publication/);
    assert.doesNotMatch(s.run || "", /(?:\b(?:node|bash|sh|source)\s+|\bimport\s*[('])["']?\.artifacts\//,
      "downloaded artifact content is data, never an executable source");
  }
});

test("R06-B only guarded handoff and exact owner cleanup hold privileged credentials", () => {
  const j = job(), enqueue = step(j, "queue-exact-review-publication"), terminal = step(j, "record-finalize-terminal"), result = step(j, "exact-review-generation-result");
  const fence = step(j, "fence-finalize-handoff"), mint = step(j, "finalize-cleanup-token"), cleanup = step(j, "finalize-owner-cleanup");
  before(j, fence, enqueue); before(j, fence, terminal); before(j, enqueue, result); before(j, terminal, result); before(j, result, mint); before(j, mint, cleanup);
  guard(enqueue.if, [last, valid, fresh, proceed, noRetry], ["always()", "!cancelled()", current, first, claimed, posted, modelSuccess]);
  guard(terminal.if, [last, fresh, "steps.fresh-finalize-live.outputs.terminal_disposition != ''"], ["always()", "!cancelled()", current, first, claimed]);
  for (const s of [enqueue, terminal]) assert.equal(compact(s.env?.CLAWSWEEPER_WEBHOOK_SECRET), expr("secrets.CLAWSWEEPER_WEBHOOK_SECRET"));
  assert.equal(compact(enqueue.env?.CLAIM_DECISION), context("decision"));
  assert.equal(compact(enqueue.env?.ARTIFACT_NAME), compact(`exact-review-${expr("github.run_id")}-${expr("github.run_attempt")}`));
  assert.equal(compact(terminal.env?.LIFECYCLE_TERMINAL), freshOutput("terminal_disposition"));
  assert.match(enqueue.run || "", /\/internal\/exact-review\/enqueue/); assert.match(terminal.run || "", /\/internal\/exact-review\/lifecycle\/terminal-disposition/);
  const cleanupAtoms = ["always()", last, posted, cleanupWanted, buildSuccess];
  guard(mint.if, cleanupAtoms, [first, current, claimed]); guard(cleanup.if, cleanupAtoms, [first, current, claimed]);
  assert.equal(mint.uses, "actions/create-github-app-token@bcd2ba49218906704ab6c1aa796996da409d3eb1");
  assert.equal(compact(mint.with?.["client-id"]), expr("env.CLAWSWEEPER_APP_CLIENT_ID"));
  assert.equal(compact(mint.with?.["private-key"]), expr("secrets.CLAWSWEEPER_APP_PRIVATE_KEY"));
  assert.equal(compact(mint.with?.owner), context("target_repo_owner")); assert.equal(compact(mint.with?.repositories), context("target_repo_name"));
  assert.ok(!Object.hasOwn(mint.with || {}, "app-id"));
  assert.deepEqual(Object.fromEntries(Object.entries(mint.with || {}).filter(([k]) => k.startsWith("permission-"))), { "permission-issues": "write" });
  env(cleanup, { TARGET_REPO: context("target_repo"), ITEM_NUMBER: context("item_number"), RESERVATION_STATUS: context("reservation_status"), RESERVATION_OWNER: context("reservation_owner"), RESERVATION_COMMENT_ID: context("reservation_comment_id"), RESERVATION_HEAD_SHA: context("reservation_head_sha"), CLEANUP_MODE: resultOutput("cleanup_mode"), GH_TOKEN: expr("steps.finalize-cleanup-token.outputs.token") });
  for (const s of j.steps) {
    if (![enqueue, terminal].includes(s)) assert.doesNotMatch(JSON.stringify(s), /CLAWSWEEPER_WEBHOOK_SECRET|CLAWSWEEPER_RECORDS_SECRET/);
    if (s !== mint) assert.doesNotMatch(JSON.stringify(s), /CLAWSWEEPER_APP_PRIVATE_KEY|create-github-app-token|private-key/);
    if (s !== cleanup) assert.doesNotMatch(JSON.stringify(s), /steps\.finalize-cleanup-token\.outputs\.token/);
    for (const m of JSON.stringify(s).matchAll(/secrets\.([A-Za-z0-9_]+)/g))
      assert.ok(["CLAWSWEEPER_WEBHOOK_SECRET", "CLAWSWEEPER_APP_PRIVATE_KEY", "CLAWSWEEPER_TARGET_READ_TOKEN"].includes(m[1]));
    assert.doesNotMatch(JSON.stringify(s), /secrets\s*\[|toJSON\(\s*secrets/);
  }
});

test("R06-B completion preserves primary outcome and the final gate reports auxiliary failure", () => {
  const j = job(), result = step(j, "exact-review-generation-result"), cleanup = step(j, "finalize-owner-cleanup"), complete = step(j, "complete-exact-review-queue"), fail = step(j, "fail-finalize");
  before(j, result, cleanup); before(j, cleanup, complete); before(j, complete, fail);
  guard(result.if, ["always()"]); guard(complete.if, ["always()", completed]); guard(fail.if, ["always()"]);
  assert.equal(j.steps.at(-1), fail, "failure propagation is the final step");
  assert.equal(compact(result.env?.CLAIMED), context("claimed"));
  assert.equal(compact(result.env?.FIRST_FENCE_OUTCOME), expr("steps.fence-finalize-authority.outcome"));
  assert.equal(compact(result.env?.HANDOFF_FENCE_OUTCOME), expr("steps.fence-finalize-handoff.outcome"));
  assert.doesNotMatch(JSON.stringify(result), /steps\.finalize-owner-cleanup\./, "primary result cannot depend on its later cleanup consumer");
  assert.equal(compact(complete.env?.PRIMARY_OUTCOME), expr("steps.exact-review-generation-result.outputs.outcome || 'failure'"));
  assert.equal(compact(complete.env?.LIFECYCLE_TERMINAL_DISPOSITION), resultOutput("lifecycle_terminal_disposition"));
  for (const [key, value] of Object.entries({ CLAIM_GENERATION: "claim_generation", ITEM_KEY: "item_key", PROTOCOL_VERSION: "protocol_version", QUEUE_LEASE_ID: "lease_id", QUEUE_LEASE_REVISION: "lease_revision" })) assert.equal(compact(complete.env?.[key]), context(value));
  const checkout = j.steps.find((s: any) => s.uses?.startsWith("actions/checkout@"));
  assert.ok(checkout?.id); assert.equal(compact(complete.env?.SOURCE_CHECKOUT_OUTCOME), expr(`steps.${checkout.id}.outcome`));
  assert.match(complete.run || "", /\/internal\/exact-review\/complete/);
  env(fail, { PRIMARY_FAILED: resultOutput("failed"), COMPLETION_REQUIRED: resultOutput("completion_required"), COMPLETE_OUTCOME: expr("steps.complete-exact-review-queue.outcome"), CLEANUP_OUTCOME: expr("steps.finalize-owner-cleanup.outcome") });
  assert.ok(String(fail.run || "").trim(), "actual failure gate required; dynamic suite checks its exit status");
});
