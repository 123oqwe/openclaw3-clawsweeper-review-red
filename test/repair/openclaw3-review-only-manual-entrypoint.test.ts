import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHmac } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import test from "node:test";
import YAML from "yaml";

// Planner-owned draft. Apply under test/repair; run only in the authorized Hosted lane,
// after its existing build:node step. No new production API or CLI is required.
const targetRepo = "123oqwe/openclaw3-clawsweeper-sandbox";
const itemNumber = "41";
const secret = "synthetic-manual-entrypoint-secret";
type Step = { name?: string; env?: Record<string, string>; run?: string };
const workflow = YAML.parse(readFileSync("candidate/receiver/.github/workflows/sweep.yml", "utf8"));

async function execute(run: string, declaredEnv: Record<string, string>, extraCaCertPath: string) {
  // Never inherit the Hosted runner environment or admit literal credentials
  // from a candidate workflow. All credential-shaped values must be fixtures.
  for (const [name, value] of Object.entries(declaredEnv)) {
    if (/(?:TOKEN|SECRET|PRIVATE_KEY|API_KEY|PASSWORD)/i.test(name)) {
      assert.ok(
        value === "" || value === secret || value === "synthetic-read-token",
        `non-fixture credential environment variable: ${name}`,
      );
    }
  }
  const root = mkdtempSync(join(tmpdir(), "oc3-manual-entrypoint-"));
  const bin = join(root, "bin");
  mkdirSync(bin);
  mkdirSync(join(root, ".artifacts"));
  // Copy executable modules: symlinking dist would bypass the production
  // pathToFileURL(process.argv[1]) === import.meta.url main-module guard.
  cpSync(resolve("dist"), join(root, "dist"), { recursive: true });
  cpSync(resolve("package.json"), join(root, "package.json"));
  symlinkSync(resolve("node_modules"), join(root, "node_modules"), "dir");
  symlinkSync(resolve("config"), join(root, "config"), "dir");
  const trace = join(root, "gh-trace.jsonl");
  writeFileSync(trace, "");
  writeFileSync(join(bin, "gh"), `#!/usr/bin/env node
import fs from "node:fs";
const args = process.argv.slice(2);
fs.appendFileSync(process.env.GH_TRACE, JSON.stringify(args) + "\\n");
if (args.length === 2 && args[0] === "api" && args[1] === "repos/${targetRepo}/issues/${itemNumber}") {
  process.stdout.write(JSON.stringify({ number: 41, pull_request: {} }));
} else if (args.length === 4 && args[0] === "api" && args[1] === "repos/${targetRepo}" && args[2] === "--jq" && args[3] === ".default_branch") {
  process.stdout.write("main\\n");
} else { process.stderr.write("unexpected GitHub operation: " + JSON.stringify(args)); process.exitCode = 97; }
`, { mode: 0o755 });
  try {
    const child = spawn("/bin/bash", ["--noprofile", "--norc", "-e", "-o", "pipefail", "-c", run], {
      cwd: root,
      env: {
        PATH: [bin, dirname(process.execPath), "/usr/bin", "/bin"].join(delimiter),
        HOME: root,
        GITHUB_RUN_ID: "41001",
        GH_TRACE: trace,
        ...declaredEnv,
        NODE_EXTRA_CA_CERTS: extraCaCertPath,
        NODE_TLS_REJECT_UNAUTHORIZED: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
    const code = await new Promise<number | null>((accept, reject) => {
      child.once("error", reject);
      child.once("close", accept);
    }).finally(() => clearTimeout(timer));
    return { code, stdout, stderr, gh: readFileSync(trace, "utf8") };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("manual receiver run invokes the real CLI and admits one signed comment-only selection", async (t) => {
  const requests: Array<{ path: string; method: string; body: string; signature: string }> = [];
  const certificateRoot = mkdtempSync(join(tmpdir(), "oc3-manual-entrypoint-tls-"));
  let server: ReturnType<typeof createServer> | undefined;
  try {
    const certificatePath = join(certificateRoot, "loopback-cert.pem");
    const keyPath = join(certificateRoot, "loopback-key.pem");
    // This command runs only inside the authorized Hosted test. A fresh test
    // certificate is trusted by the CLI child without disabling TLS validation.
    execFileSync("openssl", [
      "req", "-x509", "-newkey", "rsa:2048", "-sha256", "-nodes", "-days", "1",
      "-keyout", keyPath, "-out", certificatePath, "-subj", "/CN=127.0.0.1",
      "-addext", "subjectAltName=IP:127.0.0.1",
    ], {
      env: { PATH: "/usr/bin:/bin", HOME: certificateRoot },
      stdio: "pipe",
      timeout: 10_000,
    });
    server = createServer({ key: readFileSync(keyPath), cert: readFileSync(certificatePath) }, async (req, res) => {
      let body = "";
      for await (const chunk of req) body += chunk;
      const signature = String(req.headers["x-clawsweeper-exact-review-signature"] || "");
      requests.push({ path: req.url || "", method: req.method || "", body, signature });
      res.setHeader("content-type", "application/json");
      if (req.method === "GET" && req.url === "/api/exact-review-queue") {
        res.end(JSON.stringify({ manual_publication: { policy: "record_comment_only", enabled: true } }));
      } else if (req.method === "POST" && req.url === "/internal/exact-review/enqueue") {
        const expected = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
        if (signature !== expected) {
          res.statusCode = 401;
          res.end(JSON.stringify({ error: "invalid_signature" }));
        } else {
          res.statusCode = 202;
          res.end(JSON.stringify({ ok: true, queued: true }));
        }
      } else {
        res.statusCode = 404;
        res.end(JSON.stringify({ error: "unexpected_route" }));
      }
    });
    const listeningServer = server;
    await new Promise<void>((accept, reject) => {
      listeningServer.once("error", reject);
      listeningServer.listen(0, "127.0.0.1", () => {
        listeningServer.off("error", reject);
        accept();
      });
    });
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const queueUrl = `https://127.0.0.1:${address.port}`;
    const assertAdmission = (result: Awaited<ReturnType<typeof execute>>) => {
      assert.equal(result.code, 0, `${result.stderr}\n${result.stdout}`);
      assert.equal(requests.length, 2, JSON.stringify(requests));
      const posted = requests[1];
      assert.equal(posted.method, "POST");
      assert.equal(posted.path, "/internal/exact-review/enqueue");
      assert.equal(posted.signature, `sha256=${createHmac("sha256", secret).update(posted.body).digest("hex")}`);
      const payload = JSON.parse(posted.body);
      assert.equal(payload.delivery_id, "manual:41001:41");
      assert.equal(payload.decision.targetRepo, targetRepo);
      assert.equal(payload.decision.itemNumber, 41);
      assert.equal(payload.decision.sourceAction, "manual_explicit_review");
      assert.equal(payload.decision.publicationPolicy, "record_comment_only");
      assert.equal(payload.decision.itemKind, "pull_request");
      assert.match(result.gh, /issues\/41/);
    };
    let positiveControlPassed = false;
    await t.test("positive control: the existing CLI is executable with its documented arguments", async () => {
      requests.length = 0;
      assertAdmission(await execute(
        'node dist/repair/manual-review-enqueue.js --target-repo "$TARGET_REPO" --target-branch main --item-numbers "$ITEM_NUMBER" --request-id "$GITHUB_RUN_ID" --codex-timeout-ms 1200000 --queue-url "$QUEUE_URL"',
        { TARGET_REPO: targetRepo, ITEM_NUMBER: itemNumber, QUEUE_URL: queueUrl, CLAWSWEEPER_WEBHOOK_SECRET: secret },
        certificatePath,
      ));
      positiveControlPassed = true;
    });
    await t.test("candidate: execute its unchanged manual run with only its declared environment", {
      skip: positiveControlPassed ? false : "positive control failed; candidate was not evaluated and is not valid RED evidence",
    }, async () => {
      requests.length = 0;
      const job = workflow.jobs["manual-selection"];
      assert.ok(job, "freeze a replacement manual job selection with the test author if renamed");
      const step = (job.steps as Step[]).find((entry) => entry.run?.includes("manual-review-enqueue.js"));
      assert.ok(step?.run, "manual selection must invoke the existing executable CLI");
      // These expression values mirror the reviewed candidate and upstream manual step.
      // Resolve declared expressions, never inject alternative environment-variable aliases.
      const values: Record<string, string> = {
        "inputs.item_number": itemNumber,
        "inputs.target_repo": targetRepo,
        "inputs.target_branch": "main",
        "github.token": "synthetic-read-token",
        "github.event.inputs.target_repo": targetRepo,
        "github.event.inputs.item_number": itemNumber,
        "github.event.inputs.item_numbers": "",
        "github.event.inputs.additional_prompt || ''": "",
        "steps.target.outputs.target_repo": targetRepo,
        "steps.target.outputs.target_branch": "main",
        "steps.mode.outputs.codex_timeout_ms": "1200000",
        "steps.target-read-token.outputs.token || github.token": "synthetic-read-token",
        "vars.CLAWSWEEPER_APP_CLIENT_ID": "synthetic-app-id",
        "vars.EXACT_REVIEW_QUEUE_URL": queueUrl,
        "vars.CLAWSWEEPER_EXACT_REVIEW_QUEUE_URL": queueUrl,
        "vars.CLAWSWEEPER_EXACT_REVIEW_QUEUE_URL || 'https://clawsweeper.openclaw.ai'": queueUrl,
        "secrets.EXACT_REVIEW_QUEUE_SHARED_SECRET": secret,
        "secrets.CLAWSWEEPER_WEBHOOK_SECRET": secret,
      };
      const render = (value: string) => String(value).replace(/\$\{\{\s*([\s\S]*?)\s*\}\}/g, (_match, expression: string) => {
        assert.ok(Object.hasOwn(values, expression.trim()), `unfrozen workflow expression: ${expression}`);
        return values[expression.trim()];
      });
      const declared = { ...workflow.env, ...job.env, ...step.env };
      const env = Object.fromEntries(Object.entries(declared).map(([key, value]) => [key, render(String(value))]));
      assertAdmission(await execute(render(step.run), env, certificatePath));
    });
  } finally {
    try {
      if (server?.listening) {
        const listeningServer = server;
        await new Promise<void>((accept, reject) => listeningServer.close((error) => error ? reject(error) : accept()));
      }
    } finally {
      rmSync(certificateRoot, { recursive: true, force: true });
    }
  }
});
