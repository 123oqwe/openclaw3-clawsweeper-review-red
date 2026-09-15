import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import YAML from "yaml";

// Source/topology evidence only. Dynamic tests separately execute the real CLI.
const root = resolve(process.env.OC3_REVIEW_CANDIDATE_DIR || "candidate/receiver");
const sweep = YAML.parse(readFileSync(join(root, ".github/workflows/sweep.yml"), "utf8"));
type Step = { name?: string; id?: string; uses?: string; run?: string; if?: string; env?: Record<string, unknown>; with?: Record<string, unknown>; "working-directory"?: string; "continue-on-error"?: boolean };
const job = sweep.jobs["event-review-apply"];
const steps = job.steps as Step[];
const compact = (value: unknown) => String(value || "").replace(/\s+/g, "");
const claimedGuard = "${{steps.claim-exact-review-queue.outputs.claimed=='true'}}";
const directory = (value: unknown) => String(value || ".").replace(/^\.\//, "").replace(/\/$/, "") || ".";
const defaultCwd = job.defaults?.run?.["working-directory"] || sweep.defaults?.run?.["working-directory"] || ".";
const consumerIndex = () => steps.findIndex((s) => /\bpnpm\s+(?:run\s+)?review\b/.test(s.run || ""));
// Freeze the upstream build guard, rather than accepting substring matches or
// pretending this is a general GitHub expression evaluator.
const preparationReachable = (s: Step) => s.if === undefined || compact(s.if) === claimedGuard;

test("executor topology: its job builds the main review CLI as well as repair dependencies", () => {
  const consumer = consumerIndex();
  assert.ok(consumer >= 0, "retain the existing real review CLI");
  const before = steps.slice(0, consumer);
  const cwd = directory(steps[consumer]["working-directory"] || defaultCwd);
  const checkout = before.find((s) => s.uses?.startsWith("actions/checkout@") &&
    (!s.with?.repository || compact(s.with.repository) === "${{github.repository}}") &&
    directory(s.with?.path) === cwd && preparationReachable(s));
  assert.ok(checkout, "the real source checkout must be reachable at the executor working directory");
  assert.equal(checkout.with?.["persist-credentials"], false, "do not retain checkout write credentials");
  assert.ok(before.some((s, i) => i > before.indexOf(checkout) &&
    s.uses === (cwd === "." ? "./.github/actions/setup-pnpm" : `./${cwd}/.github/actions/setup-pnpm`) &&
    directory(s.with?.["working-directory"]) === cwd && preparationReachable(s) &&
    s["continue-on-error"] !== true &&
    ["build:node", "build:all"].includes(String(s.with?.["build-script"]))),
  "use the retained setup-pnpm with build:node/build:all; build:repair alone omits dist/clawsweeper.js");
});

test("executor topology: the existing model action has a supported explicit authentication route and read-only network", () => {
  const setup = steps.find((s) => s.uses?.endsWith("/.github/actions/setup-codex"));
  assert.ok(setup, "retain the fixed local model setup action");
  assert.ok(setup["continue-on-error"] === undefined || setup["continue-on-error"] === false,
    "authentication, read-only profile and sandbox setup failures must stop the job");
  assert.ok(steps.indexOf(setup) < consumerIndex(), "model setup must precede the real review consumer");
  assert.equal(String(setup.with?.["review-network"]), "true", "enable the existing read-only reviewer network profile");
  const mode = compact(setup.with?.["auth-mode"] || "proxy");
  const env = { ...(sweep.env || {}), ...(job.env || {}), ...(setup.env || {}) };
  const upstreamMode = "${{vars.CLAWSWEEPER_CODEX_AUTH_MODE||'proxy'}}";
  assert.ok(["proxy", "login", "clawrouter", upstreamMode].includes(mode), `unsupported model authentication route: ${mode}`);
  const secretBinding = (value: unknown, name: string) => {
    const text = compact(value);
    return text === `\${{secrets.${name}}}` ||
      (mode === upstreamMode && text === `\${{vars.CLAWSWEEPER_CODEX_AUTH_MODE!='clawrouter'&&secrets.${name}||''}}`);
  };
  if (["proxy", "login", upstreamMode].includes(mode)) {
    assert.ok(secretBinding(env.OPENAI_API_KEY, "OPENAI_API_KEY"), "use the pinned action's model secret binding or its existing guarded binding");
    assert.ok(secretBinding(env.CLAWSWEEPER_INTERNAL_MODEL, "CLAWSWEEPER_MODEL") ||
      compact(env.CLAWSWEEPER_INTERNAL_MODEL) === "${{vars.CLAWSWEEPER_MODEL}}",
    "wire the existing action's required configured model name");
  }
  if (["clawrouter", upstreamMode].includes(mode))
    assert.equal(compact(env.CLAWSWEEPER_CLAWROUTER_CONFIG), "${{secrets.CLAWSWEEPER_CLAWROUTER_CONFIG}}", "use the existing isolated model configuration secret");
});

test("executor topology: referenced target, live-item and lease outputs have preceding producers", () => {
  const consumer = consumerIndex();
  assert.ok(consumer >= 0, "retain the existing real review CLI");
  const ids = new Set(steps.slice(0, consumer).map((s) => s.id).filter(Boolean));
  for (const match of JSON.stringify(steps[consumer]).matchAll(/\bsteps\.([A-Za-z0-9_-]+)\.(?:outputs|outcome)\b/g))
    assert.ok(ids.has(match[1]), `executor references missing or later step ${match[1]}; restore its actual producer or an explicitly reviewed manual-only dependency change`);
});
