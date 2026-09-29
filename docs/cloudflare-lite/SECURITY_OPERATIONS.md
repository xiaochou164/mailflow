# 安全、部署与运维规范

## 1. 安全模型

MailFlow 处理高敏感数据：邮箱凭证、邮件正文、附件、联系人、MCP Token。因此安全优先级高于便利性。

威胁面：

- Provider credential 泄漏；
- MCP Token 泄漏/越权；
- HTML 邮件 XSS/Tracking；
- IMAP/SMTP SSRF 到内网；
- 恶意附件；
- 导入文件注入/明文 Secret；
- OAuth state/token 劫持；
- 日志泄漏；
- 重放导致重复发信；
- Queue 重复消费造成状态错乱。

## 2. Secret 分类

### Deployment Secrets

Cloudflare Secret：

- Master Encryption Key
- Session Signing Key
- OAuth Client Secret
- OIDC Client Secret

### User Provider Secrets

D1 加密保存：

- IMAP/SMTP password/app password
- OAuth refresh token
- 必要时 access token

### Access Tokens

- Web session
- MCP token

MCP 原始 token 只在创建时显示一次，D1 只保存 hash。

## 3. Credential Vault

接口：

```ts
interface CredentialVault {
  encrypt(accountId: string, credential: ProviderCredential): Promise<EncryptedCredential>;
  decrypt(accountId: string, blob: EncryptedCredential): Promise<ProviderCredential>;
  rotate(accountId: string): Promise<void>;
}
```

推荐 AES-GCM；AAD 至少绑定：

```text
accountId
userId
credentialVersion
```

防止不同账号密文被交换后仍可解密。

D1 中保存 `key_version`，支持 Master Key rotation。

## 4. Master Key Rotation

采用版本化 Key：

```text
MASTER_KEY_V1
MASTER_KEY_V2
ACTIVE_KEY_VERSION=2
```

流程：

1. 新 key 上线；
2. 新写入全部用新 key；
3. 后台按账号重加密旧 credential；
4. 验证全部升级；
5. 保留旧 key 回滚窗口；
6. 删除旧 key。

不得一次性先删除旧 key 再迁移。

## 5. OAuth 安全

- state 必须随机、一次性、有过期时间；
- callback 绑定原始 user/account intent；
- 使用 PKCE（Provider 支持时）；
- refresh token 进入 Vault；
- access token 尽量短期内存使用；
- 日志 redact query/code/token；
- OAuth reconnect bump sync generation。

## 6. MCP 安全

- 默认 `mail.read`；
- `mail.manage` / `mail.send` 显式授权；
- 支持 account allowlist；
- token hash 存储；
- token 可过期、吊销；
- write tool 全审计；
- send rate limit；
- delete 可单独 guard；
- token 不通过 URL query 传递。

## 7. Web Session

Cookie：

```text
Secure
HttpOnly
SameSite=Lax/Strict based on flow
```

使用 Cookie Auth 的状态改变请求做 CSRF 防护。

登录/重置/Token 创建等敏感路径单独 rate limit。

## 8. HTML 邮件安全

邮件 HTML 属于不可信输入。

必须：

- 移除 script；
- 移除 inline event handler；
- 限制 iframe/object/embed；
- URL scheme allowlist；
- sanitize style 中危险值；
- 默认不自动加载外部图片，或通过明确隐私策略控制；
- 禁止邮件 HTML 访问父页面 JS；
- 优先隔离 renderer/sandbox。

严禁 `dangerouslySetInnerHTML` 直接渲染 Provider 原始 HTML。

## 9. Tracking Pixel

Settings 提供：

- Block remote images（默认建议开启）；
- Load remote images once；
- Allow sender/domain（后续）。

如果未来做图片代理，必须重新评估 SSRF、隐私和缓存风险，V1 不必实现。

## 10. Attachment Security

- 不在 Worker 执行附件；
- 下载使用 `Content-Disposition: attachment` 默认；
- 可安全 inline 的图片/PDF另行白名单；
- 不相信 filename MIME；
- 文件名清理 CR/LF/path separator；
- 最大单附件/单邮件附件总量限制；
- R2 cache key 不用原始文件名做路径主体；
- MCP 不允许通过任意 URL 注入附件。

## 11. SSRF / Network Policy

Generic IMAP/SMTP 允许用户指定 host，这是显著 SSRF 面。

默认拒绝：

- loopback；
- link-local；
- metadata endpoint；
- RFC1918/private ranges（除非部署者显式允许）；
- 非法/模糊 IP 表示；
- DNS resolve 后落入禁止网段的目标。

`allowPrivateHost` 只能由部署者/管理员显式启用，不能通过导入文件自动开启。

`skipTlsVerify` 同理默认 false。

## 12. Logging

结构化日志允许：

```text
requestId
userId hashed/opaque
accountId
provider
operation
latency
status/errorCode
queue retry
```

禁止：

```text
password
refresh/access token
Authorization
Cookie
完整 email body
完整 MIME
附件内容
导入 decrypted payload
```

对 URL/query/header/body 统一 redaction。

## 13. Audit

审计事件与 debug log 分离。

必须审计：

- account create/delete/config change；
- credential change/reconnect；
- account import/export；
- MCP token create/revoke/scope change；
- MCP archive/delete/send；
- Web send；
- destructive resync/reset。

Audit 只保留最小必要 metadata。

## 14. Rate Limit

按 user/token/account/IP 多维组合，不依赖单一 IP。

重点：

- auth；
- account verify；
- manual sync；
- send；
- MCP；
- import parse/commit；
- attachment fetch。

## 15. Deployment Environments

至少：

```text
local
staging
production
```

资源必须隔离：独立 D1、R2、Queue、DO namespace、OAuth callback。

严禁 staging 使用 production D1/R2。

## 16. Wrangler Configuration

建议：

```text
wrangler.toml
wrangler.staging.toml / env.staging
```

非 Secret 配置可版本控制；Secret 使用 Cloudflare Secret 管理。

## 17. Initial Bootstrap

从空 Cloudflare 账号部署：

1. create D1；
2. apply migrations；
3. create R2 bucket；
4. create Queue；
5. bind DO；
6. configure secrets；
7. deploy Worker/static assets；
8. configure OAuth callback；
9. `/system/health`；
10. create first user/admin；
11. smoke test。

目标：脚本化，不靠 Dashboard 手工记忆步骤。

## 18. Migrations

CI/CD：

```text
lint/test
-> build
-> migration dry check
-> deploy staging
-> apply staging migration
-> smoke
-> production approval
-> production migration
-> production deploy
-> smoke
```

Destructive migration 必须单独窗口和回滚方案。

## 19. Backup / Recovery

因为邮件真源在 Provider，恢复重点：

1. account safe/encrypted export；
2. D1 backup/export（用户/账号/审计/配置）；
3. deployment secret inventory；
4. OAuth app config；
5. R2 可不纳入强恢复要求。

恢复演练必须证明：新 D1 可以从账号配置 + Provider 重建邮件索引。

## 20. R2 Cleanup

定期任务清理：

- stale body；
- stale attachments；
- deleted account prefix；
- abandoned temporary export。

删除缓存不得影响邮件可恢复性。

## 21. Observability

Dashboard/Diagnostics 最低指标：

```text
accounts total/ready/error
last sync success
sync lag
sync messages changed
queue retry/dead-letter
provider latency/error rate
D1 query failures
R2 hit/miss
MCP calls/write calls/denials
send sent/failed/unknown
import success/failed/reauth
```

个人版 UI 不需要复杂 APM，但必须能回答“哪个账号为什么没同步”。

## 22. Error Taxonomy

Provider 错误至少归类：

```text
AUTH
RATE_LIMIT
TIMEOUT
NETWORK
TLS
PROTOCOL
NOT_FOUND
CURSOR_INVALID
PERMISSION
QUOTA
UNKNOWN
```

用于 retry 策略和 UI 信息，不直接把原始异常暴露用户。

## 23. Retry Policy

可重试：timeout、network、部分 429/5xx。

不可盲重试：

- auth failure；
- invalid config；
- send status unknown；
- permission denied。

指数退避 + jitter；Queue 最大重试次数后进入可观察失败状态。

## 24. Free Tier Guardrail

业务代码不硬编码 Cloudflare 免费额度数值；Release/RC 时查官方最新限制并记录 Acceptance Report。

Guardrail：

- 默认 30 天 header/index；
- body lazy fetch；
- attachment streaming/cache-on-demand；
- batch sync；
- cursor pagination；
- per-account sync interval 可调；
- usage diagnostics；
- 超预算时降级非核心缓存/AI，不破坏收件。

## 25. Privacy

- AI 功能默认只在用户主动调用时发送必要正文；
- AI Provider 配置明确展示数据会发送到哪里；
- MCP 搜索默认 metadata/preview；
- Analytics 不收邮件正文、联系人列表、Secret；
- 导出操作明确区分 safe 与 credentials。

## 26. Incident Response

Credential 泄漏怀疑：

1. revoke MCP token；
2. revoke OAuth refresh tokens/重置 app password；
3. rotate deployment key（若涉及）；
4. bump credential/sync generation；
5. audit affected actions；
6. restore/reconnect。

## 27. Production Release Gate

Production RC 前必须：

- credential-at-rest test；
- log secret scan；
- import secret leak test；
- MCP scope negative tests；
- HTML XSS corpus test；
- SSRF/private host tests；
- OAuth state replay test；
- duplicate Queue test；
- duplicate send protection test；
- backup/recovery drill；
- staging real-provider smoke。
