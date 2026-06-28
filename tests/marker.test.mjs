import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  isMarkerFile,
  MARKER_NAME,
  markerPathForDir,
  markerPathForFile,
  readDirMarker,
  readMarker,
  withAdapterAdded,
  withAdapterRemoved,
  writeDirMarker,
} from "../bin/lib/marker.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

test("isMarkerFile matches dir markers, agent sidecars, and nested markers", () => {
  assert.ok(isMarkerFile(".ozzylabs-skills.json"));
  assert.ok(isMarkerFile("code-reviewer.md.ozzylabs-skills.json"));
  assert.ok(isMarkerFile("review/.ozzylabs-skills.json"));
  assert.ok(!isMarkerFile("SKILL.md"));
  assert.ok(!isMarkerFile("perspectives/security.md"));
});

test("markerPathForFile appends the marker suffix (agent sidecar)", () => {
  assert.equal(markerPathForFile("/x/.claude/agents/foo.md"), `/x/.claude/agents/foo.md${MARKER_NAME}`);
});

test("writeDirMarker / readDirMarker round-trip with sorted adapters + schema", async () => {
  const dir = await mkdtemp(join(tmpdir(), "marker-"));
  try {
    const written = await writeDirMarker(dir, {
      bundleVersion: "1.4.2",
      adapters: ["codex-cli", "claude-code", "codex-cli"],
    });
    assert.deepEqual(written.adapters, ["claude-code", "codex-cli"]);
    assert.equal(written.schema, 1);
    assert.equal(written.source, "@ozzylabs/skills");
    const read = await readDirMarker(dir);
    assert.deepEqual(read, written);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("readMarker returns null for absent, corrupt, or foreign markers", async () => {
  const dir = await mkdtemp(join(tmpdir(), "marker-"));
  try {
    assert.equal(await readMarker(markerPathForDir(dir)), null, "absent");
    await writeFile(markerPathForDir(dir), "{ not json");
    assert.equal(await readMarker(markerPathForDir(dir)), null, "corrupt");
    await writeFile(markerPathForDir(dir), JSON.stringify({ source: "someone-else" }));
    assert.equal(await readMarker(markerPathForDir(dir)), null, "foreign source");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("withAdapterAdded / withAdapterRemoved reference-count the shared base", () => {
  const seed = withAdapterAdded(null, "codex-cli", "1.0.0");
  assert.deepEqual(seed.adapters, ["codex-cli"]);
  const merged = withAdapterAdded({ adapters: ["codex-cli"] }, "claude-code", "1.0.0");
  assert.deepEqual(merged.adapters, ["claude-code", "codex-cli"]);
  // Re-adding is idempotent.
  assert.deepEqual(withAdapterAdded(merged, "codex-cli", "1.0.0").adapters, [
    "claude-code",
    "codex-cli",
  ]);
  // Removing the last reference yields an empty list → caller deletes the base.
  assert.deepEqual(withAdapterRemoved({ adapters: ["codex-cli"] }, "codex-cli"), []);
  assert.deepEqual(withAdapterRemoved(merged, "codex-cli"), ["claude-code"]);
});

test("the build never ships a provenance marker into dist/", async () => {
  const { readdir } = await import("node:fs/promises");
  const stack = [join(ROOT, "dist")];
  const offenders = [];
  while (stack.length) {
    const dir = stack.pop();
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (isMarkerFile(entry.name)) offenders.push(full);
    }
  }
  assert.deepEqual(offenders, [], `dist must not contain provenance markers:\n${offenders.join("\n")}`);
});
