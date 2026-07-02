// Catalog-consistency tests (Issue #171).
//
// The SSOT for the skill catalog is `.agents/skills/` — every skill directory
// there must be reflected in the human-facing catalogs:
//   1. README.md skill table (`| Skill | Description |`) — all skills, no
//      excess rows (an excess row = leftover of a deleted skill)
//   2. docs/README.ja.md skill table (`| スキル | 用途 |`) — same set
//   3. CLAUDE.md "Available Skills" `/name` list — all *user-invocable*
//      skills. Referenced companions are exempt: a skill whose canonical
//      SKILL.md or Claude Code companion (SKILL.claude-code.md) declares
//      `user-invocable: false` is reference-only and never surfaced as a
//      slash command (today: commit-conventions, policy,
//      skill-observability). They may still appear; they are just not
//      required.
//   4. The "N skills total" / 「合計 N 件」 count sentences must match the
//      SSOT skill count.
//
// These assertions make a future skill addition/removal fail CI until
// README.md / docs/README.ja.md / CLAUDE.md are updated alongside the SSOT.

import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parseSkillDocument } from "../scripts/lib/frontmatter.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SKILLS_DIR = join(ROOT, ".agents", "skills");

/** List skill names from the SSOT directory. */
async function listSkillNames() {
  const entries = await readdir(SKILLS_DIR, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

/**
 * A skill is a referenced companion (reference-only) when its canonical
 * SKILL.md or its Claude Code companion sets `user-invocable: false`.
 */
async function isReferenceOnly(name) {
  for (const file of ["SKILL.md", "SKILL.claude-code.md"]) {
    let raw;
    try {
      raw = await readFile(join(SKILLS_DIR, name, file), "utf8");
    } catch {
      continue; // companion is optional
    }
    const { frontmatter } = parseSkillDocument(raw, `.agents/skills/${name}/${file}`);
    if (frontmatter["user-invocable"] === "false") return true;
  }
  return false;
}

/**
 * Extract skill names from the first-column backtick cells of the markdown
 * table that starts with `headerFirstCell` (e.g. "Skill" or "スキル").
 * Only contiguous `|`-prefixed lines after the header are considered, so
 * other tables in the same document are never picked up.
 */
function extractTableSkills(markdown, headerFirstCell, fileLabel) {
  const lines = markdown.split("\n");
  const headerIdx = lines.findIndex((line) =>
    new RegExp(`^\\|\\s*${headerFirstCell}\\s*\\|`).test(line),
  );
  assert.notEqual(
    headerIdx,
    -1,
    `${fileLabel}: skill table header "| ${headerFirstCell} |" not found`,
  );
  assert.match(
    lines[headerIdx + 1] ?? "",
    /^\|\s*-+\s*\|/,
    `${fileLabel}: skill table separator row not found`,
  );
  const names = [];
  for (let i = headerIdx + 2; i < lines.length && lines[i].startsWith("|"); i += 1) {
    const match = lines[i].match(/^\|\s*`([^`]+)`\s*\|/);
    assert.ok(match, `${fileLabel}: skill table row has no backtick name cell: ${lines[i]}`);
    names.push(match[1]);
  }
  assert.ok(names.length > 0, `${fileLabel}: skill table has no rows`);
  return names;
}

/** Extract `/name` entries from CLAUDE.md's Available Skills bullet list. */
function extractClaudeMdSkills(markdown) {
  const names = [];
  for (const line of markdown.split("\n")) {
    const match = line.match(/^- `\/([a-z0-9-]+)` — /);
    if (match) names.push(match[1]);
  }
  return names;
}

function assertSameSet(actual, expected, label) {
  const extra = actual.filter((name) => !expected.includes(name));
  const missing = expected.filter((name) => !actual.includes(name));
  assert.deepEqual(
    { missing, extra },
    { missing: [], extra: [] },
    `${label}: catalog out of sync with .agents/skills/ (missing = not listed, extra = listed but absent from SSOT)`,
  );
}

test("README.md skill table matches the SSOT skill set exactly", async () => {
  const skills = await listSkillNames();
  const raw = await readFile(join(ROOT, "README.md"), "utf8");
  const rows = extractTableSkills(raw, "Skill", "README.md");
  assertSameSet(rows, skills, "README.md skill table");
  assert.equal(
    rows.length,
    skills.length,
    "README.md skill table row count must equal SSOT skill count (duplicate rows?)",
  );
});

test("docs/README.ja.md skill table matches the SSOT skill set exactly", async () => {
  const skills = await listSkillNames();
  const raw = await readFile(join(ROOT, "docs", "README.ja.md"), "utf8");
  const rows = extractTableSkills(raw, "スキル", "docs/README.ja.md");
  assertSameSet(rows, skills, "docs/README.ja.md skill table");
  assert.equal(
    rows.length,
    skills.length,
    "docs/README.ja.md skill table row count must equal SSOT skill count (duplicate rows?)",
  );
});

test("CLAUDE.md Available Skills lists every user-invocable skill", async () => {
  const skills = await listSkillNames();
  const raw = await readFile(join(ROOT, "CLAUDE.md"), "utf8");
  const listed = [...new Set(extractClaudeMdSkills(raw))];

  const required = [];
  for (const name of skills) {
    if (!(await isReferenceOnly(name))) required.push(name);
  }

  const missing = required.filter((name) => !listed.includes(name));
  assert.deepEqual(
    missing,
    [],
    "CLAUDE.md Available Skills: user-invocable skills missing a `- `/name`` — entry",
  );

  const unknown = listed.filter((name) => !skills.includes(name));
  assert.deepEqual(
    unknown,
    [],
    "CLAUDE.md Available Skills lists skills that do not exist in .agents/skills/",
  );
});

test("reference-only exemption covers the known companions", async () => {
  // Guard the exemption rule itself: if a companion ever flips to
  // user-invocable (or a new reference-only skill appears), this snapshot
  // forces a conscious update of the catalog expectations.
  const skills = await listSkillNames();
  const referenceOnly = [];
  for (const name of skills) {
    if (await isReferenceOnly(name)) referenceOnly.push(name);
  }
  assert.deepEqual(referenceOnly, ["commit-conventions", "policy", "skill-observability"]);
});

test("skill-count sentences in both READMEs match the SSOT skill count", async () => {
  const skills = await listSkillNames();

  const en = await readFile(join(ROOT, "README.md"), "utf8");
  const enMatch = en.match(/(\d+) skills total/);
  assert.ok(enMatch, 'README.md: "N skills total" sentence not found');
  assert.equal(Number(enMatch[1]), skills.length, 'README.md "N skills total" count is stale');

  const ja = await readFile(join(ROOT, "docs", "README.ja.md"), "utf8");
  const jaMatch = ja.match(/合計 (\d+) 件/);
  assert.ok(jaMatch, "docs/README.ja.md: 「合計 N 件」 sentence not found");
  assert.equal(Number(jaMatch[1]), skills.length, "docs/README.ja.md 「合計 N 件」 count is stale");
});
