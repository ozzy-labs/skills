---
argument-hint: <phase-number> "<title>" [--description ...] [--refs ...] [--donts ...] [--decisions-file ...] [--tasks-file ...] [--dod ...] [--outlook ...] [--related ...] [--label ...] [--repo ...] [--draft]
disable-model-invocation: true
allowed-tools: Bash, Read, Write, AskUserQuestion
---

# phase-issue

Read `.agents/skills/phase-issue/SKILL.md` and follow its workflow steps.

**Important:** Follow the canonical SKILL.md's conventions for the section structure, formatting rules, and marker block strictly. Do not add or remove sections at Claude's own discretion.

## Claude Code-specific additions

### Argument parsing

Parse `$ARGUMENTS`:

- If `<phase-number>` and `<title>` are missing, confirm each with AskUserQuestion (do not set the `answers` parameter)
- Obtain optional options (`--description`, `--refs`, `--donts`, `--decisions-file`, `--tasks-file`, `--dod`, `--outlook`, `--related`, `--label`, `--repo`, `--draft`) from the arguments

### Interactively filling in missing items

For optional items not passed as arguments, confirm **individually** via AskUserQuestion whether to fill them in (do not set the `answers` parameter).

Question order (follows the section order):

1. **「プロジェクト概要を入力する」** / 「省略する」 → corresponds to `--description`
2. **「参考実装を入力する」** / 「省略する」 → corresponds to `--refs` (comma-separated)
3. **「やってはいけないことを入力する」** / 「省略する」 → corresponds to `--donts` (newline-separated)
4. **「決定事項ファイルを指定する」** / 「TBD で残す」 → corresponds to `--decisions-file`
5. **「タスクファイルを指定する」** / 「TBD で残す」 → corresponds to `--tasks-file`
6. **「DoD を入力する」** / 「TBD で残す」 → corresponds to `--dod` (newline-separated)
7. **「Phase N+1 outlook を入力する」** / 「(未定) で残す」 → corresponds to `--outlook`
8. **「関連を入力する」** / 「省略する」 → corresponds to `--related` (newline-separated)

If 「入力する」 is chosen, ask for the specific content via AskUserQuestion (free-form entry is done via a separate AskUserQuestion call).

For items already passed as arguments, **do not ask** (do not collect the same information twice).

### Body preview and final confirmation

After assembling the body, before filing the issue or outputting to stdout, confirm via AskUserQuestion (do not set the `answers` parameter):

- **「この内容で起票する」** → file the issue with `gh issue create --body-file` (or output to stdout when `--draft` is specified)
- **「修正する」** → ask which section to revise and re-enter the corresponding item
- **「キャンセル」** → abort

**Important:** Do not run `gh issue create` without approval. Even in `--draft` mode, confirm the content before outputting to stdout.

### Next action after completion

Immediately after the completion report, call AskUserQuestion (do not set the `answers` parameter):

- **「この issue から `/drive` で実装を始める」** → guide the user to `/drive` with the filed issue number as an argument (do not execute it)
- **「別の Phase issue を作成する」** → guide the user to run this skill again
- **「終了する」** → end

Do not execute the next action without the user's confirmation.
