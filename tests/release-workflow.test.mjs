// Doc/config-content tests for the release automation wiring (introduced to
// address "A": release-please PRs created by the default GITHUB_TOKEN never
// trigger CI, so the `main-protection` ruleset (required check `lint-and-build`)
// keeps every release PR permanently BLOCKED. The fix passes a non-default
// token to release-please and documents the operational runbook.
//
// These pin the load-bearing contract so a future edit that drops the token
// wiring or the runbook's required setup steps fails CI.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const releaseYaml = await readFile(join(ROOT, ".github", "workflows", "release.yaml"), "utf8");
const releasingDoc = await readFile(join(ROOT, "docs", "releasing.md"), "utf8");

test("release.yaml passes a non-default token to release-please so release PRs trigger CI", () => {
  // The release-please step must set `token:` (default GITHUB_TOKEN suppresses
  // downstream CI). It references a dedicated secret with a safe fallback.
  assert.match(
    releaseYaml,
    /token:\s*\$\{\{\s*secrets\.RELEASE_PLEASE_TOKEN\s*\|\|\s*secrets\.GITHUB_TOKEN\s*\}\}/,
    "release-please step must pass secrets.RELEASE_PLEASE_TOKEN with GITHUB_TOKEN fallback",
  );
});

test("release.yaml still publishes via OIDC provenance (no NPM_TOKEN regression)", () => {
  assert.match(releaseYaml, /npm publish --provenance --access public/);
  assert.doesNotMatch(
    releaseYaml,
    /NPM_TOKEN/,
    "publish must stay on OIDC Trusted Publishers, never NPM_TOKEN",
  );
});

test("docs/releasing.md documents the A fix: token wiring + why release PRs are blocked", () => {
  assert.match(releasingDoc, /RELEASE_PLEASE_TOKEN/);
  assert.match(releasingDoc, /main-protection/);
  assert.match(releasingDoc, /lint-and-build/);
  // Records the root cause (GITHUB_TOKEN does not trigger CI).
  assert.match(releasingDoc, /GITHUB_TOKEN/);
  assert.match(releasingDoc, /BLOCKED/);
});

test("docs/releasing.md documents the manual first release and the npm Trusted Publisher prerequisite (B)", () => {
  assert.match(releasingDoc, /初回リリース/);
  assert.match(releasingDoc, /v0\.1\.0/);
  assert.match(releasingDoc, /Trusted Publisher/);
  assert.match(releasingDoc, /npm publish --provenance --access public/);
});
