---
name: usage-guard
description: Claude Code の Usage Limit（5 時間 = Current / 週次 = Weekly）を監視し、95% 超過で作業を一時停止、リセットで枠が回復したら自動再開する pause/resume エンジン。drive 等の caller が checkpoint で Read するエンジン形態と、`/usage-guard "<継続コマンド>"` で任意作業を guard する単体形態を同梱。Claude 専用（OAuth 使用率エンドポイント + ScheduleWakeup 依存）。
adapters: claude-code
user-invocable: true
argument-hint: "<継続コマンド>（空欄で status 確認のみ）"
disable-model-invocation: true
---

# usage-guard - Usage Limit pause/resume エンジン

Claude Code の Usage Limit が 100% に達するとセッションが中断される。本スキルは 100% 手前（既定 95%）で作業を一時停止し、リセットで枠が回復したら自動再開する仕組みを提供する。

> **Claude 専用**: OAuth 使用率エンドポイント（`~/.claude/.credentials.json` のトークン）と `ScheduleWakeup` に依存するため、`adapters: claude-code` で gate している（Codex / Gemini / Copilot には配信しない）。
>
> **自己完結ドキュメント**: 本 SKILL.md は他ファイル（`.agents/skills/...` の canonical）を Read しない。gate により codex adapter の `.agents/` 出力が存在しないため、本体手順をすべてここに内包している。

## シグナル取得: usage-check スクリプト

判定の決定論部分は `usage-check.mjs` が担う。skill ディレクトリ直下に同梱され、user-scope では `~/.claude/skills/usage-guard/usage-check.mjs`、dogfood では `.claude/skills/usage-guard/usage-check.mjs` に置かれる。**実行時は本 SKILL.md と同じディレクトリの `usage-check.mjs`** を Bash で実行する:

```bash
node ~/.claude/skills/usage-guard/usage-check.mjs
```

> dogfood（skills/commons リポ内）で動かす場合はリポルートの `.claude/skills/usage-guard/usage-check.mjs` を実行する。どちらの環境でも「本 SKILL.md と同じ階層の `usage-check.mjs`」を指す。

### 振る舞い

- `~/.claude/.credentials.json` の `claudeAiOauth.accessToken` を**毎回読み直す**（`expiresAt` 失効を考慮）
- `GET https://api.anthropic.com/api/oauth/usage`（ヘッダ `Authorization: Bearer` / `anthropic-beta: oauth-2025-04-20` / `User-Agent: claude-code/<version>`）で `five_hour` / `seven_day` の `utilization` と `resets_at` を 1 回で取得
- 30–60s のローカルキャッシュ（`~/.claude/usage-guard/cache.json`、`.claude/skills/` 配下に置かない）で連打を防止。`#123` の PreToolUse hook と同じキャッシュを共有する
- endpoint 失敗時は `~/.claude/projects/*/*.jsonl` の per-message `usage` + timestamp から 5h / 7d window を推定する JSONL フォールバック
- endpoint と JSONL の**両方が失敗したら fail-open**（`ok: true`）+ stderr に警告（ガードが自バグで hard-stop しない）

### 出力 JSON

```json
{
  "five_hour": { "utilization": 0, "resets_at": "..." },
  "seven_day": { "utilization": 0, "resets_at": "..." },
  "ok": true,
  "wait_seconds": 0,
  "resets_at": null,
  "source": "endpoint"
}
```

- `ok`: **両枠の `utilization` が閾値未満**なら `true`
- `wait_seconds` / `resets_at`: 超過枠の `resets_at` の**最遅**（最も遅くリセットする枠）から算出。`ok` のときは `wait_seconds: 0` / `resets_at: null`
- `source`: `endpoint` / `jsonl` / `cache` / `fail-open`

### 閾値

既定 95%。環境変数 `USAGE_GUARD_THRESHOLD` で上書き可能（例 `USAGE_GUARD_THRESHOLD=80`）。

## 軽量 wait-loop（共通ロジック）

両形態が共有する停止/再開の中核:

1. `usage-check.mjs` を実行して JSON を得る
2. `ok` なら**通常進行**（継続コマンドを実行 / caller は次の checkpoint へ）
3. `ok` が `false` なら `ScheduleWakeup(min(wait_seconds, 3600))` で heartbeat を仕込み、**待機する**
   - 上限 3600s は ScheduleWakeup 1 回の最大待機。`wait_seconds` がそれより長ければ複数回に分けて再チェックする
   - **待機中は再入しない**（予算を一切消費しない）
4. 起床したら再び `usage-check.mjs` を実行し、`ok` になるまで 3〜4 を繰り返す
5. `ok` になったら継続コマンドへ進む

> `wait_seconds` は `resets_at` から算出するため秒精度ではない。ScheduleWakeup の発火も下限 + オーバーヘッドで多少遅れる（実機で 60s 要求に対し ~110s）。reset 待ちには十分な精度。

## 利用形態 1: エンジン形態（呼び出し側が Read）

drive（#122）等の caller が **resumable unit の境界（checkpoint）** で本 SKILL.md を Read し、上記 wait-loop を実行する。

### checkpoint 規約

- 停止は**常にクリーンに再入できる境界**で行う。mid-implement（PR 作成前など）では止めない
- caller は各 unit の**入口**で usage-check を実行し、`ok` でなければ wait-loop に入る
- 継続コマンドは **caller が供給**する。drive は冪等 resume（既存 PR を検出して Phase 3 から再開）なので、待機後の再実行をそのまま再開機構に流用する（例: `/drive --usage-guard <args>`）
- drive のオーケストレーションモードでは wave 境界の粒度で呼ぶ。走行中の worker 内の超過は `#123` の PreToolUse hook が mid-unit ceiling として捕捉する

## 利用形態 2: 単体形態 `/usage-guard "<継続コマンド>"`

drive 非依存で、任意の長い作業を auto pause/resume で guard する（user-invocable）。

### 引数

- `$ARGUMENTS` を**継続コマンド**として解釈する
- **空欄なら status 確認のみ**: `usage-check.mjs` を実行して現在の `five_hour` / `seven_day` の `utilization` と `ok` / `wait_seconds` を表示して終了する

### 手順

1. `usage-check.mjs` を実行する
2. **両枠 `ok`** なら、継続コマンドを実行する（通常進行）
3. **超過**なら:
   - `ScheduleWakeup(min(wait_seconds, 3600))` で待機する（待機中は再入しない）
   - 起床（回復検知）したら **`/usage-guard "<継続コマンド>"` を自己再入**する
   - `ok` になるまで heartbeat を繰り返し、`ok` で継続コマンドを実行する

### 継続コマンドの冪等性

継続コマンドは**冪等前提**で扱う。待機を挟んで再実行されても安全であること（重複副作用を生まない / 進捗を検出して途中から再開できる）がユーザーの責任。

- drive は元来冪等（既存 PR / ブランチを検出して再開）なので、`/usage-guard "/drive --usage-guard #123"` のように安全に巻ける
- 汎用の長い作業（ビルド・バッチ等）を巻く場合は、再実行で壊れない設計か自分で確認すること

### 実行例

```text
/usage-guard "/drive --usage-guard #123"
/usage-guard ""                 # status 確認のみ
USAGE_GUARD_THRESHOLD=80 /usage-guard "<継続コマンド>"   # 閾値を一時的に 80% へ
```

## PreToolUse hook を有効化（推奨併用）

本スキルの停止粒度は resumable unit の境界。`--usage-guard` フラグ（#122）は unit 境界でしか止められないのに対し、PreToolUse hook（`usage-guard-hook.mjs`）は **全 tool 呼び出し前**に効く mid-unit ceiling で、長い unit の途中で閾値を超えてもその場で止める。両者は役割分担して併用する:

| 仕組み | 粒度 | 止まる場所 |
|---|---|---|
| `--usage-guard` フラグ（#122） | resumable unit 境界 | Phase 入口 / wave 入口 / worker dispatch 前など、クリーンに再入できる checkpoint |
| PreToolUse hook（本節） | tool 呼び出し単位（subagent 内含む） | unit の途中（in-flight ceiling） |

> hook はエンドポイントを叩かない。`usage-check.mjs` が書いた**同じキャッシュ**（`~/.claude/usage-guard/cache.json`、30–60s TTL）を読むだけなので、全 tool 呼び出しで連打しない。閾値超なら deny（exit 2）+ `resets_at` を `HH:MM` で提示、usage を読めなければ fail-open（allow + stderr 警告）。subagent 由来の呼び出しは payload の `agent_id` でログ上区別する。

### 仕組みと配置

hook 本体は extra file として skill ディレクトリ直下に同梱される（`usage-check.mjs` と同経路）。本リポは settings/hook を**配信しない**（build は skill / agent のみ出力）ため、有効化は**手動 opt-in**。

### settings.local.json スニペット（`update-config` 方式）

`~/.claude/settings.local.json` に PreToolUse hook を 1 つ追加する（settings は mid-session reload されるため再起動不要）:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "*",
        "hooks": [
          {
            "type": "command",
            "command": "node /home/<you>/.claude/skills/usage-guard/usage-guard-hook.mjs"
          }
        ]
      }
    ]
  }
}
```

> **M3: hook スクリプトパスは絶対パスを手で埋める。** settings 内では skill-dir 相対参照が効かないため `command` には**絶対パス**を書く。パスは環境で揺れる:
>
> - **user-scope**（`npx @ozzylabs/skills install` で配置）: `~/.claude/skills/usage-guard/usage-guard-hook.mjs`（`~` は展開されないので `/home/<you>/.claude/...` の形でフルに書く）
> - **dogfood**（skills/commons リポ内で動かす）: `<repo>/.claude/skills/usage-guard/usage-guard-hook.mjs`（例 `/home/<you>/github/ozzy-labs/skills/.claude/skills/usage-guard/usage-guard-hook.mjs`）
>
> どちらも「`usage-check.mjs` と同じ階層の `usage-guard-hook.mjs`」を指す。自分の環境のフルパスを確認してから埋めること。閾値を上書きする場合は env も settings 側に付ける（例 `"command": "USAGE_GUARD_THRESHOLD=80 node /home/<you>/.claude/skills/usage-guard/usage-guard-hook.mjs"`）。

### 無効化

`~/.claude/settings.local.json` から上記 PreToolUse エントリを削除すれば即時に無効化される（mid-session reload）。

## 注意事項

- ガードは**自バグで hard-stop しない**: シグナル取得が全滅したら fail-open で作業を継続する（`source: "fail-open"` + stderr 警告）
- 待機中は予算を消費しない（再入しない・heartbeat のみ）
- 長い待機は live セッションで吸収する前提（WSL + 常時起動）
