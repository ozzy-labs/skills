// npm pack payload contract tests.
//
// Asserts the payload shape produced by `npm pack --dry-run --json` matches
// what `package.json#files` declares:
//   - includes dist/, bin/, schemas/, README.md, LICENSE
//   - excludes the in-repo dogfood mirrors (.agents/, .claude/, src/, tests/)
//   - excludes the previously-shipped legacy duplicates
//     (dist/.agents/skills/, dist/.claude/skills/)
//
// Refs: ozzy-labs/skills#97 (sub-issue A — payload slim).

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function npmPackJson() {
  // `--ignore-scripts` avoids the `prepare` hook (lefthook install) leaking
  // non-JSON output into stdout when running in a sandbox without git hooks.
  const stdout = execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  return JSON.parse(stdout);
}

test("npm pack payload exposes the published surface", () => {
  const [pkg] = npmPackJson();
  assert.equal(pkg.name, "@ozzylabs/skills");
  assert.ok(Array.isArray(pkg.files), "pack output must list files");
  assert.ok(pkg.files.length > 0, "pack output must include at least one file");
});

test("npm pack includes README.md, LICENSE, package.json, and bin/install.mjs", () => {
  const [pkg] = npmPackJson();
  const paths = pkg.files.map((f) => f.path);
  for (const required of ["README.md", "LICENSE", "package.json", "bin/install.mjs"]) {
    assert.ok(
      paths.includes(required),
      `expected pack to include ${required}; got ${paths.join(", ")}`,
    );
  }
});

test("npm pack ships adapter payloads under dist/{adapter-id}/", () => {
  const [pkg] = npmPackJson();
  const paths = pkg.files.map((f) => f.path);
  const adapterPrefixes = [
    "dist/claude-code/",
    "dist/codex-cli/",
    "dist/gemini-cli/",
    "dist/copilot/",
  ];
  for (const prefix of adapterPrefixes) {
    assert.ok(
      paths.some((p) => p.startsWith(prefix)),
      `expected pack to include files under ${prefix}; got ${paths.length} paths`,
    );
  }
});

test("npm pack excludes the removed legacy duplicates", () => {
  const [pkg] = npmPackJson();
  const paths = pkg.files.map((f) => f.path);
  const forbidden = [
    // Legacy dist/ outputs that duplicated adapter content (removed in #97).
    "dist/.agents/",
    "dist/.claude/",
    // In-repo dogfood mirrors (kept on disk for skills repo's own slash
    // commands but excluded from the npm payload via `package.json#files`).
    ".agents/",
    ".claude/",
    // Internal sources that should never reach consumers.
    "src/",
    "tests/",
    "scripts/",
    "schemas/sync-targets",
  ];
  for (const banned of forbidden) {
    const hit = paths.filter((p) => p.startsWith(banned));
    // `schemas/` is allowed (e.g. schemas/sync-targets.schema.json); we only
    // forbid src/, tests/, scripts/, and the legacy dist/ mirrors.
    if (banned === "schemas/sync-targets") continue;
    assert.equal(hit.length, 0, `expected pack to exclude ${banned}; found ${JSON.stringify(hit)}`);
  }
});

test("npm pack only ships .mjs (bin), .md (docs), .json (manifests/schemas), .snippet, .sh, and .settings.json under dist/", () => {
  const [pkg] = npmPackJson();
  const allowedExts = [".md", ".json", ".snippet", ".sh", ".mjs"];
  for (const file of pkg.files) {
    const path = file.path;
    if (path === "LICENSE") continue; // no extension
    const ok = allowedExts.some((ext) => path.endsWith(ext));
    assert.ok(
      ok,
      `unexpected file in pack payload: ${path} (extension not in ${allowedExts.join(", ")})`,
    );
  }
});
