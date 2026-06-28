// Shared argument parsing helpers for the @ozzylabs/skills CLI.
//
// The CLI deliberately avoids any third-party dependency (commander, yargs,
// etc.) so `npx @ozzylabs/skills` stays small. The shapes we need to parse are
// trivial: a positional subcommand (handled by the dispatcher) plus a flat
// list of `--flag` / `--flag=value` style options.

/**
 * Parse a flat list of `--flag` / `--flag=value` / `--flag value` style
 * arguments against a tiny schema.
 *
 * @param {string[]} argv The arguments past the subcommand (e.g.
 *   `["--skills=drive,review", "--dry-run"]`).
 * @param {Record<string, "boolean" | "string">} schema Map of flag name (without
 *   the leading `--`) to the expected type. A boolean flag consumes no value.
 *   A string flag accepts either `--flag=value` or `--flag value`.
 * @param {Record<string, string>} [aliases] Map of short flag (e.g. `h`) to
 *   the canonical long flag name. Aliases inherit the schema entry of their
 *   target.
 * @returns {{ values: Record<string, unknown>, rejected: string[] }}
 *   `rejected` carries any unknown flags so callers can surface a clear error.
 */
export function parseFlags(argv, schema, aliases = {}) {
  const values = {};
  const rejected = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("-")) {
      rejected.push(arg);
      continue;
    }

    // Strip leading dashes and split `--flag=value`.
    const trimmed = arg.replace(/^-+/, "");
    const eq = trimmed.indexOf("=");
    const rawName = eq === -1 ? trimmed : trimmed.slice(0, eq);
    const inlineValue = eq === -1 ? null : trimmed.slice(eq + 1);

    const name = aliases[rawName] ?? rawName;
    const type = schema[name];
    if (!type) {
      rejected.push(arg);
      continue;
    }

    if (type === "boolean") {
      values[name] = true;
      continue;
    }

    if (inlineValue !== null) {
      values[name] = inlineValue;
      continue;
    }

    // Consume the next argv as the value, unless the next argv looks like
    // another flag.
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("-")) {
      throw new Error(`flag --${name} requires a value`);
    }
    values[name] = next;
    i += 1;
  }

  return { values, rejected };
}
