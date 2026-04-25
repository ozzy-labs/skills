// Prettier idempotency tests for adapter outputs.
//
// Consumers (handbook, road, writing-studio, …) sync our `dist/` payload and
// then run their own Prettier hook. If our output isn't already what Prettier
// would emit, every sync triggers a re-format on the consumer side, which the
// next sync overwrites — an oscillation we want to root-solve here rather
// than patch in each consumer with `<!-- prettier-ignore -->` markers.
//
// We test against the two Prettier configurations observed in the wild:
//   - default (singleQuote: false) — handbook, writing-studio
//   - singleQuote: true            — road
//
// To stay idempotent under both, the `argument-hint` value is left as a
// plain (unquoted) YAML scalar. `<#... | ...>` is a valid plain scalar
// (no flow indicators, no leading reserved character) that Prettier passes
// through verbatim regardless of the `singleQuote` setting — quoted forms
// would oscillate against whichever config differed from ours.

import assert from "node:assert/strict";
import { test } from "node:test";
import prettier from "prettier";
import { ClaudeCodeAdapter } from "../scripts/adapters/claude-code.mjs";
import { CodexCliAdapter } from "../scripts/adapters/codex-cli.mjs";
import { CopilotAdapter } from "../scripts/adapters/copilot.mjs";
import { GeminiCliAdapter } from "../scripts/adapters/gemini-cli.mjs";

function skill(name, description, extraFm = {}) {
  const fm = { name, description, ...extraFm };
  const fmText = Object.entries(fm)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");
  const body = `\n# ${name}\n\nbody\n`;
  const raw = `---\n${fmText}\n---\n${body}`;
  return { name, description, frontmatter: fm, body, raw };
}

const SAMPLE_SKILLS = [
  skill("alpha", "Alpha skill description"),
  skill("zeta", "Zeta skill description"),
];

const SAMPLE_WITH_COMPANION = (() => {
  const s = skill("drive", "canonical desc");
  s.claudeCodeCompanion = {
    frontmatter: {
      description: "wrapper desc",
      "argument-hint": "<#issue-number | instruction>",
      "disable-model-invocation": "true",
    },
    body: "\n# drive\n\nwrapper body\n",
    raw: [
      "---",
      "description: wrapper desc",
      "argument-hint: <#issue-number | instruction>",
      "disable-model-invocation: true",
      "---",
      "",
      "# drive",
      "",
      "wrapper body",
      "",
    ].join("\n"),
  };
  return s;
})();

async function formatMarkdown(content, options = {}) {
  return prettier.format(content, { parser: "markdown", ...options });
}

test("AGENTS.md.snippet is Prettier-idempotent under default config", async () => {
  const out = new CodexCliAdapter()
    .generate(SAMPLE_SKILLS)
    .find((o) => o.relativePath === "AGENTS.md.snippet");
  const formatted = await formatMarkdown(out.content);
  assert.equal(formatted, out.content);
});

test("AGENTS.md.snippet is Prettier-idempotent under singleQuote config", async () => {
  const out = new CodexCliAdapter()
    .generate(SAMPLE_SKILLS)
    .find((o) => o.relativePath === "AGENTS.md.snippet");
  const formatted = await formatMarkdown(out.content, { singleQuote: true });
  assert.equal(formatted, out.content);
});

test("Gemini CLI AGENTS.md.snippet is Prettier-idempotent", async () => {
  const out = new GeminiCliAdapter()
    .generate(SAMPLE_SKILLS)
    .find((o) => o.relativePath === "AGENTS.md.snippet");
  const formatted = await formatMarkdown(out.content);
  assert.equal(formatted, out.content);
});

test("copilot-instructions.md.snippet is Prettier-idempotent under default config", async () => {
  const out = new CopilotAdapter().generate(SAMPLE_SKILLS)[0];
  const formatted = await formatMarkdown(out.content);
  assert.equal(formatted, out.content);
});

test("copilot-instructions.md.snippet is Prettier-idempotent under singleQuote config", async () => {
  const out = new CopilotAdapter().generate(SAMPLE_SKILLS)[0];
  const formatted = await formatMarkdown(out.content, { singleQuote: true });
  assert.equal(formatted, out.content);
});

test("Claude Code SKILL.md (canonical pass-through) is Prettier-idempotent", async () => {
  const out = new ClaudeCodeAdapter().generate(SAMPLE_SKILLS);
  for (const file of out) {
    const formatted = await formatMarkdown(file.content);
    assert.equal(formatted, file.content, `${file.relativePath} drifts under default Prettier`);
    const formattedSingle = await formatMarkdown(file.content, { singleQuote: true });
    assert.equal(
      formattedSingle,
      file.content,
      `${file.relativePath} drifts under singleQuote Prettier`,
    );
  }
});

test("Claude Code SKILL.md (companion with argument-hint) is Prettier-idempotent under both configs", async () => {
  const out = new ClaudeCodeAdapter()
    .generate([SAMPLE_WITH_COMPANION])
    .find((o) => o.relativePath === ".claude/skills/drive/SKILL.md");
  const def = await formatMarkdown(out.content);
  assert.equal(def, out.content, "drift under default Prettier");
  const sq = await formatMarkdown(out.content, { singleQuote: true });
  assert.equal(sq, out.content, "drift under singleQuote Prettier");
});
