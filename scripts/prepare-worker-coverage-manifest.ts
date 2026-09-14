#!/usr/bin/env node
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { WORKER_RECORDS_MANIFEST_SCHEMA_VERSION } from "../src/review-coverage-manifest.ts";
import { discoverWorkerRecordRepoSlugs, fetchWorkerCanonicalItemIds } from "./worker-records.ts";

// A coverage-only artifact: this does not materialize or certify a records tree.
export async function prepareWorkerCoverageManifest(options: {
  worktreeRoot: string;
  baseUrl: string;
  webhookSecret: string;
  fetch?: typeof globalThis.fetch;
}) {
  const artifactRoot = path.join(options.worktreeRoot, ".artifacts");
  const manifestPath = path.join(artifactRoot, "worker-coverage-manifest.json");
  mkdirSync(artifactRoot, { recursive: true });
  // A failed refresh must not leave a previous manifest available to consumers.
  rmSync(manifestPath, { force: true });
  const slugs = await discoverWorkerRecordRepoSlugs(options);
  if (!slugs.length || new Set(slugs.map((entry) => entry.repoSlug)).size !== slugs.length) {
    throw new Error("Canonical coverage requires a nonempty, unique repository listing");
  }
  const repositories: Record<string, { coverageTrackedItemIds: number[] }> = {};
  for (const { repoSlug } of slugs) {
    repositories[repoSlug] = {
      coverageTrackedItemIds: await fetchWorkerCanonicalItemIds({ ...options, repoSlug }),
    };
  }
  const stagingRoot = mkdtempSync(path.join(artifactRoot, ".worker-coverage-"));
  try {
    const stagedPath = path.join(stagingRoot, "manifest.json");
    writeFileSync(
      stagedPath,
      `${JSON.stringify({ schemaVersion: WORKER_RECORDS_MANIFEST_SCHEMA_VERSION, source: "worker", purpose: "coverage-identities", repositories })}\n`,
      "utf8",
    );
    renameSync(stagedPath, manifestPath);
  } finally {
    rmSync(stagingRoot, { recursive: true, force: true });
  }
  return { manifestPath, repositoryCount: slugs.length };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const result = await prepareWorkerCoverageManifest({
      worktreeRoot: process.cwd(),
      baseUrl: process.env.CLAWSWEEPER_RECORDS_URL ?? "https://clawsweeper.openclaw.ai",
      webhookSecret:
        process.env.CLAWSWEEPER_RECORDS_SECRET ?? process.env.CLAWSWEEPER_WEBHOOK_SECRET ?? "",
    });
    console.log(`[worker-coverage] complete repositories=${result.repositoryCount}`);
  } catch {
    // Request diagnostics are allowlisted by the read client; do not print remote bodies.
    console.error("[worker-coverage] canonical identity preflight failed; refusing fanout");
    process.exitCode = 1;
  }
}
