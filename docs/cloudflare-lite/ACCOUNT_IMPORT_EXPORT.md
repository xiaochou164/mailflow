# 账号配置导入 / 导出工程规范

> 本文定义 MailFlow CF Lite 的账号迁移协议、导入状态机、安全边界和 Legacy MailFlow 兼容策略。

## 1. 设计目标

账号导入必须满足以下目标：

- 一次导入多个邮箱账号；
- 支持 Gmail、Microsoft、Generic IMAP/SMTP；
- 支持不含秘密的安全配置迁移；
- 支持用户主动选择的加密凭证迁移；
- 支持 CSV 批量导入传统邮箱；
- 支持从当前 MailFlow `email_accounts` 结构迁移；
- 导入前可预览、校验、测试连接、处理冲突；
- 单账号失败不能导致整个批次半提交；
- 同一导入文件重复执行必须可预测；
- OAuth 账号默认允许“只迁元数据、重新授权”；
- 所有导入/导出都有审计事件，但审计中不得记录秘密。

## 2. 支持的四种输入

### 2.1 Safe Manifest（默认）

扩展名建议：`.mailflow.json`

用途：备份服务器地址、Provider 类型、同步策略、签名、别名、文件夹映射等，不包含密码、refresh token、access token。

这是 UI 默认的 Export 方式，也应该是用户分享配置时唯一推荐格式。

### 2.2 Encrypted Bundle

扩展名建议：`.mfb`

用途：用户明确要求跨部署迁移账号秘密时使用。

特点：

- 文件整体加密；
- 解密口令不上传、不写日志；
- 浏览器端优先完成 KDF 和解密；
- Worker 只接收已解密后的结构化对象并立即使用服务端 Master Key 二次加密后落库；
- 导入结束后浏览器和 Worker 不保留明文秘密。

### 2.3 IMAP/SMTP CSV

扩展名：`.csv`

用途：批量导入 QQ、163、企业邮箱、自建邮箱等传统账号。

CSV 可以携带密码，但 UI 必须明确提示：CSV 是明文文件，不推荐长期保存；导入后应立即删除原文件。默认模板允许 `password` 留空，留空则账号进入 `CREDENTIAL_REQUIRED`。

### 2.4 Legacy MailFlow Migration

用途：从现有 MailFlow Node/PostgreSQL 迁入 Cloudflare Lite。

当前旧表 `email_accounts` 中存在：

- `name`
- `email_address`
- `color`
- `protocol`
- `imap_host/imap_port/imap_tls`
- `smtp_host/smtp_port/smtp_tls`
- `auth_user/auth_pass`
- `oauth_provider`
- `oauth_access_token/oauth_refresh_token/oauth_token_expiry`
- `enabled`
- `sort_order`
- `folder_mappings`
- `imap_skip_tls_verify`
- `signature`

迁移器必须显式映射这些字段，不允许依赖 SQL 列顺序。

## 3. Canonical Account Configuration Model

所有导入器先转换成同一个 Canonical Model，再进入校验和提交阶段。

```ts
export interface CanonicalAccountConfig {
  schemaVersion: 1;
  sourceId?: string;
  name: string;
  email: string;
  color?: string;
  enabled: boolean;
  sortOrder?: number;

  provider: {
    kind: 'gmail' | 'microsoft' | 'imap-smtp';
  };

  auth: OAuthAuthConfig | PasswordAuthConfig | MissingAuthConfig;

  incoming?: {
    host: string;
    port: number;
    security: 'tls' | 'starttls' | 'plain';
    username: string;
    skipTlsVerify?: boolean;
    allowPrivateHost?: boolean;
  };

  outgoing?: {
    host: string;
    port: number;
    security: 'tls' | 'starttls' | 'plain';
    username: string;
    skipTlsVerify?: boolean;
  };

  sync: {
    enabled: boolean;
    intervalMinutes?: number;
    historyDays?: number | 'all-headers';
    folderPolicy?: 'inbox-sent' | 'all' | 'custom';
    folders?: string[];
  };

  folderMappings?: Record<string, string>;
  signature?: string;
  aliases?: Array<{
    name: string;
    email: string;
    replyTo?: string;
    signature?: string;
  }>;

  metadata?: {
    importedAt?: string;
    importedFrom?: string;
    legacyAccountId?: string;
  };
}
```

### 3.1 Auth Model

```ts
type OAuthAuthConfig = {
  type: 'oauth';
  provider: 'google' | 'microsoft';
  refreshToken?: SecretValue;
  accessToken?: SecretValue;
  tokenExpiry?: string;
  clientProfileFingerprint?: string;
};

type PasswordAuthConfig = {
  type: 'password';
  password?: SecretValue;
};

type MissingAuthConfig = {
  type: 'missing';
};
```

`SecretValue` 只存在于内存 DTO，不能成为 D1 Repository 的公共类型。

## 4. Safe Manifest v1

建议顶层格式：

```json
{
  "format": "mailflow-account-manifest",
  "version": 1,
  "exportedAt": "2026-09-29T10:00:00Z",
  "accounts": [
    {
      "name": "Work",
      "email": "user@example.com",
      "enabled": true,
      "provider": { "kind": "imap-smtp" },
      "auth": { "type": "missing" },
      "incoming": {
        "host": "imap.example.com",
        "port": 993,
        "security": "tls",
        "username": "user@example.com"
      },
      "outgoing": {
        "host": "smtp.example.com",
        "port": 587,
        "security": "starttls",
        "username": "user@example.com"
      },
      "sync": {
        "enabled": true,
        "historyDays": 30,
        "folderPolicy": "inbox-sent"
      }
    }
  ]
}
```

Safe Manifest 必须满足：

- 导出前删除 password/access token/refresh token；
- 不输出 MCP Token；
- 不输出 Worker Secret；
- 不输出 session/cookie；
- 导入后缺少秘密的账号进入 `CREDENTIAL_REQUIRED` 或 `REAUTH_REQUIRED`；
- 用户可在一次导入流程中补密码或发起 OAuth。

## 5. Encrypted Bundle v1

建议 Envelope：

```json
{
  "format": "mailflow-encrypted-account-bundle",
  "version": 1,
  "crypto": {
    "cipher": "AES-256-GCM",
    "kdf": "PBKDF2-HMAC-SHA256",
    "salt": "base64url",
    "iterations": 600000,
    "iv": "base64url"
  },
  "payload": "base64url-ciphertext"
}
```

工程要求：

- `iterations` 属于文件参数但服务端必须有最低接受阈值和最高防 DoS 阈值；
- 导出时每个 Bundle 使用随机 salt/iv；
- 导出密码不能复用 MailFlow 登录密码；
- 解密失败统一返回 `IMPORT_BUNDLE_DECRYPT_FAILED`，不区分密码错误还是密文损坏；
- 解密完成后仍必须执行完整 Schema Validation；
- 文件中禁止携带服务端 Master Key；
- 明文 payload 与 Safe Manifest 结构一致，但允许 Secret 字段存在；
- Bundle 解密和解析可优先在浏览器 Worker/Web Worker 中完成，减少秘密经网络流转。

### 5.1 OAuth 可移植性规则

OAuth refresh token 不是绝对可移植。

导入逻辑：

1. 读取 `clientProfileFingerprint`；
2. 与当前部署 Provider OAuth Client 配置指纹比对；
3. 一致：允许尝试 refresh；
4. 不一致或缺失：不得盲目复用 token，账号标记 `REAUTH_REQUIRED`；
5. 用户重新授权后替换旧 Secret。

Gmail/Microsoft 的默认迁移策略应是：**配置可迁移，OAuth 重新授权优先**。

## 6. CSV v1

建议表头：

```csv
name,email,provider,imap_host,imap_port,imap_security,smtp_host,smtp_port,smtp_security,username,password,enabled,history_days,signature
```

示例：

```csv
Work,user@example.com,imap-smtp,imap.example.com,993,tls,smtp.example.com,587,starttls,user@example.com,,true,30,
```

规则：

- UTF-8；
- 首行为 header；
- email/host trim；
- port 必须为整数；
- `password` 可空；
- provider 仅允许白名单；
- CSV 不支持 OAuth token 导入；
- CSV 中 `skipTlsVerify`、`allowPrivateHost` 这类危险项默认不可配置，必须在导入后 UI 中单独开启。

## 7. Legacy MailFlow 映射

### 7.1 字段映射

| Legacy `email_accounts` | Canonical |
|---|---|
| `name` | `name` |
| `email_address` | `email` |
| `color` | `color` |
| `enabled` | `enabled` |
| `sort_order` | `sortOrder` |
| `auth_user` | incoming/outgoing username |
| `auth_pass` | password secret |
| `imap_host` | incoming.host |
| `imap_port` | incoming.port |
| `imap_tls=true` | incoming.security=tls |
| `imap_skip_tls_verify` | incoming.skipTlsVerify |
| `smtp_host` | outgoing.host |
| `smtp_port` | outgoing.port |
| `smtp_tls` | outgoing.security |
| `oauth_provider` | auth.provider |
| `oauth_refresh_token` | auth.refreshToken |
| `oauth_access_token` | auth.accessToken |
| `oauth_token_expiry` | auth.tokenExpiry |
| `folder_mappings` | folderMappings |
| `signature` | signature |

### 7.2 Legacy 迁移方式

建议提供两条路径：

**A. 旧 MailFlow 在线导出**

旧实例增加一次性管理员导出功能，生成 Safe Manifest 或 Encrypted Bundle。

**B. 离线迁移 CLI**

CLI 从 PostgreSQL 读取必要账号配置，输出 `.mailflow.json` 或 `.mfb`。CLI 不上传旧数据库文件。

禁止 Cloudflare Worker 直接连接用户旧 PostgreSQL 并做远程抓取式迁移。

## 8. Import Pipeline

导入必须分成六阶段：

```text
UPLOAD/PASTE
   -> PARSE
   -> NORMALIZE
   -> VALIDATE
   -> DRY_RUN
   -> COMMIT
   -> VERIFY
```

### 8.1 Parse

- 根据显式 `format/version` 识别原生格式；
- CSV 通过 header 识别；
- 未知格式拒绝，不做猜测性解析；
- 设置最大文件大小和最大账号数。

### 8.2 Normalize

所有输入转换成 `CanonicalAccountConfig[]`。

normalize 只做确定性转换，不访问 Provider，不写 D1。

### 8.3 Validate

分三级：

**Schema Validation**
- 必填字段
- enum
- email
- port
- string length

**Security Validation**
- host/IP SSRF 检查
- private host policy
- TLS policy
- dangerous option policy

**Provider Validation**
- Gmail/Microsoft 是否需要 OAuth
- IMAP/SMTP 字段是否齐全
- Alias email 是否合法

### 8.4 Dry Run

返回：

```json
{
  "importId": "imp_xxx",
  "summary": {
    "total": 5,
    "create": 2,
    "update": 1,
    "skip": 1,
    "reauthRequired": 1,
    "invalid": 0
  },
  "accounts": []
}
```

Dry Run 必须告诉用户每个账号即将发生什么，但不得回显 Secret。

### 8.5 Commit

每个账号独立事务/独立结果，不使用“5 个账号全部成功才提交”的大事务。

原因：Provider Test/OAuth 状态属于外部系统，不能依赖单个 D1 大事务覆盖。

每个账号流程：

1. acquire import/account lock；
2. resolve conflict；
3. write/update account metadata；
4. encrypt Secret；
5. write encrypted credential blob；
6. write aliases/folder mappings/sync policy；
7. enqueue optional connection verification；
8. append audit event；
9. return item result。

### 8.6 Verify

状态：

- `READY`
- `CREDENTIAL_REQUIRED`
- `REAUTH_REQUIRED`
- `VERIFYING`
- `CONNECTION_FAILED`
- `DISABLED`

导入成功不等于连接成功；两者在 UI 上必须分开展示。

## 9. 冲突解析

### 9.1 Identity Key

建议账号自然键：

```text
provider_kind + normalized_email + provider_endpoint_identity
```

其中：

- Gmail: `gmail + email`
- Microsoft: `microsoft + email`
- IMAP: `imap-smtp + email + lower(imap_host) + imap_port`

不要单纯按 email 判重，因为同一个 email 可能由不同后端/环境提供服务。

### 9.2 Conflict Modes

用户可选择：

- `skip`：已有账号不变；
- `merge`：更新非秘密配置，Secret 仅在导入文件明确携带且用户勾选时替换；
- `replace-config`：替换配置但保留本地 Secret；
- `replace-all`：配置与 Secret 均替换，必须二次确认；
- `create-copy`：创建副本，名称追加后缀，默认 disabled。

批量导入允许设置默认策略并对单账号覆盖。

## 10. 幂等设计

每个导入文件计算：

```text
manifestFingerprint = SHA-256(canonical-json-without-secrets)
```

每个 item 计算：

```text
itemFingerprint = SHA-256(account-identity + normalized-config-without-secrets)
```

D1 保存 import batch 和 item result。

重复上传同一文件时 UI 应提示“曾于某时间导入”，但允许再次执行 dry-run。

Secret 不参与可持久化 fingerprint，避免通过 hash 建立密码旁路信息。

## 11. 建议 D1 表

```sql
CREATE TABLE import_batches (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  source_type TEXT NOT NULL,
  manifest_fingerprint TEXT,
  status TEXT NOT NULL,
  total_count INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE TABLE import_items (
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL,
  account_identity_hash TEXT NOT NULL,
  source_id TEXT,
  target_account_id TEXT,
  action TEXT NOT NULL,
  status TEXT NOT NULL,
  error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

不得保存：

- password
- refresh token
- access token
- decrypted bundle payload

## 12. API

```text
POST /api/v1/account-import/parse
POST /api/v1/account-import/dry-run
POST /api/v1/account-import/:importId/commit
GET  /api/v1/account-import/:importId
POST /api/v1/account-import/:importId/retry-failed

POST /api/v1/account-export/manifest
POST /api/v1/account-export/encrypted-bundle
```

推荐让 `parse` 与 `dry-run` 合并为一次前端体验，但后端 Service 仍分层实现。

## 13. UI 流程

```text
Settings > Accounts > Import

Step 1 选择文件/粘贴配置
Step 2 解密（若 .mfb，仅本地处理口令）
Step 3 预览账号
Step 4 校验错误/补充缺少字段
Step 5 冲突策略
Step 6 Dry Run
Step 7 Commit
Step 8 Connection Verify
Step 9 OAuth Reconnect / Missing Credential
Step 10 完成摘要
```

结果必须按账号逐项展示：

```text
Work Gmail      REAUTH_REQUIRED
Personal QQ     READY
163             CONNECTION_FAILED (AUTH_FAILED)
Old Account     SKIPPED (already exists)
```

## 14. 导出设计

### 14.1 Safe Export

默认按钮：`Export account settings`

输出不含任何 Secret。

### 14.2 Encrypted Export

必须：

- 用户显式点击“Include credentials”类入口；
- 展示风险提示；
- 设置独立导出口令；
- 导出文件只生成一次；
- 不把口令发送到分析/遥测；
- OAuth token 若不可安全迁移，可选择排除并标记 `reauthOnImport=true`。

## 15. 回滚

导入批次必须记录目标账号 ID 和动作。

提供“逻辑回滚”能力：

- 本批次 `create` 的账号可批量删除（在尚未产生大量本地状态前）；
- `merge/replace` 不自动恢复 Secret，除非实现安全的短期 encrypted rollback snapshot；
- V1 推荐对 update 使用 D1 `account_config_revisions` 保存**不含明文秘密**的前一版配置；
- Secret 更新失败时保持旧 encrypted credential blob，不先删后写。

## 16. 安全要求

- 所有 Secret 字段使用显式 Secret 类型，禁止通用 logger 序列化；
- 请求日志必须 redact `password/token/authorization/cookie`；
- Queue payload 不携带 password/token；
- Dry Run 响应不返回 Secret；
- Audit 只记录“credential changed=true”，不记录值；
- CSV 明文密码必须在 UI 警告；
- `skipTlsVerify` 导入默认降级为 false，并提示用户手工确认；
- `allowPrivateHost` 不从外部文件自动开启；
- 文件解析必须有大小、深度、数组长度上限；
- JSON 不接受原型污染相关危险 key；
- Encrypted Bundle 解密错误不得泄漏细节。

## 17. 错误码

建议：

```text
IMPORT_FORMAT_UNSUPPORTED
IMPORT_VERSION_UNSUPPORTED
IMPORT_FILE_TOO_LARGE
IMPORT_TOO_MANY_ACCOUNTS
IMPORT_SCHEMA_INVALID
IMPORT_BUNDLE_DECRYPT_FAILED
IMPORT_ACCOUNT_CONFLICT
IMPORT_PROVIDER_UNSUPPORTED
IMPORT_PRIVATE_HOST_REJECTED
IMPORT_CREDENTIAL_REQUIRED
IMPORT_REAUTH_REQUIRED
IMPORT_CONNECTION_FAILED
IMPORT_COMMIT_FAILED
IMPORT_ALREADY_APPLIED
```

## 18. 测试要求

至少覆盖：

- Safe Manifest 单账号/多账号；
- Safe Manifest 缺 Secret；
- Encrypted Bundle 正确/错误密码/损坏密文；
- CSV BOM、逗号、引号、空密码、非法端口；
- Legacy password account；
- Legacy OAuth account；
- 同 email 不同 IMAP endpoint；
- 重复导入；
- merge/replace/skip/create-copy；
- 批量中第 3 个账号失败但其他账号成功；
- Secret 不出现在日志/D1 import 表/响应；
- OAuth Client 指纹不一致 -> `REAUTH_REQUIRED`；
- malicious JSON/超大文件；
- private host / skip TLS policy；
- import 后触发首轮 sync。

## 19. V1 Definition of Done

- [ ] `.mailflow.json` safe import/export
- [ ] `.mfb` encrypted import/export
- [ ] CSV importer
- [ ] Legacy MailFlow mapping
- [ ] canonical model + JSON Schema
- [ ] dry-run
- [ ] per-account conflict policy
- [ ] idempotent re-import
- [ ] per-account result
- [ ] OAuth reauth flow
- [ ] credential encryption before D1 write
- [ ] import audit
- [ ] failure retry
- [ ] UI complete flow
- [ ] security tests
