// Tests for the central autonomy policy foundation (ADR-0028 R3, PR 1/4).
//
// policy.schema.json is the single SSOT; policy-read.mjs and this suite both
// consume it (no doc/code drift). All I/O is dependency-injected (no real
// ~/.agents reads). Covers: (a) schema validation (valid passes, unknown key
// rejected), (b) user+repo merge order (repo overrides user), (c) zero-config
// defaults equal today's behavior, (d) invalid values fail-safe to `ask`.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  coerceGate,
  loadSchema,
  mergePolicies,
  parseYaml,
  resolveGate,
  run,
  validatePolicy,
  ZERO_CONFIG_CLASS_DEFAULTS,
} from "../.agents/skills/policy/policy-read.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCHEMA_FILE = join(ROOT, ".agents/skills/policy/policy.schema.json");

const VALID = {
  schema_version: 1,
  classes: {
    "reversible-local": "proceed",
    "externally-visible": "batch-confirm",
    irreversible: "ask",
  },
  actions: { merge: "ask", "issue-create": "proceed" },
};

// --- schema file structural guarantees -------------------------------------

test("schema file: privacy/strictness guard + version pin", async () => {
  const schema = JSON.parse(await readFile(SCHEMA_FILE, "utf8"));
  // additionalProperties:false is the mechanical guard against unknown keys.
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.required, ["schema_version"]);
  assert.equal(schema.properties.schema_version.const, 1);
  // classes are a closed set of exactly the three known classes.
  assert.equal(schema.properties.classes.additionalProperties, false);
  assert.deepEqual(Object.keys(schema.properties.classes.properties).sort(), [
    "externally-visible",
    "irreversible",
    "reversible-local",
  ]);
  // gate vocabulary is exactly proceed / batch-confirm / ask.
  assert.deepEqual(schema.properties.classes.properties.irreversible.enum, [
    "proceed",
    "batch-confirm",
    "ask",
  ]);
});

// --- (a) schema validation --------------------------------------------------

test("schema is the SSOT the validator consumes; a valid policy passes", async () => {
  const schema = await loadSchema({ schemaPath: SCHEMA_FILE });
  assert.equal(validatePolicy(VALID, schema).ok, true);
});

test("(a) unknown top-level key is rejected", async () => {
  const schema = await loadSchema({ schemaPath: SCHEMA_FILE });
  const res = validatePolicy({ ...VALID, autonomy: "yolo" }, schema);
  assert.equal(res.ok, false);
  assert.ok(res.errors.some((e) => e.includes("autonomy")));
});

test("(a) unknown class key and invalid gate token are rejected", async () => {
  const schema = await loadSchema({ schemaPath: SCHEMA_FILE });
  assert.equal(
    validatePolicy({ schema_version: 1, classes: { bogus: "proceed" } }, schema).ok,
    false,
  );
  assert.equal(
    validatePolicy({ schema_version: 1, classes: { irreversible: "sometimes" } }, schema).ok,
    false,
  );
  assert.equal(
    validatePolicy({ schema_version: 1, actions: { merge: "sometimes" } }, schema).ok,
    false,
  );
  // Wrong schema_version fails the const.
  assert.equal(validatePolicy({ schema_version: 2 }, schema).ok, false);
});

test("(a) action names must be kebab-case; a valid override passes", async () => {
  const schema = await loadSchema({ schemaPath: SCHEMA_FILE });
  assert.equal(
    validatePolicy({ schema_version: 1, actions: { "issue-create": "proceed" } }, schema).ok,
    true,
  );
  assert.equal(
    validatePolicy({ schema_version: 1, actions: { Bad_Name: "ask" } }, schema).ok,
    false,
  );
});

// --- YAML subset parser -----------------------------------------------------

test("parseYaml: nested mappings, comments, scalars", () => {
  const yaml = [
    "# comment",
    "schema_version: 1",
    "classes:",
    "  reversible-local: proceed  # trailing comment",
    "  irreversible: ask",
    "actions:",
    "  merge: ask",
    "",
  ].join("\n");
  assert.deepEqual(parseYaml(yaml), {
    schema_version: 1,
    classes: { "reversible-local": "proceed", irreversible: "ask" },
    actions: { merge: "ask" },
  });
});

// --- (b) user + repo merge order -------------------------------------------

test("(b) repo overrides user; user overrides defaults; classes merge per-key", () => {
  const user = {
    schema_version: 1,
    classes: { irreversible: "batch-confirm", "reversible-local": "ask" },
  };
  const repo = { schema_version: 1, classes: { irreversible: "proceed" } };
  const eff = mergePolicies({ user, repo });
  // repo wins for irreversible.
  assert.equal(eff.classes.irreversible, "proceed");
  // user wins over default for reversible-local (no repo override).
  assert.equal(eff.classes["reversible-local"], "ask");
  // untouched class keeps the zero-config default.
  assert.equal(eff.classes["externally-visible"], "batch-confirm");
});

test("(b) action overrides merge with repo precedence", () => {
  const user = { actions: { merge: "batch-confirm", publish: "ask" } };
  const repo = { actions: { merge: "proceed" } };
  const eff = mergePolicies({ user, repo });
  assert.equal(eff.actions.merge, "proceed"); // repo wins
  assert.equal(eff.actions.publish, "ask"); // user-only survives
});

// --- (c) zero-config defaults == today's behavior --------------------------

test("(c) zero-config defaults reproduce current behavior", () => {
  const eff = mergePolicies({});
  assert.deepEqual(eff.classes, {
    "reversible-local": "proceed",
    "externally-visible": "batch-confirm",
    irreversible: "ask",
  });
  assert.deepEqual(eff.actions, {});
  // The exported defaults are the SSOT for "current behavior".
  assert.equal(ZERO_CONFIG_CLASS_DEFAULTS["reversible-local"], "proceed");
  assert.equal(ZERO_CONFIG_CLASS_DEFAULTS.irreversible, "ask");
});

test("(c) run() with no files returns zero-config defaults, not degraded", async () => {
  const r = await run([], {
    existsImpl: () => false,
    loadSchemaImpl: () => loadSchema({ schemaPath: SCHEMA_FILE }),
    warn: () => {},
  });
  assert.equal(r.classes.irreversible, "ask");
  assert.equal(r.classes["reversible-local"], "proceed");
  assert.deepEqual(r.sources, { user: false, repo: false });
  assert.equal(r.degraded, false);
});

// --- (d) invalid values fail-safe to `ask` ---------------------------------

test("(d) coerceGate: valid passes, invalid/missing → ask (undefined stays undefined)", () => {
  assert.equal(coerceGate("proceed"), "proceed");
  assert.equal(coerceGate("batch-confirm"), "batch-confirm");
  assert.equal(coerceGate("yolo"), "ask");
  assert.equal(coerceGate(42), "ask");
  assert.equal(coerceGate(undefined), undefined);
});

test("(d) an invalid gate value fails safe to ask (not the looser lower layer)", () => {
  // user says proceed; repo tries to override with garbage → must not silently
  // fall back to the looser user value; it collapses to the strict gate.
  const user = { classes: { irreversible: "proceed" } };
  const repo = { classes: { irreversible: "totally-fine" } };
  const eff = mergePolicies({ user, repo });
  assert.equal(eff.classes.irreversible, "ask");
  // Same for a bad reversible-local value (default would otherwise be proceed).
  const eff2 = mergePolicies({ user: { classes: { "reversible-local": "nope" } } });
  assert.equal(eff2.classes["reversible-local"], "ask");
});

test("(d) an unparseable policy file is ignored + degraded, others still apply", async () => {
  const r = await run([], {
    existsImpl: () => true,
    // Broken YAML (a sequence, unsupported by the subset parser) → parse throws.
    readImpl: async () => "classes:\n  - not a mapping\n",
    loadSchemaImpl: () => loadSchema({ schemaPath: SCHEMA_FILE }),
    userPolicyPath: join("/nowhere", ".agents", "policy.yaml"),
    warn: () => {},
  });
  assert.equal(r.degraded, true);
  // Defaults still hold for the dangerous class.
  assert.equal(r.classes.irreversible, "ask");
});

// --- resolveGate ------------------------------------------------------------

test("resolveGate: action override > class default > fail-safe", () => {
  const eff = mergePolicies({ user: { actions: { merge: "proceed" } } });
  // action override wins.
  assert.deepEqual(resolveGate(eff, { action: "merge" }), {
    gate: "proceed",
    class: "irreversible",
    source: "action-override",
  });
  // no override → known action maps to class default.
  const eff2 = mergePolicies({});
  assert.equal(resolveGate(eff2, { action: "merge" }).gate, "ask");
  assert.equal(resolveGate(eff2, { action: "merge" }).source, "class-default");
  assert.equal(resolveGate(eff2, { action: "issue-create" }).gate, "batch-confirm");
  // unknown action with no class → strict gate.
  assert.deepEqual(resolveGate(eff2, { action: "mystery-op" }), {
    gate: "ask",
    class: null,
    source: "fail-safe",
  });
  // explicit class resolves directly.
  assert.equal(resolveGate(eff2, { class: "reversible-local" }).gate, "proceed");
});

test("run(): --action query attaches a resolved gate", async () => {
  const r = await run(["--action=merge"], {
    existsImpl: () => false,
    loadSchemaImpl: () => loadSchema({ schemaPath: SCHEMA_FILE }),
    warn: () => {},
  });
  assert.equal(r.resolved.gate, "ask");
  assert.equal(r.resolved.class, "irreversible");
});
