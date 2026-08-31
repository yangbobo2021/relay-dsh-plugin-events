# DSH 0.1.2-alpha.2 compatibility (unreleased)

本分支适配官方 DSH `0.1.2-alpha.2`，提交
[`0a53fb55bea101816fa226bb964ae2bed71c343b`](https://github.com/deepseek-ai/deepseek-harness/commit/0a53fb55bea101816fa226bb964ae2bed71c343b)。
这是未发布的代码适配；插件版本号及 npm `latest` / `next` 未变更。
本分支不承诺继续兼容 `0.1.1-rc.2`。

## 变更

客户端公共服务入口；对齐官方依赖图与声明入口；事件路由、去重及投递语义保持不变。

## 本地验证

类型/语法检查、插件测试及构建：

```sh
npm ci --ignore-scripts
export DSH_ROOT=/path/to/prepared/official/deepseek-harness
npm run typecheck
npm test
npm run build
```

除插件管理器使用 npm 官方包外，开发脚本从 `DSH_ROOT` 链接官方包并按
`exports.types` 生成本插件的声明映射，不再依赖已移除的 `dsh-client-runtime`。
官方 checkout 必须是上述版本，并已完成 `pnpm install` 和 `pnpm run build:lib`。
脚本不会修改官方源码。测试使用清理过的数据，不需要真实客户会话。

## 合并与发布边界

合并到默认分支不代表已发布，也不代表向后兼容保护已经实现。旧 DSH 用户不要从 GitHub
默认分支安装本次适配代码，应继续使用已验证的旧版 npm 包或固定的旧版提交。
兼容检查和独立发布通道完成前，不得将本次适配发布到原有 `latest` / `next`。
