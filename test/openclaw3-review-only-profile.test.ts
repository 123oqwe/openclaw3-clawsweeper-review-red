import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const validator = new URL("../scripts/validate-openclaw3-review-only-profile.mjs", import.meta.url);
const example = new URL("../config/openclaw3-review-only.example.json", import.meta.url);

function validate(path: string) {
  return execFileSync(process.execPath, [validator.pathname, "--draft", path], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

test("review-only draft accepts the pinned manual comment-only contract but is not deployable", () => {
  assert.match(validate(example.pathname), /not deployment-ready/);
  assert.throws(
    () =>
      execFileSync(process.execPath, [validator.pathname, example.pathname], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }),
    (error: unknown) => /approval placeholder/.test(String((error as { stderr?: unknown }).stderr)),
  );
});

for (const [name, mutate, expected] of [
  ["rejects automatic close", (p: any) => (p.review.automaticClose = true), /automaticClose/],
  ["rejects scheduled intake", (p: any) => (p.review.scheduledIntake = true), /scheduledIntake/],
  ["rejects unpaired identity adaptation", (p: any) => (p.identity.replacementRequiresPairedLoginAndId = false), /login\/id pair/],
  ["rejects a source pin drift", (p: any) => (p.upstream.commit = "main"), /source pin/],
  ["rejects an escaped concrete target in a draft", (p: any) => (p.target.repository = "123oqwe/openclaw3.0"), /approval placeholder/],
] as const) {
  test(name, () => {
    const dir = mkdtempSync(join(tmpdir(), "openclaw3-review-only-"));
    const path = join(dir, "profile.json");
    const profile = JSON.parse(readFileSync(example, "utf8"));
    mutate(profile);
    writeFileSync(path, JSON.stringify(profile));
    assert.throws(() => validate(path), (error: unknown) => expected.test(String((error as { stderr?: unknown }).stderr)));
  });
}
