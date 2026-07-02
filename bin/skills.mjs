#!/usr/bin/env node
// @ozzylabs/skills CLI entry point.
//
// Verbs (CRUD-symmetric; updating is `update`, not a flag on `add`):
//   add     Add skills to a scope (user = $HOME, project = --target <repo>).
//   update  Update installed skills (preserves your edits — see #151).
//   list    Show installed skills + status.
//   remove  Uninstall skills (with confirmation).
//   fork    Copy a skill to a user-owned, unmanaged name.
//   diff    Show a skill's local diff against upstream.
//   hooks   Wire/unwire/inspect optional Claude Code hooks shipped with a skill (#174).
//
// `install`/`uninstall` are accepted as aliases for `add`/`remove`. Scope is
// expressed by `--target` (absent = user, present = project repo). See #151 for
// the full design; verbs other than `add` land in follow-up PRs.

import { runAdd } from "./lib/add.mjs";
import { didYouMean } from "./lib/detect.mjs";
import { runDiff } from "./lib/diff.mjs";
import { runFork } from "./lib/fork.mjs";
import { runHooks } from "./lib/hooks.mjs";
import { runList } from "./lib/list.mjs";
import { runRemove } from "./lib/remove.mjs";
import { runUpdate } from "./lib/update.mjs";

const VERBS = ["add", "update", "list", "remove", "fork", "diff", "hooks"];
const VERB_ALIASES = { install: "add", uninstall: "remove" };

const TOP_LEVEL_HELP = `npx @ozzylabs/skills <verb> [options]

Verbs:
  add        Add skills to a scope. User scope by default; --target <repo> for
             project scope. Alias: install.
  update     Update installed skills, preserving local edits.
  list       Show the catalog and what is installed.
  remove     Uninstall skills (confirmation required). Alias: uninstall.
  fork       Copy a skill to a user-owned name.
  diff       Show a skill's diff against upstream.
  hooks      Wire/unwire/inspect an optional Claude Code hook shipped with a
             skill (usage-guard, observability). 'status' also diagnoses whether
             a wired usage-guard is effective or has degraded to a no-op.

Run 'npx @ozzylabs/skills <verb> --help' for verb-specific options.
`;

async function main(argv) {
  const raw = argv[0];

  if (!raw || raw === "-h" || raw === "--help") {
    process.stdout.write(TOP_LEVEL_HELP);
    return 0;
  }

  const verb = VERB_ALIASES[raw] ?? raw;
  const rest = argv.slice(1);

  if (verb === "add") {
    return await runAdd(rest);
  }
  if (verb === "update") {
    return await runUpdate(rest);
  }
  if (verb === "list") {
    return await runList(rest);
  }
  if (verb === "remove") {
    return await runRemove(rest);
  }
  if (verb === "fork") {
    return await runFork(rest);
  }
  if (verb === "diff") {
    return await runDiff(rest);
  }
  if (verb === "hooks") {
    return await runHooks(rest);
  }

  process.stderr.write(
    `error: unknown verb '${raw}'${didYouMean(raw, [...VERBS, ...Object.keys(VERB_ALIASES)])}\n\n${TOP_LEVEL_HELP}`,
  );
  return 1;
}

main(process.argv.slice(2))
  .then((code) => process.exit(code ?? 0))
  .catch((err) => {
    process.stderr.write(`error: ${err?.stack ?? err}\n`);
    process.exit(1);
  });
