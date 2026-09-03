# 面向 DeepSeek Harness 的 Relay Events

> **现已支持 DSH `0.1.2-rc.1`，并保留对 `0.1.2-alpha.3` 的兼容。** 插件 `0.2.2` 已在两个版本上完成验证。[从 npm 安装](https://www.npmjs.com/package/relay-dsh-plugin-events) · [兼容性证据](https://github.com/yangbobo2021/Relay/tree/codex/relay-foundation/dsh-lab/dsh-0.1.2-rc.1-20260903)。

> **发布通道：** `latest` → `0.2.2`；`next` → `0.2.3-rc.1`。

> **升级提示：** 当前已发布的 `0.2.2` 和 `0.2.3-rc.1` 在打开已有 schema v4
> 数据库时可能失败。下文所述的安全迁移修复已在源码中实现，但尚未发布。在新版本
> 发布前，不要使用上述版本升级已有 Relay 数据库。

```bash
npx @deepseek-ai/dsh@0.1.2-rc.1 plugin --profile web add relay-dsh-plugin-events@0.2.2
npx @deepseek-ai/dsh@0.1.2-rc.1 web
```

[![DSH 兼容版本](https://img.shields.io/badge/DSH-0.1.1--rc.2%20%7C%200.1.2--alpha.2%20%7C%200.1.2--alpha.3%20%7C%200.1.2--rc.1-2f7d68)](https://github.com/deepseek-ai/deepseek-harness)

[English](README.md) | 中文

`relay-dsh-plugin-events` 是官方 DeepSeek Harness 的持久化、中立执行后端的
Wait/Event/Delivery 核心。它提供 Agent 工具、通用 JSON 事件入口、向原有归属
Session 投递、故障恢复以及 Waiting Events 设置界面，但不增加执行后端。

旧的 `internal` npm 通道继续用于集成测试，不包含此次兼容保证。请使用上方最新版
DSH 命令中精确的 `0.2.2` 版本，不要替换为 `@internal`。

```bash
dsh plugin --profile web add --save-exact relay-dsh-plugin-events@internal
dsh web
```

语义路由与 Monitor 执行由独立插件提供。未安装 Router 时，Events 使用精确事件类型
匹配；未安装 Monitors 时，Wait 注册与外部事件入口仍然可以完整使用。

## 数据库生命周期

Relay 数据库是持久化数据，卸载插件时不会被删除。启动时，插件会将不存在或空数据库
直接初始化为当前 schema。对于可识别的旧 schema，会先校验完整性，再备份到
`<database>.backup-v<old>-to-v<current>.sqlite`，然后在同一个事务内执行升级，
最后创建依赖新字段的索引。备份会被校验，重试时会复用。迁移失败会回滚所有 schema 修改，
并在错误中给出备份路径。未知的非空 schema、损坏的数据库、外键违规，或高于插件所支持版本的
schema 都会被拒绝，不会猜测结构或静默修改数据。

详见 [SPEC.md](SPEC.md) 与[投递场景](docs/acceptance-scenarios.md)。

将 `DSH_ROOT` 指向准备好的官方 DSH 只读检出，然后执行
`npm ci --ignore-scripts && npm run verify && npm pack`。npm 包和本地生成的 tarball
包含已构建的运行文件。原始 GitHub 检出不会跟踪 `lib/`，不要把 `#main` 当作已构建
版本安装。

已验证的官方 DSH：`0.1.1-rc.2` / `b150a551b8d465e31e418e1b2eaf5e79bbb7d28e`
、`0.1.2-alpha.2` / `0a53fb55bea101816fa226bb964ae2bed71c343b`，以及 `0.1.2-alpha.3` / `dd6322d604e00eec1ba5e0c8541159906a21094a`。
