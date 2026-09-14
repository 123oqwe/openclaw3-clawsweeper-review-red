import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, createHmac } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { type TestContext } from "node:test";

import { prepareWorkerCoverageManifest } from "../scripts/prepare-worker-coverage-manifest.ts";
import { materializeWorkerRecords } from "../scripts/worker-records.ts";
import { coverageTrackedCountsFromManifest } from "../src/review-coverage-manifest.ts";

const secret = "coverage-fixture-secret";
const slugs = ["fixture-empty", "fixture-large", "fixture-small"];
const identities = new Map(
  slugs.map((slug, index) => [
    slug,
    index === 1 ? Array.from({ length: 501 }, (_, i) => i + 1) : index === 2 ? [7, 9] : [],
  ]),
);

function temporaryRoot(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "worker-coverage-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

async function fixture(t: TestContext, options: { full?: boolean; failSlug?: string } = {}) {
  const requests: Array<{ endpoint: string; repoSlug?: string; cursor?: number }> = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const text = Buffer.concat(chunks).toString("utf8");
    assert.equal(request.method, "POST");
    assert.equal(
      request.headers["x-clawsweeper-exact-review-signature"],
      "sha256=" + createHmac("sha256", secret).update(text).digest("hex"),
    );
    const body = JSON.parse(text);
    const endpoint = request.url ?? "";
    requests.push({ endpoint, repoSlug: body.repoSlug, cursor: body.cursor });
    const send = (status: number, value: unknown) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(value));
    };
    if (endpoint.endsWith("/slugs")) {
      send(200, { repositories: slugs.map((repoSlug) => ({ repoSlug, revision: 1 })) });
    } else if (endpoint.endsWith("/list")) {
      assert.equal(body.section, "items");
      assert.equal(body.limit, 500);
      if (body.repoSlug === options.failSlug) {
        send(403, { error: "BODY_SENTINEL_DO_NOT_LOG" });
      } else {
        const ids = (identities.get(body.repoSlug) ?? [])
          .filter((id) => id > body.cursor)
          .slice(0, 500);
        send(200, {
          repoSlug: body.repoSlug,
          section: "items",
          records: ids.map((id) => ({ id })),
          nextCursor: ids.length === 500 ? ids.at(-1) : null,
        });
      }
    } else if (options.full && endpoint.endsWith("/snapshots/latest")) {
      send(404, { error: "snapshot_not_found" });
    } else if (options.full && endpoint.endsWith("/export")) {
      const records = [
        ...(identities.get(body.repoSlug) ?? []).map((id) => ({
          section: "items",
          id: String(id),
          content: "fixture",
          digest: createHash("sha256").update("fixture").digest("hex"),
          revision: 1,
          storeRevision: id,
          deleted: false,
        })),
        {
          section: "closed",
          id: "800",
          content: "closed",
          digest: createHash("sha256").update("closed").digest("hex"),
          revision: 1,
          storeRevision: 800,
          deleted: false,
        },
        {
          section: "items",
          id: "900",
          content: null,
          digest: null,
          revision: 1,
          storeRevision: 900,
          deleted: true,
        },
      ];
      const page = records
        .filter((record) => record.storeRevision > body.cursor)
        .slice(0, body.limit);
      send(200, {
        repoSlug: body.repoSlug,
        revision: 1000,
        records: page,
        nextCursor: page.length === body.limit ? page.at(-1)?.storeRevision : null,
      });
    } else {
      send(403, { error: "UNEXPECTED_SNAPSHOT_OR_EXPORT" });
    }
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  t.after(() => new Promise<void>((done) => server.close(() => done())));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return { baseUrl: "http://127.0.0.1:" + address.port, webhookSecret: secret, requests };
}

function runCli(root: string, baseUrl: string) {
  const child = spawn(process.execPath, [resolve("scripts/prepare-worker-coverage-manifest.ts")], {
    cwd: root,
    env: {
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      CLAWSWEEPER_RECORDS_URL: baseUrl,
      CLAWSWEEPER_RECORDS_SECRET: secret,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += String(chunk);
  });
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((done, reject) => {
    child.on("error", reject);
    child.on("close", (code) => done({ code, stdout, stderr }));
  });
}

test("coverage CLI uses signed paginated identities without snapshot/export or record writes", async (t) => {
  const root = temporaryRoot(t);
  const service = await fixture(t);
  const result = await runCli(root, service.baseUrl);
  assert.equal(result.code, 0, result.stderr);
  const manifestPath = join(root, ".artifacts", "worker-coverage-manifest.json");
  assert.deepEqual(
    [...coverageTrackedCountsFromManifest(manifestPath)],
    [
      ["fixture-empty", 0],
      ["fixture-large", 501],
      ["fixture-small", 2],
    ],
  );
  assert.equal(JSON.parse(readFileSync(manifestPath, "utf8")).purpose, "coverage-identities");
  assert.equal(existsSync(join(root, "records")), false);
  assert.equal(existsSync(join(root, ".artifacts", "worker-records-manifest.json")), false);
  assert.deepEqual(
    service.requests.map((request) => [request.endpoint.split("/").at(-1), request.cursor]),
    [
      ["slugs", undefined],
      ["list", 0],
      ["list", 0],
      ["list", 500],
      ["list", 0],
    ],
  );
});

test("identities preflight matches full cold hydration coverage without closed/deleted records", async (t) => {
  t.mock.method(console, "error", () => {});
  const service = await fixture(t, { full: true });
  const full = await materializeWorkerRecords({
    ...service,
    worktreeRoot: temporaryRoot(t),
    repoSlugs: slugs,
  });
  const identity = await prepareWorkerCoverageManifest({
    ...service,
    worktreeRoot: temporaryRoot(t),
  });
  assert.deepEqual(
    [...coverageTrackedCountsFromManifest(identity.manifestPath)],
    [...coverageTrackedCountsFromManifest(full.manifestPath)],
  );
  const { reviewPlanningRepositories, planReviewFanout } =
    await import("../dist/repair/target-fanout.js");
  const repositories = slugs.map((slug) => ({
    targetRepo: slug.replace("-", "/"),
    defaultBranch: "main",
    visibility: "PUBLIC",
  }));
  const openCounts = new Map(
    repositories.map((repo, index) => [
      repo.targetRepo,
      { issues: index * 260, pullRequests: index },
    ]),
  );
  const plan = (manifest: string) =>
    planReviewFanout(
      reviewPlanningRepositories({
        repositories,
        openCounts,
        coverageTrackedCounts: coverageTrackedCountsFromManifest(manifest),
        recordsRoot: join(temporaryRoot(t), "absent-records"),
      }),
      { limit: 2, cursor: 1, candidateCapacity: 51 },
    );
  assert.deepEqual(plan(identity.manifestPath), plan(full.manifestPath));
});

test("late CLI failure removes stale output without publishing partial identities or remote text", async (t) => {
  const root = temporaryRoot(t);
  mkdirSync(join(root, ".artifacts"));
  const output = join(root, ".artifacts", "worker-coverage-manifest.json");
  writeFileSync(output, "stale manifest");
  const service = await fixture(t, { failSlug: "fixture-small" });
  const result = await runCli(root, service.baseUrl);
  assert.equal(result.code, 1);
  assert.equal(existsSync(output), false);
  assert.equal(existsSync(join(root, "records")), false);
  assert.match(result.stderr, /"endpoint":"records_list"/);
  assert.match(result.stderr, /"repoSlug":"fixture-small"/);
  assert.match(result.stderr, /"status":403/);
  assert.doesNotMatch(result.stderr, /BODY_SENTINEL|coverage-fixture-secret|https?:/);
  assert.equal(
    service.requests.filter((request) => request.repoSlug === "fixture-small").length,
    1,
  );
});

test("empty or duplicate discovery refuses coverage", async (t) => {
  for (const repositories of [
    [],
    [
      { repoSlug: "fixture-empty", revision: 1 },
      { repoSlug: "fixture-empty", revision: 1 },
    ],
  ]) {
    const root = temporaryRoot(t);
    await assert.rejects(
      prepareWorkerCoverageManifest({
        worktreeRoot: root,
        baseUrl: "http://127.0.0.1:1",
        webhookSecret: secret,
        fetch: async () => Response.json({ repositories }),
      }),
      /nonempty, unique/,
    );
    assert.equal(existsSync(join(root, ".artifacts", "worker-coverage-manifest.json")), false);
  }
});

test("persistent late read failure exhausts existing delays without exposing an artifact", async (t) => {
  const root = temporaryRoot(t);
  const delays: number[] = [];
  const original = globalThis.setTimeout;
  t.mock.method(globalThis, "setTimeout", ((callback: () => void, delay: number) => {
    delays.push(delay);
    queueMicrotask(callback);
    return 0 as unknown as ReturnType<typeof original>;
  }) as typeof setTimeout);
  t.mock.method(console, "error", () => {});
  let lateRequests = 0;
  await assert.rejects(
    prepareWorkerCoverageManifest({
      worktreeRoot: root,
      baseUrl: "http://127.0.0.1:1",
      webhookSecret: secret,
      fetch: async (input, init) => {
        if (String(input).endsWith("/slugs"))
          return Response.json({
            repositories: [
              { repoSlug: "fixture-first", revision: 1 },
              { repoSlug: "fixture-last", revision: 1 },
            ],
          });
        const body = JSON.parse(String(init?.body));
        if (body.repoSlug === "fixture-first") {
          assert.equal(
            existsSync(join(root, ".artifacts", "worker-coverage-manifest.json")),
            false,
          );
          return Response.json({
            repoSlug: body.repoSlug,
            section: "items",
            records: [{ id: 1 }],
            nextCursor: null,
          });
        }
        lateRequests++;
        return Response.json({ error: "exact_review_queue_unavailable" }, { status: 500 });
      },
    }),
    /exact_review_queue_unavailable/,
  );
  assert.equal(lateRequests, 3);
  assert.deepEqual(delays, [30_000, 60_000]);
  assert.equal(existsSync(join(root, ".artifacts", "worker-coverage-manifest.json")), false);
});
