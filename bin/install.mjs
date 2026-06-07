#!/usr/bin/env node
// @ozzylabs/skills CLI entry point — dispatcher for `install` and `migrate`.
//
// Usage:
//   npx @ozzylabs/skills install [options]
//   npx @ozzylabs/skills migrate [options]
//
// The installer writes user-scoped skill files (always under the user's HOME
// directory — never project-scoped). The migrate command removes the legacy
// project-scoped skill copies left over by the older Renovate-based sync flow.
//
// See ozzy-labs/skills#96 (parent epic) and #98 (this sub-issue) for the
// design discussion.

import { runInstall } from "./lib/install.mjs";
import { runMigrate } from "./lib/migrate.mjs";

const TOP_LEVEL_HELP = `npx @ozzylabs/skills <subcommand> [options]

Subcommands:
  install   Install canonical skills into the user-scoped skills directory
            (~/.claude/skills/, ~/.agents/skills/, etc.) for the chosen adapter.
  migrate   Remove the legacy project-scoped skill copies and the related
            .commons/sync.yaml entries (skills_adapters / skills_commit).

Run 'npx @ozzylabs/skills <subcommand> --help' for subcommand-specific options.
`;

async function main(argv) {
  const subcommand = argv[0];
  const rest = argv.slice(1);

  if (!subcommand || subcommand === "-h" || subcommand === "--help") {
    process.stdout.write(TOP_LEVEL_HELP);
    return 0;
  }

  if (subcommand === "install") {
    return await runInstall(rest);
  }
  if (subcommand === "migrate") {
    return await runMigrate(rest);
  }

  process.stderr.write(`Unknown subcommand: ${subcommand}\n\n${TOP_LEVEL_HELP}`);
  return 1;
}

main(process.argv.slice(2))
  .then((code) => process.exit(code ?? 0))
  .catch((err) => {
    process.stderr.write(`error: ${err?.stack ?? err}\n`);
    process.exit(1);
  });
