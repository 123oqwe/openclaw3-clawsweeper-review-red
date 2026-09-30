import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import YAML from "yaml";

// Planner-owned wiring evidence. Runtime cases execute these real shell bodies
// against the existing Worker/Queue; this file does not simulate Actions timing.
const sweep = YAML.parse(readFileSync("candidate/receiver/.github/workflows/sweep.yml", "utf8"));
const compact = (v: unknown) => String(v ?? "").replace(/\s+/g, "");
const expr = (v: string) => "${{" + compact(v) + "}}";
const C = "steps.publication-context.outputs";
const claimed = `${C}.claimed == 'true'`;
const direct = `${C}.direct_lifecycle_recovery == 'true'`;
const ordinary = `${C}.direct_lifecycle_recovery != 'true'`;
const context = (field: string) => expr(`${C}.${field}`);
const queue = expr("vars.CLAWSWEEPER_EXACT_REVIEW_QUEUE_URL || 'https://clawsweeper.openclaw.ai'");
const output = (field: string) => expr(`steps.replay-direct-lifecycle.outputs.${field}`);
function job() {
  const j = sweep.jobs["event-review-publish"];
  assert.ok(j && Array.isArray(j.steps));
  assert.deepEqual(j.permissions, { contents: "read", actions: "read" });
  assert.equal(j["continue-on-error"] ?? false, false);
  return j;
}
function step(j: any, id: string) {
  const matches = j.steps.filter((s: any) => s.id === id);
  assert.equal(matches.length, 1, `missing/duplicate direct recovery step: ${id}`);
  const s = matches[0];
  assert.equal(s["continue-on-error"] ?? false, false, `${id} must expose failure`);
  assert.equal(s["working-directory"] || ".", ".");
  return s;
}
function guard(s: any, atoms: string[]) {
  assert.equal(compact(s.if), expr(atoms.join(" && ")), `${s.id} guard`);
}
function env(s: any, fields: Record<string, string>) {
  for (const [key, value] of Object.entries(fields)) assert.equal(compact(s.env?.[key]), compact(value), `${s.id}/${key}`);
}
function before(j: any, a: any, b: any) {
  assert.ok(j.steps.indexOf(a) < j.steps.indexOf(b), `${a.id} must precede ${b.id}`);
}
function priorReferences(j: any, s: any) {
  const prior = new Set(j.steps.slice(0, j.steps.indexOf(s)).map((v: any) => v.id));
  for (const ref of JSON.stringify(s).matchAll(/\bsteps\.([A-Za-z0-9_-]+)\.(?:outputs|outcome)\b/g))
    assert.ok(prior.has(ref[1]), `${s.id} references missing/later ${ref[1]}`);
}

test("R06-D replay uses persisted claimed lifecycle with current owner and no GitHub token", () => {
  const j = job(), claim = step(j, "publication-context"), replay = step(j, "replay-direct-lifecycle");
  guard(replay, [claimed, direct]); before(j, claim, replay); before(j, replay, step(j, "source-checkout"));
  priorReferences(j, replay); assert.ok(replay.run);
  env(replay, {
    TARGET_REPO: context("target_repo"), ITEM_NUMBER: context("item_number"),
    FENCE_KEY: context("publisher_item_key"), REVISION: context("publisher_lease_revision"),
    CLAIM_DECISION: context("decision"), DIRECT_LIFECYCLE_PLAN: context("direct_lifecycle_plan"),
    DIRECT_LIFECYCLE_RECEIPT_OUTCOME: context("direct_lifecycle_receipt_outcome"),
    QUEUE_LEASE_ID: context("publisher_lease_id"), ITEM_KEY: context("publisher_item_key"),
    LEASE_REVISION: context("publisher_lease_revision"), CLAIM_GENERATION: context("publisher_claim_generation"),
    RUN_ATTEMPT: expr("github.run_attempt"), QUEUE_URL: queue,
    CLAWSWEEPER_WEBHOOK_SECRET: expr("secrets.CLAWSWEEPER_WEBHOOK_SECRET"),
  });
  assert.deepEqual(Object.keys(replay.env || {}).filter((key) => /(?:TOKEN|APP_PRIVATE|MODEL|OPENAI|ANTHROPIC)/.test(key)), []);
  assert.match(replay.run, /\$RUNNER_TEMP\/control-plane-curl\.sh/);
  assert.doesNotMatch(replay.run, /\b(?:gh|pnpm|npm)\s|scripts\/control-plane-curl\.sh|dist\//);
});

test("R06-D direct recovery remains independent from ordinary artifact and comment publication", () => {
  const j = job();
  for (const id of ["source-checkout", "setup-publish-pnpm", "download-exact-review-bundle", "validate-exact-review-bundle", "stage-validated-exact-review-artifact", "reviewer-token", "setup-state", "publish-event-result", "record-fallback-canonical-lifecycle-receipt", "record-no-router-lifecycle-receipt", "exact-review-publication-result", "complete-exact-review-publication", "fail-exact-review-publication"]) {
    const s = step(j, id);
    assert.ok(compact(s.if).includes(compact(ordinary)), `${id} must skip a direct recovery`);
  }
  for (const id of ["replay-direct-lifecycle", "direct-lifecycle-result", "complete-direct-lifecycle", "fail-direct-lifecycle"]) {
    const s = step(j, id);
    priorReferences(j, s);
    for (const ref of JSON.stringify(s).matchAll(/\bsteps\.([A-Za-z0-9_-]+)\.(?:outputs|outcome)\b/g))
      assert.ok(["publication-context", "replay-direct-lifecycle", "direct-lifecycle-result", "complete-direct-lifecycle"].includes(ref[1]), `${id} cannot depend on ordinary stage ${ref[1]}`);
  }
});

test("R06-D result and completion use only the direct outcome and current publisher tuple", () => {
  const j = job(), replay = step(j, "replay-direct-lifecycle"), result = step(j, "direct-lifecycle-result"), complete = step(j, "complete-direct-lifecycle");
  before(j, replay, result); before(j, result, complete);
  for (const s of [result, complete]) { guard(s, ["always()", claimed, direct]); priorReferences(j, s); assert.ok(s.run); }
  env(result, {
    PRIOR_JOB_STATUS: expr("job.status"), DIRECT_RECOVERY_OUTCOME: expr("steps.replay-direct-lifecycle.outcome"),
    DIRECT_RECOVERY_REPLAY_OUTCOME: output("outcome"), DIRECT_RECOVERY_COMPLETION_KIND: output("completion_kind"),
    DIRECT_RECOVERY_REASON_CODE: output("reason_code"), DIRECT_RECOVERY_REQUEUE_LATEST: output("requeue_latest"), DIRECT_RECOVERY_REQUEUE: output("direct_requeue"),
  });
  env(complete, {
    CLAIM_GENERATION: context("publisher_claim_generation"), ITEM_KEY: context("publisher_item_key"),
    LEASE_REVISION: context("publisher_lease_revision"), QUEUE_LEASE_ID: context("publisher_lease_id"),
    RUN_ATTEMPT: expr("github.run_attempt"), QUEUE_URL: queue,
    OUTCOME: expr("steps.direct-lifecycle-result.outputs.outcome || 'failure'"),
    COMPLETION_KIND: expr("steps.direct-lifecycle-result.outputs.completion_kind"),
    REASON_CODE: expr("steps.direct-lifecycle-result.outputs.reason_code"),
  });
  assert.match(complete.run, /\$RUNNER_TEMP\/control-plane-curl\.sh/);
  assert.doesNotMatch(complete.run, /source scripts\/|\b(?:gh|pnpm|npm)\s/);
});

test("R06-D failure gate preserves cancellation, replay failure and completion failure", () => {
  const j = job(), result = step(j, "direct-lifecycle-result"), complete = step(j, "complete-direct-lifecycle"), failed = step(j, "fail-direct-lifecycle");
  before(j, result, complete); before(j, complete, failed); priorReferences(j, failed);
  guard(failed, ["always()", claimed, direct, "(steps.direct-lifecycle-result.outputs.outcome != 'success' || steps.complete-direct-lifecycle.outcome != 'success')"]);
  assert.match(failed.run || "", /\bexit\s+1\b/);
});
