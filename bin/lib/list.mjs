// `skills list` — show the catalog and what's installed (ozzy-labs/skills#151 PR4).
//
// State is read from per-item provenance markers (no central registry): the
// shared `.agents/skills/<name>` base marker reference-counts adapters, and the
// `.claude/skills/<name>` wrapper marker covers claude-code-only skills (e.g.
// usage-guard, which has no base). The full catalog is read from the package's
// dist payload. Output is a compact table by default, or JSON with `--json`.

import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseFlags } from "./args.mjs";
import { findPackageRoot } from "./install.mjs";
import { readDirMarker } from "./marker.mjs";

const HELP = `npx @ozzylabs/skills list [options]

Show the skill catalog and what is installed in a scope.

Options:
  --target=<dir>   List a project repo instead of user scope ($HOME).
  --json           Machine-readable JSON instead of the table.
  -h, --help       Show this help.
`;

const SCHEMA = { target: "string", json: "boolean", help: "boolean" };
const ALIASES = { h: "help" };

// Roots scanned for installed skills, relative to the scope root. The base is
// shared across adapters; `.claude/skills` carries claude-code-only skills.
const SCAN_ROOTS = [".agents/skills", ".claude/skills"];

async function subdirs(dir) {
  if (!existsSync(dir)) return [];
  const entries = await readdir(dir, { withFileTypes: true });
  return entries.filter((e) => e.isDirectory()).map((e) => e.name);
}

/**
 * Read the installed state under a scope root from provenance markers.
 * @returns {Promise<Map<string, { version: string, adapters: Set<string> }>>}
 */
async function readInstalled(scopeRoot) {
  const installed = new Map();
  for (const root of SCAN_ROOTS) {
    for (const name of await subdirs(join(scopeRoot, root))) {
      const marker = await readDirMarker(join(scopeRoot, root, name));
      if (!marker) continue; // unmarked dir → not ours, skip
      const entry = installed.get(name) ?? { version: marker.bundleVersion, adapters: new Set() };
      for (const a of marker.adapters ?? []) entry.adapters.add(a);
      entry.version = marker.bundleVersion ?? entry.version;
      installed.set(name, entry);
    }
  }
  return installed;
}

/** The full skill catalog the package ships (claude-code dist has every public skill). */
async function readCatalog(packageRoot) {
  const names = await subdirs(join(packageRoot, "dist", "claude-code", ".claude", "skills"));
  return names.sort();
}

/**
 * @param {string[]} argv args past the `list` subcommand keyword
 * @returns {Promise<number>} exit code
 */
export async function runList(argv) {
  let parsed;
  try {
    parsed = parseFlags(argv, SCHEMA, ALIASES);
  } catch (err) {
    process.stderr.write(`error: ${err.message}\n\n${HELP}`);
    return 1;
  }
  if (parsed.values.help) {
    process.stdout.write(HELP);
    return 0;
  }
  if (parsed.rejected.length > 0) {
    process.stderr.write(`error: unknown argument(s): ${parsed.rejected.join(", ")}\n\n${HELP}`);
    return 1;
  }

  const packageRoot = await findPackageRoot();
  const scopeRoot = parsed.values.target ?? process.env.OZZYLABS_SKILLS_HOME ?? homedir();
  const scope = parsed.values.target ? "project" : "user";

  const catalog = await readCatalog(packageRoot);
  const installed = await readInstalled(scopeRoot);

  // Catalog skills first (alpha), then any installed skill not in the catalog.
  const names = [...new Set([...catalog, ...installed.keys()])].sort();
  const rows = names.map((name) => {
    const inst = installed.get(name);
    return {
      skill: name,
      status: inst ? "installed" : "available",
      version: inst?.version ?? null,
      adapters: inst ? [...inst.adapters].sort() : [],
    };
  });

  if (parsed.values.json) {
    process.stdout.write(`${JSON.stringify({ scope, root: scopeRoot, skills: rows }, null, 2)}\n`);
    return 0;
  }

  const pad = Math.max(5, ...rows.map((r) => r.skill.length));
  const lines = [`Skills (${scope} scope: ${scopeRoot})`, ""];
  for (const r of rows) {
    const mark = r.status === "installed" ? "●" : "○";
    const detail =
      r.status === "installed" ? `${r.version}  [${r.adapters.join(", ")}]` : "available";
    lines.push(`  ${mark} ${r.skill.padEnd(pad)}  ${detail}`);
  }
  process.stdout.write(`${lines.join("\n")}\n`);
  return 0;
}

export { HELP };
