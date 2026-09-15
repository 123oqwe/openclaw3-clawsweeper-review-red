import fs from "node:fs";

const args = process.argv.slice(2);
const expected = ["api", `repos/${process.env.OC3_TARGET_REPO}/issues/41`];
const releaseRead = ["--repo", process.env.OC3_TARGET_REPO, "release", "list", "--exclude-drafts", "--exclude-pre-releases", "--limit", "100", "--json", "tagName,name,publishedAt,isLatest"];
const stat = fs.readFileSync("/proc/self/stat", "utf8");
const processGroup = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[2]);
const record = (event) => fs.appendFileSync(process.env.OC3_GH_TRACE,
  JSON.stringify({ event, pid: process.pid, processGroup, args }) + "\n");

// These are the existing gitInfo() release read and exact selection metadata read.
if (args.length === releaseRead.length && args.every((value, i) => value === releaseRead[i])) {
  record("release-read");
  process.stdout.write("[]\n");
} else if (args.length === expected.length && args.every((value, i) => value === expected[i])) {
  record("metadata-ready");
  if (process.env.OC3_SCENARIO === "revoked") {
    // The real queue is changed only after this point. Only the production
    // workflow's lease-loss process-group termination should end this transport.
    setTimeout(() => { record("barrier-timeout"); process.exit(98); }, 15_000);
  } else {
    record("metadata-denied");
    process.stderr.write("gh: Resource not accessible by integration: OC3_EXECUTOR_METADATA_DENIED (HTTP 403)\n");
    process.exitCode = 1;
  }
} else {
  record("unexpected-gh");
  process.stderr.write(`Unexpected synthetic GitHub operation: ${JSON.stringify(args)}\n`);
  process.exitCode = 97;
}
