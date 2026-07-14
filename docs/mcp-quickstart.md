# MailFlow MCP 调用说明

这份文档用于快速接入 MailFlow MCP。MCP 适合给 AI 客户端读取邮件、搜索知识库、读取线程和导出 Markdown。

## 1. 服务地址

如果按示例 Docker 部署，并暴露端口 `8089:80`：

```text
http://你的服务器地址:8089/mcp
```

本地测试地址示例：

```text
http://127.0.0.1:8089/mcp
```

注意：`GET /mcp` 返回 `405 Method Not Allowed` 是正常的。MCP 使用 `POST` 请求。

## 2. 鉴权方式

请求头使用 Bearer Token：

```http
Authorization: Bearer mf_sk_xxx
```

示例：

```bash
export MAILFLOW_MCP_URL="http://127.0.0.1:8089/mcp"
export MAILFLOW_TOKEN="mf_sk_xxx"
```

Token 在 MailFlow 后台的“开发者应用”里创建。不同 Token 能看到的 MCP 工具取决于它被授权的权限。

## 3. 初始化 MCP

```bash
curl -sS "$MAILFLOW_MCP_URL" \
  -H "Authorization: Bearer $MAILFLOW_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  --data '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "initialize",
    "params": {
      "protocolVersion": "2025-03-26",
      "capabilities": {},
      "clientInfo": {
        "name": "my-client",
        "version": "1.0.0"
      }
    }
  }'
```

成功时会返回类似：

```json
{
  "result": {
    "protocolVersion": "2025-03-26",
    "capabilities": {
      "tools": {
        "listChanged": true
      }
    },
    "serverInfo": {
      "name": "mailflow-mcp",
      "version": "0.1.0"
    }
  }
}
```

## 4. 查看可用工具

```bash
curl -sS "$MAILFLOW_MCP_URL" \
  -H "Authorization: Bearer $MAILFLOW_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  --data '{
    "jsonrpc": "2.0",
    "id": 2,
    "method": "tools/list",
    "params": {}
  }'
```

常见工具：

```text
search_email              搜索邮件
read_email                读取单封邮件
list_accounts             列出邮箱账号
read_thread               读取完整邮件线程
get_attachment            下载附件
create_draft              创建草稿
draft_reply               生成回复草稿
send_email                发送邮件
reply_email               回复邮件
forward_email             转发邮件
summarize_thread          总结邮件线程
daily_email_digest        每日邮件摘要
search_knowledge          检索邮件知识库
contact_history           联系人历史
similar_emails            相似邮件
export_thread_markdown    导出 Obsidian Markdown
```

实际能看到哪些工具，取决于 Token 权限。

## 5. 调用工具

### 列出邮箱账号

```bash
curl -sS "$MAILFLOW_MCP_URL" \
  -H "Authorization: Bearer $MAILFLOW_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  --data '{
    "jsonrpc": "2.0",
    "id": 3,
    "method": "tools/call",
    "params": {
      "name": "list_accounts",
      "arguments": {}
    }
  }'
```

### 搜索邮件

```bash
curl -sS "$MAILFLOW_MCP_URL" \
  -H "Authorization: Bearer $MAILFLOW_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  --data '{
    "jsonrpc": "2.0",
    "id": 4,
    "method": "tools/call",
    "params": {
      "name": "search_email",
      "arguments": {
        "query": "from:example.com after:2026-01-01",
        "limit": 10
      }
    }
  }'
```

### 读取完整线程

```bash
curl -sS "$MAILFLOW_MCP_URL" \
  -H "Authorization: Bearer $MAILFLOW_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  --data '{
    "jsonrpc": "2.0",
    "id": 5,
    "method": "tools/call",
    "params": {
      "name": "read_thread",
      "arguments": {
        "thread_id": "THREAD_ID_FROM_SEARCH"
      }
    }
  }'
```

### 总结线程

需要 Token 拥有 AI 总结相关权限。

```bash
curl -sS "$MAILFLOW_MCP_URL" \
  -H "Authorization: Bearer $MAILFLOW_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  --data '{
    "jsonrpc": "2.0",
    "id": 6,
    "method": "tools/call",
    "params": {
      "name": "summarize_thread",
      "arguments": {
        "thread_id": "THREAD_ID_FROM_SEARCH"
      }
    }
  }'
```

### 导出 Obsidian Markdown

```bash
curl -sS "$MAILFLOW_MCP_URL" \
  -H "Authorization: Bearer $MAILFLOW_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  --data '{
    "jsonrpc": "2.0",
    "id": 7,
    "method": "tools/call",
    "params": {
      "name": "export_thread_markdown",
      "arguments": {
        "thread_id": "THREAD_ID_FROM_SEARCH"
      }
    }
  }'
```

## 6. 权限建议

只读检索：

```text
email.search
email.read
email.thread
```

附件和草稿：

```text
email.attachments
email.draft
```

AI 能力：

```text
ai.summarize
```

发送和删除属于高风险权限，建议单独授权：

```text
email.send
email.reply
email.forward
email.delete
```

## 7. 常见问题

### GET /mcp 返回 405

正常。MCP 使用 `POST` 请求。

### tools/list 返回的工具少

说明当前 Token 权限较少。到 MailFlow 后台编辑或重新创建开发者应用，授予对应权限。

### 返回 401 或 Unauthorized

检查：

```text
Authorization: Bearer mf_sk_xxx
```

确认 Token 没有过期、没有被轮换、没有被撤销。

### list_accounts 返回 []

说明当前部署环境里还没有连接邮箱账号，或者 Token 的账号范围限制没有包含任何账号。

### /mcp 地址无法访问

检查 Docker 容器：

```bash
docker compose ps
docker logs mailflow-mcp --tail=100
docker logs mailflow-frontend --tail=100
```

如果前端端口是 `8089:80`，MCP 地址应为：

```text
http://服务器地址:8089/mcp
```
