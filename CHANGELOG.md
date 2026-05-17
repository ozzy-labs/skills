# Changelog

## 0.1.0 (2026-05-17)


### Features

* **adapters/claude-code:** support companion wrapper file ([#22](https://github.com/ozzy-labs/skills/issues/22)) ([9c25743](https://github.com/ozzy-labs/skills/commit/9c25743566b4d29a151f24a8c947888577522363)), closes [#21](https://github.com/ozzy-labs/skills/issues/21)
* **adapters:** add AdapterBase contract and shared lib ([#15](https://github.com/ozzy-labs/skills/issues/15)) ([272fc62](https://github.com/ozzy-labs/skills/commit/272fc62ca6b9a9d67315d0c55e5c42d70217da03)), closes [#9](https://github.com/ozzy-labs/skills/issues/9)
* **adapters:** implement Claude Code adapter ([#16](https://github.com/ozzy-labs/skills/issues/16)) ([088575e](https://github.com/ozzy-labs/skills/commit/088575eb5d4ba0051cb03c5e02849bbd5832f4e1)), closes [#10](https://github.com/ozzy-labs/skills/issues/10)
* **adapters:** implement Codex CLI adapter ([#17](https://github.com/ozzy-labs/skills/issues/17)) ([fba5108](https://github.com/ozzy-labs/skills/commit/fba51082c39241718b71873b912d38fcd5dad726)), closes [#11](https://github.com/ozzy-labs/skills/issues/11)
* **adapters:** implement Gemini CLI adapter ([#18](https://github.com/ozzy-labs/skills/issues/18)) ([7e96685](https://github.com/ozzy-labs/skills/commit/7e966859ec998394c8d61677209e64a1357605cd)), closes [#12](https://github.com/ozzy-labs/skills/issues/12)
* **adapters:** implement GitHub Copilot adapter ([#19](https://github.com/ozzy-labs/skills/issues/19)) ([3c8ee5f](https://github.com/ozzy-labs/skills/commit/3c8ee5f8c2fa672f235c3bbda41e3e5f7091226c)), closes [#13](https://github.com/ozzy-labs/skills/issues/13)
* **drive:** add --merge option for autonomous PR merging ([#31](https://github.com/ozzy-labs/skills/issues/31)) ([3354950](https://github.com/ozzy-labs/skills/commit/33549506d1e63668f300e900c5f1fe78a09ab498))
* **drive:** add cleanup step (switch to base branch and pull) after merge ([#32](https://github.com/ozzy-labs/skills/issues/32)) ([4d35fa3](https://github.com/ozzy-labs/skills/commit/4d35fa3683789c8b4a8633bf6aa5bf8e5e7bc230))
* **drive:** post-merge audit step を Phase Final に追加 ([#74](https://github.com/ozzy-labs/skills/issues/74)) ([3ade6fe](https://github.com/ozzy-labs/skills/commit/3ade6fe32d8e78a7a3227c4649061a5071d89a64)), closes [#70](https://github.com/ozzy-labs/skills/issues/70)
* **drive:** subagent に scope 外波及チェックと cross_cutting_gaps 戻り値を追加 ([#75](https://github.com/ozzy-labs/skills/issues/75)) ([09ac973](https://github.com/ozzy-labs/skills/commit/09ac97335bfb4a232266814610abf3567dccf2ed)), closes [#70](https://github.com/ozzy-labs/skills/issues/70)
* **drive:** 複数 issue/PR の並列実行サポート ([#41](https://github.com/ozzy-labs/skills/issues/41)) ([595a703](https://github.com/ozzy-labs/skills/commit/595a703d9c2df34fb31625a3d10d2cea160c198a))
* **health:** drive orphan worktree と synthetic branch の検出を強化 ([#76](https://github.com/ozzy-labs/skills/issues/76)) ([27ae962](https://github.com/ozzy-labs/skills/commit/27ae96210fee135e608b16e938cb338c9b2b45ae))
* initial scaffold for @ozzylabs/skills v0.0.0 ([4c13fc5](https://github.com/ozzy-labs/skills/commit/4c13fc5de0fc28d82fc9d1738145fc4c4622ee7e))
* **review:** adopt ADR-0025 multi-perspective review with code-reviewer agent ([#60](https://github.com/ozzy-labs/skills/issues/60)) ([10f42c4](https://github.com/ozzy-labs/skills/commit/10f42c4532be92eef781ed1250b045636859c24d))
* self-consume skills for in-repo agent development ([#5](https://github.com/ozzy-labs/skills/issues/5)) ([689ed8e](https://github.com/ozzy-labs/skills/commit/689ed8e0c5548bd2d8179058befbfb9f56dd890c))
* **skills-sync:** expose adapter outputs via per-adapter sub-presets ([#24](https://github.com/ozzy-labs/skills/issues/24)) ([d3ff883](https://github.com/ozzy-labs/skills/commit/d3ff883a9a47477a8b148b7b6b9cc6bbdd1635aa))
* **skills/health:** add --deep mode and layout improvements ([#48](https://github.com/ozzy-labs/skills/issues/48)) ([ca34616](https://github.com/ozzy-labs/skills/commit/ca346169a702dc692e70421f43ba9f263378473a))
* **skills/health:** replace summary line and Clean aggregation with 15-row status table ([#49](https://github.com/ozzy-labs/skills/issues/49)) ([18172e1](https://github.com/ozzy-labs/skills/commit/18172e1fe797ade6449c66843e1842e8ea782eaf))
* **skills:** add /health skill for repo state inspection ([#44](https://github.com/ozzy-labs/skills/issues/44)) ([20e0585](https://github.com/ozzy-labs/skills/commit/20e05853ade22cf1efd7d048f791de05380dcd23))
* **skills:** add phase-issue skill for Phase-N tracking issues ([#64](https://github.com/ozzy-labs/skills/issues/64)) ([2031f63](https://github.com/ozzy-labs/skills/commit/2031f63ea3252eb3faf40328a39e761ad539ca2a)), closes [#62](https://github.com/ozzy-labs/skills/issues/62)
* **skills:** add topics skill for research-driven GitHub topics setup ([#65](https://github.com/ozzy-labs/skills/issues/65)) ([b8ae1c1](https://github.com/ozzy-labs/skills/commit/b8ae1c14aebc71c851d4f4781c6b0f76f7402574)), closes [#63](https://github.com/ozzy-labs/skills/issues/63)


### Bug Fixes

* **adapters:** emit Prettier-compatible JSON for .gemini/settings.json ([#37](https://github.com/ozzy-labs/skills/issues/37)) ([ba88440](https://github.com/ozzy-labs/skills/commit/ba88440b598f85cb0c8888fa473fd024489e714d))
* **adapters:** make snippet outputs Prettier-compatible to prevent sync oscillation ([#26](https://github.com/ozzy-labs/skills/issues/26)) ([a355f5b](https://github.com/ozzy-labs/skills/commit/a355f5bbfe15958515c778607f1cc9a938dc4413)), closes [#25](https://github.com/ozzy-labs/skills/issues/25)
* **drive:** apply parent worktree drift fix to SSOT and rebuild dist ([#68](https://github.com/ozzy-labs/skills/issues/68)) ([6e6c81a](https://github.com/ozzy-labs/skills/commit/6e6c81a65b80ad46fd4e06d6a786b73b54594f70))
* **drive:** prevent subagent worktree contamination of parent ([#67](https://github.com/ozzy-labs/skills/issues/67)) ([52a3ded](https://github.com/ozzy-labs/skills/commit/52a3ded111933e8ccbefbebb334747c6515ab899))
* **drive:** subagent worktree と関連 branch を Phase Final でクリーンアップ ([#73](https://github.com/ozzy-labs/skills/issues/73)) ([b97be7a](https://github.com/ozzy-labs/skills/commit/b97be7ae77960768197aea818c654723949f49ad)), closes [#69](https://github.com/ozzy-labs/skills/issues/69)
* **release-please:** set initial-version to 0.1.0 ([#38](https://github.com/ozzy-labs/skills/issues/38)) ([36fb681](https://github.com/ozzy-labs/skills/commit/36fb68104709587dcda7a823b654645e16c3356c))
* **review:** move severity_rules and exit_criteria into perspective frontmatter ([#61](https://github.com/ozzy-labs/skills/issues/61)) ([943a3dc](https://github.com/ozzy-labs/skills/commit/943a3dc70327220e9dd20281e6d4c63007cfdeb2))
* **skills/health:** clarify delete recommendation condition for merged branches ([#46](https://github.com/ozzy-labs/skills/issues/46)) ([1d5a26c](https://github.com/ozzy-labs/skills/commit/1d5a26c63547ae9a6ae50c80c97173ab26ad8806)), closes [#43](https://github.com/ozzy-labs/skills/issues/43)
* **sync:** pin .github/workflows/* to bypass GITHUB_TOKEN workflows scope limitation ([#36](https://github.com/ozzy-labs/skills/issues/36)) ([ac81d7b](https://github.com/ozzy-labs/skills/commit/ac81d7ba52ec979ce813d444a225e19c6bd9a661))
* **sync:** ship replace-snippet.sh with marker-missing auto-recovery ([#34](https://github.com/ozzy-labs/skills/issues/34)) ([8c9074b](https://github.com/ozzy-labs/skills/commit/8c9074bd14bd7c8dd8f033af1f12efdd7c722097))
