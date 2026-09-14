import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  ACTION_SESSION_FETCH_TIMEOUT_MS,
  actionRunUrl,
  actionSessionOwner,
  actionSourceUrl,
  actionWorkKey,
  actionWorkKind,
  registerActionSession,
  updateActionSession,
} from "../../dist/repair/action-session.js";

test("action session classifies issue implementation and PR repair work", () => {
  assert.equal(
    actionWorkKind({ job_intent: "implement_issue", source: "issue_implementation" }),
    "issue_to_pr",
  );
  assert.equal(actionWorkKind({ job_intent: "automerge_pr" }), "pr_repair");
  assert.equal(actionWorkKind({ job_intent: "pr_repair" }), "pr_repair");
  assert.equal(actionWorkKind({ cluster_id: "automerge-openclaw-openclaw-123" }), "pr_repair");
  assert.equal(actionWorkKind({ cluster_id: "repair-pr-openclaw-clawsweeper-290" }), "pr_repair");
  assert.equal(actionWorkKind({ job_intent: "repair_cluster" }), "repair_cluster");
});

test("action session builds stable work and run identifiers", () => {
  assert.equal(
    actionWorkKey({ repo: "openclaw/openclaw", cluster_id: "issue-openclaw-openclaw-123" }),
    "openclaw/openclaw:issue-openclaw-openclaw-123",
  );
  assert.equal(
    actionRunUrl({
      GITHUB_SERVER_URL: "https://github.example/",
      GITHUB_REPOSITORY: "openclaw/clawsweeper",
      GITHUB_RUN_ID: "456",
    }),
    "https://github.example/openclaw/clawsweeper/actions/runs/456",
  );
});

test("action session reads the configured CrabFleet owner principal", () => {
  assert.equal(actionSessionOwner({ CLAWSWEEPER_CRABFLEET_OWNER: "@steipete" }), "@steipete");
  assert.throws(
    () => actionSessionOwner({}),
    /action session requires a configured CrabFleet owner/,
  );
});

test("action session prefers the full source URL from the job body", () => {
  assert.equal(
    actionSourceUrl({
      raw: "Source issue: https://github.com/openclaw/openclaw/issues/123\n",
      frontmatter: {
        repo: "openclaw/openclaw",
        canonical: ["#456"],
      },
    } as never),
    "https://github.com/openclaw/openclaw/issues/123",
  );
});

test(
  "action session register and update abort hung CrabFleet fetches",
  { timeout: 3_000 },
  async (t) => {
    const previousTimeout = AbortSignal.timeout;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-action-session-"));
    const jobPath = path.join(tmp, "job.md");
    const envPath = path.join(tmp, "github.env");
    const metadataPath = path.join(tmp, "action-session.json");
    fs.writeFileSync(
      jobPath,
      `---
repo: openclaw/openclaw
cluster_id: repair-pr-openclaw-openclaw-1
target_branch: main
job_intent: pr_repair
---
Source issue: https://github.com/openclaw/openclaw/issues/1
`,
    );
    fs.writeFileSync(envPath, "");

    const previousEnv = {
      CLAWSWEEPER_CRABFLEET_SERVICE_TOKEN: process.env.CLAWSWEEPER_CRABFLEET_SERVICE_TOKEN,
      CLAWSWEEPER_CRABFLEET_URL: process.env.CLAWSWEEPER_CRABFLEET_URL,
      CLAWSWEEPER_CRABFLEET_OWNER: process.env.CLAWSWEEPER_CRABFLEET_OWNER,
      CLAWSWEEPER_CRABFLEET_WORK_STATE_URL: process.env.CLAWSWEEPER_CRABFLEET_WORK_STATE_URL,
      CLAWSWEEPER_CRABFLEET_AGENT_TOKEN: process.env.CLAWSWEEPER_CRABFLEET_AGENT_TOKEN,
      CLAWSWEEPER_ACTION_SESSION_METADATA: process.env.CLAWSWEEPER_ACTION_SESSION_METADATA,
      GITHUB_ENV: process.env.GITHUB_ENV,
    };
    t.after(() => {
      AbortSignal.timeout = previousTimeout;
      restoreEnv(
        "CLAWSWEEPER_CRABFLEET_SERVICE_TOKEN",
        previousEnv.CLAWSWEEPER_CRABFLEET_SERVICE_TOKEN,
      );
      restoreEnv("CLAWSWEEPER_CRABFLEET_URL", previousEnv.CLAWSWEEPER_CRABFLEET_URL);
      restoreEnv("CLAWSWEEPER_CRABFLEET_OWNER", previousEnv.CLAWSWEEPER_CRABFLEET_OWNER);
      restoreEnv(
        "CLAWSWEEPER_CRABFLEET_WORK_STATE_URL",
        previousEnv.CLAWSWEEPER_CRABFLEET_WORK_STATE_URL,
      );
      restoreEnv(
        "CLAWSWEEPER_CRABFLEET_AGENT_TOKEN",
        previousEnv.CLAWSWEEPER_CRABFLEET_AGENT_TOKEN,
      );
      restoreEnv(
        "CLAWSWEEPER_ACTION_SESSION_METADATA",
        previousEnv.CLAWSWEEPER_ACTION_SESSION_METADATA,
      );
      restoreEnv("GITHUB_ENV", previousEnv.GITHUB_ENV);
      fs.rmSync(tmp, { recursive: true, force: true });
    });

    const server = http.createServer((_request, _response) => {});
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(
      () =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    );
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const origin = `http://127.0.0.1:${address.port}`;

    const seenTimeouts: number[] = [];
    t.mock.method(AbortSignal, "timeout", (ms: number) => {
      seenTimeouts.push(ms);
      return previousTimeout(50);
    });

    process.env.CLAWSWEEPER_CRABFLEET_SERVICE_TOKEN = "service-token";
    process.env.CLAWSWEEPER_CRABFLEET_URL = origin;
    process.env.CLAWSWEEPER_CRABFLEET_OWNER = "@steipete";
    process.env.CLAWSWEEPER_ACTION_SESSION_METADATA = metadataPath;
    process.env.GITHUB_ENV = envPath;
    process.env.CLAWSWEEPER_CRABFLEET_WORK_STATE_URL = `${origin}/work-state`;
    process.env.CLAWSWEEPER_CRABFLEET_AGENT_TOKEN = "agent-token";

    await assert.rejects(
      () => registerActionSession(jobPath),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.name, /AbortError|TimeoutError/);
        return true;
      },
    );
    await assert.rejects(
      () =>
        updateActionSession({
          state: "running",
          phase: "planning",
          summary: "Planning",
          completionReason: "",
        }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.name, /AbortError|TimeoutError/);
        return true;
      },
    );
    assert.deepEqual(seenTimeouts, [
      ACTION_SESSION_FETCH_TIMEOUT_MS,
      ACTION_SESSION_FETCH_TIMEOUT_MS,
    ]);
  },
);

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
