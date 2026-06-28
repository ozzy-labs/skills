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
//
// `install`/`uninstall` are accepted as aliases for `add`/`remove`. Scope is
// expressed by `--target` (absent = user, present = project repo). See #151 for
// the full design; verbs other than `add` land in follow-up PRs.

import { runAdd } from "./lib/add.mjs";
import { didYouMean } from "./lib/detect.mjs";
import { runList } from "./lib/list.mjs";

const VERBS = ["add", "update", "list", "remove", "fork", "diff"];
const VERB_ALIASES = { install: "add", uninstall: "remove" };

const TOP_LEVEL_HELP = `npx @ozzylabs/skills <verb> [options]

Verbs:
  add        Add skills to a scope. User scope by default; --target <repo> for
             project scope. Alias: install.
  update     Update installed skills, preserving local edits. (coming — #151)
  list       Show the catalog and what is installed.
  remove     Uninstall skills. Alias: uninstall. (coming — #151)
  fork       Copy a skill to a user-owned name. (coming — #151)
  diff       Show a skill's diff against upstream. (coming — #151)

Run 'npx @ozzylabs/skills <verb> --help' for verb-specific options.
`;

/**
 * Placeholder for verbs whose implementation lands in a later #151 PR. Exits
 * non-zero so callers/scripts don't silently treat a no-op as success.
 *
 * @param {string} verb
 * @returns {number}
 */
function notYetImplemented(verb) {
  process.stderr.write(
    `'${verb}' is not implemented yet — tracked in ozzy-labs/skills#151. ` +
      `For now use 'add' (alias: install).\n`,
  );
  return 1;
}

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
  if (verb === "list") {
    return await runList(rest);
  }
  if (VERBS.includes(verb)) {
    return notYetImplemented(verb);
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
