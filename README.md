# Relay Events for DeepSeek Harness

`relay-dsh-plugin-events` is the durable, provider-neutral Wait/Event/Delivery
core for official DeepSeek Harness. It adds Agent tools, generic JSON ingress,
delivery to the owning existing Session, recovery, and a Waiting Events settings
surface without adding an execution backend.

```bash
dsh plugin --profile web add github:yangbobo2021/relay-dsh-plugin-events#main
dsh web
```

Semantic routing and Monitor execution are separate plugins. Without a Router,
Events uses exact event-type matching. Without Monitors, Wait-only registration
and external ingress remain fully usable.

See [SPEC.md](SPEC.md) and
[delivery scenarios](docs/acceptance-scenarios.md).

Set `DSH_ROOT` to the prepared immutable official DSH checkout, then run
`npm ci --ignore-scripts && npm run verify`.

Tested official DSH reference:
`b150a551b8d465e31e418e1b2eaf5e79bbb7d28e`.
