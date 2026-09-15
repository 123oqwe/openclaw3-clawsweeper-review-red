import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import YAML from "yaml";

// R06-B: actual candidate inline steps, real built marker helpers, synthetic gh
// transport only. No App mint, Queue authority, artifact transport or model proof.
const carrier = process.cwd();
const candidate = join(resolve(process.env.OC3_REVIEW_CANDIDATE_DIR || "candidate/receiver"), ".github/workflows/sweep.yml");
const upstream = "fixtures/upstream-16505cf/.github/workflows/sweep.yml";
const repo = "123oqwe/openclaw3-clawsweeper-sandbox", item = "41", head = "a".repeat(40);
const owner = "github-run-41001-1", id = 41010;
const decision = { targetRepo: repo, targetBranch: "main", itemNumber: 41, itemKind: "pull_request", sourceEvent: "pull_request", sourceAction: "manual_explicit_review", publicationPolicy: "record_comment_only", supersedesInProgress: false, sourceHeadSha: head };
const started = (leaseOwner = owner, sha = head) => `<!-- clawsweeper-review-status:started item=41 sha=${sha} started_at=2026-09-15T00:00:00.000Z lease_expires_at=2099-09-15T01:00:00.000Z owner=${leaseOwner} -->`;
const body = `${"Review in progress."}\n\n${started()}\n<!-- clawsweeper-review-lease item=41 -->`;
const comment = { id, body, user: { login: "clawsweeper[bot]" } };
const firstCommentPage = Array.from({ length: 100 }, (_, index) => ({ ...comment, id: id + index + 1 }));
type Step = { run?: string; env?: Record<string, unknown> };
type Scenario = { itemStatus?: number; repoStatus?: number; pullStatus?: number; state?: string; locked?: boolean; head?: string; branch?: string; comments?: unknown[]; commentPages?: unknown[][]; commentsStatus?: number; secondPageStatus?: number; writeStatus?: number };
type Trace = { method: string; path: string; body?: unknown };
const compact = (s: string) => s.replace(/\s+/g, "");
function actualStep(path: string, job: string, id: string): Step {
  const entries = YAML.parse(readFileSync(path, "utf8")).jobs?.[job]?.steps || [];
  const found = entries.filter((s: any) => s.id === id);
  assert.equal(found.length, 1, `missing topology: ${job}/${id}`);
  assert.ok(typeof found[0].run === "string");
  return found[0];
}
function render(value: unknown, values: Record<string, string>) {
  const frozen = Object.fromEntries(Object.entries(values).map(([k, v]) => [compact(k), v]));
  return String(value).replace(/\$\{\{([\s\S]*?)\}\}/g, (_match, expr: string) => {
    assert.ok(Object.hasOwn(frozen, compact(expr)), `HARNESS_ERROR: unfrozen expression ${expr}`);
    return frozen[compact(expr)];
  });
}
function outputs(path: string) {
  return Object.fromEntries(readFileSync(path, "utf8").split("\n").filter(Boolean).map((line) => {
    const at = line.indexOf("="); assert.ok(at > 0, "HARNESS_ERROR: unsupported output encoding");
    return [line.slice(0, at), line.slice(at + 1)];
  }));
}
function runtime(readOnly = false) {
  const root = mkdtempSync(join(tmpdir(), "oc3-finalize-gh-")), bin = join(root, "bin");
  mkdirSync(bin); cpSync(join(carrier, "dist"), join(root, "dist"), { recursive: true });
  cpSync(join(carrier, "package.json"), join(root, "package.json"));
  symlinkSync(join(carrier, "node_modules"), join(root, "node_modules"), "dir");
  const scenarioPath = join(root, "scenario.json"), tracePath = join(root, "trace.jsonl"), errors = join(root, "harness-errors"), output = join(root, "outputs");
  // Only these synthetic endpoints exist. An unknown path/method/option is a
  // harness failure even when the candidate catches the command's exit status.
  writeFileSync(join(bin, "gh.cjs"), `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2), s = JSON.parse(fs.readFileSync(${JSON.stringify(scenarioPath)}, 'utf8'));
function bad(message) { fs.appendFileSync(${JSON.stringify(errors)}, message+'\\n'); process.stderr.write('HARNESS_ERROR '+message); process.exit(96); }
if (args.shift() !== 'api') bad('only gh api is permitted');
let method='', endpoint='', input='', jq='', slurp=false, paginate=false, fields={};
for(let i=0;i<args.length;i++) { const a=args[i];
 if(a==='--method'||a==='-X') method=args[++i];
 else if(a==='--input') input=args[++i];
 else if(a==='--jq'||a==='-q') jq=args[++i];
 else if(a==='--paginate') paginate=true; else if(a==='--slurp') slurp=true;
 else if(a==='--field'||a==='-F'||a==='--raw-field'||a==='-f') { const f=args[++i], n=f.indexOf('='); fields[f.slice(0,n)]=f.slice(n+1); }
 else if(a==='--header'||a==='-H') i++;
 else if(a.startsWith('-')) bad('unknown gh option '+a);
 else if(!endpoint) endpoint=a; else bad('unexpected argument '+a);
}
endpoint=endpoint.replace(/^https:\\/\\/api.github.com\\//,'').replace(/^\\//,'');
// gh api chooses POST when input/fields are present unless --method overrides it.
method=method||(input||Object.keys(fields).length?'POST':'GET');
let payload;
if(input) { try { payload=JSON.parse(fs.readFileSync(input==='-'?0:input,'utf8')); } catch { bad('invalid JSON input'); } }
else if(Object.keys(fields).length) payload=fields;
fs.appendFileSync(${JSON.stringify(tracePath)}, JSON.stringify({method,path:endpoint,body:payload})+'\\n');
const base=${JSON.stringify(`repos/${repo}`)}; let status=200, value, commentResult=false;
if(method==='GET'&&endpoint===base) { status=s.repoStatus||200; value={full_name:${JSON.stringify(repo)},private:false,visibility:'public',default_branch:s.branch||'main'}; }
else if(method==='GET'&&endpoint===base+'/issues/41') { status=s.itemStatus||200; value={number:41,state:s.state||'open',locked:!!s.locked,pull_request:{url:'https://api.github.com/'+base+'/pulls/41'}}; }
else if(method==='GET'&&endpoint===base+'/pulls/41') { status=s.pullStatus||200; value={number:41,state:s.state||'open',head:{sha:s.head||${JSON.stringify(head)}},base:{ref:'main'},additions:1,deletions:1,changed_files:1}; }
else if(method==='GET'&&(endpoint===base+'/issues/41/comments'||endpoint===base+'/issues/41/comments?per_page=100')) {
 status=s.commentsStatus||200; commentResult=true;
 const pages=s.commentPages||[s.comments||[]];
 if(!Array.isArray(pages)||pages.some(page=>!Array.isArray(page))) bad('invalid comments fixture');
 const visible=paginate?pages:pages.slice(0,1);
 if(status===200&&paginate&&pages.length>1&&s.secondPageStatus&&s.secondPageStatus!==200) {
  // A page already received cannot prove absence if the next page fails.
  process.stdout.write(JSON.stringify(slurp?[pages[0]]:pages[0])+'\\n');
  status=s.secondPageStatus;
 }
 value=slurp?visible:visible.map(page=>JSON.stringify(page)).join('\\n');
}
else if(['PATCH','DELETE'].includes(method)&&endpoint===base+'/issues/comments/${id}') { status=s.writeStatus||200; value=method==='PATCH'?{id:${id},body:payload?.body}:{}; }
else bad('unallowed endpoint '+method+' '+endpoint);
if(status!==200) { process.stderr.write(status===429?'HTTP 429 rate limit exceeded':status===404?'HTTP 404 Not Found':'HTTP '+status+' denied'); process.exit(1); }
if(jq) { if(jq!=='.default_branch // empty') bad('unfrozen jq '+jq); process.stdout.write(String(value.default_branch||'')); }
else process.stdout.write(commentResult&&!slurp?value:JSON.stringify(value));
`, { mode: 0o755 });
  writeFileSync(join(bin, "gh"), `#!/bin/sh\nexec '${process.execPath}' '${join(bin, "gh.cjs")}' "$@"\n`, { mode: 0o755 });
  for (const command of ["curl", "wget", "git", "pnpm", "npm", "npx"])
    writeFileSync(join(bin, command), `#!/bin/sh\nprintf '%s\\n' 'HARNESS_ERROR: unexpected ${command}' >> '${errors}'\nexit 96\n`, { mode: 0o755 });
  const preload = join(root, "no-network.mjs");
  writeFileSync(preload, `import fs from 'node:fs'; import net from 'node:net'; import tls from 'node:tls'; import http from 'node:http'; import https from 'node:https';
const deny=()=>{fs.appendFileSync(${JSON.stringify(errors)},'unexpected Node network\\n');throw Error('HARNESS_ERROR: unexpected Node network');};
globalThis.fetch=deny; net.connect=deny; net.createConnection=deny; tls.connect=deny; http.request=deny; https.request=deny;
`);
  return {
    run(step: Step, values: Record<string, string>, scenario: Scenario = {}) {
      writeFileSync(scenarioPath, JSON.stringify(scenario)); for (const p of [output, tracePath, errors]) writeFileSync(p, "");
      const env = Object.fromEntries(Object.entries(step.env || {}).map(([k, v]) => [k, render(v, values)]));
      const result = spawnSync("/bin/bash", ["--noprofile", "--norc", "-e", "-o", "pipefail", "-c", render(step.run, values)], {
        cwd: root, env: { PATH: [bin, dirname(process.execPath), "/usr/bin", "/bin"].join(delimiter), HOME: root, RUNNER_TEMP: root, GITHUB_OUTPUT: output, GITHUB_RUN_ID: "41001", GITHUB_RUN_ATTEMPT: "1", GITHUB_REPOSITORY: "123oqwe/openclaw3-clawsweeper-review-red", NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`, ...env },
        encoding: "utf8", timeout: 15_000, maxBuffer: 2 * 1024 * 1024,
      });
      assert.equal(result.error, undefined, "HARNESS_ERROR: timeout/spawn is not a valid rejection");
      assert.notEqual(result.status, null, "HARNESS_ERROR: signalled child");
      assert.equal(readFileSync(errors, "utf8"), "", "HARNESS_ERROR: unexpected transport/tool");
      const trace = readFileSync(tracePath, "utf8").split("\n").filter(Boolean).map((s) => JSON.parse(s)) as Trace[];
      if (readOnly) assert.ok(trace.every((entry) => entry.method === "GET"), "fresh live must make zero GitHub writes on every outcome");
      return { code: result.status, out: outputs(output), stdout: result.stdout, stderr: result.stderr, trace };
    },
    close: () => rmSync(root, { recursive: true, force: true }),
  };
}
function contextValues(overrides: Record<string, string> = {}) {
  const context = { decision: JSON.stringify(decision), raw_decision: JSON.stringify(decision), target_repo: repo, item_number: item, target_branch: "main", reservation_status: "posted", reservation_owner: owner, reservation_comment_id: String(id), reservation_head_sha: head, ...overrides };
  return Object.fromEntries(Object.entries(context).map(([k, v]) => [`steps.finalize-preparation-context.outputs.${k}`, v]));
}
const readValues = (overrides: Record<string, string> = {}) => ({ ...contextValues(overrides), "secrets.CLAWSWEEPER_TARGET_READ_TOKEN": "synthetic-read-only" });
const noTerminal = (out: Record<string, string>) => {
  assert.notEqual(out.terminal_noop, "true"); assert.notEqual(out.terminal_missing, "true");
  assert.notEqual(out.guarded_open, "true"); assert.ok(!out.terminal_disposition);
};

test("R06-B real marker controls and fixed upstream live run establish the GH fixture", async () => {
  const { expireReviewStartStatusLease } = await import(pathToFileURL(join(carrier, "dist/clawsweeper-review-comment-state.js")).href);
  const { isTrustedReviewStartStatusComment } = await import(pathToFileURL(join(carrier, "dist/repair/comment-router-core.js")).href);
  const { trailingHtmlComments } = await import(pathToFileURL(join(carrier, "dist/review-comment-markers.js")).href);
  assert.equal(isTrustedReviewStartStatusComment({ comment, trustedAuthors: new Set(["clawsweeper[bot]"]) }), true);
  assert.equal(trailingHtmlComments(body).at(-1), "<!-- clawsweeper-review-lease item=41 -->");
  assert.equal(expireReviewStartStatusLease(body, "2000-01-01T00:00:00.000Z", 41), body.replace("2099-09-15T01:00:00.000Z", "2000-01-01T00:00:00.000Z"));
  const s = runtime(true);
  try {
    const control = actualStep(upstream, "event-review-apply", "live-item");
    const values = { "steps.claim-exact-review-queue.outputs.decision": JSON.stringify(decision), "steps.target.outputs.target_repo == 'openclaw/openclaw' && github.token || steps.target-read-token.outputs.token": "synthetic-read-only", "steps.target.outputs.target_repo": repo, "steps.target.outputs.item_number": item, "fromJSON(steps.claim-exact-review-queue.outputs.decision).targetBranch": "main" };
    const positive = s.run(control, values);
    assert.equal(positive.code, 0, positive.stderr); assert.equal(positive.out.proceed, "true");
    assert.deepEqual(positive.trace.map((r) => r.path), [`repos/${repo}/issues/41`, `repos/${repo}/pulls/41`]);
  } finally { s.close(); }
});

test("R06-B candidate fresh live distinguishes terminal, changed authority and read failure", async (t) => {
  const step = actualStep(candidate, "event-review-finalize", "fresh-finalize-live"), s = runtime(true);
  try {
    const positive = s.run(step, readValues());
    assert.equal(positive.code, 0, positive.stderr); assert.equal(positive.out.proceed, "true"); noTerminal(positive.out);
    assert.equal(positive.out.head_sha, head); assert.equal(positive.out.target_branch, "main");
    assert.deepEqual(JSON.parse(positive.out.decision), decision);
    assert.ok(positive.trace.some((r) => r.path === `repos/${repo}/pulls/41`));
    for (const [name, scenario, kind] of [
      ["closed", { state: "closed" }, "target_closed"], ["locked", { locked: true }, "guarded_open"],
      ["item missing while repository readable", { itemStatus: 404 }, "target_missing"],
    ] as const) await t.test(name, () => {
      const r = s.run(step, readValues(), scenario); assert.equal(r.code, 0, r.stderr);
      assert.equal(r.out.proceed, "false"); assert.equal(r.out.terminal_disposition, kind);
      if (kind === "target_missing") assert.ok(r.trace.some((x) => x.path === `repos/${repo}`));
    });
    for (const [name, scenario] of [["forbidden item", { itemStatus: 403 }], ["inaccessible repository", { itemStatus: 404, repoStatus: 404 }], ["PR metadata unavailable", { pullStatus: 403 }], ["malformed live state", { state: "mystery" }]] as const)
      await t.test(name, () => { const r = s.run(step, readValues(), scenario); assert.notEqual(r.code, 0); noTerminal(r.out); assert.notEqual(r.out.proceed, "true"); });
    await t.test("throttle is typed retry, never terminal", () => {
      const r = s.run(step, readValues(), { itemStatus: 429 }); assert.equal(r.code, 0, r.stderr); noTerminal(r.out);
      assert.equal(r.out.proceed, "false"); assert.equal(r.out.admission_retry, "true"); assert.equal(r.out.retry_kind, "throttle"); assert.ok(Number.isFinite(Date.parse(r.out.retry_at)));
    });
    for (const [name, values, scenario] of [
      ["changed reservation head", readValues(), { head: "b".repeat(40) }],
      ["changed resolved default branch", readValues({ raw_decision: JSON.stringify({ ...decision, targetBranch: "41" }) }), { branch: "develop" }],
    ] as const) await t.test(name, () => {
      const r = s.run(step, values, scenario); assert.equal(r.code, 0, r.stderr); noTerminal(r.out);
      assert.equal(r.out.proceed, "false"); assert.equal(r.out.admission_retry, "true"); assert.equal(r.out.retry_kind, "coordination"); assert.ok(Number.isFinite(Date.parse(r.out.retry_at)));
      if (r.out.decision) assert.deepEqual(JSON.parse(r.out.decision), decision, "fresh cannot rewrite expected context");
    });
  } finally { s.close(); }
});

test("R06-B candidate cleanup fences the exact canonical owner/head snapshot", async (t) => {
  const step = actualStep(candidate, "event-review-finalize", "finalize-owner-cleanup"), s = runtime();
  try {
    // Require imports of real source helpers in the executed run, not test filters.
    for (const symbol of ["isTrustedReviewStartStatusComment", "trailingHtmlComments", "expireReviewStartStatusLease"])
      assert.match(step.run || "", new RegExp(`\\b${symbol}\\b`));
    assert.match(step.run || "", /(?:import[\s\S]*?from\s*["']|import\(["'])\.\/dist\//);
    const values = (mode: string, overrides: Record<string, string> = {}) => ({ ...contextValues(overrides), "steps.exact-review-generation-result.outputs.cleanup_mode": mode, "steps.finalize-cleanup-token.outputs.token": "synthetic-issues-write" });
    const positive = s.run(step, values("expire"), { comments: [comment] });
    assert.equal(positive.code, 0, positive.stderr); assert.equal(positive.out.status, "expired");
    const writes = positive.trace.filter((r) => r.method !== "GET"); assert.equal(writes.length, 1);
    assert.equal(writes[0].method, "PATCH"); assert.equal(writes[0].path, `repos/${repo}/issues/comments/${id}`);
    const { expireReviewStartStatusLease } = await import(pathToFileURL(join(carrier, "dist/clawsweeper-review-comment-state.js")).href);
    const patched = String((writes[0].body as any)?.body);
    const expiry = /lease_expires_at=([^\s>]+)/.exec(patched)?.[1]; assert.ok(expiry && Date.parse(expiry) <= Date.now());
    assert.equal(patched, expireReviewStartStatusLease(body, expiry, 41), "PATCH must use the exact fenced body and real expire transform");
    for (const [name, changed] of [
      ["wrong owner", { ...comment, body: body.replace(`owner=${owner}`, "owner=another-run") }],
      ["wrong head", { ...comment, body: body.replace(`sha=${head}`, `sha=${"b".repeat(40)}`) }],
      ["untrusted author", { ...comment, user: { login: "attacker" } }],
      ["body forged owner before canonical wrong owner", { ...comment, body: `${started()}\nreview text\n${started("another-run")}\n<!-- clawsweeper-review-lease item=41 -->` }],
      ["durable review is not dedicated lease", { ...comment, body: body.replace("clawsweeper-review-lease item", "clawsweeper-review item") }],
      ["wrong canonical item", { ...comment, body: body.replaceAll("item=41", "item=42") }],
      ["ambiguous canonical owner", { ...comment, body: body.replace(`owner=${owner}`, `owner=another-run owner=${owner}`) }],
    ] as const) await t.test(name, () => {
      const r = s.run(step, values("delete"), { comments: [changed] }); assert.notEqual(r.code, 0); assert.ok(!r.out.status);
      assert.equal(r.trace.filter((x) => x.method !== "GET").length, 0);
    });
    await t.test("delete exact owned comment only", () => {
      const r = s.run(step, values("delete"), { comments: [comment, { ...comment, id: id + 1 }] });
      assert.equal(r.code, 0, r.stderr); assert.equal(r.out.status, "deleted");
      assert.deepEqual(r.trace.filter((x) => x.method !== "GET").map(({ method, path }) => ({ method, path })), [{ method: "DELETE", path: `repos/${repo}/issues/comments/${id}` }]);
    });
    await t.test("the exact comment can be on the second page", () => {
      const r = s.run(step, values("delete"), { commentPages: [firstCommentPage, [comment]] });
      assert.equal(r.code, 0, r.stderr); assert.equal(r.out.status, "deleted");
      assert.deepEqual(r.trace.filter((x) => x.method !== "GET").map(({ method, path }) => ({ method, path })), [{ method: "DELETE", path: `repos/${repo}/issues/comments/${id}` }]);
    });
    for (const [name, pages] of [
      ["target only on failed second page", [firstCommentPage, [comment]]],
      ["target already visible but later page fails", [[comment, ...firstCommentPage.slice(1)], [{ ...comment, id: id + 200 }]]],
    ] as const) await t.test(`second-page failure: ${name}`, () => {
      const r = s.run(step, values("expire"), { commentPages: pages.map((page) => [...page]), secondPageStatus: 403 });
      assert.notEqual(r.code, 0); assert.ok(!r.out.status);
      assert.ok(r.trace.length > 0); assert.ok(r.trace.every((x) => x.method === "GET"));
    });
    await t.test("already absent only after successful exact item read", () => {
      const r = s.run(step, values("expire"), { comments: [{ ...comment, id: id + 1 }] });
      assert.equal(r.code, 0, r.stderr); assert.equal(r.out.status, "already_absent"); assert.ok(r.trace.length > 0); assert.ok(r.trace.every((x) => x.method === "GET"));
    });
    for (const [name, v] of [["none", values("none")], ["no trusted posted receipt", values("delete", { reservation_status: "held", reservation_comment_id: "" })]] as const)
      await t.test(name, () => { const r = s.run(step, v, { comments: [comment] }); assert.equal(r.code, 0, r.stderr); assert.equal(r.out.status, "skipped"); assert.deepEqual(r.trace, []); });
    for (const [name, scenario] of [["read failure", { comments: [comment], commentsStatus: 403 }], ["write failure", { comments: [comment], writeStatus: 403 }]] as const)
      await t.test(name, () => { const r = s.run(step, values("expire"), scenario); assert.notEqual(r.code, 0); assert.ok(!r.out.status, "failed transport cannot announce cleanup success"); });
  } finally { s.close(); }
});
