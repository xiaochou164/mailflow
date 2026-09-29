# MailFlow CF Lite 详细架构

## 1. 架构目标

目标系统是 Cloudflare Native 的轻量统一邮箱客户端，核心链路只有四类：

1. Web/PWA 浏览与管理邮件；
2. 后台增量同步多个 Provider；
3. MCP 搜索、读取、管理和轻量发信；
4. 账号配置导入/导出与迁移。

必须避免把旧 Node 服务原样塞进 Worker。重构应围绕无状态请求、短任务、Queue、D1、R2 和 Provider API 重新建模。

## 2. C4 Context

```text
+----------------+       HTTPS        +-------------------------+
| Browser / PWA  | <----------------> | MailFlow CF Lite Worker |
+----------------+                    +-------------------------+
                                             |    |    |
+----------------+       MCP                 |    |    +--> R2
| ChatGPT/Agent  | <-------------------------+    +------> D1
+----------------+                                  |
                                                    +--> Queues / Cron / DO
                                             |
                                             +--> Gmail API
                                             +--> Microsoft Graph
                                             +--> IMAP / SMTP
```

## 3. Deployment Units

建议 V1 保持一个主 Worker + Queue Consumer 同代码仓，而不是过早拆多个 Worker：

```text
mailflow-cf
├── fetch()        Web API / MCP / static fallback
├── scheduled()    Cron scheduler
├── queue()        sync / verify / cache jobs
└── DurableObject  AccountSyncCoordinator
```

若后续资源和权限边界需要再拆：

- `mailflow-web`
- `mailflow-sync`
- `mailflow-mcp`

但 V1 不强制微服务化。

## 4. Cloudflare Bindings

建议 bindings：

```text
DB                  D1
CACHE_BUCKET        R2
SYNC_QUEUE          Queue
ACCOUNT_SYNC        Durable Object namespace
AI                  Workers AI (optional)
ASSETS              Static assets
```

Secrets：

```text
MASTER_ENCRYPTION_KEY
SESSION_SIGNING_KEY
GOOGLE_CLIENT_ID
GOOGLE_CLIENT_SECRET
MICROSOFT_CLIENT_ID
MICROSOFT_CLIENT_SECRET
OIDC_*              optional
```

任何 Provider 用户级 credential 都不放 wrangler vars。

## 5. Layering

```text
Transport
├── Web API Controllers
├── MCP Tools
├── Queue Consumers
├── Cron Handler
└── Import/Export Controllers
        |
Application Services
├── AccountService
├── MailService
├── SearchService
├── SendService
├── SyncService
├── ImportExportService
└── McpAuthorizationService
        |
Domain / Ports
├── MailProvider
├── CredentialVault
├── MailRepository
├── AccountRepository
├── CacheStore
├── SyncCoordinator
└── AuditSink
        |
Adapters
├── GmailProvider
├── MicrosoftProvider
├── ImapSmtpProvider
├── D1 repositories
├── R2 cache
└── Durable Object lock
```

规则：Transport 层不直接调用 D1/Provider；Provider 不知道 Web/MCP；Repository 不知道 HTTP。

## 6. 请求链路

### 6.1 Unified Inbox

```text
GET /api/v1/messages?scope=unified
  -> Auth
  -> MailService.listMessages
  -> D1 index query
  -> compact DTO
```

列表请求禁止实时查询所有 Provider。

### 6.2 打开邮件

```text
GET /api/v1/messages/:id
  -> D1 metadata
  -> body cache hit?
       yes -> return
       no  -> Provider.getMessage/body
              -> sanitize/normalize
              -> optional R2 cache
              -> return
```

若 Provider 拉取耗时超过交互预算，可返回 metadata + `bodyStatus=fetching`，同时 enqueue body-fetch；前端轮询或事件更新。

### 6.3 写操作

```text
POST archive/star/read/delete
  -> Auth / Scope
  -> optimistic intent row(optional)
  -> Provider action
  -> D1 state update
  -> audit
```

Provider action 失败时不得把 D1 永久标记成成功状态。

### 6.4 发信

```text
POST /send
  -> validation
  -> rate limit
  -> account ownership
  -> Provider.send
  -> optional Sent reconciliation job
  -> audit
```

发送结果分：`accepted`, `sent`, `failed`, `unknown`。网络断开造成“不确定是否已发送”时必须返回 `unknown`，不得自动无限重试 SMTP 发送以避免重复邮件。

## 7. 异步链路

### 7.1 Cron

Cron 只做：

- 查找到期账号；
- 分页生成 sync job；
- enqueue；
- 不连接 Provider。

### 7.2 Queue Topics / Job Types

可共用一条 Queue，以 `type` 区分：

```ts
type Job =
  | { type: 'sync-account'; accountId: string; reason: string }
  | { type: 'sync-folder'; accountId: string; folderId: string; cursor?: string }
  | { type: 'verify-account'; accountId: string }
  | { type: 'fetch-body'; messageId: string }
  | { type: 'reconcile-send'; accountId: string; providerMessageId?: string }
  | { type: 'cache-cleanup'; prefix?: string };
```

Queue payload 禁止携带 credential。

## 8. Durable Object 职责

`AccountSyncCoordinator` 只负责账号级串行化和短状态，不保存邮件业务数据。

职责：

- 同一账号避免并发 full/incremental sync；
- generation/token 防 stale continuation；
- lease/heartbeat；
- 可选 websocket sync progress。

不得用 DO 当第二数据库。

## 9. Provider Capability Matrix

业务层必须做 capability discovery：

```ts
interface ProviderCapabilities {
  incrementalSync: boolean;
  nativeThreads: boolean;
  archive: boolean;
  move: boolean;
  serverSearch: boolean;
  send: boolean;
  aliases: boolean;
  modseq?: boolean;
}
```

不要假设所有 Provider 都支持同一套语义。

## 10. Gmail

推荐 API 优先：

- OAuth
- historyId 增量
- labels -> normalized folder roles
- native thread
- get message/attachment
- modify labels/read/star/archive
- send raw MIME via API

遇到 history cursor 过期：进入 bounded resync，不删除现有索引后全量重建。

## 11. Microsoft

推荐 Graph：

- OAuth
- mailFolders
- deltaLink
- conversationId
- move/delete/read
- sendMail

Delta link 失效同样进入 bounded resync。

## 12. Generic IMAP/SMTP

核心：

- IMAP TLS/STARTTLS
- folder discovery
- UIDVALIDITY
- UIDNEXT
- CONDSTORE/QRESYNC/MODSEQ 若可用则使用
- MIME header first
- body/attachment lazy fetch
- SMTP TLS/STARTTLS

必须通过 WP compatibility spike 确认 runtime/依赖，不允许把 `imapflow`/`nodemailer` 原样兼容当成前提。

## 13. Frontend 边界

保留：

- Unified Inbox
- Message List/Reader
- Thread
- Account/Folder sidebar
- Search
- Compose Lite
- Settings/Accounts
- MCP Token UI
- Import/Export Wizard
- Diagnostics

前端不得持有长期 Provider Secret。OAuth PKCE/state 等临时材料按协议生命周期处理。

## 14. Search Architecture

搜索分两层：

1. 本地索引搜索：D1 FTS/metadata，快、统一；
2. Provider deep search：可选，用户显式触发，用于未建立历史索引的老邮件。

V1 默认本地搜索。

Search DTO：

```text
id/account/thread/subject/from/date/preview/flags/matchedFields
```

只有打开结果时才拉完整正文。

## 15. Cache Architecture

R2 是 cache，不是 source of truth。

对象需带逻辑 metadata：

```text
contentType
etag/providerVersion
cachedAt
lastAccessBucket(optional)
```

清理策略允许删除任何 body/attachment cache；删除后应能从 Provider 重建。

## 16. Configuration

配置分三类：

- deployment config：wrangler vars，不含用户 Secret；
- deployment secret：Cloudflare Secret；
- user/provider secret：CredentialVault 加密后 D1。

账号导入统一进入 Canonical Config，不允许 import 文件直接映射到 D1 row。

## 17. Availability / Failure Model

Provider 不可用时 MailFlow 仍应：

- 展示已索引列表；
- 展示已缓存正文；
- 搜索已索引数据；
- 明确显示 stale/lastSync；
- 写操作返回可解释错误；
- 不隐藏同步错误。

## 18. Consistency Model

- 邮件索引：eventually consistent with Provider；
- read/star/archive：尽量 provider-first，成功后更新 D1；
- send：外部副作用，使用 idempotency key 仅防本系统重复提交，不能假设 SMTP 支持 exactly-once；
- import：D1 item-level transaction + external verify asynchronously；
- cache：弱一致，可随时丢弃。

## 19. Idempotency Keys

建议：

```text
sync: accountId + folderId + providerCursor + generation
manage: request idempotency key + user + message + action
send: clientOperationId + accountId
import: importBatchId + itemFingerprint
```

发送的 idempotency 只保证 MailFlow 不重复调用；若 Provider 返回 unknown，必须由用户/对账逻辑处理。

## 20. ADR 要求

以下变化必须写 ADR：

- 更换 D1 为其他数据库；
- 放弃 Gmail/Graph API 优先；
- 引入常驻外部服务器；
- 导入 Secret 明文落盘；
- MCP 默认开启 send；
- R2 从 cache 改为真源；
- 引入付费 Cloudflare 作为 V1 必选依赖。
