// Tests for review.mjs perspective SELECTION (ADR-0028 R1 / ADR-0025 選別).
//
// Layer 1: the glob matcher and the pure selection algorithm against synthetic
// perspective descriptors (full control over the 5 selection rules).
// Layer 2: the real `.agents/skills/review/perspectives/*.md` set — realistic
// changed-file sets → expected applied axes, so the frontmatter and the engine
// stay in lockstep (replaces the "prose re-implementation" assertions).

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  globToRegExp,
  loadPerspectives,
  matchesAny,
  parsePerspectiveFrontmatter,
  renderSelection,
  run,
  selectAxes,
} from "../.agents/skills/review/review.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PERSPECTIVES_DIR = join(ROOT, ".agents", "skills", "review", "perspectives");

/** Build a synthetic perspective descriptor (parsePerspectiveFrontmatter shape). */
function persp(name, category, appliesWhen, diffOnlyIn = null, defaultEnabled = true) {
  return { name, category, appliesWhen, diffOnlyIn, defaultEnabled };
}

// ---------------------------------------------------------------------------
// glob matcher
// ---------------------------------------------------------------------------

test("globToRegExp: **/* matches root and nested files", () => {
  const re = globToRegExp("**/*");
  assert.ok(re.test("README.md"));
  assert.ok(re.test("a/b/c.ts"));
});

test("globToRegExp: dir/** matches only under that dir", () => {
  const re = globToRegExp("src/**");
  assert.ok(re.test("src/x.ts"));
  assert.ok(re.test("src/a/b.ts"));
  assert.ok(!re.test("README.md"));
  assert.ok(!re.test("srcx.ts"));
});

test("globToRegExp: exact path vs **/*.ext", () => {
  assert.ok(globToRegExp("package.json").test("package.json"));
  assert.ok(!globToRegExp("package.json").test("sub/package.json"));
  const md = globToRegExp("**/*.md");
  assert.ok(md.test("x.md"));
  assert.ok(md.test("docs/x.md"));
  assert.ok(!md.test("x.mdx"));
});

test("globToRegExp: **/*.test.* and **/SKILL.md", () => {
  const t = globToRegExp("**/*.test.*");
  assert.ok(t.test("a.test.mjs"));
  assert.ok(t.test("tests/x.test.ts"));
  assert.ok(!t.test("a.mjs"));
  const s = globToRegExp("**/SKILL.md");
  assert.ok(s.test("SKILL.md"));
  assert.ok(s.test("a/b/SKILL.md"));
});

test("matchesAny: OR across globs", () => {
  assert.ok(matchesAny("src/x.ts", ["docs/**", "src/**"]));
  assert.ok(!matchesAny("README.md", ["src/**", "**/*.ts"]));
});

// ---------------------------------------------------------------------------
// selection algorithm (synthetic perspectives)
// ---------------------------------------------------------------------------

test("required axes always apply (ignore applies_when/skip_when, even with no changed files)", () => {
  const perspectives = [
    persp("correctness", "required", ["**/*"]),
    persp("security", "required", ["**/*"]),
    persp("testing", "quality", ["src/**"], ["**/*.md"]),
  ];
  const sel = selectAxes({ changedFiles: [], perspectives });
  assert.deepEqual(sel.axesApplied, ["correctness", "security"]);
});

test("skip_when.diff_only_in has priority: matches applies_when but diff confined → skip", () => {
  const perspectives = [
    persp("correctness", "required", ["**/*"]),
    persp("testing", "quality", ["**/*.mjs"], ["tests/**"]),
  ];
  // tests/a.mjs matches applies_when (**/*.mjs) AND is ⊆ diff_only_in (tests/**).
  const sel = selectAxes({ changedFiles: ["tests/a.mjs"], perspectives });
  assert.deepEqual(sel.axesApplied, ["correctness"]);
});

test("skip does NOT fire when some changed file is outside diff_only_in", () => {
  const perspectives = [persp("testing", "quality", ["src/**"], ["**/*.md"])];
  const sel = selectAxes({ changedFiles: ["src/a.ts", "README.md"], perspectives });
  assert.deepEqual(sel.axesApplied, ["testing"]);
});

test("empty diff_only_in [] never skips (documentation-like)", () => {
  const perspectives = [persp("documentation", "ux", ["**/*"], [])];
  const sel = selectAxes({ changedFiles: ["src/a.ts"], perspectives });
  assert.deepEqual(sel.axesApplied, ["documentation"]);
});

test("applies_when OR-match: at least one file matches → apply", () => {
  const perspectives = [persp("architecture", "design", ["src/**", "**/*.mjs"])];
  assert.deepEqual(
    selectAxes({ changedFiles: ["docs/x.md", "src/a.ts"], perspectives }).axesApplied,
    ["architecture"],
  );
  assert.deepEqual(selectAxes({ changedFiles: ["docs/x.md"], perspectives }).axesApplied, []);
});

test("default_enabled:false is excluded unless named in --axes", () => {
  const perspectives = [
    persp("correctness", "required", ["**/*"]),
    persp("experimental", "quality", ["**/*"], null, false),
  ];
  assert.deepEqual(selectAxes({ changedFiles: ["src/a.ts"], perspectives }).axesApplied, [
    "correctness",
  ]);
  assert.deepEqual(
    selectAxes({ changedFiles: ["src/a.ts"], perspectives, explicitAxes: ["experimental"] })
      .axesApplied,
    ["experimental"],
  );
});

test("--axes explicit override applies exactly the named axes, ignoring globs", () => {
  const perspectives = [
    persp("correctness", "required", ["**/*"]),
    persp("security", "required", ["**/*"]),
    persp("performance", "quality", ["src/**"], ["**/*.md"]),
  ];
  // performance would normally be skipped for a docs-only diff; --axes forces it.
  const sel = selectAxes({
    changedFiles: ["README.md"],
    perspectives,
    explicitAxes: ["performance", "security"],
  });
  assert.deepEqual(sel.axesApplied, ["security", "performance"]);
});

test("--axes with an unknown axis is reported in unknownAxes", () => {
  const perspectives = [persp("correctness", "required", ["**/*"])];
  const sel = selectAxes({
    changedFiles: ["src/a.ts"],
    perspectives,
    explicitAxes: ["correctness", "nope"],
  });
  assert.deepEqual(sel.axesApplied, ["correctness"]);
  assert.deepEqual(sel.unknownAxes, ["nope"]);
});

test("byCategory groups applied axes and renderSelection shows the block", () => {
  const perspectives = [
    persp("correctness", "required", ["**/*"]),
    persp("security", "required", ["**/*"]),
    persp("architecture", "design", ["src/**"]),
    persp("documentation", "ux", ["**/*"], []),
  ];
  const sel = selectAxes({ changedFiles: ["src/a.ts"], perspectives });
  assert.deepEqual(sel.byCategory, {
    required: ["correctness", "security"],
    design: ["architecture"],
    ux: ["documentation"],
  });
  const block = renderSelection(sel);
  assert.match(block, /^適用観点 \(4\/4\):/);
  assert.match(block, /required: correctness, security/);
  assert.match(block, /design: {3}architecture/);
});

// ---------------------------------------------------------------------------
// frontmatter parsing
// ---------------------------------------------------------------------------

test("parsePerspectiveFrontmatter extracts globs, skip_when, default_enabled", () => {
  const raw = [
    "---",
    "name: testing",
    "category: quality",
    'applies_when: ["src/**", "**/*.mjs"]',
    'skip_when: { diff_only_in: ["**/*.md", "docs/**"] }',
    "default_enabled: true",
    "---",
    "",
    "# body",
  ].join("\n");
  const p = parsePerspectiveFrontmatter(raw);
  assert.equal(p.name, "testing");
  assert.equal(p.category, "quality");
  assert.deepEqual(p.appliesWhen, ["src/**", "**/*.mjs"]);
  assert.deepEqual(p.diffOnlyIn, ["**/*.md", "docs/**"]);
  assert.equal(p.defaultEnabled, true);
});

test("parsePerspectiveFrontmatter: no skip_when → diffOnlyIn null; default_enabled:false honored", () => {
  const raw = [
    "---",
    "name: correctness",
    "category: required",
    'applies_when: ["**/*"]',
    "default_enabled: false",
    "---",
  ].join("\n");
  const p = parsePerspectiveFrontmatter(raw);
  assert.equal(p.diffOnlyIn, null);
  assert.equal(p.defaultEnabled, false);
  assert.equal(parsePerspectiveFrontmatter("no frontmatter"), null);
});

// ---------------------------------------------------------------------------
// real perspectives (SSOT) — realistic sets
// ---------------------------------------------------------------------------

test("real perspectives: docs-only diff → required + documentation + usability", () => {
  const perspectives = loadPerspectives(PERSPECTIVES_DIR);
  assert.equal(perspectives.length, 11);
  const sel = selectAxes({ changedFiles: ["README.md"], perspectives });
  assert.deepEqual(sel.axesApplied, [
    "correctness",
    "security",
    "conventions",
    "usability",
    "documentation",
  ]);
});

test("real perspectives: a src/*.mjs change applies all 11 axes", () => {
  const perspectives = loadPerspectives(PERSPECTIVES_DIR);
  const sel = selectAxes({ changedFiles: ["src/foo.mjs"], perspectives });
  assert.equal(sel.axesApplied.length, 11);
});

test("real perspectives: --axes override selects exactly the named set", () => {
  const perspectives = loadPerspectives(PERSPECTIVES_DIR);
  const sel = selectAxes({
    changedFiles: ["README.md"],
    perspectives,
    explicitAxes: ["security", "architecture"],
  });
  assert.deepEqual(sel.axesApplied, ["security", "architecture"]);
});

// ---------------------------------------------------------------------------
// CLI dispatch
// ---------------------------------------------------------------------------

test("run select --json reads a changed-file list and emits structured selection", () => {
  const dir = mkdtempSync(join(tmpdir(), "review-select-"));
  const changed = join(dir, "changed.txt");
  writeFileSync(changed, "README.md\n");
  const out = run([
    "select",
    "--json",
    `--perspectives-dir=${PERSPECTIVES_DIR}`,
    `--changed-file=${changed}`,
  ]);
  const parsed = JSON.parse(out);
  assert.equal(parsed.total, 11);
  assert.ok(parsed.axesApplied.includes("documentation"));
  assert.ok(!parsed.axesApplied.includes("performance"));
});
