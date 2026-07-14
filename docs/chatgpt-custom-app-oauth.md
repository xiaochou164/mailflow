# ChatGPT 自定义 App OAuth 接入说明

本文档说明 MailFlow MCP 如何接入 ChatGPT 自定义 App。目标是让 ChatGPT 通过 OAuth 2.1 授权访问 MCP，而不是手工填写固定 `mf_sk_...` Token。

## 1. 地址

生产 MCP 地址：

```text
https://mail_admin.sundays.ink/mcp
```

OAuth metadata：

```text
https://mail_admin.sundays.ink/.well-known/oauth-protected-resource
https://mail_admin.sundays.ink/.well-known/oauth-authorization-server
```

OAuth endpoints：

```text
https://mail_admin.sundays.ink/oauth/authorize
https://mail_admin.sundays.ink/oauth/token
https://mail_admin.sundays.ink/oauth/register
https://mail_admin.sundays.ink/oauth/revoke
```

## 2. 兼容方式

当前实现采用 OAuth 适配层：

```text
ChatGPT
  -> OAuth 2.1 + PKCE
  -> MailFlow OAuth adapter
  -> MailFlow MCP
  -> MailFlow /api/v1
```

保留旧方式：

```http
Authorization: Bearer mf_sk_xxx
```

新增方式：

```http
Authorization: Bearer mf_oat_xxx
```

`mf_oat_xxx` 是短期 OAuth access token。它不会暴露或返回内部 `mf_sk_xxx` Token。

## 3. 第一阶段开放工具

ChatGPT OAuth 模式下仅暴露：

```text
list_accounts
search_email
read_email
read_thread
daily_email_digest
summarize_thread
```

暂不开放：

```text
send_email
reply_email
forward_email
delete_email
```

## 4. OAuth scopes

支持：

```text
email.search
email.read
email.thread
ai.summarize
```

`list_accounts` 在服务端内部通过 ChatGPT MCP 应用授予 `account.read`，但不作为外部 OAuth scope 暴露。

## 5. Docker Compose 修改

backend 需要：

```yaml
environment:
  APP_URL: ${APP_URL:-}
  MCP_PUBLIC_ORIGIN: ${MCP_PUBLIC_ORIGIN:-}
```

mcp 需要：

```yaml
environment:
  MAILFLOW_API_BASE_URL: http://backend:3000/api/v1
  APP_URL: ${APP_URL:-}
  MCP_PUBLIC_ORIGIN: ${MCP_PUBLIC_ORIGIN:-}
```

生产建议：

```env
APP_URL=https://mail_admin.sundays.ink
MCP_PUBLIC_ORIGIN=https://mail_admin.sundays.ink
```

## 6. Nginx 反向代理

frontend nginx 需要代理：

```nginx
location = /mcp {
    proxy_pass http://mcp:3001;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto https;
    proxy_read_timeout 300s;
    proxy_buffering off;
    proxy_cache off;
}

location /oauth/ {
    proxy_pass http://backend:3000;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto https;
}

location = /.well-known/oauth-protected-resource {
    proxy_pass http://backend:3000;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto https;
}

location = /.well-known/oauth-authorization-server {
    proxy_pass http://backend:3000;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto https;
}
```

仓库内 `frontend/nginx.conf` 已包含这些配置。

## 7. Caddy 配置

当前 `Caddyfile` 全量反代到 frontend：

```caddy
{$DOMAIN} {
    reverse_proxy frontend:443 {
        transport http {
            tls_insecure_skip_verify
        }
    }
}
```

因为 frontend nginx 已负责 `/mcp`、`/oauth/`、`/.well-known/oauth-*` 的内部转发，所以 Caddy 不需要额外路径规则。

## 8. 数据库迁移

新增迁移：

```text
backend/migrations/0044_mcp_oauth_adapter.sql
```

新增表：

```text
mcp_oauth_clients
mcp_oauth_authorization_codes
mcp_oauth_tokens
```

用途：

```text
mcp_oauth_clients              动态客户端注册 DCR
mcp_oauth_authorization_codes  短期授权码，绑定 PKCE S256
mcp_oauth_tokens               access/refresh token 哈希存储、过期和撤销
```

## 9. OAuth 授权页面

授权页：

```text
/oauth/authorize
```

行为：

- 未登录 MailFlow：提示先登录
- 已登录 MailFlow：显示 ChatGPT 授权确认页
- 点击授权：创建或复用内部 `ChatGPT MCP` 开发者应用
- 授权后：回跳 ChatGPT redirect URI，并带上 authorization code

## 10. curl 测试

### 10.1 protected resource metadata

```bash
curl -sS https://mail_admin.sundays.ink/.well-known/oauth-protected-resource | jq
```

应返回：

```json
{
  "resource": "https://mail_admin.sundays.ink/mcp",
  "authorization_servers": [
    "https://mail_admin.sundays.ink"
  ],
  "scopes_supported": [
    "email.search",
    "email.read",
    "email.thread",
    "ai.summarize"
  ]
}
```

### 10.2 authorization server metadata

```bash
curl -sS https://mail_admin.sundays.ink/.well-known/oauth-authorization-server | jq
```

应包含：

```json
{
  "authorization_endpoint": "https://mail_admin.sundays.ink/oauth/authorize",
  "token_endpoint": "https://mail_admin.sundays.ink/oauth/token",
  "registration_endpoint": "https://mail_admin.sundays.ink/oauth/register",
  "grant_types_supported": [
    "authorization_code",
    "refresh_token"
  ],
  "code_challenge_methods_supported": [
    "S256"
  ],
  "token_endpoint_auth_methods_supported": [
    "none"
  ]
}
```

### 10.3 未认证 MCP 请求

```bash
curl -i https://mail_admin.sundays.ink/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  --data '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

应返回：

```http
HTTP/1.1 401 Unauthorized
WWW-Authenticate: Bearer resource_metadata="https://mail_admin.sundays.ink/.well-known/oauth-protected-resource"
```

### 10.4 DCR 注册测试

```bash
curl -sS https://mail_admin.sundays.ink/oauth/register \
  -H "Content-Type: application/json" \
  --data '{
    "client_name": "ChatGPT Test",
    "redirect_uris": ["https://chat.openai.com/aip/test/oauth/callback"],
    "grant_types": ["authorization_code", "refresh_token"],
    "response_types": ["code"],
    "scope": "email.search email.read email.thread ai.summarize"
  }' | jq
```

返回中会包含：

```text
client_id
token_endpoint_auth_method=none
```

### 10.5 旧 mf_sk 方式仍可用

```bash
export MAILFLOW_TOKEN="mf_sk_xxx"

curl -sS https://mail_admin.sundays.ink/mcp \
  -H "Authorization: Bearer $MAILFLOW_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  --data '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "tools/list",
    "params": {}
  }'
```

## 11. ChatGPT 开发者模式接入步骤

1. 打开 ChatGPT 开发者模式。
2. 创建 Custom App。
3. 选择 MCP remote server。
4. MCP URL 填：

```text
https://mail_admin.sundays.ink/mcp
```

5. 认证方式选择 OAuth。
6. ChatGPT 会读取：

```text
/.well-known/oauth-protected-resource
/.well-known/oauth-authorization-server
```

7. ChatGPT 动态注册客户端。
8. 浏览器跳转到 MailFlow `/oauth/authorize`。
9. 登录 MailFlow，并点击授权。
10. ChatGPT 用授权码和 PKCE verifier 换取 access token / refresh token。
11. ChatGPT 调用 MCP `tools/list`，应只看到第一阶段 6 个工具。

## 12. 安全检查清单

- `mf_sk_xxx` 不返回给 ChatGPT。
- OAuth access token 只短期有效。
- Refresh token 支持轮换。
- Token 仅哈希保存。
- Authorization code 只能使用一次。
- Authorization code 有短过期时间。
- 强制 PKCE S256。
- DCR 客户端为 public client，`token_endpoint_auth_method=none`。
- OAuth 模式只暴露只读和 AI 摘要工具。
- 发送、转发、删除工具不向 ChatGPT 暴露。
- `/mcp` 未认证时返回 `WWW-Authenticate`，并指向 protected resource metadata。
- 旧 `mf_sk_xxx` 调用方式仍可用。
- 可在 MailFlow 开发者应用中撤销 `ChatGPT MCP` 应用。
