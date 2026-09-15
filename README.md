# Relay Events for DeepSeek Harness

> **Stable `0.2.4` is verified on official DSH `0.1.5-rc.2` and `0.1.6-alpha.1`.** It uses the explicit official Session-list state contract required by the alpha release while remaining compatible with rc.2; its peer metadata declares both exact releases. [Install it from npm](https://www.npmjs.com/package/relay-dsh-plugin-events) · [Compatibility evidence](https://github.com/yangbobo2021/Relay/tree/codex/relay-foundation/dsh-lab/dsh-0.1.6-alpha.1-20260915).

> **Release channels:** `latest` → `0.2.4`; `next` → `0.2.4-rc.1`.

```bash
npx @deepseek-ai/dsh@0.1.6-alpha.1 plugin --profile web add relay-dsh-plugin-events@next
npx @deepseek-ai/dsh@0.1.6-alpha.1 web
```

[![DSH compatibility](https://img.shields.io/badge/DSH-0.1.1--rc.2%20%7C%200.1.2--alpha.2%20%7C%200.1.2--alpha.3%20%7C%200.1.2--rc.1-2f7d68)](https://github.com/deepseek-ai/deepseek-harness)

English | [中文](README.zh.md)

`relay-dsh-plugin-events` is the durable, provider-neutral Wait/Event/Delivery
core for official DeepSeek Harness. It adds Agent tools, generic JSON ingress,
delivery to the owning existing Session, recovery, and a Waiting Events settings
surface without adding an execution backend.

The older `internal` npm channel remains available for integration testing and
does not carry this compatibility guarantee. Use the exact `0.2.3`
version in the latest-DSH command above; do not substitute `@internal`.

```bash
dsh plugin --profile web add --save-exact relay-dsh-plugin-events@internal
dsh web
```

Semantic routing and Monitor execution are separate plugins. Without a Router,
Events uses exact event-type matching. Without Monitors, Wait-only registration
and external ingress remain fully usable.

## Database lifecycle

The Relay database is persistent and is not removed when the plugin is
uninstalled. On startup, the plugin initializes a missing or empty database at
the current schema. A recognized older schema is integrity-checked, backed up to
`<database>.backup-v<old>-to-v<current>.sqlite`, and upgraded in one transaction
before dependent indexes are created. The backup is verified and reused on a
retry. Migration failure rolls back all schema changes and reports the backup
path. An unknown non-empty schema, a corrupt database, foreign-key violations,
or a schema newer than the plugin supports is rejected rather than guessed or
silently modified.

See [SPEC.md](SPEC.md) and
[delivery scenarios](docs/acceptance-scenarios.md).

Set `DSH_ROOT` to the prepared immutable official DSH checkout, then run
`npm ci --ignore-scripts && npm run verify && npm pack`.
The npm package and locally packed tarball include built runtime files. A raw
GitHub checkout intentionally does not track `lib/`; do not install `#main` as if
it were a built release.

Tested official DSH references: `0.1.1-rc.2` at
`b150a551b8d465e31e418e1b2eaf5e79bbb7d28e`, `0.1.2-alpha.2` at
`0a53fb55bea101816fa226bb964ae2bed71c343b`, and `0.1.2-alpha.3` at `dd6322d604e00eec1ba5e0c8541159906a21094a`.
