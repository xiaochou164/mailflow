# D1 数据模型、Provider 与同步状态机

## 1. 数据职责

### D1

保存：用户、账号元数据、加密凭证、文件夹、邮件索引、Thread、同步 cursor、MCP Token 元数据、审计、导入批次、发送记录。

不保存：大正文、raw MIME、大附件、导入明文 Secret。

### R2

保存可删除缓存：

- body text/html
- raw MIME（可选）
- attachment cache
- 临时导出对象（必须短 TTL；更推荐直接流式返回）

### Provider

永远是邮件事实源。

## 2. ID 规范

内部主键统一使用 opaque string，例如 UUIDv7/ULID；Provider ID 单独保存。

禁止把 Gmail message id、IMAP UID 当内部主键。

## 3. 建议 D1 Schema

以下是逻辑 Schema，实施时用 D1 migration 固化。

### users

```sql
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  display_name TEXT,
  role TEXT NOT NULL DEFAULT 'user',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

### accounts

```sql
CREATE TABLE accounts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  email_address TEXT NOT NULL,
  provider_kind TEXT NOT NULL,
  color TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'credential_required',
  signature TEXT,
  sync_enabled INTEGER NOT NULL DEFAULT 1,
  sync_interval_minutes INTEGER,
  history_days TEXT,
  folder_policy TEXT,
  last_sync_at TEXT,
  last_success_at TEXT,
  last_error_code TEXT,
  last_error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
```

状态 enum：

```text
ready
credential_required
reauth_required
verifying
connection_failed
disabled
```

### account_endpoints

```sql
CREATE TABLE account_endpoints (
  account_id TEXT PRIMARY KEY,
  incoming_host TEXT,
  incoming_port INTEGER,
  incoming_security TEXT,
  incoming_username TEXT,
  outgoing_host TEXT,
  outgoing_port INTEGER,
  outgoing_security TEXT,
  outgoing_username TEXT,
  skip_tls_verify INTEGER NOT NULL DEFAULT 0,
  allow_private_host INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
);
```

### account_credentials

```sql
CREATE TABLE account_credentials (
  account_id TEXT PRIMARY KEY,
  auth_type TEXT NOT NULL,
  provider TEXT,
  ciphertext BLOB NOT NULL,
  iv BLOB NOT NULL,
  key_version INTEGER NOT NULL,
  credential_version INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
);
```

只允许 CredentialVault Repository 访问该表。

### account_aliases

```sql
CREATE TABLE account_aliases (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  reply_to TEXT,
  signature TEXT,
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
);
```

### folders

```sql
CREATE TABLE folders (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  provider_folder_id TEXT NOT NULL,
  path TEXT,
  name TEXT NOT NULL,
  role TEXT,
  parent_id TEXT,
  delimiter TEXT,
  sync_enabled INTEGER NOT NULL DEFAULT 1,
  total_count INTEGER,
  unread_count INTEGER,
  provider_version TEXT,
  updated_at TEXT NOT NULL,
  UNIQUE(account_id, provider_folder_id),
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
);
```

### threads

```sql
CREATE TABLE threads (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  provider_thread_id TEXT,
  normalized_subject TEXT,
  latest_at TEXT,
  message_count INTEGER NOT NULL DEFAULT 0,
  participants_json TEXT NOT NULL DEFAULT '[]',
  updated_at TEXT NOT NULL,
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
);
```

跨账号统一 Thread V1 不强制；同一 account 内优先 Provider thread，否则 RFC header/subject heuristic。

### messages

```sql
CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  thread_id TEXT,
  provider_message_id TEXT NOT NULL,
  provider_uid TEXT,
  internet_message_id TEXT,
  in_reply_to TEXT,
  references_json TEXT,
  subject TEXT,
  from_json TEXT NOT NULL,
  to_json TEXT NOT NULL,
  cc_json TEXT NOT NULL DEFAULT '[]',
  bcc_json TEXT NOT NULL DEFAULT '[]',
  sent_at TEXT,
  received_at TEXT,
  preview TEXT,
  is_read INTEGER NOT NULL DEFAULT 0,
  is_starred INTEGER NOT NULL DEFAULT 0,
  is_deleted INTEGER NOT NULL DEFAULT 0,
  has_attachments INTEGER NOT NULL DEFAULT 0,
  size_bytes INTEGER,
  provider_version TEXT,
  body_cache_key TEXT,
  raw_cache_key TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(account_id, provider_message_id),
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
);
```

### message_folders

Gmail label、多文件夹语义不能只在 messages 里放一个 folder_id，因此建议关系表：

```sql
CREATE TABLE message_folders (
  message_id TEXT NOT NULL,
  folder_id TEXT NOT NULL,
  PRIMARY KEY(message_id, folder_id)
);
```

Generic IMAP 一封邮件在多个 Folder 的情况可按 Provider identity 处理；若本质为复制，则 provider_message_id/uid 不同。

### attachments

```sql
CREATE TABLE attachments (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL,
  provider_attachment_id TEXT,
  filename TEXT,
  mime_type TEXT,
  size_bytes INTEGER,
  content_id TEXT,
  disposition TEXT,
  r2_cache_key TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE
);
```

### sync_cursors

```sql
CREATE TABLE sync_cursors (
  account_id TEXT NOT NULL,
  folder_id TEXT NOT NULL DEFAULT '',
  cursor_type TEXT NOT NULL,
  cursor_value TEXT,
  uid_validity TEXT,
  uid_next TEXT,
  highest_modseq TEXT,
  generation INTEGER NOT NULL DEFAULT 0,
  last_success_at TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(account_id, folder_id, cursor_type)
);
```

### sync_runs

```sql
CREATE TABLE sync_runs (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  generation INTEGER NOT NULL,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  messages_seen INTEGER NOT NULL DEFAULT 0,
  messages_changed INTEGER NOT NULL DEFAULT 0,
  error_code TEXT
);
```

### mcp_tokens

```sql
CREATE TABLE mcp_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  scopes_json TEXT NOT NULL,
  account_allowlist_json TEXT,
  expires_at TEXT,
  last_used_at TEXT,
  revoked_at TEXT,
  created_at TEXT NOT NULL
);
```

### audit_events

```sql
CREATE TABLE audit_events (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  actor_type TEXT NOT NULL,
  actor_id TEXT,
  action TEXT NOT NULL,
  target_type TEXT,
  target_id TEXT,
  result TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
```

`metadata_json` 禁止 Secret。

### send_operations

```sql
CREATE TABLE send_operations (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  client_operation_id TEXT NOT NULL,
  provider_message_id TEXT,
  status TEXT NOT NULL,
  recipients_count INTEGER NOT NULL,
  subject_hash TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(account_id, client_operation_id)
);
```

## 4. Index 设计

至少：

```text
accounts(user_id, enabled)
messages(account_id, received_at DESC)
messages(account_id, is_read, received_at DESC)
messages(thread_id, received_at)
message_folders(folder_id, message_id)
folders(account_id, role)
sync_runs(account_id, started_at DESC)
audit_events(user_id, created_at DESC)
```

FTS 建议独立虚表：subject/from/to/preview/可选 body_plain_excerpt。

## 5. R2 Key

```text
v1/users/{userId}/accounts/{accountId}/messages/{messageId}/body/text
v1/users/{userId}/accounts/{accountId}/messages/{messageId}/body/html
v1/users/{userId}/accounts/{accountId}/messages/{messageId}/raw
v1/users/{userId}/accounts/{accountId}/messages/{messageId}/attachments/{attachmentId}
```

内部 ID 不包含原始邮箱地址，减少对象 key 泄漏 PII。

## 6. Provider Port

```ts
interface MailProvider {
  kind: 'gmail' | 'microsoft' | 'imap-smtp';
  capabilities(): ProviderCapabilities;
  verify(): Promise<VerifyResult>;
  listFolders(): Promise<ProviderFolder[]>;
  initialSync(input: InitialSyncInput): Promise<SyncPage>;
  incrementalSync(input: IncrementalSyncInput): Promise<SyncPage>;
  getMessage(input: ProviderMessageRef): Promise<ProviderMessageBody>;
  getAttachment(input: ProviderAttachmentRef): Promise<ReadableStream>;
  setRead(ref: ProviderMessageRef, read: boolean): Promise<void>;
  setStarred(ref: ProviderMessageRef, starred: boolean): Promise<void>;
  archive(ref: ProviderMessageRef): Promise<void>;
  delete(ref: ProviderMessageRef): Promise<void>;
  move?(ref: ProviderMessageRef, folder: ProviderFolderRef): Promise<void>;
  send(input: ProviderSendInput): Promise<ProviderSendResult>;
}
```

Provider 返回自己的 cursor/version，Application Service 决定何时 commit。

## 7. Normalized Message

```ts
interface NormalizedMessage {
  providerMessageId: string;
  providerThreadId?: string;
  internetMessageId?: string;
  folderRefs: string[];
  subject?: string;
  from: Address[];
  to: Address[];
  cc: Address[];
  bcc: Address[];
  sentAt?: string;
  receivedAt?: string;
  preview?: string;
  isRead: boolean;
  isStarred: boolean;
  hasAttachments: boolean;
  sizeBytes?: number;
  providerVersion?: string;
  attachments?: NormalizedAttachmentMeta[];
}
```

同步阶段尽量只处理 metadata；正文 lazy fetch。

## 8. 同步状态机

账号级：

```text
IDLE
  -> SCHEDULED
  -> LOCKING
  -> SYNCING
       -> CONTINUATION -> SYNCING
       -> VERIFYING(optional)
  -> SUCCESS
  -> IDLE

任何阶段 -> RETRYABLE_ERROR -> SCHEDULED
任何阶段 -> AUTH_ERROR -> REAUTH_REQUIRED
任何阶段 -> TERMINAL_CONFIG_ERROR -> CONNECTION_FAILED
```

## 9. Cursor Commit Rule

最关键原则：**先持久化本批 message changes，再推进 cursor。**

禁止：先写新 cursor，后写 messages。

单批建议：

1. 获取当前 generation/cursor；
2. Provider fetch page；
3. normalize；
4. D1 transaction upsert folder/messages/flags；
5. 同 transaction/紧随其后更新 cursor；
6. enqueue continuation。

若运行时限制不能放在同一事务，必须使用 pending cursor/checkpoint 机制保证 crash 后重复处理而不是漏邮件。

## 10. Generation

每个账号有 sync generation。

以下情况递增 generation：

- OAuth reconnect；
- IMAP UIDVALIDITY 变化；
- 用户发起 reset/resync；
- Provider cursor invalidation；
- endpoint 变化。

旧 generation 的 continuation job 收到后直接丢弃。

## 11. Gmail Cursor

- 保存 historyId；
- history 失效：创建新 generation，执行 bounded reconciliation；
- 不默认删除全部 messages；
- 通过最近窗口+provider ids 修复，再建立新 cursor。

## 12. Graph Cursor

- 保存 deltaLink/nextLink；
- nextLink 仅作为当前 page continuation；
- 完成一个 delta cycle 后才保存稳定 deltaLink；
- invalid delta 进入新 generation reconciliation。

## 13. IMAP Cursor

按 folder 保存：

- UIDVALIDITY
- UIDNEXT
- HIGHESTMODSEQ（可用时）

若 UIDVALIDITY 变化：

- 不再信任旧 UID 映射；
- 新 generation；
- 对该 folder bounded rebuild；
- 可使用 Message-ID/date/size 辅助去重，但不得把启发式去重当强一致主键。

## 14. 删除检测

不同 Provider 删除语义不同。

- Gmail/Graph：增量事件/delta；
- IMAP MODSEQ/QRESYNC 可用时使用；
- 不可用时周期性 reconciliation。

索引里允许 tombstone，延迟清理，避免瞬时失联误删本地索引。

## 15. Thread

优先级：

1. provider native thread/conversation；
2. `Message-ID` / `In-Reply-To` / `References`；
3. normalized subject + participant + time heuristic（仅最后兜底）。

Thread 重算必须可重复且不能改变 provider message identity。

## 16. Flag 冲突

read/star 等状态可能由其他客户端更改。

Provider 同步是最终校正来源。Web 操作成功后立即改 D1；下一轮增量以 Provider 返回状态修正。

## 17. 搜索索引更新

metadata upsert 同步维护 FTS；正文首次拉取后可异步把 plain-text 摘要写入可选 body FTS 字段。

正文缓存删除不要求删除已经允许保留的文本搜索摘要，但需提供隐私设置关闭正文索引。

## 18. 账号删除

删除账号流程：

1. disable sync；
2. bump generation；
3. revoke/clear credentials；
4. 删除 D1 child rows；
5. enqueue R2 prefix cleanup；
6. audit。

R2 清理失败不能阻塞账号删除完成，但要可重试。

## 19. 数据迁移

所有 D1 migration：

- append-only 文件编号；
- staging 先验证；
- 不允许运行时随意 `ALTER`；
- destructive migration 必须有备份/导出方案；
- schema version 可观测。

## 20. 恢复原则

D1 丢失但账号 Safe/Encrypted Bundle 可用时：

- 重建用户/账号；
- 重新授权 OAuth（若需要）；
- 从 Provider 重建 folders/messages/cursor；
- R2 只是 cache，不作为恢复前置。

因此真正需要保护的是：部署配置、账号配置和 credential；邮件本体由 Provider 保有。
