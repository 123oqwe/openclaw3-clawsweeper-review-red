import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import YAML from "yaml";

// Source-bound configuration evidence. The other suite executes both real CLIs;
// neither suite impersonates the Actions upload/download service or a model.
const root = resolve(process.env.OC3_REVIEW_CANDIDATE_DIR || "candidate/receiver");
const sweep = YAML.parse(readFileSync(join(root, ".github/workflows/sweep.yml"), "utf8"));
const compact = (v: unknown) => String(v ?? "").replace(/\s+/g, "");
const expression = (v: string) => "${{" + compact(v) + "}}";
const claim = "steps.claim-exact-review-queue.outputs.claimed == 'true'";
const pubClaim = "steps.publication-context.outputs.claimed == 'true'";
const deferred = "steps.publication-context.outputs.direct_lifecycle_recovery != 'true'";
const validDownload = "steps.download-exact-review-bundle.outcome == 'success'";
const validBundle = "steps.validate-exact-review-bundle.outcome == 'success'";
const createAtoms = [
  "!cancelled()", claim,
  "steps.target.outputs.target_enabled == 'true'",
  "steps.live-item.outcome == 'success'",
  "steps.live-item.outputs.scheduled_semantic_noop != 'true'",
  "steps.live-item.outputs.admission_retry != 'true'",
  "steps.setup-pnpm.outcome == 'success'",
  "steps.review-exact-event-item.outcome == 'success'",
  "steps.review-exact-event-item.outputs.superseded != 'true'",
  "steps.review-exact-event-item.outputs.retry_at == ''",
  "steps.reserve-exact-review-lease.outputs.status == 'posted'",
];
const uploadAtoms = ["!cancelled()", claim, "steps.create-exact-review-bundle.outcome == 'success'"];
function guard(value: unknown, required: string[], optional: string[] = []) {
  const atoms = compact(value).replace(/^\$\{\{/, "").replace(/\}\}$/, "").split("&&");
  const allowed = new Set([...required, ...optional].map(compact));
  assert.ok(atoms.every((atom) => allowed.has(atom)), `unsupported/false gate: ${String(value)}`);
  for (const atom of required) assert.ok(atoms.includes(compact(atom)), `missing gate: ${atom}`);
}
function job(id: string) {
  const result = sweep.jobs[id];
  assert.ok(result && Array.isArray(result.steps), `missing actual ${id} job`);
  assert.equal(result["continue-on-error"] ?? false, false);
  return result;
}
function step(value: any, id: string) {
  const matches = value.steps.filter((s: any) => s.id === id);
  assert.equal(matches.length, 1, `require unique real ${id}`);
  assert.equal(matches[0]["continue-on-error"] ?? false, false, `${id} must propagate failures`);
  assert.equal(matches[0]["working-directory"] || ".", ".");
  return matches[0];
}
function referencesExist(value: any, consumer: any) {
  const preceding = new Set(value.steps.slice(0, value.steps.indexOf(consumer)).map((s: any) => s.id).filter(Boolean));
  for (const m of JSON.stringify(consumer).matchAll(/\bsteps\.([A-Za-z0-9_-]+)\.(?:outputs|outcome)\b/g))
    assert.ok(preceding.has(m[1]), `missing/late producer ${m[1]}`);
}
function exactEnv(actual: any, expected: Record<string, string>) {
  assert.deepEqual(Object.keys(actual || {}).sort(), Object.keys(expected).sort());
  for (const [key, value] of Object.entries(expected)) assert.equal(compact(actual[key]), compact(value), key);
}
function trustedBuild(value: any, before: any, required: string[]) {
  assert.equal(value.defaults?.run?.["working-directory"] || sweep.defaults?.run?.["working-directory"] || ".", ".");
  const limit = value.steps.indexOf(before);
  const checkoutIndex = value.steps.findIndex((s: any) => s.uses?.startsWith("actions/checkout@"));
  assert.ok(checkoutIndex >= 0 && checkoutIndex < limit, "trusted source checkout must precede the CLI");
  const checkout = value.steps[checkoutIndex];
  assert.ok(!checkout.with?.repository || compact(checkout.with.repository) === expression("github.repository"));
  assert.ok(!checkout.with?.ref || compact(checkout.with.ref) === expression("github.sha"), "do not checkout the untrusted artifact producer ref as executable source");
  assert.equal(checkout.with?.path || ".", ".");
  assert.equal(checkout.with?.["persist-credentials"], false);
  assert.equal(checkout["continue-on-error"] ?? false, false);
  guard(checkout.if, required);
  const buildIndex = value.steps.findIndex((s: any, i: number) => i > checkoutIndex && i < limit && s.uses === "./.github/actions/setup-pnpm");
  assert.ok(buildIndex > checkoutIndex, "build the real retained bundle CLI");
  const build = value.steps[buildIndex];
  assert.equal(build["continue-on-error"] ?? false, false);
  assert.equal(build.with?.["working-directory"] || ".", ".");
  assert.ok(["build:repair", "build:node", "build:all"].includes(build.with?.["build-script"]));
  guard(build.if, required);
  return checkoutIndex;
}

test("R06-A model produces the real authority-bound bundle after a successful review", () => {
  const model = job("event-review-apply");
  const create = step(model, "create-exact-review-bundle");
  guard(create.if, createAtoms, ["always()"]);
  referencesExist(model, create);
  trustedBuild(model, create, [claim]);
  assert.ok(model.steps.findIndex((s: any) => s.id === "review-exact-event-item") < model.steps.indexOf(create));
  assert.match(create.run || "", /pnpm\s+run\s+--silent\s+repair:exact-review-bundle\s+create\b/);
  exactEnv(create.env, {
    EXACT_REVIEW_ACTION_LEDGER_ROOT: expression("env.CLAWSWEEPER_ACTION_LEDGER_OUTPUT_ROOT"),
    EXACT_REVIEW_BUNDLE_DIR: ".artifacts/exact-review-bundle",
    EXACT_REVIEW_CLAIM_GENERATION: expression("steps.claim-exact-review-queue.outputs.claim_generation"),
    EXACT_REVIEW_DECISION: expression("steps.live-item.outputs.decision"),
    EXACT_REVIEW_GENERATION_ATTEMPT: expression("github.run_attempt"),
    EXACT_REVIEW_ITEM_KEY: expression("steps.claim-exact-review-queue.outputs.item_key"),
    EXACT_REVIEW_ITEM_KIND: expression("fromJSON(steps.claim-exact-review-queue.outputs.decision).itemKind"),
    EXACT_REVIEW_ITEM_NUMBER: expression("steps.target.outputs.item_number"),
    EXACT_REVIEW_LEASE_REVISION: expression("steps.claim-exact-review-queue.outputs.lease_revision"),
    EXACT_REVIEW_LIVE_GUARDED_OPEN: expression("steps.live-item.outputs.guarded_open"),
    EXACT_REVIEW_LIVE_PROCEEDED: expression("steps.review-exact-event-item.outputs.terminal_during_review == 'true' && 'false' || steps.live-item.outputs.proceed"),
    EXACT_REVIEW_LIVE_TERMINAL_MISSING: expression("steps.live-item.outputs.terminal_missing"),
    EXACT_REVIEW_LIVE_TERMINAL_NOOP: expression("steps.review-exact-event-item.outputs.terminal_during_review == 'true' && 'true' || steps.live-item.outputs.terminal_noop"),
    EXACT_REVIEW_PRODUCER_JOB: "event-review-apply",
    EXACT_REVIEW_PROTOCOL_VERSION: expression("steps.claim-exact-review-queue.outputs.protocol_version"),
    EXACT_REVIEW_REPORT_PATH: "artifacts/event/" + expression("steps.target.outputs.item_number") + ".md",
    EXACT_REVIEW_TARGET_BRANCH: expression("steps.live-item.outputs.target_branch"),
    EXACT_REVIEW_TARGET_REPO: expression("steps.target.outputs.target_repo"),
  });
  for (const output of ["artifact_name", "generation_attempt"])
    assert.equal(compact(model.outputs?.[output]), expression(`steps.create-exact-review-bundle.outputs.${output}`));
});

test("R06-A selected upload has a real producer and excludes unrelated diagnostics", () => {
  const model = job("event-review-apply");
  const create = step(model, "create-exact-review-bundle");
  const upload = step(model, "upload-exact-review-bundle");
  assert.ok(model.steps.indexOf(create) < model.steps.indexOf(upload));
  guard(upload.if, uploadAtoms, ["always()"]);
  assert.equal(upload.uses, "actions/upload-artifact@v7");
  assert.equal(compact(upload.with?.name), expression("steps.create-exact-review-bundle.outputs.artifact_name"));
  assert.equal(upload.with?.path, ".artifacts/exact-review-bundle");
  assert.equal(upload.with?.["if-no-files-found"], "error");
  assert.equal(upload.with?.["include-hidden-files"], true);
  assert.equal(upload.with?.["retention-days"], 90);
  referencesExist(model, upload);
  assert.doesNotMatch(JSON.stringify(model), /CLAWSWEEPER_WEBHOOK_SECRET|create-github-app-token|private-key|repair:publish-event-result|repair:exact-review-direct-publication|\/internal\/exact-review\/enqueue/,
    "artifact production must not restore privileged direct publication to the model job");
});

test("R06-A publisher downloads the claimed producer artifact and validates before minting", () => {
  const publish = job("event-review-publish");
  assert.deepEqual(publish.permissions, { contents: "read", actions: "read" });
  const claimStep = step(publish, "publication-context");
  const download = step(publish, "download-exact-review-bundle");
  const validate = step(publish, "validate-exact-review-bundle");
  const mint = step(publish, "reviewer-token");
  assert.ok(publish.steps.indexOf(claimStep) < publish.steps.indexOf(download));
  assert.ok(publish.steps.indexOf(download) < publish.steps.indexOf(validate));
  assert.ok(publish.steps.indexOf(validate) < publish.steps.indexOf(mint));
  const checkoutIndex = trustedBuild(publish, download, [pubClaim, deferred]);
  assert.ok(publish.steps.indexOf(claimStep) < checkoutIndex, "claim must precede trusted checkout/build, which must precede download to avoid checkout cleaning the downloaded bundle");
  assert.doesNotMatch(JSON.stringify({ ...(sweep.env || {}), ...(publish.env || {}) }),
    /secrets\.|private-key|CLAWSWEEPER_APP_PRIVATE_KEY|CLAWSWEEPER_WEBHOOK_SECRET|target-write-token/,
    "download and validation must not inherit privileged workflow/job environment");
  guard(download.if, [pubClaim, deferred]);
  guard(validate.if, [pubClaim, deferred, validDownload]);
  guard(mint.if, [pubClaim, deferred, validBundle]);
  assert.equal(download.uses, "actions/download-artifact@v8");
  assert.deepEqual(Object.keys(download.with || {}).sort(), ["github-token", "name", "path", "repository", "run-id"]);
  for (const [key, value] of Object.entries({
    name: expression("steps.publication-context.outputs.artifact_name"),
    "run-id": expression("steps.publication-context.outputs.producer_run_id"),
    "github-token": expression("github.token"), repository: expression("github.repository"),
    path: ".artifacts/exact-review-bundle",
  })) assert.equal(compact(download.with[key]), compact(value), key);
  const fields: Record<string, string> = {
    CLAIM_GENERATION: "claim_generation", DECISION: "decision", GENERATION_ATTEMPT: "generation_attempt",
    ITEM_KEY: "item_key", ITEM_KIND: "item_kind", ITEM_NUMBER: "item_number", LEASE_REVISION: "lease_revision",
    LIVE_GUARDED_OPEN: "live_guarded_open", LIVE_PROCEEDED: "live_proceeded",
    LIVE_TERMINAL_MISSING: "live_terminal_missing", LIVE_TERMINAL_NOOP: "live_terminal_noop",
    PRODUCER_RUN_ID: "producer_run_id", PROTOCOL_VERSION: "protocol_version", SOURCE_SHA: "source_sha",
    TARGET_BRANCH: "target_branch", TARGET_REPO: "target_repo",
  };
  exactEnv(validate.env, {
    EXACT_REVIEW_BUNDLE_DIR: ".artifacts/exact-review-bundle", EXACT_REVIEW_PRODUCER_JOB: "event-review-apply",
    ...Object.fromEntries(Object.entries(fields).map(([env, output]) => [`EXACT_REVIEW_${env}`, expression(`steps.publication-context.outputs.${output}`)])),
  });
  assert.equal(String(validate.run).trim(), "pnpm run --silent repair:exact-review-bundle validate");
  for (const s of [download, validate, mint]) referencesExist(publish, s);
  assert.equal(mint.uses, "actions/create-github-app-token@bcd2ba49218906704ab6c1aa796996da409d3eb1");
  assert.equal(compact(mint.with?.["client-id"]), expression("env.CLAWSWEEPER_APP_CLIENT_ID"));
  assert.equal(compact(mint.with?.["private-key"]), expression("secrets.CLAWSWEEPER_APP_PRIVATE_KEY"));
  assert.equal(compact(mint.with?.owner), expression("steps.publication-context.outputs.target_repo_owner"));
  assert.equal(compact(mint.with?.repositories), expression("steps.publication-context.outputs.target_repo_name"));
  const permissions = Object.fromEntries(Object.entries(mint.with || {}).filter(([key]) => key.startsWith("permission-")));
  assert.deepEqual(permissions, { "permission-issues": "write" });
  assert.ok(!Object.hasOwn(mint.with || {}, "app-id"), "reuse the fixed client-id action contract");
  for (const s of publish.steps.slice(0, publish.steps.indexOf(validate) + 1))
    assert.doesNotMatch(JSON.stringify(s), /secrets\.|private-key|create-github-app-token|repair:publish-event-result/,
      "download and validation must finish before privileged credentials/publication");
});
