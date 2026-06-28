// `skills add` — the unified materialize verb (replaces `install` + `sync-project`).
//
// Scope is expressed by `--target` alone: absent → user scope ($HOME), present
// → project scope (a consumer repo, committed). `--adapter` selects the agent
// CLIs; on an interactive run it defaults to the CLIs detected on this machine,
// on a non-interactive run it is required. `add` only INSTALLS; updating is
// `skills update`, removal is `skills remove`.

import { homedir } from "node:os";
import { parseFlags } from "./args.mjs";
import { detectAdapters, didYouMean } from "./detect.mjs";
import {
  executeInstall,
  findPackageRoot,
  planInstall,
  SUPPORTED_ADAPTERS,
} from "./install.mjs";
import { executeSyncProject, planSyncProject } from "./sync-project.mjs";

const HELP = `npx @ozzylabs/skills add [options]

Add canonical OzzyLabs skills to a scope.

Scope (chosen by --target):
  (no --target)        User scope — installs under $HOME (~/.claude/skills/,
                       ~/.agents/skills/, …) for your machine.
  --target=<dir>       Project scope — writes into a consumer repo so Claude
                       mobile / web (cloud) sessions can use the skills. Review
                       the diff and commit the files in that repo.

Options:
  --adapter=<list>     Comma-separated adapter ids: claude-code, codex-cli,
                       gemini-cli, copilot. On an interactive run, defaults to
                       the CLIs detected on this machine; on a non-interactive
                       run (CI), --adapter is required.
  --skills=<list>      Comma-separated skill names (default: all).
  --dry-run            Print the plan as JSON and exit. No files are written.
  --force              Overwrite existing files / skip the confirmation prompt.
  -h, --help           Show this help.

Aliases: \`install\` is accepted as an alias for \`add\`.
`;

const SCHEMA = {
  target: "string",
  adapter: "string",
  skills: "string",
  "dry-run": "boolean",
  force: "boolean",
  help: "boolean",
};
const ALIASES = { h: "help" };

function splitList(value) {
  return value
    ? value.split(",").map((s) => s.trim()).filter(Boolean)
    : null;
}

/**
 * Resolve which adapters to install for.
 *  - explicit `--adapter` wins (validated, with did-you-mean on typos)
 *  - interactive (TTY): default to detected adapters
 *  - non-interactive: error (detection is unsafe in CI)
 *
 * @param {string | undefined} explicit
 * @param {string} home
 * @param {boolean} isTTY
 * @returns {string[]}
 */
function resolveAdapters(explicit, home, isTTY) {
  if (explicit) {
    const ids = splitList(explicit) ?? [];
    for (const id of ids) {
      if (!SUPPORTED_ADAPTERS.includes(id)) {
        throw new Error(
          `unknown adapter '${id}'${didYouMean(id, SUPPORTED_ADAPTERS)} (supported: ${SUPPORTED_ADAPTERS.join(", ")})`,
        );
      }
    }
    return ids;
  }
  if (!isTTY) {
    throw new Error(
      `non-interactive session — specify --adapter (e.g. --adapter=claude-code). Supported: ${SUPPORTED_ADAPTERS.join(", ")}`,
    );
  }
  const detected = detectAdapters(home);
  if (detected.length === 0) {
    throw new Error(
      `no supported agent CLI detected on this machine — specify --adapter explicitly (supported: ${SUPPORTED_ADAPTERS.join(", ")})`,
    );
  }
  return detected;
}

/**
 * @param {string[]} argv args past the `add` subcommand keyword
 * @param {{ isTTY?: boolean }} [opts]
 * @returns {Promise<number>} exit code
 */
export async function runAdd(argv, opts = {}) {
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

  const home = process.env.OZZYLABS_SKILLS_HOME ?? homedir();
  const isTTY = opts.isTTY ?? Boolean(process.stdin.isTTY);
  const skillsFilter = splitList(parsed.values.skills);
  const dryRun = Boolean(parsed.values["dry-run"]);
  const force = Boolean(parsed.values.force);
  const target = parsed.values.target;
  const packageRoot = await findPackageRoot();

  // Project scope: delegate to the project-scope payload (relative refs, meant
  // to be committed). Adapter-specific project delivery is a later #151 PR; for
  // now the project payload ships the Claude wrappers + canonical `.agents/skills`.
  if (target) {
    let plan;
    try {
      plan = await planSyncProject({ packageRoot, target, skillsFilter });
    } catch (err) {
      process.stderr.write(`error: ${err.message}\n`);
      return 1;
    }
    if (dryRun) {
      process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
      return 0;
    }
    const result = await executeSyncProject(plan);
    process.stdout.write(`${JSON.stringify({ scope: "project", target, ...result }, null, 2)}\n`);
    return 0;
  }

  // User scope.
  let adapters;
  try {
    adapters = resolveAdapters(parsed.values.adapter, home, isTTY);
  } catch (err) {
    process.stderr.write(`error: ${err.message}\n`);
    return 1;
  }

  const plans = [];
  for (const adapter of adapters) {
    try {
      plans.push(await planInstall({ packageRoot, home, adapter, skillsFilter }));
    } catch (err) {
      process.stderr.write(`error: ${err.message}\n`);
      return 1;
    }
  }
  if (dryRun) {
    const out = plans.length === 1 ? plans[0] : plans;
    process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
    return 0;
  }
  const summaries = [];
  for (const plan of plans) {
    const result = await executeInstall(plan, { upgrade: force, force });
    summaries.push({ scope: "user", adapter: plan.adapter, ...result });
  }
  const out = summaries.length === 1 ? summaries[0] : summaries;
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
  return 0;
}

export { HELP };
