// `npx @ozzylabs/skills sync-project` implementation.
//
// Unlike `install` (user-scope only, always under $HOME), this subcommand
// copies a PROJECT-scoped skill payload into a consumer repo's working tree so
// it can be committed and picked up by Claude mobile / web (cloud) sessions.
//
// Cloud sessions run "repo only": they see a repo's committed `.claude/skills/`
// but never the user-scope `~/.claude/skills/` the installer writes. The
// per-adapter `dist/{adapter}/` payloads have their skill refs rewritten to
// `~/…` (ADR-0027 user-skills-only), which breaks in that environment. This
// command instead delivers `dist/claude-code-project/`, where refs stay
// repo-root-relative and the canonical `.agents/skills/<name>/SKILL.md` files
// the Claude wrappers Read are shipped alongside the `.claude/skills/` wrappers.
//
// Project-scope distribution is an explicit, per-repo opt-in (handbook ADR-0027
// amendment): default distribution stays user-scope. `--target <repo>` is
// REQUIRED — there is no implicit default — and the command writes files only;
// the user reviews the diff and commits.

import { existsSync } from "node:fs";
import { copyFile, mkdir, readdir } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { findPackageRoot } from "./install.mjs";
import { parseFlags } from "./args.mjs";

// Must match scripts/build.mjs PROJECT_SCOPE_ID.
const PROJECT_SCOPE_DIST_ID = "claude-code-project";

// Per-skill folders live under these roots inside the project payload. The
// `.claude/skills/<name>` wrappers are what Claude Code discovers; the
// `.agents/skills/<name>` canonicals are what those wrappers Read.
const SKILL_ROOTS = [".claude/skills", ".agents/skills"];

const HELP = `npx @ozzylabs/skills sync-project --target <repo> [options]

Copy the project-scoped skill payload into a consumer repo so Claude mobile /
web (cloud) sessions — which see only repo-committed .claude/skills/ — can use
the skills. Writes both the .claude/skills/ wrappers and the canonical
.agents/skills/ files they Read, with repo-root-relative refs preserved.

Options:
  --target=<dir>       REQUIRED. Path to the consumer repo root. Files are
                       written under <dir>/.claude/skills/, <dir>/.agents/skills/
                       and <dir>/.claude/agents/.
  --skills=<list>      Comma-separated skill names (default: sync all). Note
                       /drive depends on implement, ship, review, commit, pr,
                       lint, test — sync those together or omit --skills.
  --dry-run            Print the plan as JSON and exit. No files are written.
  --force              Overwrite existing files without prompting (non-TTY
                       sessions never prompt).
  -h, --help           Show this help.

After syncing, review the diff and commit the files in the target repo. This is
an explicit project-scope opt-in; default distribution remains user-scope via
'npx @ozzylabs/skills install'.
`;

const SCHEMA = {
  target: "string",
  skills: "string",
  "dry-run": "boolean",
  force: "boolean",
  help: "boolean",
};

const ALIASES = { h: "help" };

/**
 * Walk a directory tree and return every file path relative to `root`,
 * normalized to forward slashes.
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
 * Classify a payload-relative path to its owning skill, or null for files that
 * are not per-skill (e.g. `.claude/agents/<name>.md`).
 *
 * @param {string} relPath
 * @returns {string | null}
 */
function skillForPath(relPath) {
  for (const root of SKILL_ROOTS) {
    if (relPath.startsWith(`${root}/`)) {
      return relPath.slice(root.length + 1).split("/")[0];
    }
  }
  return null;
}

/**
 * Plan a sync-project run. Pure: returns the action plan without touching the
 * destination filesystem (it only reads the package's dist payload).
 *
 * @param {object} args
 * @param {string} args.packageRoot
 * @param {string} args.target Absolute path to the consumer repo root.
 * @param {string[] | null} args.skillsFilter
 * @returns {Promise<{ target: string, files: Array<{ source: string, dest: string, skill: string | null }>, skills_available: string[] }>}
 */
export async function planSyncProject({ packageRoot, target, skillsFilter }) {
  const distRoot = join(packageRoot, "dist", PROJECT_SCOPE_DIST_ID);
  if (!existsSync(distRoot)) {
    throw new Error(
      `missing project-scope payload at ${distRoot} — run \`pnpm build\` first?`,
    );
  }

  const skillsAvailable = await listSubdirs(join(distRoot, ".claude", "skills"));

  if (skillsFilter) {
    const unknown = skillsFilter.filter((s) => !skillsAvailable.includes(s));
    if (unknown.length > 0) {
      throw new Error(
        `unknown skill(s): ${unknown.join(", ")} (available: ${skillsAvailable.join(", ") || "<none>"})`,
      );
    }
  }

  const files = [];
  for (const relPath of await listFiles(distRoot)) {
    const skill = skillForPath(relPath);
    // Per-skill files honor the filter. Non-skill files (Claude Code agents
    // under .claude/agents/) are shared infrastructure that /review and /drive
    // rely on, so they are always included.
    if (skill && skillsFilter && !skillsFilter.includes(skill)) continue;
    files.push({
      source: join(distRoot, relPath),
      dest: join(target, relPath),
      skill,
    });
  }

  return { target, files, skills_available: skillsAvailable };
}

/**
 * Execute a sync-project plan against the real filesystem. Mutates disk.
 * Always overwrites; the caller is responsible for any confirmation gate.
 *
 * @param {Awaited<ReturnType<typeof planSyncProject>>} plan
 * @returns {Promise<{ target: string, written: string[] }>}
 */
export async function executeSyncProject(plan) {
  const written = new Set();
  for (const file of plan.files) {
    await mkdir(dirname(file.dest), { recursive: true });
    await copyFile(file.source, file.dest);
    if (file.skill) written.add(file.skill);
  }
  return { target: plan.target, written: [...written].sort() };
}

/**
 * Confirm an overwrite. Returns true when `force` is set, when stdin is not a
 * TTY (unattended runs proceed — the command is explicit and git-reversible),
 * or when the user types "y"/"yes".
 *
 * @param {string} message
 * @param {boolean} force
 * @returns {Promise<boolean>}
 */
async function confirm(message, force) {
  if (force) return true;
  if (!process.stdin.isTTY) return true;
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
 * Run the `sync-project` subcommand from CLI argv. Returns a process exit code.
 *
 * @param {string[]} argv The args after the `sync-project` subcommand keyword.
 * @returns {Promise<number>}
 */
export async function runSyncProject(argv) {
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

  const targetArg = parsed.values.target;
  if (!targetArg) {
    process.stderr.write(`error: --target <repo> is required\n\n${HELP}`);
    return 1;
  }
  const cwd = process.env.OZZYLABS_SKILLS_CWD ?? process.cwd();
  const target = resolve(cwd, targetArg);

  const skillsFilter = parsed.values.skills
    ? parsed.values.skills.split(",").map((s) => s.trim()).filter(Boolean)
    : null;
  const dryRun = Boolean(parsed.values["dry-run"]);
  const force = Boolean(parsed.values.force);

  const packageRoot = await findPackageRoot();

  let plan;
  try {
    plan = await planSyncProject({ packageRoot, target, skillsFilter });
  } catch (err) {
    process.stderr.write(`error: ${err.message}\n`);
    return 1;
  }

  if (dryRun) {
    const summary = {
      target: plan.target,
      skills: [...new Set(plan.files.map((f) => f.skill).filter(Boolean))].sort(),
      files: plan.files.map((f) => ({ source: f.source, dest: f.dest, skill: f.skill })),
    };
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    return 0;
  }

  const existing = plan.files.filter((f) => existsSync(f.dest));
  if (existing.length > 0) {
    const ok = await confirm(
      `${existing.length} file(s) already exist under ${plan.target}. Overwrite?`,
      force,
    );
    if (!ok) {
      process.stderr.write("aborted: user declined\n");
      return 1;
    }
  }

  const result = await executeSyncProject(plan);
  process.stdout.write(
    `${JSON.stringify({ target: result.target, synced: result.written }, null, 2)}\n`,
  );
  return 0;
}

export { HELP, PROJECT_SCOPE_DIST_ID, SKILL_ROOTS };
