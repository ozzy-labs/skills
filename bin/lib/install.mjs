// `npx @ozzylabs/skills install` implementation.
//
// The installer copies canonical skill payloads from the package's `dist/`
// directory into the user-scoped skills directory (always under HOME — never
// project-scoped). Adapter layouts mirror what the build pipeline writes
// under `dist/{adapter-id}/`:
//
//   claude-code → ~/.claude/skills/{name}/SKILL.md  (+ extras)
//   codex-cli   → ~/.agents/skills/{name}/SKILL.md  (+ extras + AGENTS.md.snippet)
//   gemini-cli  → ~/.gemini/settings.json + ~/AGENTS.md.snippet (no per-skill files)
//   copilot     → ~/.github/copilot-instructions.md.snippet     (no per-skill files)
//
// `--dry-run` reports the plan as JSON on stdout without touching the disk.

import { existsSync } from "node:fs";
import { copyFile, mkdir, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { assertNoForbiddenFlags, parseFlags } from "./args.mjs";

const HELP = `npx @ozzylabs/skills install [options]

Install canonical OzzyLabs skills into the user-scoped skills directory.

Options:
  --skills=<list>      Comma-separated skill names (default: install all).
  --adapter=<id>       Adapter id: claude-code (default), codex-cli,
                       gemini-cli, copilot.
  --dry-run            Print the install plan as JSON and exit. No files are
                       written.
  --upgrade            Overwrite skills that are already installed.
  --force              Skip the interactive confirmation prompt (non-TTY
                       sessions skip the prompt automatically).
  -h, --help           Show this help.

Note: @ozzylabs/skills installs into the user-scoped skills directory only —
i.e. under \$HOME. Project-scoped install paths (e.g. \`--target\`) are not
supported and never will be. Use the legacy \`/sync-consumers\` flow if you
need per-repo skill mirrors.
`;

const SUPPORTED_ADAPTERS = ["claude-code", "codex-cli", "gemini-cli", "copilot"];

const SCHEMA = {
  skills: "string",
  adapter: "string",
  "dry-run": "boolean",
  upgrade: "boolean",
  force: "boolean",
  help: "boolean",
};

const ALIASES = { h: "help" };

// Per-adapter description of how to walk the dist tree and map it onto
// the user HOME directory. Each adapter declares:
//   - skillsRoot:  the dist-relative path containing per-skill folders (or
//                  null if the adapter does not ship per-skill folders).
//   - distSubtree: the dist-relative directory rooted at the user HOME image
//                  (i.e. everything below this directory is copied to
//                  `<HOME>/<rest-of-path>`).
const ADAPTER_LAYOUT = {
  "claude-code": {
    skillsRoot: ".claude/skills",
    distSubtree: ".",
  },
  "codex-cli": {
    skillsRoot: ".agents/skills",
    distSubtree: ".",
  },
  "gemini-cli": {
    skillsRoot: null,
    distSubtree: ".",
  },
  copilot: {
    skillsRoot: null,
    distSubtree: ".",
  },
};

/**
 * Walk a directory tree and return every file path relative to `root`.
 * Paths are normalized to forward-slash separators so the internal layout
 * comparisons (e.g. matching `".claude/skills/"`) work on Windows too.
 *
 * @param {string} root
 * @returns {Promise<string[]>}
 */
async function listFiles(root) {
  const out = [];
  async function walk(dir) {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile()) {
        out.push(relative(root, full).split(sep).join("/"));
      }
    }
  }
  await walk(root);
  out.sort();
  return out;
}

/**
 * Read a directory's immediate subdirectory names. Returns [] if missing.
 *
 * @param {string} dir
 * @returns {Promise<string[]>}
 */
async function listSubdirs(dir) {
  if (!existsSync(dir)) return [];
  const entries = await readdir(dir, { withFileTypes: true });
  return entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

/**
 * Locate the @ozzylabs/skills package root (the directory that contains
 * `dist/` and `package.json`). Walks up from this module's location, which
 * works both inside the installed npm package and inside the source repo.
 *
 * @returns {Promise<string>}
 */
async function findPackageRoot() {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(dir, "package.json")) && existsSync(join(dir, "dist"))) {
      return dir;
    }
    dir = dirname(dir);
  }
  throw new Error(
    "could not locate the @ozzylabs/skills package root (missing dist/ next to package.json)",
  );
}

/**
 * Confirm an interactive overwrite. Returns true when stdin is a TTY and the
 * user types "y"/"yes", or when `force` is set. Non-TTY sessions return
 * false (i.e. skip the skill) so unattended runs never block on prompts.
 *
 * @param {string} message
 * @param {boolean} force
 * @returns {Promise<boolean>}
 */
async function confirm(message, force) {
  if (force) return true;
  if (!process.stdin.isTTY) return false;
  process.stdout.write(`${message} [y/N] `);
  return await new Promise((resolve) => {
    let buf = "";
    const onData = (chunk) => {
      buf += chunk.toString();
      if (buf.includes("\n")) {
        process.stdin.off("data", onData);
        process.stdin.pause();
        const answer = buf.trim().toLowerCase();
        resolve(answer === "y" || answer === "yes");
      }
    };
    process.stdin.resume();
    process.stdin.on("data", onData);
  });
}

/**
 * Plan a single install run. Pure: takes inputs and returns the action plan
 * without touching the filesystem. The caller is responsible for printing
 * the plan (`--dry-run`) or executing it.
 *
 * @param {object} args
 * @param {string} args.packageRoot
 * @param {string} args.home
 * @param {string} args.adapter
 * @param {string[] | null} args.skillsFilter
 * @returns {Promise<{ adapter: string, target_dir: string, files: Array<{ source: string, dest: string, skill: string | null }>, skills_available: string[] }>}
 */
export async function planInstall({ packageRoot, home, adapter, skillsFilter }) {
  if (!SUPPORTED_ADAPTERS.includes(adapter)) {
    throw new Error(
      `unsupported adapter '${adapter}' — choose from: ${SUPPORTED_ADAPTERS.join(", ")}`,
    );
  }
  const layout = ADAPTER_LAYOUT[adapter];
  const distAdapterRoot = join(packageRoot, "dist", adapter);
  if (!existsSync(distAdapterRoot)) {
    throw new Error(`missing adapter payload at ${distAdapterRoot} — run \`pnpm build\` first?`);
  }

  const skillsAvailable = layout.skillsRoot
    ? await listSubdirs(join(distAdapterRoot, layout.skillsRoot))
    : [];

  // Validate the requested skill list against what the payload actually
  // ships. We accept an empty filter (= install everything) but reject
  // typos eagerly.
  if (skillsFilter && layout.skillsRoot) {
    const unknown = skillsFilter.filter((s) => !skillsAvailable.includes(s));
    if (unknown.length > 0) {
      throw new Error(
        `unknown skill(s) for adapter '${adapter}': ${unknown.join(", ")} (available: ${skillsAvailable.join(", ") || "<none>"})`,
      );
    }
  }
  if (skillsFilter && !layout.skillsRoot) {
    throw new Error(
      `adapter '${adapter}' does not ship per-skill files; --skills is only meaningful for adapters that do (claude-code, codex-cli)`,
    );
  }

  const allFiles = await listFiles(distAdapterRoot);
  const files = [];
  for (const relPath of allFiles) {
    let skillName = null;
    if (layout.skillsRoot && relPath.startsWith(`${layout.skillsRoot}/`)) {
      const tail = relPath.slice(layout.skillsRoot.length + 1);
      skillName = tail.split("/")[0];
      if (skillsFilter && !skillsFilter.includes(skillName)) continue;
    } else if (skillsFilter) {
      // When the caller restricted to specific skills, skip the
      // adapter-level snippet files (e.g. AGENTS.md.snippet) because they
      // embed the full skill catalog and would not match the filter.
      continue;
    }
    files.push({
      source: join(distAdapterRoot, relPath),
      dest: join(home, relPath),
      skill: skillName,
    });
  }

  return {
    adapter,
    target_dir: home,
    files,
    skills_available: skillsAvailable,
  };
}

/**
 * Execute an install plan against the real filesystem. Mutates disk.
 *
 * @param {Awaited<ReturnType<typeof planInstall>>} plan
 * @param {object} options
 * @param {boolean} options.upgrade
 * @param {boolean} options.force
 * @returns {Promise<{ installed: string[], upgraded: string[], skipped: string[] }>}
 */
export async function executeInstall(plan, options) {
  const installed = new Set();
  const upgraded = new Set();
  const skipped = new Set();

  // Group files by skill so the prompt asks once per skill (not per file).
  const bySkill = new Map();
  for (const file of plan.files) {
    const key = file.skill ?? "__adapter__";
    if (!bySkill.has(key)) bySkill.set(key, []);
    bySkill.get(key).push(file);
  }

  for (const [skillKey, files] of bySkill) {
    const skillLabel = skillKey === "__adapter__" ? "(adapter-wide files)" : skillKey;

    // Determine whether anything in this group already exists. Snippet-only
    // adapters (gemini-cli, copilot) flow through the `__adapter__` group and
    // can overwrite the user's hand-edited ~/.gemini/settings.json or
    // ~/AGENTS.md.snippet, so they MUST prompt unless --upgrade / --force is
    // set just like skill groups do.
    let hasExisting = false;
    for (const file of files) {
      if (existsSync(file.dest)) {
        hasExisting = true;
        break;
      }
    }

    if (hasExisting) {
      if (options.upgrade || options.force) {
        // proceed and mark as upgraded
      } else {
        const yes = await confirm(
          `'${skillLabel}' is already installed at ${plan.target_dir}. Overwrite?`,
          false,
        );
        if (!yes) {
          if (skillKey !== "__adapter__") skipped.add(skillKey);
          continue;
        }
      }
    }

    for (const file of files) {
      await mkdir(dirname(file.dest), { recursive: true });
      await copyFile(file.source, file.dest);
    }
    if (skillKey === "__adapter__") continue;
    if (hasExisting) upgraded.add(skillKey);
    else installed.add(skillKey);
  }

  return {
    installed: [...installed].sort(),
    upgraded: [...upgraded].sort(),
    skipped: [...skipped].sort(),
  };
}

/**
 * Run the `install` subcommand from CLI argv. Returns a process exit code.
 *
 * @param {string[]} argv The args after the `install` subcommand keyword.
 * @returns {Promise<number>}
 */
export async function runInstall(argv) {
  try {
    assertNoForbiddenFlags(argv);
  } catch (err) {
    process.stderr.write(`error: ${err.message}\n\n${HELP}`);
    return 1;
  }

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

  const adapter = parsed.values.adapter ?? "claude-code";
  const skillsFilter = parsed.values.skills
    ? parsed.values.skills.split(",").map((s) => s.trim()).filter(Boolean)
    : null;
  const dryRun = Boolean(parsed.values["dry-run"]);
  const upgrade = Boolean(parsed.values.upgrade);
  const force = Boolean(parsed.values.force);

  const packageRoot = await findPackageRoot();
  const home = process.env.OZZYLABS_SKILLS_HOME ?? homedir();

  let plan;
  try {
    plan = await planInstall({ packageRoot, home, adapter, skillsFilter });
  } catch (err) {
    process.stderr.write(`error: ${err.message}\n`);
    return 1;
  }

  if (dryRun) {
    const summary = await summarizePlan(plan, home);
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    return 0;
  }

  const result = await executeInstall(plan, { upgrade, force });
  const summary = {
    target_dir: plan.target_dir,
    adapter: plan.adapter,
    installed: result.installed,
    upgraded: result.upgraded,
    skipped: result.skipped,
  };
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  return 0;
}

/**
 * Compute a dry-run summary that mirrors `executeInstall`'s result shape so
 * downstream tooling can rely on the same JSON contract.
 *
 * @param {Awaited<ReturnType<typeof planInstall>>} plan
 * @param {string} home
 */
async function summarizePlan(plan, _home) {
  const installed = new Set();
  const upgraded = new Set();
  const skipped = new Set();
  for (const file of plan.files) {
    if (!file.skill) continue;
    if (existsSync(file.dest)) upgraded.add(file.skill);
    else installed.add(file.skill);
  }
  return {
    target_dir: plan.target_dir,
    adapter: plan.adapter,
    installed: [...installed].sort(),
    upgraded: [...upgraded].sort(),
    skipped: [...skipped].sort(),
    files: plan.files.map((f) => ({ source: f.source, dest: f.dest, skill: f.skill })),
  };
}

export { SUPPORTED_ADAPTERS, ADAPTER_LAYOUT, HELP };
