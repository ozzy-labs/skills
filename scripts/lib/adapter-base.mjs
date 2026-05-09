// AdapterBase — the contract every agent adapter implements.
//
// An adapter is a pure function: it takes the canonical skill list (and
// optional Claude Code agents) and returns OutputFile[] rooted under its own
// `dist/{id}/` subtree. The build orchestrator is responsible for clearing
// the destination and writing the files. Adapters never touch the file
// system.

/**
 * @typedef {import("./types.mjs").Skill} Skill
 * @typedef {import("./types.mjs").Agent} Agent
 * @typedef {import("./types.mjs").OutputFile} OutputFile
 * @typedef {import("./types.mjs").GenerateOptions} GenerateOptions
 */

export class AdapterBase {
  /**
   * Adapter identifier — used as the dist subdirectory (`dist/{id}/`).
   * Subclasses must override.
   *
   * @type {string}
   */
  static id = "";

  /**
   * Generate the OutputFile list for this adapter.
   *
   * Subclasses must override. Implementations must be deterministic: the same
   * inputs must produce the same OutputFile list (same order, same content).
   * May be async — the build orchestrator awaits the result.
   *
   * Adapters that do not consume agents may ignore the `options` argument.
   *
   * @param {Skill[]} _skills
   * @param {GenerateOptions} [_options]
   * @returns {Promise<OutputFile[]> | OutputFile[]}
   */
  generate(_skills, _options) {
    throw new Error(`${this.constructor.name}.generate() not implemented`);
  }
}
