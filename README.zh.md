# 面向 DeepSeek Harness 的 Relay Events

> **现已支持最新 DSH `0.1.2-alpha.2`。** 同一插件版本已在 DSH `0.1.2-alpha.2` 与 `0.1.1-rc.2` 上完成兼容验证。[安装插件，立即体验最新版 DSH](https://www.npmjs.com/package/relay-dsh-plugin-events) · [兼容性详情](docs/dsh-0.1.2-alpha.2.md)。

```bash
npx @deepseek-ai/dsh@0.1.2-alpha.2 plugin --profile web add relay-dsh-plugin-events@0.2.0
npx @deepseek-ai/dsh@0.1.2-alpha.2 web
```

[![DSH 兼容版本](https://img.shields.io/badge/DSH-0.1.1--rc.2%20%7C%200.1.2--alpha.2-2f7d68)](https://github.com/deepseek-ai/deepseek-harness)

[English](README.md) | 中文

`relay-dsh-plugin-events` 是官方 DeepSeek Harness 的持久化、中立执行后端的
Wait/Event/Delivery 核心。它提供 Agent 工具、通用 JSON 事件入口、向原有归属
Session 投递、故障恢复以及 Waiting Events 设置界面，但不增加执行后端。

旧的 `internal` npm 通道继续用于集成测试，不包含此次兼容保证。请使用上方最新版
DSH 命令中精确的 `0.2.0` 版本，不要替换为 `@internal`。

```bash
dsh plugin --profile web add --save-exact relay-dsh-plugin-events@internal
dsh web
```

语义路由与 Monitor 执行由独立插件提供。未安装 Router 时，Events 使用精确事件类型
匹配；未安装 Monitors 时，Wait 注册与外部事件入口仍然可以完整使用。

详见 [SPEC.md](SPEC.md) 与[投递场景](docs/acceptance-scenarios.md)。

将 `DSH_ROOT` 指向准备好的官方 DSH 只读检出，然后执行
`npm ci --ignore-scripts && npm run verify && npm pack`。npm 包和本地生成的 tarball
包含已构建的运行文件。原始 GitHub 检出不会跟踪 `lib/`，不要把 `#main` 当作已构建
版本安装。

已验证的官方 DSH：`0.1.1-rc.2` / `b150a551b8d465e31e418e1b2eaf5e79bbb7d28e`
与 `0.1.2-alpha.2` / `0a53fb55bea101816fa226bb964ae2bed71c343b`。
