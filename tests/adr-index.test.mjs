// Doc-content tests for the skills project ADR set (docs/adr/, first introduced
// by #162 PR4 = observability measurement design).
//
// project ADRs are prose docs, so the *contract* pinned here is index integrity
// (the README Index row resolves to a real ADR file) plus the load-bearing
// decisions the observability ADR must record — so a future edit that drops the
// 2-tier routing rationale, a Decision, or the deferred-outcome note fails CI.

import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ADR_DIR = join(ROOT, "docs", "adr");

/** A markdown link target `[label](./path)` in the Index maps to a real file. */
async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

test("docs/adr/README.md Index rows resolve to real ADR files", async () => {
  const body = await readFile(join(ADR_DIR, "README.md"), "utf8");
  // Rows look like: | [0001](./0001-slug.md) | Title | Accepted | 2026-07-03 |
  const rows = [...body.matchAll(/^\|\s*\[(\d{4})\]\(\.\/([^)]+)\)\s*\|/gm)];
  assert.ok(rows.length > 0, "ADR Index has no rows");
  for (const [, num, file] of rows) {
    assert.match(
      file,
      new RegExp(`^${num}-`),
      `Index link ${file} must start with its number ${num}`,
    );
    assert.ok(await exists(join(ADR_DIR, file)), `Index references a missing ADR file: ${file}`);
  }
});

test("ADR-0001 is indexed and present", async () => {
  const index = await readFile(join(ADR_DIR, "README.md"), "utf8");
  assert.match(
    index,
    /\[0001\]\(\.\/0001-observability-measurement-design\.md\)/,
    "README Index must list the 0001 observability ADR",
  );
  assert.ok(
    await exists(join(ADR_DIR, "0001-observability-measurement-design.md")),
    "0001 ADR file must exist",
  );
});

test("docs/adr/README.md documents the 2-tier ADR routing", async () => {
  const body = await readFile(join(ADR_DIR, "README.md"), "utf8");
  assert.match(body, /cross-repo policy only/i, "must state handbook = cross-repo policy only");
  assert.match(body, /project ADR/i, "must name the project ADR tier");
  assert.match(body, /project-docs-layout\.md/, "must link the 2-tier convention");
  assert.match(body, /[Ii]ndependent/, "must state numbering is independent from the handbook");
});

test("ADR-0001 records the load-bearing decisions", async () => {
  const body = await readFile(join(ADR_DIR, "0001-observability-measurement-design.md"), "utf8");
  assert.match(body, /^- Status: Accepted/m, "Status must be Accepted");
  // MADR sections.
  for (const section of [
    "## Context",
    "## Decision",
    "## Consequences",
    "## Alternatives",
    "## References",
  ]) {
    assert.match(body, new RegExp(section), `missing MADR section: ${section}`);
  }
  // The seven decisions' load-bearing terms.
  assert.match(body, /[Aa]rtifact-derived/, "Decision 1: artifact-derived primary");
  assert.match(body, /min[_-]n/i, "Decision 2: min-n guard");
  assert.match(body, /additionalProperties/, "Decision 3: privacy guard");
  assert.match(body, /[Ff]ail-open/, "Decision 4: fail-open");
  assert.match(body, /lessons-triage/, "Decision 5: reflection folded into lessons-triage");
  assert.match(body, /dogfooding/i, "Decision 6: single-author dogfooding scope");
  assert.match(body, /OTel/, "Decision 7: native OTel is a separate surface");
  // Cross-references.
  assert.match(body, /ADR-0028/, "must cross-reference handbook ADR-0028 (R5)");
  assert.match(body, /#162/, "must reference issue #162");
});

test("ADR-0001 records the deferred outcome-derivation caveat", async () => {
  const body = await readFile(join(ADR_DIR, "0001-observability-measurement-design.md"), "utf8");
  assert.match(body, /## .*Deferred|### Deferred/i, "must have a Deferred section");
  assert.match(
    body,
    /[Oo]utcome[\s\S]{0,400}?(deferred|unimplemented|not.*auto-derived)/,
    "must record outcome derivation as deferred/unimplemented",
  );
  // The schema HAS an outcome type even though T0 auto-derivation is deferred.
  assert.match(body, /outcome/i, "outcome event type must be discussed");
});
