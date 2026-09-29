# 测试、验收与发布门槛

## 1. 目标

测试体系必须证明：

- 核心功能正确；
- Provider 差异被 Adapter 隔离；
- Queue 重试不会破坏数据；
- 导入重复执行可预测；
- MCP 权限不可绕过；
- 发信不会因自动重试制造重复邮件；
- Cloudflare 空环境可重建；
- 免费层设计约束具备保护机制。

## 2. 测试层级

```text
Unit
Integration
Contract
Provider Sandbox
E2E
Fault Injection
Security
Performance/Quota
Staging Smoke
Production Smoke
Recovery Drill
```

## 3. Unit Tests

必须覆盖：

- account config normalizer；
- import parser / CSV parser；
- JSON schema validation；
- provider capability mapping；
- credential crypto；
- MCP scope evaluator；
- account allowlist；
- thread grouping；
- MIME/address normalization；
- cursor codec；
- sync generation；
- search query builder；
- error mapper；
- idempotency key handling；
- filename/header sanitization；
- SSRF host classifier。

## 4. D1 Integration

使用真实 D1/local emulator 能力验证：

- migrations 从空库执行；
- migrations 重复执行规则；
- account CRUD；
- credential Repository 不暴露密文之外结构；
- message upsert；
- cursor commit；
- FTS；
- import batch/item；
- send operation uniqueness；
- cascade/account delete；
- indexes query plan（关键查询）。

## 5. R2 Integration

- body cache write/read/miss；
- attachment stream；
- account prefix cleanup；
- oversized object guard；
- content-type/disposition；
- cache deletion 后 Provider 可重新获取。

## 6. Queue Integration

至少：

- duplicate delivery；
- retry；
- continuation；
- stale generation；
- account lock；
- poison job；
- max retries；
- auth error 不无限重试；
- cursor 不提前提交。

## 7. Provider Contract Suite

所有 Provider Adapter 共用同一套 contract tests：

```text
verify
listFolders
initialSync
incrementalSync
getMessage
getAttachment
setRead
setStarred
archive
delete
move(if capability)
send
```

同一测试定义运行在：

- Gmail mock/fake；
- Microsoft mock/fake；
- IMAP/SMTP test server。

Provider 专属测试额外覆盖 cursor/history/delta/UID semantics。

## 8. Real Provider Smoke

RC 前必须真实联调：

- 1 个 Gmail；
- 1 个 Outlook/Microsoft 365；
- 至少 2 类标准 IMAP/SMTP 邮箱。

每类真实联调：

1. add/connect；
2. folders；
3. initial sync；
4. receive new mail；
5. incremental sync；
6. open body；
7. attachment；
8. read/star；
9. archive/delete/move where supported；
10. new send；
11. reply；
12. sent reconciliation；
13. auth expiration/reconnect。

## 9. API Contract Tests

冻结前端依赖的 DTO 和错误码。

重点：

- old backend/client compatibility where required；
- cursor pagination；
- no secret fields；
- message list compact；
- `unknown` send state；
- idempotency conflict；
- import dry-run contract。

## 10. MCP Contract Tests

### Read-only token

应该成功：

- list_accounts
- list_recent_emails
- search_emails
- get_email
- get_thread

应该失败：

- archive
- delete
- send

### Manage token

允许 read/manage；禁止 send（无 mail.send 时）。

### Send token

发送前仍需 account ownership/allowlist/rate limit 校验。

### Account allowlist

Token 只允许 A 账号时，不得通过 message id、thread id、search query 间接读取 B 账号。

## 11. Import / Export Matrix

### Safe Manifest

- single/multiple；
- missing credential；
- malformed JSON；
- unsupported version；
- duplicate account；
- alias/folder mapping/signature；
- re-import same file。

### Encrypted Bundle

- correct passphrase；
- wrong passphrase；
- corrupted payload；
- weak/out-of-policy KDF params；
- OAuth client fingerprint match/mismatch；
- secret leak scan。

### CSV

- UTF-8 BOM；
- quoted comma/newline；
- empty password；
- invalid port/security；
- formula-like cell content treated as text；
- oversized row/file。

### Legacy

- password account；
- OAuth account；
- custom ports；
- TLS flags；
- folder mappings；
- aliases；
- disabled account；
- dangerous legacy skip verify/private host requires confirmation。

### Batch Failure

10 accounts：第 3/7 个失败，其余成功；retry-failed 不重复创建成功账号。

## 12. Sync Fault Injection

模拟：

- Gmail history invalid；
- Graph delta invalid；
- IMAP UIDVALIDITY changed；
- IMAP disconnect mid-page；
- SMTP disconnect after DATA；
- Provider 401/403/429/5xx；
- Worker crash after message upsert before continuation；
- duplicate Queue；
- stale continuation；
- D1 write failure；
- R2 failure；
- Account deleted during queued sync。

验收标准：不漏邮件优先于避免重复处理；重复处理必须被 upsert/idempotency 吸收。

## 13. Send Safety Tests

重点：

- clientOperationId same payload -> same result；
- same key different payload -> conflict；
- request timeout before Provider call -> safe retry；
- Provider explicit failure -> failed；
- SMTP ambiguous disconnect -> unknown；
- unknown 不自动重发；
- MCP token without send scope denied；
- recipient limits；
- attachment limits。

## 14. Security Tests

### Secrets

CI 扫描：

- repository；
- test snapshots；
- structured logs；
- import table fixtures；
- API responses。

### XSS

HTML corpus：

- script；
- onerror/onload；
- javascript: URL；
- SVG payload；
- iframe/object；
- CSS URL/behavior variants。

### SSRF

- 127.0.0.1；
- localhost；
- ::1；
- RFC1918；
- link-local；
- metadata IP；
- decimal/hex/IPv6 mapped forms；
- DNS rebinding style resolution changes。

### OAuth

- invalid state；
- replay state；
- expired state；
- wrong user session；
- callback error；
- refresh revoked。

## 15. Performance / Quota Tests

个人典型数据集：

```text
5 accounts
50k indexed messages
30-day active window
mixed attachments
```

扩展数据集：

```text
10 accounts
200k indexed messages
```

测：

- unified inbox p50/p95；
- search p50/p95；
- message open cached/uncached；
- sync batch CPU/wall time；
- D1 reads/writes；
- Queue ops；
- R2 ops/storage；
- Cron fan-out。

目标不是追求 benchmark 数字，而是找到免费层风险和 query hot spot。

## 16. Frontend E2E

Playwright/等价工具至少：

1. login；
2. import safe manifest；
3. add Gmail OAuth；
4. unified inbox；
5. filter account/folder；
6. search；
7. open thread；
8. attachment；
9. read/star/archive；
10. compose；
11. reply；
12. account diagnostics；
13. MCP token create/revoke；
14. account export；
15. OAuth reconnect。

## 17. Accessibility / UX Checks

核心路径：

- keyboard navigation；
- focus states；
- aria labels；
- loading/error/empty states；
- import wizard 可明确看到逐账号状态；
- sync stale/error 不只靠颜色表达。

## 18. Recovery Drill

至少一次完整演练：

1. 新建空 D1/R2；
2. deploy same code；
3. import account bundle；
4. OAuth reconnect where required；
5. sync folders/messages；
6. verify unified inbox/search；
7. MCP token re-create；
8. send smoke。

R2 原缓存不恢复也应该可正常工作。

## 19. Acceptance Report Template

每个 WP 输出：

```markdown
# WPx Acceptance Report

## Candidate
- branch/commit
- runtime/version

## Scope Completed

## Files Changed

## Architecture Decisions

## Tests
- unit
- integration
- contract
- real provider

## Cloudflare Compatibility

## Security Checks

## Free-tier Impact

## Known Issues

## Deferred

## Next WP Preconditions
```

## 20. WP Gates

### WP0

- 前端 API usage inventory；
- contract baseline。

### WP1

- Worker local/staging health；
- CI pass。

### WP2

- clean D1 migration；
- repository integration。

### WP3

- credential encryption；
- MCP token hashing；
- negative scope tests。

### WP3A

- four import paths；
- dry-run/conflict/idempotency；
- secret leak tests。

### WP4-6

- Provider contract + real smoke。

### WP7

- duplicate/retry/crash fault injection。

### WP8

- lazy body + streaming attachments + cleanup。

### WP9

- MCP read/manage/send；
- allowlist/scope/audit。

### WP10

- browser E2E；
- no dependency on old backend for core flow。

### WP11 / RC

- free-tier audit；
- security gate；
- recovery drill；
- staging smoke；
- production smoke。

## 21. RC Definition of Done

### Product

- [ ] Unified Inbox
- [ ] Gmail
- [ ] Microsoft
- [ ] Generic IMAP/SMTP x2 real providers
- [ ] Search/Thread/Attachment
- [ ] Read/Star/Archive/Delete
- [ ] New/Reply/Reply All/Forward
- [ ] account import/export
- [ ] MCP read/manage/send

### Reliability

- [ ] cursor recovery
- [ ] stale job protection
- [ ] duplicate Queue safe
- [ ] provider reconnect
- [ ] send unknown handled
- [ ] import partial failure safe

### Security

- [ ] no plaintext provider credential at rest
- [ ] no raw MCP token at rest
- [ ] log redaction
- [ ] XSS tests
- [ ] SSRF tests
- [ ] OAuth replay tests
- [ ] MCP negative permission tests

### Operations

- [ ] scripted clean deploy
- [ ] migrations
- [ ] diagnostics
- [ ] recovery drill
- [ ] free-tier usage review

只有全部满足，才可将 Cloudflare Lite 标为 production-ready。
