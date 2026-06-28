// Validate review perspective MD files (ADR-0025).
//
// Each `.agents/skills/review/perspectives/<axis>.md` declares one review axis
// for the review skill / `code-reviewer` agent. The frontmatter must satisfy
// a documented schema so reviewers can correctly select and apply axes.

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parseSkillDocument } from "../scripts/lib/frontmatter.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PERSPECTIVES_DIR = join(ROOT, ".agents", "skills", "review", "perspectives");
const VALID_CATEGORIES = new Set(["required", "design", "quality", "ux"]);

async function listAxes() {
  const entries = await readdir(PERSPECTIVES_DIR, { withFileTypes: true });
  return entries
    .filter((e) => e.isFile() && e.name.endsWith(".md") && e.name !== "README.md")
    .map((e) => e.name)
    .sort();
}

test("perspectives directory exists with at least one axis file", async () => {
  assert.ok(existsSync(PERSPECTIVES_DIR), "perspectives directory must exist");
  const axes = await listAxes();
  assert.ok(axes.length > 0, "at least one axis MD must be present");
});

test("each perspective MD has required frontmatter keys", async () => {
  const axes = await listAxes();
  // Match Issue #59 scope: name, category, description, applies_when,
  // default_enabled, severity_rules, exit_criteria. (skip_when is optional —
  // required-category axes need no skip rules.)
  const required = [
    "name",
    "category",
    "description",
    "applies_when",
    "default_enabled",
    "severity_rules",
    "exit_criteria",
  ];
  for (const filename of axes) {
    const path = join(PERSPECTIVES_DIR, filename);
    const raw = await readFile(path, "utf8");
    const label = `.agents/skills/review/perspectives/${filename}`;
    const { frontmatter } = parseSkillDocument(raw, label);
    for (const key of required) {
      assert.ok(
        frontmatter[key] && frontmatter[key].length > 0,
        `${label}: missing required frontmatter key '${key}'`,
      );
    }
  }
});

test("severity_rules frontmatter mentions all three severities", async () => {
  const axes = await listAxes();
  for (const filename of axes) {
    const path = join(PERSPECTIVES_DIR, filename);
    const raw = await readFile(path, "utf8");
    const label = `.agents/skills/review/perspectives/${filename}`;
    const { frontmatter } = parseSkillDocument(raw, label);
    for (const sev of ["critical", "warning", "info"]) {
      assert.match(
        frontmatter.severity_rules,
        new RegExp(`\\b${sev}\\b`),
        `${label}: severity_rules must declare '${sev}'`,
      );
    }
  }
});

test("exit_criteria frontmatter declares drive_loop", async () => {
  const axes = await listAxes();
  for (const filename of axes) {
    const path = join(PERSPECTIVES_DIR, filename);
    const raw = await readFile(path, "utf8");
    const label = `.agents/skills/review/perspectives/${filename}`;
    const { frontmatter } = parseSkillDocument(raw, label);
    assert.match(
      frontmatter.exit_criteria,
      /drive_loop\s*:/,
      `${label}: exit_criteria must declare drive_loop`,
    );
    assert.match(
      frontmatter.exit_criteria,
      /critical\s*:/,
      `${label}: exit_criteria.drive_loop must declare critical threshold`,
    );
  }
});

test("perspective frontmatter name matches file name", async () => {
  const axes = await listAxes();
  for (const filename of axes) {
    const path = join(PERSPECTIVES_DIR, filename);
    const raw = await readFile(path, "utf8");
    const label = `.agents/skills/review/perspectives/${filename}`;
    const { frontmatter } = parseSkillDocument(raw, label);
    const expected = filename.replace(/\.md$/, "");
    assert.equal(
      frontmatter.name,
      expected,
      `${label}: frontmatter name='${frontmatter.name}' does not match filename`,
    );
  }
});

test("perspective category is one of required/design/quality/ux", async () => {
  const axes = await listAxes();
  for (const filename of axes) {
    const path = join(PERSPECTIVES_DIR, filename);
    const raw = await readFile(path, "utf8");
    const label = `.agents/skills/review/perspectives/${filename}`;
    const { frontmatter } = parseSkillDocument(raw, label);
    assert.ok(
      VALID_CATEGORIES.has(frontmatter.category),
      `${label}: category '${frontmatter.category}' is not one of ${[...VALID_CATEGORIES].join(", ")}`,
    );
  }
});

test("ADR-0025 set: 11 axes (3 required + 3 design + 3 quality + 2 ux)", async () => {
  const axes = await listAxes();
  const byCategory = { required: [], design: [], quality: [], ux: [] };
  for (const filename of axes) {
    const path = join(PERSPECTIVES_DIR, filename);
    const raw = await readFile(path, "utf8");
    const { frontmatter } = parseSkillDocument(raw, "");
    byCategory[frontmatter.category]?.push(frontmatter.name);
  }
  assert.equal(axes.length, 11, "ADR-0025 specifies 11 axes total");
  assert.equal(byCategory.required.length, 3);
  assert.equal(byCategory.design.length, 3);
  assert.equal(byCategory.quality.length, 3);
  assert.equal(byCategory.ux.length, 2);
});
