// AdapterBase — the contract every agent adapter implements.
//
// An adapter is a pure function: it takes the canonical skill list and
// returns OutputFile[] rooted under its own `dist/{id}/` subtree. The build
// orchestrator is responsible for clearing the destination and writing the
// files. Adapters never touch the file system.

/**
 * @typedef {import("./types.mjs").Skill} Skill
 * @typedef {import("./types.mjs").OutputFile} OutputFile
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
   * skills input must produce the same OutputFile list (same order, same
   * content).
   *
   * @param {Skill[]} _skills
   * @returns {OutputFile[]}
   */
  generate(_skills) {
    throw new Error(`${this.constructor.name}.generate() not implemented`);
  }
}
