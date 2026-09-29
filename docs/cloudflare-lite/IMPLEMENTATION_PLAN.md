# 实施计划与工作包

## 1. 执行原则

- 一次只完成一个 WP；
- 每个 WP 必须读本目录全部相关文档；
- 不破坏现有 `backend/`；
- Cloudflare 新实现优先放 `backend-cf/`；
- 任何偏离设计的决定先写 ADR/Acceptance Report；
- 每个 WP 都要有可运行测试，不接受仅文档声称完成；
- Provider 和 Cloudflare Runtime 能力必须通过真实 Spike/Smoke 验证。

## 2. 依赖关系

```text
WP0 Contract Freeze
  |
WP1 CF Skeleton
  |
WP2 D1 Foundation
  |
WP3 Security/Auth
  |\
  | WP3A Import/Export
  |
WP4 Gmail ----\
WP5 Graph -----+--> WP7 Sync Engine --> WP8 Body/R2
WP6 IMAP/SMTP-/                         |
                                         v
WP9 MCP ------------------------------> WP10 Frontend Cutover
                                         |
                                         v
                                      WP11 RC
```

WP4/5/6 可在 Provider Port 稳定后部分并行，但最终 Sync Engine 必须统一收敛。

## 3. WP0 - Baseline / Contract Freeze

### Deliverables

- frontend API call inventory；
- old backend route inventory；
- account/message/thread/send DTO inventory；
- core user flow diagram；
- contract test harness；
- compatibility decisions。

### Must Inspect

- `frontend/src/**`
- `backend/src/routes/**`
- `backend/src/services/**`
- `backend/migrations/**`

### Exit Gate

- 能明确说出前端核心流程依赖哪些 API；
- Contract tests 可作为 CF backend 替代判据。

## 4. WP1 - Cloudflare Skeleton

### Deliverables

- `backend-cf/` package；
- Worker fetch/scheduled/queue entry；
- Hono/native router；
- bindings typing；
- local dev；
- `/api/v1/system/health`；
- staging deploy；
- CI lint/test/build。

### Exit Gate

- local + staging 运行；
- 无 Provider 也能健康启动；
- environment bindings 校验明确。

## 5. WP2 - D1 Foundation

### Deliverables

- migrations；
- repositories；
- schema version；
- FTS baseline；
- R2 abstraction；
- audit repository；
- send/import tables。

### Exit Gate

- 空 D1 可重建；
- migration integration tests；
- 关键 query index audit。

## 6. WP3 - Auth / Credential Security

### Deliverables

- Web session；
- optional OIDC；
- CredentialVault AES-GCM；
- key version/rotation framework；
- MCP token mint/hash/revoke；
- Scope evaluator；
- rate limit abstraction；
- security logging redaction。

### Exit Gate

- D1 无明文 credential；
- raw MCP token 只出现一次；
- negative scope/security tests pass。

## 7. WP3A - Account Import / Export

### Deliverables

- Canonical Account Config；
- `account-manifest-v1.schema.json`；
- Safe Manifest import/export；
- Encrypted Bundle import/export；
- CSV parser/template；
- Legacy mapper；
- dry-run；
- conflict resolver；
- import batches/items；
- OAuth reauth marker；
- import/export UI wizard；
- audit。

### Exit Gate

- 10 个混合账号批量导入；
- partial failure safe；
- repeated import predictable；
- Secret leak scan pass；
- legacy fields map correctly；
- OAuth client mismatch -> reauth required。

## 8. WP4 - Gmail Provider

### Deliverables

- OAuth；
- verify；
- label/folder normalize；
- initial/history sync；
- message/attachment fetch；
- read/star/archive/delete；
- send/reply/forward；
- Gmail contract tests；
- real smoke。

### Exit Gate

完整 E2E Provider path 成功。

## 9. WP5 - Microsoft Provider

### Deliverables

- OAuth；
- mail folders；
- delta；
- conversation；
- message/attachment；
- actions；
- send；
- tests + real smoke。

### Exit Gate

Outlook/M365 complete path。

## 10. WP6 - Generic IMAP/SMTP

### Step 1 Compatibility Spike

先回答：

- Worker runtime 是否支持选定 TCP/TLS 方案；
- 现有 `imapflow`/`nodemailer` 能否工作；
- 若不能，最小替代方案是什么；
- TLS/timeout/streaming 如何实现；
- MIME parser CPU/memory 行为。

不得跳过 Spike 直接大规模改造。

### Deliverables

- IMAP folder/UID sync；
- MODSEQ capability；
- body/attachment；
- flags/move/archive/delete；
- SMTP send；
- timeout/TLS error taxonomy；
- 至少两类真实邮箱 smoke。

### Exit Gate

真实传统邮箱收+发+增量同步通过。

## 11. WP7 - Queue / Cron / Sync Engine

### Deliverables

- Cron scheduler；
- due account query；
- sync jobs；
- DO lock；
- generation；
- continuation；
- retry/backoff；
- cursor commit；
- bounded reconciliation；
- stale job drop；
- diagnostics。

### Exit Gate

故障注入：duplicate/retry/crash/cursor invalid 全部不漏关键数据、不破坏 cursor。

## 12. WP8 - Body / Attachment / R2

### Deliverables

- lazy body；
- sanitize pipeline；
- body/attachment stream；
- R2 cache；
- cleanup；
- size/content-disposition guard；
- cache metrics。

### Exit Gate

删除 R2 缓存后仍可从 Provider 恢复；大附件不进 D1。

## 13. WP9 - MCP First-Class

### Deliverables

- MCP transport；
- tools in API spec；
- scopes；
- account allowlist；
- audit；
- pagination；
- compact response；
- rate limit；
- send idempotency。

### Exit Gate

ChatGPT/兼容客户端真实调用：search/read/manage/send；只读 Token 的所有写操作均拒绝。

## 14. WP10 - Frontend Cutover

### Deliverables

- API client 指向 CF backend；
- account setup；
- import/export wizard；
- compose lite；
- sync diagnostics；
- MCP token UI；
- OAuth reconnect；
- error/stale/loading states。

### Exit Gate

核心 UX 完全不依赖旧 backend。

## 15. WP11 - Free Tier Hardening / RC

### Deliverables

- Cloudflare 最新免费限额核验；
- usage report；
- D1 query audit；
- R2 cleanup；
- Queue tuning；
- security review；
- recovery drill；
- deployment scripts；
- staging/prod smoke；
- release notes。

### Exit Gate

`TESTING_ACCEPTANCE.md` RC checklist 全绿。

## 16. 每个 WP 的 Codex 输入模板

```text
你正在实现 MailFlow CF Lite 的 WPx。

开始前：
1. 阅读 docs/cloudflare-lite/README.md；
2. 阅读与本 WP 相关的工程文档；
3. 阅读 docs/CLOUDFLARE_LITE_REFACTOR_PLAN.md；
4. 检查当前代码和前一 WP Acceptance Report；
5. 不破坏 backend/ 现有能力。

执行要求：
- 先给出当前事实和差距；
- 实现本 WP 范围；
- 编写/更新测试；
- 本地运行完整相关测试；
- 能做真实 smoke 的必须做；
- 不得以 mock 结果冒充真实兼容性；
- 不得把 Secret 写日志/fixture；
- 不得越过 Application Service 建第二套 MCP 业务逻辑；
- 所有异步任务幂等。

完成后输出 WPx Acceptance Report，包含 commit、变更、测试、真实联调、已知问题、Cloudflare 兼容性、Free Tier 影响、下一 WP 前置条件。
```

## 17. Release Branch Strategy

推荐：

```text
main                         当前稳定 MailFlow
cloudflare-lite-design       设计/实现主分支（当前）
feature/cf-wpN-*             每个 WP 临时开发分支，可选
```

当 CF Lite 达到 RC 后再决定：

- 合并 main 并双后端共存；或
- 独立 Cloudflare edition 分支/目录。

在 WP11 前不删除旧 Node backend。
