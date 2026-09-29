# Web API 与 MCP 契约

## 1. 通用约定

Base path：`/api/v1`

响应：JSON；附件/导出可流式二进制。

时间：RFC3339 UTC。

内部 ID：opaque string。

分页：cursor-based，不使用大 offset。

```json
{
  "data": [],
  "page": {
    "nextCursor": "...",
    "hasMore": true
  }
}
```

错误统一：

```json
{
  "error": {
    "code": "ACCOUNT_REAUTH_REQUIRED",
    "message": "Account authorization must be refreshed",
    "requestId": "req_xxx",
    "details": {}
  }
}
```

`details` 不得包含 Secret、Provider 原始 token 或完整内部异常栈。

## 2. 认证

Web API：session cookie / OIDC session。

MCP：独立 Bearer token。

不得用 MCP token 登录 Web UI；不得把 Web session 自动当 MCP credential。

## 3. Accounts

```text
GET    /accounts
POST   /accounts
GET    /accounts/:id
PATCH  /accounts/:id
DELETE /accounts/:id
POST   /accounts/:id/verify
POST   /accounts/:id/sync
POST   /accounts/:id/reconnect
GET    /accounts/:id/diagnostics
```

`GET /accounts` 响应不得返回 encrypted credential blob。

Account DTO：

```json
{
  "id": "acc_x",
  "name": "Work",
  "email": "user@example.com",
  "providerKind": "imap-smtp",
  "enabled": true,
  "status": "ready",
  "lastSyncAt": "...",
  "lastSuccessAt": "...",
  "lastError": null,
  "sync": {
    "enabled": true,
    "intervalMinutes": 60,
    "historyDays": 30
  }
}
```

## 4. OAuth

```text
POST /oauth/google/start
GET  /oauth/google/callback
POST /oauth/microsoft/start
GET  /oauth/microsoft/callback
```

OAuth state 与 callback account intent 绑定；state 单次使用并过期。

## 5. Folders

```text
GET /folders?accountId=
POST /accounts/:id/folders/refresh
```

Normalized folder role：

```text
inbox
sent
draft
archive
trash
spam
custom
```

## 6. Messages

```text
GET  /messages
GET  /messages/:id
POST /messages/:id/read
POST /messages/:id/star
POST /messages/:id/archive
POST /messages/:id/move
DELETE /messages/:id
```

列表 filters：

```text
accountId
folderId
threadId
unread
starred
before/after
cursor
limit
```

默认 limit 建议 50，最大值必须服务端限制。

Message List DTO 只返回 metadata/preview。

Message Detail DTO：

```json
{
  "id": "msg_x",
  "accountId": "acc_x",
  "threadId": "thr_x",
  "subject": "...",
  "from": [],
  "to": [],
  "cc": [],
  "sentAt": "...",
  "receivedAt": "...",
  "flags": { "read": true, "starred": false },
  "body": {
    "status": "ready",
    "text": "...",
    "html": "..."
  },
  "attachments": []
}
```

HTML 必须是服务端/隔离 renderer 可安全呈现的 sanitized content。

## 7. Threads

```text
GET /threads/:id
```

Thread DTO 返回按时间排序的 message summaries；可参数 `includeBodies=false`，默认 false。

## 8. Search

```text
GET /search?q=&accountId=&folderId=&from=&after=&before=&cursor=&limit=
```

V1 查询语言不做 Gmail 复杂语法；先实现结构化参数 + 普通文本。

深度 Provider Search：

```text
POST /search/provider
```

仅在用户显式调用时启用，不作为 unified inbox 正常路径。

## 9. Attachment

```text
GET /attachments/:id
```

必须：

- ownership check；
- safe content disposition；
- size/header limits；
- stream；
- 不把 arbitrary provider URL 暴露给浏览器。

## 10. Send

```text
POST /send
POST /messages/:id/reply
POST /messages/:id/reply-all
POST /messages/:id/forward
```

请求：

```json
{
  "clientOperationId": "uuid-from-client",
  "accountId": "acc_x",
  "to": [{"email":"a@example.com","name":"A"}],
  "cc": [],
  "bcc": [],
  "subject": "Hello",
  "text": "...",
  "html": null,
  "attachments": []
}
```

结果：

```json
{
  "operationId": "send_x",
  "status": "sent",
  "providerMessageId": "..."
}
```

状态：`accepted|sent|failed|unknown`。

`unknown` 不允许自动重新发送，避免重复邮件。

## 11. Contacts

```text
GET /contacts/suggest?q=
```

数据来自本地 contacts/历史参与人，不把整个地址簿作为 V1 前置。

## 12. Import / Export

```text
POST /account-import/dry-run
POST /account-import/:id/commit
GET  /account-import/:id
POST /account-import/:id/retry-failed
POST /account-export/manifest
POST /account-export/encrypted-bundle
```

具体见 `ACCOUNT_IMPORT_EXPORT.md`。

## 13. Sync / Diagnostics

```text
GET /sync/runs?accountId=
GET /system/health
GET /system/usage
```

Health 不泄漏绑定名/Secret，只给依赖健康状态。

## 14. MCP Endpoint

推荐：`POST /mcp`

按所选 MCP transport 实现协议，不把 REST JSON 直接伪装成 MCP。

MCP 工具调用最终进入与 Web 相同的 Application Service。

## 15. MCP Scope

```text
mail.read
mail.manage
mail.send
mail.ai
```

权限：

| Tool | Scope |
|---|---|
| list_accounts | mail.read |
| list_folders | mail.read |
| list_recent_emails | mail.read |
| search_emails | mail.read |
| get_email | mail.read |
| get_thread | mail.read |
| list_important_emails | mail.read |
| mark_read/unread | mail.manage |
| star/unstar | mail.manage |
| archive/delete | mail.manage |
| send/reply/forward | mail.send |
| summarize_* | mail.ai + mail.read |
| list_actionable_emails | mail.ai + mail.read |

Token 还可带 account allowlist。

## 16. MCP Tool Schemas

### list_accounts

Input：空或 `{ includeDisabled?: boolean }`

Output：只返回 id/name/email/provider/status，不返回 endpoint secret。

### list_recent_emails

```json
{
  "account_ids": ["acc_x"],
  "folder": "inbox",
  "limit": 20,
  "after": "2026-09-29T00:00:00Z",
  "unread_only": false
}
```

### search_emails

```json
{
  "query": "supplier delivery",
  "account_ids": [],
  "from": null,
  "after": null,
  "before": null,
  "limit": 20,
  "cursor": null
}
```

输出 compact list；不默认带正文。

### get_email

```json
{
  "message_id": "msg_x",
  "include_html": false,
  "include_attachment_metadata": true
}
```

### get_thread

```json
{
  "thread_id": "thr_x",
  "include_bodies": false
}
```

### mark_read

```json
{ "message_id": "msg_x", "read": true }
```

### archive_email

```json
{ "message_id": "msg_x" }
```

### send_email

```json
{
  "client_operation_id": "uuid",
  "account_id": "acc_x",
  "to": ["a@example.com"],
  "cc": [],
  "bcc": [],
  "subject": "...",
  "text": "..."
}
```

V1 MCP `send_email` 默认不接受任意 URL 附件。附件应来自用户明确上传或已有 MailFlow attachment reference。

### reply_email

```json
{
  "client_operation_id": "uuid",
  "message_id": "msg_x",
  "reply_all": false,
  "text": "..."
}
```

### forward_email

```json
{
  "client_operation_id": "uuid",
  "message_id": "msg_x",
  "to": ["a@example.com"],
  "text": "optional comment"
}
```

## 17. MCP 安全默认值

创建 Token 默认：

```text
Scopes: mail.read
Accounts: all current accounts or explicit selected accounts
Expiry: user chooses; UI 推荐有限有效期
```

`mail.send` 必须显式勾选。

删除邮件属于高影响管理动作；可增加 Token 级 `allow_delete=false` 细粒度 guard，即使拥有 `mail.manage` 也可禁用 delete。

## 18. MCP 返回最小化

搜索/列表：不带完整 body。

邮箱地址按功能需要返回，不做无意义遮罩；但日志、遥测不得收集完整正文。

大 Thread：分页/摘要，不一次塞全部 HTML。

## 19. MCP 审计

写操作记录：

```text
actor_type=mcp_token
actor_id=token id
action=mail.archive/mail.send/...
target_id
result
request_id
```

不记录邮件完整正文；发送审计可记录 recipient count、target domain summary 等最小必要信息。

## 20. Rate Limits

分别限：

- login/auth；
- account verify；
- manual sync；
- body/attachment fetch；
- MCP tool calls；
- send。

不要用一个全局 limit 影响所有能力。

## 21. Idempotency

以下写接口接受 `Idempotency-Key` 或 body `clientOperationId`：

- send/reply/forward；
- import commit；
- 部分 manage actions可选。

同 key + 同 payload 返回已有结果；同 key + 不同 payload 返回 `IDEMPOTENCY_CONFLICT`。

## 22. 错误码分类

```text
AUTH_*                Web 登录
MCP_*                 Token/scope
ACCOUNT_*             账号配置/连接
PROVIDER_*            上游 Provider
SYNC_*                同步
MESSAGE_*             邮件操作
SEND_*                发信
IMPORT_*              导入
ATTACHMENT_*          附件
RATE_LIMITED
IDEMPOTENCY_CONFLICT
INTERNAL_ERROR
```

Provider 原始错误映射为稳定内部 code；原始文本只进入受控 debug log，且先 redact。

## 23. 版本演进

V1 路由 `/api/v1`。

字段新增向后兼容；字段改名/删除进入新版本。

MCP Tool 参数变化优先做 optional extension，破坏性变化需新 tool/version，避免突然破坏已连接客户端。
