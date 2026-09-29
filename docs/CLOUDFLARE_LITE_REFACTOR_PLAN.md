# MailFlow Cloudflare Lite 重构方案

> 分支：`cloudflare-lite-design`
>
> 目标：将 MailFlow 从传统 Node.js + Express + PostgreSQL + Redis + Docker 的完整 Webmail，重构为一个 **Cloudflare Native、0 VPS、面向“统一收件 + MCP + 轻量发信”** 的 B/S 邮件客户端。

---

## 1. 背景与产品定位

现有 MailFlow 是完整 Webmail，能力覆盖多邮箱、统一收件箱、IMAP/SMTP、富文本写信、附件、全文搜索、规则、GTD、CardDAV、AI、用户管理、2FA、OIDC、WebSocket、Web Push 等。

本次重构不追求 1:1 复制全部能力，而是围绕实际核心需求重新定义产品：

> **MailFlow CF Lite = 多邮箱统一收件箱 + MCP 邮件能力 + 轻量发信。**

产品优先级：

1. **收件稳定**：多个邮箱统一展示、搜索、阅读、管理。
2. **MCP 一等公民**：ChatGPT / Agent 能安全搜索、读取、总结、管理和轻量发送邮件。
3. **轻量发信**：支持新建、回复、回复全部、转发、CC/BCC、简单附件，不做重型富文本编辑器和邮件营销能力。
4. **Cloudflare Native**：不依赖 VPS、Docker、PostgreSQL、Redis；尽量长期运行在 Cloudflare Free Plan。
5. **保持 Provider 可扩展**：Gmail、Microsoft、标准 IMAP/SMTP 使用统一 Adapter 层。

---

## 2. 本次范围

### 2.1 必须保留 / 实现

#### 收件

- 多邮箱账号
- 统一收件箱
- 单账号 / 文件夹浏览
- 邮件列表
- 邮件详情
- HTML / Text 邮件阅读
- Thread / Conversation 聚合
- 已读 / 未读
- 星标
- 归档
- 删除
- 移动文件夹（标准 IMAP Provider）
- 附件查看 / 下载
- 搜索
- 联系人基础自动补全
- 增量同步
- 手工立即同步
- 定时同步

#### MCP

MCP 必须作为独立核心模块，而不是 Web API 的附属功能。

第一版 MCP Tools：

- `list_accounts`
- `list_folders`
- `list_recent_emails`
- `search_emails`
- `get_email`
- `get_thread`
- `list_important_emails`
- `mark_read`
- `mark_unread`
- `star_email`
- `unstar_email`
- `archive_email`
- `delete_email`
- `send_email`
- `reply_email`
- `forward_email`

AI / 聚合类能力：

- `summarize_email`
- `summarize_thread`
- `summarize_inbox`
- `list_actionable_emails`

MCP 应支持 Scope：

- `mail.read`
- `mail.manage`
- `mail.send`
- `mail.ai`

默认 MCP Token 建议只发放 `mail.read`，管理和发送权限显式开启。

#### 轻量发信

- New Mail
- Reply
- Reply All
- Forward
- To / CC / BCC
- Subject
- 纯文本
- 简单 HTML
- 基础签名
- 小附件
- Sent 状态回写

### 2.2 明确不作为第一版目标

以下功能从 Cloudflare Lite V1 中移除或推迟：

- 完整 TipTap 富文本编辑器能力
- 字体 / 颜色 / 表格 / 图片 resize 等复杂排版
- 邮件营销 / 群发
- 定时发送
- 阅读回执 / 邮件追踪
- Todoist
- CardDAV Server
- GTD 五状态完整工作流
- 高级 Inbox Rules
- Block List 高级规则
- Spam feedback 体系
- Snooze 高级工作流
- 多租户 SaaS
- 企业级 Admin / 邀请系统
- 完整 SMTP Server
- 自建邮件接收服务器

后续如果确实有需要，可以按独立模块追加，不能反向污染 V1 核心架构。

---

## 3. 现有架构与目标架构

### 3.1 当前 MailFlow

```text
Browser
   |
   v
Frontend (React + Vite)
   |
   v
Node.js / Express
   |------- PostgreSQL
   |------- Redis
   |------- IMAPFlow
   |------- Nodemailer
   |------- WebSocket
   |------- Web Push
   |
 Docker / VPS / nginx / Caddy
```

主要问题：

- 必须维护服务器或 Docker Runtime
- PostgreSQL / Redis 增加运维成本
- 常驻 IMAP / WebSocket 逻辑与 Serverless 模型不匹配
- 现有产品功能明显超过个人“统一收件 + MCP + 轻量发信”的真实需求

### 3.2 Cloudflare Lite 目标架构

```text
             Browser / PWA
                  |
                  v
      Cloudflare Worker / API
          |        |        |
          |        |        +------ MCP Endpoint
          |        |
          |        +--------------- Auth / Session
          |
          +------ Provider Layer
          |          |       |
          |          |       +------ IMAP / SMTP
          |          +-------------- Microsoft Graph
          +------------------------- Gmail API

          |
          +------ D1
          |       accounts / folders / message index
          |       threads / cursors / sessions / MCP tokens
          |
          +------ R2
          |       body cache / MIME cache / attachment cache
          |
          +------ Queues
          |       sync jobs / body fetch / attachment jobs
          |
          +------ Durable Objects (optional / limited)
          |       account sync lock / live state / websocket
          |
          +------ Cron
                  periodic sync scheduler
```

设计原则：

- **D1 存索引和业务状态，不存大量原始邮件正文。**
- **R2 作为可回收缓存，不把 MailFlow 做成第二个邮箱服务器。**
- **Provider 是事实源，MailFlow 是统一访问层和索引层。**
- **同步任务全部幂等。**
- **单个 Worker 请求不承担大规模全量同步。**
- **所有重任务拆到 Queue。**

---

## 4. Cloudflare 资源映射

| 当前组件 | Cloudflare Lite | 说明 |
|---|---|---|
| React / Vite | Workers Static Assets 或 Pages | 前端最大程度复用 |
| Express API | Workers + Hono 或原生 Router | 建议新建 `backend-cf/` |
| PostgreSQL | D1 | 元数据、索引、状态 |
| Redis Session | Cookie + D1 / DO | 不再依赖 Redis |
| Redis Cache | D1 / Cache API / DO | 按场景使用 |
| Redis Lock | Durable Object | 每账号串行同步 |
| 后台任务 | Queues | 解耦同步和请求 |
| 系统 Cron | Cron Triggers | 定时调度 |
| 邮件正文 / MIME | R2 可选缓存 | 按需缓存 |
| 附件 | R2 可选缓存 | 非永久真源 |
| WebSocket | Durable Objects 可选 | 非 V1 硬依赖 |
| AI | Workers AI / 外部 OpenAI-Compatible | 可插拔 |
| Secret | Worker Secrets | Provider Client Secret / 加密主密钥 |

---

## 5. Provider Adapter 设计

Provider 层必须把 Gmail / Graph / IMAP 差异隔离在业务层之外。

建议接口：

```ts
export interface MailProvider {
  readonly kind: 'gmail' | 'microsoft' | 'imap';

  testConnection(): Promise<ConnectionResult>;
  listFolders(): Promise<Folder[]>;

  syncFolder(input: SyncFolderInput): Promise<SyncBatch>;
  getMessage(input: GetMessageInput): Promise<ProviderMessage>;
  getRawMessage?(input: GetMessageInput): Promise<ArrayBuffer>;
  getAttachment(input: GetAttachmentInput): Promise<ReadableStream>;

  markRead(messageId: string, read: boolean): Promise<void>;
  star(messageId: string, starred: boolean): Promise<void>;
  archive(messageId: string): Promise<void>;
  delete(messageId: string): Promise<void>;
  move?(messageId: string, folderId: string): Promise<void>;

  send(input: SendMessageInput): Promise<SendResult>;
  reply(input: ReplyMessageInput): Promise<SendResult>;
  forward(input: ForwardMessageInput): Promise<SendResult>;
}
```

### 5.1 GmailProvider

优先使用 Gmail API，而不是长期 IMAP IDLE。

目标：

- OAuth 2.0
- Gmail History 增量同步
- Thread ID 直接复用
- Label 映射到 Folder / Category
- Gmail API 发信
- Gmail API 修改 read/star/archive

优点：

- 更适合 Serverless
- 增量同步效率高
- Thread 语义天然存在
- 发信 / Sent / Draft 状态一致性更好

### 5.2 MicrosoftProvider

优先 Microsoft Graph：

- OAuth 2.0
- delta query 增量同步
- Graph message / conversation
- Graph sendMail
- Graph 标记 read / move / delete

### 5.3 ImapSmtpProvider

用于：

- QQ 邮箱
- 163 / 126
- iCloud（若不单独实现）
- 企业邮箱
- 自建邮箱
- 其他标准 IMAP / SMTP 服务

收件：IMAP over TLS。

发信：SMTP over TLS。

必须避免依赖“永不退出的 IMAP IDLE 进程”。V1 使用：

- Cron 触发
- UID / UIDVALIDITY / MODSEQ（服务端支持时）
- 按 folder 增量拉取
- 手工立即同步

---

## 6. 同步模型

### 6.1 核心原则

Cloudflare Worker 不作为常驻邮箱连接器。

邮件同步采用：

```text
Cron / Manual Sync
       |
       v
Sync Scheduler
       |
       v
Queue: account-sync
       |
       v
Account Sync Worker
       |
       +-- acquire AccountSyncDO lock
       |
       +-- provider.syncFolder()
       |
       +-- upsert D1 index
       |
       +-- schedule next batch if needed
```

### 6.2 同步粒度

不能“一封邮件一个 Queue message”。

建议 Queue Payload：

```json
{
  "accountId": "...",
  "folderId": "...",
  "cursor": "...",
  "reason": "cron|manual|continuation"
}
```

单批处理建议：

- 20 ~ 100 封 / batch
- 达到执行预算前主动 checkpoint
- cursor 持久化到 D1
- 失败任务可安全重试

### 6.3 初次同步

第一版默认：

- Inbox：最近 30 天
- Sent：最近 30 天
- 其他 Folder：按需同步

允许高级配置：

- 7 天
- 30 天
- 90 天
- 全部 Header 索引

不要默认全量拉取多年历史邮件。

### 6.4 增量同步状态

D1 保存：

- Gmail `historyId`
- Graph `deltaLink`
- IMAP `uidValidity`
- IMAP `uidNext`
- IMAP `highestModSeq`（支持时）
- `last_success_at`
- `last_error`

---

## 7. 数据存储设计

## 7.1 D1 原则

D1 是 MailFlow 的**索引数据库**，不是完整邮件仓库。

建议表：

### users

```text
id
email
name
role
created_at
updated_at
```

V1 可以单用户优先，但 Schema 不要锁死为单用户。

### accounts

```text
id
user_id
provider_kind
email_address
display_name
auth_type
encrypted_credentials
status
sync_enabled
sync_interval_minutes
created_at
updated_at
last_sync_at
last_error
```

### folders

```text
id
account_id
provider_folder_id
name
role        // inbox, sent, draft, trash, archive, spam, custom
parent_id
sync_enabled
created_at
updated_at
```

### threads

```text
id
account_id
provider_thread_id
subject_normalized
latest_at
message_count
participants_json
created_at
updated_at
```

### messages

```text
id
account_id
folder_id
thread_id
provider_message_id
provider_uid
internet_message_id
in_reply_to
references_json
subject
from_json
to_json
cc_json
bcc_json
sent_at
received_at
preview
is_read
is_starred
has_attachments
size_bytes
body_cache_key
raw_cache_key
created_at
updated_at
```

### attachments

```text
id
message_id
provider_attachment_id
filename
mime_type
size_bytes
content_id
r2_cache_key
created_at
```

### sync_cursors

```text
account_id
folder_id
cursor_type
cursor_value
uid_validity
highest_modseq
updated_at
```

### contacts

```text
id
user_id
email
name
frequency
last_seen_at
```

### mcp_tokens

```text
id
user_id
token_hash
name
scopes_json
expires_at
last_used_at
revoked_at
created_at
```

### audit_events

记录关键写动作：

- MCP send
- delete
- archive
- OAuth reconnect
- Provider credential change

### search index

使用 D1 / SQLite FTS5 建立：

- subject
- from
- to
- cc
- preview
- cached plain body（可选）

正文全文索引应是可选项，不要求所有历史正文永久复制进 D1。

---

## 8. R2 对象布局

R2 只用于缓存和大对象。

建议：

```text
users/{userId}/accounts/{accountId}/messages/{messageId}/body.html
users/{userId}/accounts/{accountId}/messages/{messageId}/body.txt
users/{userId}/accounts/{accountId}/messages/{messageId}/raw.eml
users/{userId}/accounts/{accountId}/messages/{messageId}/attachments/{attachmentId}
```

缓存策略：

- 邮件正文第一次打开时按需获取
- 小正文可不落 R2
- HTML / raw MIME 可以配置 TTL / LRU 清理
- 附件优先流式透传
- 频繁访问附件再写 R2

目标：避免“邮箱服务器 10GB + MailFlow 再复制 10GB”。

---

## 9. 轻量发信设计

### 9.1 Provider 策略

```text
Gmail      -> Gmail API
Microsoft  -> Microsoft Graph
Generic    -> SMTP
```

### 9.2 V1 支持能力

- New
- Reply
- Reply All
- Forward
- CC
- BCC
- Text Body
- Basic HTML
- 简单签名
- 小附件

### 9.3 不做的内容

- 复杂富文本样式
- 模板市场
- 邮件追踪
- 大附件中转
- 营销批量发送
- 定时发送

### 9.4 MCP 发信安全

`send_email` 必须要求 `mail.send` Scope。

建议 MCP 参数：

```json
{
  "account_id": "...",
  "to": ["..."],
  "cc": [],
  "bcc": [],
  "subject": "...",
  "text": "...",
  "html": null,
  "reply_to_message_id": null
}
```

服务端必须校验：

- account 属于当前 user
- MCP Token 有 `mail.send`
- 单次 recipient 数量限制
- 附件体积限制
- 发送速率限制
- 审计日志

---

## 10. MCP Server 设计

### 10.1 Endpoint

建议：

```text
https://mail.example.com/mcp
```

同时提供：

```text
/.well-known/
/api/v1/
/mcp
```

MCP 与 Web Session 鉴权必须分离。

### 10.2 鉴权

推荐：

- Bearer MCP Token
- D1 只保存 hash
- Token 支持 Scope
- 可吊销
- 可设置失效时间
- 所有写操作 Audit

### 10.3 工具层与业务层分离

MCP Tool 不直接写 D1 / Provider。

统一调用 Application Service：

```text
MCP Tool
   -> MailApplicationService
      -> MailRepository
      -> ProviderAdapter
```

Web API 使用相同 Service，避免 Web 和 MCP 形成两套逻辑。

### 10.4 MCP 返回策略

MCP 搜索默认返回摘要，不一次返回完整正文：

```text
message_id
account
subject
from
date
preview
flags
```

只有 `get_email` 才获取完整正文。

这样减少延迟、Token 使用和 Provider 请求次数。

---

## 11. Web API 建议

```text
GET    /api/v1/accounts
POST   /api/v1/accounts
PATCH  /api/v1/accounts/:id
DELETE /api/v1/accounts/:id
POST   /api/v1/accounts/:id/test
POST   /api/v1/accounts/:id/sync

GET    /api/v1/folders
GET    /api/v1/messages
GET    /api/v1/messages/:id
GET    /api/v1/threads/:id
GET    /api/v1/search

POST   /api/v1/messages/:id/read
POST   /api/v1/messages/:id/star
POST   /api/v1/messages/:id/archive
DELETE /api/v1/messages/:id

POST   /api/v1/send
POST   /api/v1/messages/:id/reply
POST   /api/v1/messages/:id/forward

GET    /api/v1/attachments/:id

GET    /api/v1/mcp/tokens
POST   /api/v1/mcp/tokens
DELETE /api/v1/mcp/tokens/:id
```

---

## 12. 身份认证与安全

### 12.1 Web Auth

V1 推荐优先级：

1. OIDC / OAuth Login
2. MailFlow 本地账号（可保留）
3. TOTP（可后续）

个人部署允许设置：

```text
SINGLE_USER_MODE=true
```

### 12.2 Provider Credential 加密

OAuth refresh token、IMAP password、SMTP password 不能明文保存在 D1。

建议：

- Worker Secret 保存 Master Encryption Key
- Web Crypto AES-GCM 加密 credential blob
- D1 保存 ciphertext + nonce + key version
- 支持未来 rotation

### 12.3 安全边界

必须实现：

- CSRF 防护（Cookie Auth 场景）
- Secure / HttpOnly / SameSite Cookie
- CSP
- HTML 邮件 sanitize
- 外部图片默认可配置关闭
- 防止 remote tracking pixel
- Attachment Content-Type / Content-Disposition
- MCP Token hash 存储
- Rate Limit
- Audit log
- 禁止 Server-side URL 任意抓取导致 SSRF

---

## 13. 前端复用策略

现有 React + Vite 前端尽量保留。

### 13.1 保留

- 登录页面基础 UI
- Sidebar
- 账号列表
- Folder 导航
- Unified Inbox
- Message List
- Message Reader
- Thread UI
- Theme
- i18n
- PWA
- Contacts Autocomplete

### 13.2 简化

Compose：

- 去掉完整 TipTap 高级能力
- 使用 textarea + 基础 HTML toolbar，或极简 TipTap 配置
- 保留附件上传
- 保留 Reply / Forward

Settings：

重点只保留：

- Accounts
- Sync
- Provider Auth
- MCP Tokens
- AI Provider
- Appearance
- Security

### 13.3 删除 / 隐藏

- GTD
- Todoist
- CardDAV
- 高级 Rule UI
- 用户邀请复杂 UI
- 商业 Webmail 功能

---

## 14. 建议代码目录

不在现有 `backend/` 内边改边迁。

新增：

```text
backend-cf/
  src/
    index.ts
    api/
    auth/
    mcp/
    providers/
      gmail/
      microsoft/
      imap/
    services/
    repositories/
    queues/
    cron/
    durable-objects/
    storage/
    security/
    types/
  migrations/
  test/
  wrangler.toml
  package.json
```

现有：

```text
backend/
```

在迁移阶段继续保持可运行。

最终是否删除 Node Backend，在 Cloudflare 版达到 RC 后再决定。

---

## 15. 分阶段实施路线

## WP0 - Baseline / Contract Freeze

目标：冻结现有 Web API 和前端实际依赖。

工作：

- 枚举前端调用的 API
- 识别必须兼容的数据结构
- 建立 contract tests
- 记录当前登录 / account / inbox / read / send 流程

验收：

- Cloudflare Backend 可以按照 Contract 替代旧 API

## WP1 - Cloudflare Skeleton

工作：

- `backend-cf/`
- Worker
- Hono / Router
- Static frontend integration
- `/health`
- environment bindings
- local Wrangler
- CI basic tests

验收：

- 本地 + Preview Worker 可运行

## WP2 - D1 Foundation

工作：

- D1 migrations
- users
- accounts
- folders
- messages
- threads
- attachments
- cursors
- MCP tokens
- audit
- repositories

验收：

- migration from empty database repeatable
- repository tests 全通过

## WP3 - Auth / Credential Security

工作：

- Web session
- OIDC 可选
- credential AES-GCM
- secrets
- MCP token
- scopes
- audit framework

验收：

- D1 中不存在明文 Provider Secret
- MCP scope tests 完整

## WP4 - Gmail Provider

工作：

- OAuth
- list folders / labels
- initial sync
- history incremental sync
- get body
- get attachment
- read/star/archive/delete
- send/reply/forward

验收：

- Gmail 作为第一条完整 E2E Provider 跑通

## WP5 - Microsoft Graph Provider

工作：

- OAuth
- Graph mail folders
- delta sync
- body / attachment
- actions
- send

验收：

- Outlook / Microsoft 365 E2E 跑通

## WP6 - Generic IMAP/SMTP Provider

工作：

- Worker TCP/TLS compatibility spike
- IMAP auth
- folder list
- UID incremental sync
- MIME parsing
- attachment fetch
- mark read / star / archive / delete / move
- SMTP send/reply/forward

验收：

- 至少选两类传统邮箱进行真实联调
- 连接失败 / TLS / timeout / partial sync 均有测试

## WP7 - Queue / Cron / Sync Engine

工作：

- account-sync queue
- continuation jobs
- AccountSyncDO lock
- Cron scheduler
- manual sync
- exponential backoff
- dead-letter strategy
- cursor commit

验收：

- 并发同步同一账号不会重复写坏
- Queue 重试幂等
- Provider 暂时不可用可恢复

## WP8 - Body / Attachment / R2 Cache

工作：

- lazy body fetch
- R2 cache
- attachment streaming
- TTL cleanup
- size limits

验收：

- 大附件不进入 D1
- 不要求完整镜像邮箱

## WP9 - MCP First-Class

工作：

- MCP endpoint
- read tools
- manage tools
- send tools
- scopes
- audit
- pagination
- compact result schema

验收：

- ChatGPT 能搜索、读取、总结、标记、归档和发送邮件
- read-only Token 无法执行写动作

## WP10 - Frontend Cutover

工作：

- frontend API client 切换
- compose 简化
- settings 简化
- MCP Token UI
- sync status UI
- provider reconnect UI

验收：

- 核心 UX 不依赖旧 Node Backend

## WP11 - Free Tier Hardening / RC

工作：

- Cloudflare Free Plan usage audit
- D1 query optimization
- FTS index audit
- Queue batch tuning
- body cache eviction
- provider rate limit
- security review
- staging smoke
- production smoke

验收：

- 个人常规使用下不依赖付费 Cloudflare 资源
- 所有关键限额均有监控或保护

---

## 16. 测试策略

### Unit

重点覆盖：

- Provider normalizer
- cursor parser
- crypto
- MCP scopes
- MIME parser
- search query builder
- thread grouping

### Integration

- D1 repository
- Queue consumer
- R2 cache
- DO lock
- Gmail Adapter mock
- Graph Adapter mock
- IMAP Adapter mock

### Contract

保证前端在迁移期间可以同时接：

- existing backend
- backend-cf

### E2E

至少覆盖：

1. 登录
2. 添加 Gmail
3. Gmail 初次同步
4. Gmail 增量同步
5. 添加 Microsoft
6. 添加标准 IMAP
7. Unified Inbox
8. Search
9. Open body
10. Download attachment
11. Mark read
12. Star
13. Archive
14. Send
15. Reply
16. MCP search
17. MCP get
18. MCP archive
19. MCP send
20. Token scope denial

### Fault Injection

必须模拟：

- Provider timeout
- OAuth token expired
- OAuth refresh failed
- IMAP disconnect
- SMTP failure
- Queue duplicate delivery
- Queue retry
- D1 transaction failure
- R2 miss
- malformed MIME
- oversized attachment

---

## 17. 0 费用设计约束

本项目“0 费用”的定义：

> 个人 / 小规模邮箱使用，在正常邮件量下，不需要 VPS，不需要数据库服务器，不需要 Redis，不需要付费 Cloudflare 服务，即可长期运行。

必须建立 Guardrail：

- D1 不存大量正文和附件
- R2 缓存可清理
- Queue 按 batch 工作
- Cron 只做 scheduler，不做同步本体
- 搜索结果分页
- MCP 默认返回 metadata / preview
- 正文按需读取
- 附件流式传输
- 不默认全量同步多年历史
- 可设置每账号历史窗口
- Worker CPU-heavy MIME 操作拆分或优化
- 免费额度具体数值不写死在业务逻辑，Release 时重新核验 Cloudflare 官方限制

---

## 18. 可观测性

V1 至少需要：

- account sync status
- last success
- last error
- messages synced
- cursor
- queue retry count
- provider latency
- provider error category
- MCP tool audit
- send audit

前端 Settings 增加简单 Diagnostics：

```text
Account
Provider
Last Sync
Sync Status
Last Error
Indexed Messages
Cached Bodies
```

---

## 19. 关键风险与应对

### 风险 1：标准 IMAP / SMTP 在 Worker Runtime 的兼容性

应对：

- WP6 前先做 Compatibility Spike
- 不直接假设现有 `imapflow` / `nodemailer` 可原样运行
- 必要时实现更轻量的 Worker-compatible IMAP / SMTP adapter
- Gmail / Microsoft 优先走 HTTP API，降低 TCP 依赖比例

### 风险 2：Worker 不适合长期 IMAP IDLE

应对：

- 不把 IDLE 作为 V1 基础
- 增量轮询 + Provider API delta/history
- 手工 sync
- Cron + Queue

### 风险 3：D1 体积和读写压力

应对：

- D1 只存 metadata/index
- body / MIME / attachment 不直接塞 D1
- 定期清理 body cache index
- indexes 有明确用途，避免无效索引

### 风险 4：邮件 HTML 安全

应对：

- sanitize
- iframe sandbox 或隔离 renderer
- 外链图片隐私开关
- 禁止 script
- 阻止危险 URL scheme

### 风险 5：MCP 发送邮件风险

应对：

- read / manage / send Scope 分离
- 默认 read-only
- send rate limit
- audit log
- UI 可随时 revoke token

---

## 20. Definition of Done

Cloudflare Lite V1 只有满足以下条件才算完成：

### Infrastructure

- [ ] 无 VPS
- [ ] 无 Docker Runtime
- [ ] 无 PostgreSQL
- [ ] 无 Redis
- [ ] Cloudflare 一键部署
- [ ] D1 migrations 可从 0 重建

### Receive

- [ ] Gmail
- [ ] Microsoft
- [ ] Generic IMAP
- [ ] Unified Inbox
- [ ] Folder
- [ ] Thread
- [ ] Search
- [ ] Read / unread
- [ ] Star
- [ ] Archive
- [ ] Delete
- [ ] Attachment

### Send

- [ ] New Mail
- [ ] Reply
- [ ] Reply All
- [ ] Forward
- [ ] CC / BCC
- [ ] Basic HTML / Text
- [ ] Small Attachment

### MCP

- [ ] Search
- [ ] Read
- [ ] Thread
- [ ] Summarize
- [ ] Mark read
- [ ] Star
- [ ] Archive
- [ ] Send
- [ ] Scopes
- [ ] Token revoke
- [ ] Audit

### Reliability

- [ ] Incremental sync
- [ ] Idempotent Queue
- [ ] Cursor recovery
- [ ] Provider reconnect
- [ ] OAuth refresh
- [ ] Duplicate delivery safe
- [ ] Free Tier guardrails

### Security

- [ ] Credential encryption
- [ ] MCP token hash
- [ ] HTML sanitize
- [ ] Rate limit
- [ ] Audit log
- [ ] No plaintext secrets in repository / D1

---

## 21. Codex / 开发执行规则

后续让 Codex 实施时遵守：

1. **一次只完成一个 WP。**
2. 每个 WP 先读本方案和现有代码，再修改。
3. 不允许为了 Cloudflare 版破坏 `main` 上现有 Node Backend。
4. 新代码优先放在 `backend-cf/`。
5. 每个 Provider 必须通过统一 Adapter 接口。
6. MCP 不得绕过 Application Service 直接操作 Provider / DB。
7. 所有 Queue handler 必须幂等。
8. 所有 Credential 必须加密后落库。
9. 不允许把附件 / raw MIME 大对象直接写 D1。
10. 所有核心模块必须配测试。
11. 每个 WP 完成后输出 Acceptance Report：
    - 改动文件
    - 架构决策
    - 测试结果
    - 已知问题
    - Cloudflare 兼容性
    - 下一 WP 前置条件
12. 在 RC 前必须真实完成 Gmail + Microsoft + 至少两类标准 IMAP/SMTP 邮箱联调。
13. 不得用“理论可行”代替真实 smoke test。
14. Release 前重新核验 Cloudflare Free Plan 最新限额。

---

## 22. 最终目标形态

```text
MailFlow CF Lite

收件
├── Unified Inbox
├── Gmail
├── Microsoft
├── IMAP
├── Folder
├── Search
├── Thread
├── Attachment
├── Read / Star / Archive / Delete
└── Incremental Sync

MCP
├── Search
├── Read
├── Summarize
├── Manage
├── Send
├── Scopes
└── Audit

轻量发信
├── New
├── Reply
├── Reply All
├── Forward
├── CC / BCC
├── Text / Basic HTML
└── Small Attachment

Cloudflare
├── Workers
├── D1
├── R2
├── Queues
├── Cron
├── Durable Objects (limited)
└── Workers AI / External AI optional
```

产品判断标准不是“是否完整替代 Gmail 网页版”，而是：

> **是否可以在一个轻量 B/S 界面和 MCP 中，高效管理所有邮箱，并以接近零运维、零基础设施成本长期运行。**

这就是 Cloudflare Lite 重构的核心边界。