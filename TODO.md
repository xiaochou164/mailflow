# MailFlow TODO

## ChatGPT Custom App OAuth 上线收尾

- [x] 服务器 `.env` 确认包含：

```env
APP_URL=https://admin.mail.sundays.ink
MCP_PUBLIC_ORIGIN=https://admin.mail.sundays.ink
MCP_ALLOWED_HOSTS=admin.mail.sundays.ink
```

- [x] 服务器 `docker-compose.yml` 的 `mcp.environment` 确认包含：

```yaml
APP_URL: ${APP_URL:-}
MCP_PUBLIC_ORIGIN: ${MCP_PUBLIC_ORIGIN:-}
MCP_ALLOWED_HOSTS: ${MCP_ALLOWED_HOSTS:-}
```

- [x] 强制更新并重建 MCP 容器：

```bash
docker compose pull mcp
docker compose up -d --force-recreate mcp
```

- [x] 验证 metadata：

```bash
curl https://admin.mail.sundays.ink/.well-known/oauth-protected-resource
curl https://admin.mail.sundays.ink/.well-known/oauth-authorization-server
```

- [x] 验证未认证 MCP 请求应返回 `401`，而不是 `403 Invalid Host`：

```bash
curl -i https://admin.mail.sundays.ink/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  --data '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

期望响应头包含：

```http
WWW-Authenticate: Bearer resource_metadata="https://admin.mail.sundays.ink/.well-known/oauth-protected-resource"
```

- [x] ChatGPT Developer Mode 中重新连接 MCP：

```text
https://admin.mail.sundays.ink/mcp
```

- [x] 授权完成后确认 ChatGPT 只看到第一阶段工具：

```text
list_accounts
search_email
read_email
read_thread
daily_email_digest
summarize_thread
```

## 测试结论（2026-07-15）

- Backend：40 个测试文件、684 项测试通过。
- MCP：13 项测试通过；ChatGPT OAuth 模式仅注册上述 6 个只读/摘要工具。
- Frontend：1389 项测试通过，生产构建通过。
- Backend、MCP、Frontend lint 通过。
- 服务器 Backend、MCP、Frontend、PostgreSQL、Redis 容器均为 healthy。
- 公网 OAuth metadata 返回 200；未认证 `/mcp` 返回 401 和正确的 `WWW-Authenticate`。
- ChatGPT 已安装并完成 MailFlow OAuth 授权；真实调用 `list_accounts` 成功，未读取邮件正文、未执行写操作。
