# MailFlow CF Lite 工程文档

> 状态：Design Baseline
> 分支：`cloudflare-lite-design`
> 产品边界：**统一收件 + MCP + 轻量发信 + 账号配置导入/导出**

本文档目录是 Cloudflare Lite 重构的工程入口。后续实现、Codex 工作包、评审和验收均以这里的文档为准；`../CLOUDFLARE_LITE_REFACTOR_PLAN.md` 保留为产品级总方案和路线图。

## 1. 文档地图

| 文档 | 用途 | 实施阶段 |
|---|---|---|
| `ARCHITECTURE.md` | 系统边界、Cloudflare 资源、模块职责、请求/异步链路 | WP0-WP2 |
| `DATA_MODEL_AND_SYNC.md` | D1/R2 模型、Provider Adapter、同步状态机、幂等与一致性 | WP2-WP8 |
| `ACCOUNT_IMPORT_EXPORT.md` | 账号配置导入/导出协议、加密包、冲突、迁移与回滚 | WP3/WP3A |
| `API_MCP_CONTRACT.md` | Web API、错误模型、分页、MCP Tool/Scope/Schema | WP0/WP9 |
| `SECURITY_OPERATIONS.md` | 凭证安全、HTML/附件安全、部署、密钥轮换、监控、备份恢复 | WP3/WP11 |
| `TESTING_ACCEPTANCE.md` | 单测、集成、契约、E2E、故障注入、RC 验收门槛 | 全阶段 |

## 2. 产品目标

MailFlow CF Lite 不是完整 Gmail/Outlook 替代品，而是一个 Cloudflare Native 的 B/S 统一邮箱工作台：

- 多账号统一收件箱
- Gmail / Microsoft / 标准 IMAP 收件
- 搜索、Thread、附件、已读、星标、归档、删除
- New / Reply / Reply All / Forward / CC / BCC / 小附件
- MCP 搜索、读取、总结、管理、轻量发信
- 账号批量导入/导出与迁移
- 不依赖 VPS、Docker、PostgreSQL、Redis
- 个人/小规模使用优先保持 Cloudflare 免费层可运行

## 3. 非目标

V1 明确不做：

- 邮件营销、群发、追踪、阅读回执
- 重型富文本排版
- 完整邮件服务器
- 长驻 IMAP IDLE 守护进程
- GTD/CardDAV/Todoist 等非核心模块
- 企业多租户 SaaS

## 4. 目录约定

建议新增实现目录：

```text
backend-cf/
  src/
    api/
    auth/
    import-export/
    mcp/
    providers/
      gmail/
      microsoft/
      imap-smtp/
    services/
    repositories/
    queues/
    cron/
    durable-objects/
    storage/
    security/
    observability/
    types/
  migrations/
  schemas/
  test/
  wrangler.toml
```

原 `backend/` 在 Cloudflare RC 前保持可运行，迁移阶段不得破坏现有 Node 版本。

## 5. 核心工程原则

1. **Provider 是事实源，D1 是索引层，不做第二个邮箱服务器。**
2. **所有同步和导入流程必须幂等、可重试、可恢复。**
3. **Gmail/Microsoft API 优先，IMAP/SMTP 作为通用兜底。**
4. **凭证永不明文落 D1、日志、Queue、审计事件或导出文件。**
5. **MCP 和 Web 共用 Application Service，不允许两套业务逻辑。**
6. **MCP 默认只读，`mail.manage`、`mail.send` 独立授权。**
7. **正文和附件按需拉取，R2 仅作为可清理缓存。**
8. **大任务拆 Queue；Cron 只调度，不做完整同步。**
9. **导入先 validate/dry-run，再 commit；导入必须支持逐账号结果和回滚。**
10. **每个工作包必须有 Acceptance Report。**

## 6. 账号导入/导出能力是 V1 正式功能

账号迁移不是管理员脚本。Settings > Accounts 中必须提供：

```text
Import Accounts
├── MailFlow Account Manifest (.json)      默认不含秘密
├── MailFlow Encrypted Bundle (.mfb)       可携带秘密
├── IMAP/SMTP CSV (.csv)                   批量基础账号
└── Legacy MailFlow Migration              现有版本迁移

Export Accounts
├── Safe Manifest                          默认
└── Encrypted Bundle                       显式选择 + 本地口令
```

详细规范见 `ACCOUNT_IMPORT_EXPORT.md`。

## 7. 工作包调整

在原 WP0-WP11 基础上增加：

### WP3A - Account Import / Export

必须在 Provider 大规模联调前完成基础框架：

- canonical account config model
- JSON Schema
- safe manifest import/export
- encrypted bundle import/export
- CSV importer
- validate/dry-run/commit pipeline
- conflict resolution
- legacy account mapping
- per-account audit
- OAuth `REAUTH_REQUIRED` 机制

验收：

- 至少 10 个混合账号批量导入，单个失败不污染其他账号
- 同一文件重复导入不产生非预期重复账号
- 导入结果可精确显示 `created/updated/skipped/failed/reauth_required`
- D1、日志、响应中无明文密码和 refresh token

## 8. 工程完成标准

RC 必须同时满足：

- Gmail、Microsoft、至少两类 Generic IMAP/SMTP 真实联调
- 多账号统一收件 + 搜索 +操作稳定
- MCP Read/Manage/Send Scope 完整
- Safe Manifest、Encrypted Bundle、CSV、Legacy Migration 均有测试
- Cloudflare 从空账号可一键初始化 D1/R2/Queue/Worker
- staging 与 production smoke 均通过
- 关键失败路径具备明确恢复方式
- 免费层 Guardrail 生效

## 9. 变更规则

若实现过程中发现本文档与 Cloudflare Runtime/Provider 实际能力冲突：

1. 先记录 ADR/Acceptance Report；
2. 用真实 Spike/测试证明；
3. 更新文档后再改变架构；
4. 不允许为了快速通过测试静默绕开安全边界或幂等约束。
