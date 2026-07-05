---
name: security
category: required
description: Injection, secret exposure, privilege escalation, supply chain, script execution
applies_when: ["**/*"]
default_enabled: true
severity_rules: { critical: "悪用可能な脆弱性、明示的な秘密情報の commit、認証回避、任意コード実行", warning: "防御層の欠落、未サニタイズ入力、過剰な権限、暗黙の信頼境界", info: "改善余地のある defensive coding、CSP / セキュリティヘッダの強化提案" }
exit_criteria: { drive_loop: { critical: 0, warning: 0 } }
---

# security — Security

## Inspection items

- **Injection**: command injection, SQL/NoSQL injection, shell `eval`, unescaped template expansion, prompt injection
- **Secret exposure**: hardcoded tokens / API keys / passwords, committing `.env`, secrets leaking into logs
- **Privilege escalation**: overly permissive tokens / IAM policies, unnecessary use of `sudo`, running as root
- **Supply chain**: untrusted registries, unpinned dependencies, unverified script execution (`curl | bash`)
- **Script execution**: passing external input into eval / spawn, unsanitized URL fetch, `child_process` with user input
- **CI/CD workflows**: `pull_request_target`, secret exposure in `run-on-pr`, missing SHA pinning for third-party actions
- **Data handling**: unnecessary retention/transmission of PII, missing encryption, communication without TLS

## Severity guide

- **critical**: exploitable vulnerabilities, explicit commits of secrets, authentication bypass, arbitrary code execution
- **warning**: missing defensive layer, unsanitized input, excessive privileges, implicit trust boundaries
- **info**: defensive coding with room for improvement, suggestions for strengthening CSP / security headers

## skip_when

```yaml
skip_when:
  diff_only_in: []
```

Always applied because this is a `required` perspective.

## exit_criteria.drive_loop

```yaml
exit_criteria:
  drive_loop:
    critical: 0
    warning: 0
```

Do not judge as merge-ready while critical / warning issues related to security remain.
