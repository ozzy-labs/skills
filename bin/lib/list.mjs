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
import { readInstalled } from "./installed.mjs";
import { findPackageRoot } from "./install.mjs";

const HELP = `npx @ozzylabs/skills list [options]

Show the skill catalog and what is installed in a scope.

Options:
  --target=<dir>   List a project repo instead of user scope ($HOME).
  --json           Machine-readable JSON instead of the table.
  -h, --help       Show this help.
`;

const SCHEMA = { target: "string", json: "boolean", help: "boolean" };
const ALIASES = { h: "help" };

/** The full skill catalog the package ships (claude-code dist has every public skill). */
async function readCatalog(packageRoot) {
  const dir = join(packageRoot, "dist", "claude-code", ".claude", "skills");
  if (!existsSync(dir)) return [];
  return (await readdir(dir, { withFileTypes: true }))
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
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
