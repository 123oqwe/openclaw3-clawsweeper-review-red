import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import YAML from "yaml";

// Planner-owned configuration evidence, paired with the real publisher/Queue
// entrypoint suite. This does not assert live App permissions or Actions timing.
const sweep = YAML.parse(readFileSync("candidate/receiver/.github/workflows/sweep.yml", "utf8"));
const compact = (v: unknown) => String(v ?? "").replace(/\s+/g, "");
const expr = (v: string) => "${{" + compact(v) + "}}";
const C = "steps.publication-context.outputs";
const claimed = `${C}.claimed == 'true'`;
const deferred = `${C}.direct_lifecycle_recovery != 'true'`;
const valid = "steps.validate-exact-review-bundle.outcome == 'success'";
const published = "steps.publish-event-result.outcome == 'success'";
const verified = "steps.publish-event-result.outputs.remote_tuple_verified == 'true'";
const context = (field: string) => expr(`${C}.${field}`);
const queue = expr("vars.CLAWSWEEPER_EXACT_REVIEW_QUEUE_URL || 'https://clawsweeper.openclaw.ai'");
function job() {
  const j = sweep.jobs["event-review-publish"];
  assert.ok(j && Array.isArray(j.steps));
  assert.equal(j["continue-on-error"] ?? false, false);
  assert.deepEqual(j.permissions, { contents: "read", actions: "read" });
  return j;
}
function step(j: any, id: string) {
  const found = j.steps.filter((s: any) => s.id === id);
  assert.equal(found.length, 1, `missing/duplicate publisher topology: ${id}`);
  assert.equal(found[0]["working-directory"] || ".", ".");
  return found[0];
}
function guard(value: unknown, required: string[], optional: string[] = []) {
  const atoms = compact(value).replace(/^\$\{\{/, "").replace(/\}\}$/, "").split("&&");
  const allowed = new Set([...required, ...optional].map(compact));
  assert.ok(atoms.every((atom) => allowed.has(atom)), `unsupported/false guard: ${String(value)}`);
  for (const atom of required) assert.ok(atoms.includes(compact(atom)), `missing guard: ${atom}`);
}
function before(j: any, a: any, b: any) { assert.ok(j.steps.indexOf(a) < j.steps.indexOf(b), `${a.id} must precede ${b.id}`); }
function env(s: any, expected: Record<string, string>) {
  for (const [key, value] of Object.entries(expected)) assert.equal(compact(s.env?.[key]), compact(value), `${s.id}/${key}`);
}
function noIgnoredFailure(s: any) { assert.equal(s["continue-on-error"] ?? false, false, `${s.id} must expose failure`); }
function referencesExist(j: any, s: any) {
  const prior = new Set(j.steps.slice(0, j.steps.indexOf(s)).map((v: any) => v.id));
  for (const match of JSON.stringify(s).matchAll(/\bsteps\.([A-Za-z0-9_-]+)\.(?:outputs|outcome)\b/g))
    assert.ok(prior.has(match[1]), `${s.id} references missing/later producer ${match[1]}`);
}

test("R06-C publisher builds the real runtime and stages only the validated selected report", () => {
  const j = job(), checkout = step(j, "source-checkout"), build = step(j, "setup-publish-pnpm");
  const download = step(j, "download-exact-review-bundle"), validate = step(j, "validate-exact-review-bundle");
  const stage = step(j, "stage-validated-exact-review-artifact"), hydrate = step(j, "setup-state"), publish = step(j, "publish-event-result");
  assert.match(checkout.uses, /^actions\/checkout@/); assert.equal(checkout.with["persist-credentials"], false);
  assert.equal(compact(checkout.with.ref), expr("github.sha"));
  assert.ok(!checkout.with.repository || compact(checkout.with.repository) === expr("github.repository"));
  assert.equal(build.uses, "./.github/actions/setup-pnpm"); assert.equal(build.with["build-script"], "build:node");
  for (const s of [checkout, build]) { guard(s.if, [claimed, deferred]); noIgnoredFailure(s); }
  for (const [a, b] of [[checkout, build], [build, download], [download, validate], [validate, stage], [stage, hydrate], [hydrate, publish]]) before(j, a, b);
  guard(stage.if, [claimed, deferred, valid]); noIgnoredFailure(stage); assert.ok(stage.run);
  assert.equal(hydrate.uses, "./.github/actions/setup-state"); guard(hydrate.if, [claimed, deferred, valid], ["steps.stage-validated-exact-review-artifact.outcome == 'success'"]);
  noIgnoredFailure(hydrate);
  assert.equal(String(hydrate.with["hydrate-records"] ?? "true"), "true", "selected records hydration cannot be disabled");
  for (const key of ["hydrate-git-state", "hydrate-state-blobs", "persist-credentials"]) assert.equal(String(hydrate.with[key]), "false", key);
  assert.equal(compact(hydrate.with["records-repo-slugs"]), context("target_slug"));
  assert.equal(compact(hydrate.with["records-item-number"]), context("item_number"));
  assert.equal(compact(hydrate.with["records-secret"]), expr("secrets.CLAWSWEEPER_WEBHOOK_SECRET"));
  for (const key of ["records-url", "coordinator-url"]) assert.equal(compact(hydrate.with[key]), queue);
  for (const s of [stage, hydrate, publish]) referencesExist(j, s);
});

test("R06-C actual publisher uses only restricted identity and the current publisher owner tuple", () => {
  const j = job(), mint = step(j, "reviewer-token"), publish = step(j, "publish-event-result");
  before(j, step(j, "validate-exact-review-bundle"), mint); before(j, mint, publish);
  assert.equal(j.steps.filter((s: any) => s.uses?.startsWith("actions/create-github-app-token@")).length, 1, "do not restore broad upstream write tokens");
  assert.deepEqual(Object.fromEntries(Object.entries(mint.with).filter(([k]) => k.startsWith("permission-"))), { "permission-issues": "write" });
  guard(publish.if, [claimed, deferred, valid, "steps.reviewer-token.outcome == 'success'", "steps.setup-state.outcome == 'success'"], ["steps.stage-validated-exact-review-artifact.outcome == 'success'"]);
  noIgnoredFailure(publish);
  assert.match(publish.run || "", /pnpm\s+run\s+(?:--silent\s+)?repair:publish-event-result\b/);
  env(publish, {
    CLAWSWEEPER_WEBHOOK_SECRET: expr("secrets.CLAWSWEEPER_WEBHOOK_SECRET"),
    GH_TOKEN: expr("steps.reviewer-token.outputs.token"), TARGET_REPO: context("target_repo"), ITEM_NUMBER: context("item_number"),
    REVIEW_ONLY: "true", EXACT_EVENT_PUBLICATION: "true", EXACT_REVIEW_CLOSE_COVERAGE_DEFERRED: "true",
    EXACT_REVIEW_DECISION: context("decision"), EXACT_REVIEW_QUEUE_URL: queue,
    EXACT_REVIEW_LEASE_ID: context("publisher_lease_id"), EXACT_REVIEW_ITEM_KEY: context("publisher_item_key"),
    EXACT_REVIEW_LEASE_REVISION: context("publisher_lease_revision"), EXACT_REVIEW_CLAIM_GENERATION: context("publisher_claim_generation"),
    LIVE_PROCEEDED: context("live_proceeded"), LIVE_TERMINAL_NOOP: context("live_terminal_noop"),
    LIVE_TERMINAL_MISSING: context("live_terminal_missing"), LIVE_GUARDED_OPEN: context("live_guarded_open"),
  });
  for (const s of j.steps) assert.doesNotMatch(String(s.run || ""), /gh\s+(?:pr\s+merge|issue\s+close|workflow\s+run\s+repair-comment-router)|--method\s+(?:PUT|POST)\s+[^\n]*(?:\/labels|\/reactions|\/merge)/, "review-only must not add unrelated mutation steps");
  for (const scope of [sweep.env, j.env]) assert.doesNotMatch(JSON.stringify(scope || {}), /secrets\.|GH_TOKEN|REPO_TOKEN/);
  referencesExist(j, publish);
});

test("R06-C lifecycle receipts follow verified canonical publication and use publisher fences", () => {
  const j = job(), publish = step(j, "publish-event-result");
  const canonical = step(j, "record-fallback-canonical-lifecycle-receipt"), noRouter = step(j, "record-no-router-lifecycle-receipt");
  before(j, publish, canonical); before(j, canonical, noRouter);
  guard(canonical.if, [claimed, deferred, published, verified]);
  guard(noRouter.if, [claimed, deferred, published, verified, "steps.record-fallback-canonical-lifecycle-receipt.outcome == 'success'"]);
  for (const s of [canonical, noRouter]) {
    noIgnoredFailure(s); referencesExist(j, s);
    env(s, { TARGET_REPO: context("target_repo"), ITEM_NUMBER: context("item_number"), FENCE_KEY: context("publisher_item_key"), REVISION: context("publisher_lease_revision"), QUEUE_URL: queue, CLAWSWEEPER_WEBHOOK_SECRET: expr("secrets.CLAWSWEEPER_WEBHOOK_SECRET") });
  }
});

test("R06-C ordinary publisher closes its own queue lifecycle and propagates unsuccessful completion", () => {
  const j = job(), result = step(j, "exact-review-publication-result"), complete = step(j, "complete-exact-review-publication");
  const failed = step(j, "fail-exact-review-publication");
  before(j, step(j, "record-no-router-lifecycle-receipt"), result); before(j, result, complete); before(j, complete, failed);
  for (const s of [result, complete]) { guard(s.if, [claimed, deferred, "always()"]); referencesExist(j, s); assert.ok(s.run); }
  noIgnoredFailure(result); noIgnoredFailure(failed);
  env(result, { PRIOR_JOB_STATUS: expr("job.status"), PUBLISH_OUTCOME: expr("steps.publish-event-result.outcome"), PUBLISH_COMPLETION_KIND: expr("steps.publish-event-result.outputs.completion_kind"), PUBLISH_REASON_CODE: expr("steps.publish-event-result.outputs.reason_code") });
  env(complete, { CLAIM_GENERATION: context("publisher_claim_generation"), ITEM_KEY: context("publisher_item_key"), LEASE_REVISION: context("publisher_lease_revision"), QUEUE_LEASE_ID: context("publisher_lease_id"), RUN_ATTEMPT: expr("github.run_attempt"), QUEUE_URL: queue, OUTCOME: expr("steps.exact-review-publication-result.outputs.outcome || 'failure'") });
  assert.equal(compact(failed.if), expr(`always() && ${claimed} && ${deferred} && (steps.exact-review-publication-result.outputs.outcome != 'success' || steps.complete-exact-review-publication.outcome != 'success')`), "either primary failure or completion failure must fail the job");
  assert.match(failed.run || "", /\bexit\s+1\b/); referencesExist(j, failed);
});
