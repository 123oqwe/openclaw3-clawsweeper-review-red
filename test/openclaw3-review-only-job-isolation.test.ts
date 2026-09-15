import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import YAML from "yaml";

// Configuration evidence only. Real Queue/bridge and process tests are separate.
const root = resolve(process.env.OC3_REVIEW_CANDIDATE_DIR || "candidate/receiver");
const sweep = YAML.parse(readFileSync(join(root, ".github/workflows/sweep.yml"), "utf8"));
const prepareId = "event-review-prepare";
const modelId = "event-review-apply";
const compact = (value: unknown) => String(value ?? "").replace(/\s+/g, "");
const expectedOutputs = {
  claimed: "steps.claim-exact-review-queue.outputs.claimed",
  protocol_version: "steps.claim-exact-review-queue.outputs.protocol_version",
  item_key: "steps.claim-exact-review-queue.outputs.item_key",
  lease_id: "steps.claim-exact-review-queue.outputs.lease_id",
  lease_revision: "steps.claim-exact-review-queue.outputs.lease_revision",
  claim_generation: "steps.claim-exact-review-queue.outputs.claim_generation",
  decision: "steps.claim-exact-review-queue.outputs.decision",
  reservation_status: "steps.reserve-exact-review-lease.outputs.status",
  reservation_owner: "steps.reserve-exact-review-lease.outputs.owner",
  reservation_comment_id: "steps.reserve-exact-review-lease.outputs.comment_id",
};
function job(id: string) {
  const value = sweep.jobs[id];
  assert.ok(value && Array.isArray(value.steps), `missing concrete ${id} job`);
  return value;
}
function step(value: any, id: string) {
  const matches = value.steps.filter((entry: any) => entry.id === id);
  assert.equal(matches.length, 1, `require unique ${id} step`);
  return matches[0];
}
const eventAtoms = ["github.event_name == 'repository_dispatch'", "github.event.client_payload.source_action == 'manual_explicit_review'", "github.event.client_payload.queue_lease_id != ''"];
const modelAtoms = [...eventAtoms, "needs.event-review-prepare.result == 'success'", "needs.event-review-prepare.outputs.reservation_status == 'posted'"];
const claimed = "steps.claim-exact-review-queue.outputs.claimed == 'true'";
const liveProceed = "steps.live-item.outputs.proceed == 'true'";
const modelSetupAtoms = [claimed, liveProceed, "steps.live-item.outputs.oversized != 'true'", "env.CLAWSWEEPER_RUNNER != 'openclaw'", "steps.reserve-exact-review-lease.outputs.status == 'posted'"];
function requires(condition: unknown, expected: string, allowed: string[] = [expected]) {
  const expression = compact(condition).replace(/^\$\{\{/, "").replace(/\}\}$/, "");
  const atoms = expression.split("&&");
  const admitted = new Set(allowed.map(compact));
  assert.ok(atoms.every((atom) => admitted.has(atom)), `unsupported or permanently false boundary: ${expression}`);
  assert.ok(atoms.includes(compact(expected)), `missing required boundary: ${expected}`);
}
const preparationReachable = (entry: any) => entry.if === undefined || compact(entry.if) === "${{" + compact(claimed) + "}}";
const directory = (value: unknown) => String(value || ".").replace(/^\.\//, "").replace(/\/$/, "") || ".";

test("R05-B privileged reservation has a separate trusted job and real output producers", () => {
  const prepare = job(prepareId);
  const model = job(modelId);
  for (const atom of eventAtoms) requires(prepare.if, atom, eventAtoms);
  assert.equal(prepare["continue-on-error"] ?? false, false);
  const reserve = step(prepare, "reserve-exact-review-lease");
  assert.match(reserve.run || "", /pnpm\s+run\s+--silent\s+reserve-review-lease\b/,
    "retain the actual reservation CLI; outputs must not be invented");
  const claim = step(prepare, "claim-exact-review-queue");
  assert.ok(prepare.steps.indexOf(claim) < prepare.steps.indexOf(reserve));
  for (const atom of [claimed, liveProceed]) requires(reserve.if, atom, [claimed, liveProceed]);
  const reserveIndex = prepare.steps.indexOf(reserve);
  const before = prepare.steps.slice(0, reserveIndex);
  const cwd = directory(reserve["working-directory"] || prepare.defaults?.run?.["working-directory"] || sweep.defaults?.run?.["working-directory"]);
  const checkout = before.find((entry: any) => entry.uses?.startsWith("actions/checkout@") &&
    (!entry.with?.repository || compact(entry.with.repository) === "${{github.repository}}") &&
    directory(entry.with?.path) === cwd && preparationReachable(entry));
  assert.ok(checkout, "reservation requires a reachable checkout of the trusted source in its own job");
  assert.equal(checkout.with?.["persist-credentials"], false);
  const buildIndex = before.findIndex((entry: any, index: number) => index > before.indexOf(checkout) &&
    entry.uses === (cwd === "." ? "./.github/actions/setup-pnpm" : `./${cwd}/.github/actions/setup-pnpm`) &&
    directory(entry.with?.["working-directory"]) === cwd && preparationReachable(entry) &&
    entry["continue-on-error"] !== true && ["build:node", "build:all"].includes(String(entry.with?.["build-script"])));
  assert.ok(buildIndex >= 0, "reservation's real main CLI must be built before use");
  const live = step(prepare, "live-item");
  assert.ok(buildIndex < prepare.steps.indexOf(live), "the retained live-item importer needs the built runtime");
  const mint = step(prepare, "target-write-token");
  assert.ok(prepare.steps.indexOf(live) < prepare.steps.indexOf(mint) && prepare.steps.indexOf(mint) < reserveIndex,
    "the comment credential must be produced after live validation and before reservation");
  assert.ok(mint.uses?.startsWith("actions/create-github-app-token@"));
  assert.equal(mint.with?.["permission-issues"], "write");
  const mintAtoms = [claimed, "steps.live-item.outcome == 'success'", "steps.live-item.outputs.scheduled_semantic_noop != 'true'", "steps.live-item.outputs.admission_retry != 'true'", liveProceed];
  requires(mint.if, claimed, mintAtoms);
  requires(mint.if, "steps.live-item.outcome == 'success'", mintAtoms);
  assert.equal(compact(reserve.env?.GH_TOKEN), "${{steps.target-write-token.outputs.token}}",
    "the real reservation consumer must receive its preceding comment credential");
  assert.equal(prepare.steps.some((entry: any) => /setup-codex|setup-openclaw$/.test(entry.uses || "") || /\bpnpm\s+(?:run\s+)?review\b/.test(entry.run || "")), false,
    "do not place model execution back beside privileged preparation");
  assert.deepEqual(Object.keys(prepare.outputs || {}).sort(), Object.keys(expectedOutputs).sort(),
    "the preparation receipt contains only the ten reviewed authority/reservation outputs");
  for (const [name, producer] of Object.entries(expectedOutputs))
    assert.equal(compact(prepare.outputs[name]), "${{" + producer + "}}", `${name} must come from its real preparation producer`);
  const needs = Array.isArray(model.needs) ? model.needs : [model.needs];
  assert.ok(needs.includes(prepareId), "the model must wait for its actual preparation");
  for (const atom of modelAtoms) requires(model.if, atom, modelAtoms);
});

test("R05-B the model job has no privileged credentials and uses explicit target-read configuration", () => {
  const model = job(modelId);
  const serialized = JSON.stringify({ workflowEnv: sweep.env || {}, model });
  assert.doesNotMatch(serialized, /CLAWSWEEPER_APP_PRIVATE_KEY|CLAWSWEEPER_WEBHOOK_SECRET|CLAWSWEEPER_RECORDS_SECRET|target-write-token|create-github-app-token|secrets\s*\[|toJSON\(\s*secrets/,
    "App/HMAC/write-token credentials may not enter the model job through any inherited declaration");
  const allowed = new Set(["CLAWSWEEPER_TARGET_READ_TOKEN", "OPENAI_API_KEY", "CLAWSWEEPER_MODEL", "CLAWSWEEPER_CLAWROUTER_CONFIG"]);
  for (const match of serialized.matchAll(/\bsecrets\.([A-Za-z0-9_]+)/g))
    assert.ok(allowed.has(match[1]), `unreviewed model-job credential: ${match[1]}`);
  const permissions = model.permissions ?? sweep.permissions;
  assert.ok(permissions && typeof permissions === "object" && !Array.isArray(permissions));
  for (const [name, value] of Object.entries(permissions))
    assert.ok(value === "read" || value === "none", `model ambient permission ${name} is not read-only`);
  const review = step(model, "review-exact-event-item");
  const live = step(model, "live-item");
  for (const [consumer, key] of [[review, "GH_TOKEN"], [review, "CLAWSWEEPER_PROOF_INSPECTION_TOKEN"], [live, "GH_TOKEN"]] as const)
    assert.equal(compact(consumer.env?.[key]), "${{secrets.CLAWSWEEPER_TARGET_READ_TOKEN}}",
      `${key} must use the separately configured read credential, never a private key or cross-job token output`);
  assert.equal(model["continue-on-error"] ?? false, false);
  assert.equal(review["continue-on-error"] ?? false, false);
});

test("R05-B model reservation handoff revalidates current claim and trusted preparation before setup", () => {
  const model = job(modelId);
  const claim = step(model, "claim-exact-review-queue");
  const bridge = step(model, "reserve-exact-review-lease");
  const setupIndex = model.steps.findIndex((entry: any) => entry.uses?.endsWith("/.github/actions/setup-codex"));
  assert.ok(model.steps.indexOf(claim) < model.steps.indexOf(bridge) && model.steps.indexOf(bridge) < setupIndex,
    "reclaim and receipt comparison must occur before model setup or invocation");
  requires(bridge.if, "steps.claim-exact-review-queue.outputs.claimed == 'true'");
  assert.equal(compact(bridge.env?.PREPARATION_RECEIPT), "${{toJSON(needs.event-review-prepare.outputs)}}");
  assert.equal(compact(bridge.env?.CURRENT_CLAIM), "${{toJSON(steps.claim-exact-review-queue.outputs)}}");
  assert.equal(bridge["continue-on-error"] ?? false, false);
  assert.doesNotMatch(bridge.run || "", /\breserve-review-lease\b/, "the model handoff must not create another reservation comment");
  const setup = model.steps[setupIndex];
  requires(setup.if, "steps.reserve-exact-review-lease.outputs.status == 'posted'", modelSetupAtoms);
  requires(step(model, "review-exact-event-item").if, "steps.reserve-exact-review-lease.outputs.status == 'posted'", modelSetupAtoms);
});
