# Relay Events for DeepSeek Harness

> 未发布适配：本分支已迁移到 DSH `0.1.2-alpha.2`。npm 版本和标签尚未更新；下方已发布版本的安装示例不代表新版兼容性。见[适配说明](docs/dsh-0.1.2-alpha.2.md)。

`relay-dsh-plugin-events` is the durable, provider-neutral Wait/Event/Delivery
core for official DeepSeek Harness. It adds Agent tools, generic JSON ingress,
delivery to the owning existing Session, recovery, and a Waiting Events settings
surface without adding an execution backend.

The `internal` npm channel is public for integration testing. It has no stability
or compatibility guarantee and must not be treated as `latest`, `next`, or a
production release.

```bash
dsh plugin --profile web add --save-exact relay-dsh-plugin-events@internal
dsh web
```

Semantic routing and Monitor execution are separate plugins. Without a Router,
Events uses exact event-type matching. Without Monitors, Wait-only registration
and external ingress remain fully usable.

See [SPEC.md](SPEC.md) and
[delivery scenarios](docs/acceptance-scenarios.md).

Set `DSH_ROOT` to the prepared immutable official DSH checkout, then run
`npm ci --ignore-scripts && npm run verify && npm pack`.
The npm package and locally packed tarball include built runtime files. A raw
GitHub checkout intentionally does not track `lib/`; do not install `#main` as if
it were a built release.

Tested official DSH reference:
`b150a551b8d465e31e418e1b2eaf5e79bbb7d28e`.
