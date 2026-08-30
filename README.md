# Relay Events for DeepSeek Harness

`relay-dsh-plugin-events` is the durable, provider-neutral Wait/Event/Delivery
core for official DeepSeek Harness. It adds Agent tools, generic JSON ingress,
delivery to the owning existing Session, recovery, and a Waiting Events settings
surface without adding an execution backend.

```bash
# After building this repository (see below):
dsh plugin --profile web add ./relay-dsh-plugin-events-0.1.0.tgz
dsh web
```

Semantic routing and Monitor execution are separate plugins. Without a Router,
Events uses exact event-type matching. Without Monitors, Wait-only registration
and external ingress remain fully usable.

See [SPEC.md](SPEC.md) and
[delivery scenarios](docs/acceptance-scenarios.md).

Set `DSH_ROOT` to the prepared immutable official DSH checkout, then run
`npm ci --ignore-scripts && npm run verify && npm pack`.
The tarball includes built runtime files. A raw GitHub checkout intentionally does
not track `lib/`; do not install `#main` as if it were a built release. This delivery
does not claim an npm registry publication.

Tested official DSH reference:
`b150a551b8d465e31e418e1b2eaf5e79bbb7d28e`.
