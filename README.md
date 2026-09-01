# Relay Events for DeepSeek Harness

> **Now supports the latest DSH `0.1.2-alpha.2`.** The same plugin release is verified on DSH `0.1.2-alpha.2` and `0.1.1-rc.2`. [Install it and try the latest DSH](https://www.npmjs.com/package/relay-dsh-plugin-events) · [Compatibility details](docs/dsh-0.1.2-alpha.2.md).

```bash
npx @deepseek-ai/dsh@0.1.2-alpha.2 plugin --profile web add relay-dsh-plugin-events@0.2.0
npx @deepseek-ai/dsh@0.1.2-alpha.2 web
```

[![DSH compatibility](https://img.shields.io/badge/DSH-0.1.1--rc.2%20%7C%200.1.2--alpha.2-2f7d68)](https://github.com/deepseek-ai/deepseek-harness)

English | [中文](README.zh.md)

`relay-dsh-plugin-events` is the durable, provider-neutral Wait/Event/Delivery
core for official DeepSeek Harness. It adds Agent tools, generic JSON ingress,
delivery to the owning existing Session, recovery, and a Waiting Events settings
surface without adding an execution backend.

The older `internal` npm channel remains available for integration testing and
does not carry this compatibility guarantee. Use the exact `0.2.0`
versions in the latest-DSH command above; do not substitute `@internal`.

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

Tested official DSH references: `0.1.1-rc.2` at
`b150a551b8d465e31e418e1b2eaf5e79bbb7d28e` and `0.1.2-alpha.2` at
`0a53fb55bea101816fa226bb964ae2bed71c343b`.
