# Events Delivery Acceptance Scenarios

Official DSH references: `b150a551b8d465e31e418e1b2eaf5e79bbb7d28e`,
`0a53fb55bea101816fa226bb964ae2bed71c343b`, and
`dd6322d604e00eec1ba5e0c8541159906a21094a`.

| ID | Scenario | Required result | Evidence |
| --- | --- | --- | --- |
| EVT-001 | Events-only boot | Packed plugin installs into a pristine official DSH profile and Host boots without Codex, Claude, Router, or Monitors. | package acceptance |
| EVT-002 | Exact fallback delivery | An Event whose type equals one active Wait is delivered once to that existing Session. | unit + Host contract |
| EVT-003 | Unmatched fallback | An unmatched Event is durably dismissed with an inspectable reason and starts no Session. | unit |
| EVT-004 | Duplicate ingress | Repeating the same provider identity/fingerprint returns the original Event and creates no second Delivery. | unit + HTTP |
| EVT-005 | Router substitution | A fake registered Router receives the compact snapshot; unload restores exact fallback. | service contract |
| EVT-006 | Duplicate Router | A second active Router registration fails without replacing the first. | service contract |
| EVT-007 | Monitor provider absence | Wait-only registration works; registration containing Monitors fails before replacing prior Waits. | service contract |
| EVT-008 | Atomic prepared Monitor registration | A fake Monitor provider baseline succeeds and Wait/Monitor records commit together; baseline failure changes neither. | integration |
| EVT-009 | Delivery retry identity | First admission fails, background recovery succeeds, and Event/Delivery/Activation IDs remain unchanged. | fake clock integration |
| EVT-010 | Restart recovery | A database with queued Delivery is reopened and recovered without re-routing or duplicate injection. | integration |
| EVT-011 | Ingress authorization | Loopback is accepted; non-loopback missing/wrong token is rejected; valid token succeeds. | HTTP unit |
| EVT-012 | Ingress bounds | Wrong method/content type, malformed JSON, and oversized bodies receive stable errors. | HTTP unit |
| EVT-013 | DSH tool ownership | Tools attach to every root Agent and use the authenticated Session ID rather than a model-supplied ID. | Host contract |
| EVT-014 | Management operations | List, open, cancel, and provider-backed run-now operate through the typed Remote. | Host/client contract |
| EVT-015 | Clean unload | New operations fail during shutdown; in-flight work settles; listeners, Remote, service, timers, and SQLite are released. | lifecycle integration |
| EVT-016 | Backend neutrality | Events-only, Events+Codex, and Events+Claude compositions contain no backend import or backend-name branch in Events. | static + official DSH |
| EVT-017 | Package boundary | Tarball contains built/public artifacts only and imports in a clean directory. | `npm pack` acceptance |
| EVT-018 | Wait continuation | Complete and legacy Waits normalize versioned continuation; invalid/oversized nested values fail before replacing prior Waits. | unit + SQLite |
| EVT-019 | Matched Wait envelope | Delivery contains only immutable matched Wait snapshots, continuation and routing evidence from the committed routing snapshot. | SQLite + inbox contract |
| EVT-020 | Exclusive conflict | Cross-Session exact matches involving exclusive Waits escalate independent of insertion order and claim nothing. | randomized-order integration |
| EVT-021 | Non-exclusive fan-out | Exact non-exclusive matches create one atomic Delivery per Session with complete matched cards. | SQLite integration |
| EVT-022 | Trusted bound source | Only a registered source capability can submit a binding; public payload ownership fields have no authority. | service + protocol security |
| EVT-023 | Stale/cross-Session binding | Invalid owner, Wait, version, or Session/Wait pair escalates with no claim or Delivery. | SQLite integration |
| EVT-024 | Safe schema initialization and upgrade | Missing, empty, and metadata-only storage initializes directly at schema v10; every historical schema v1-v9 is integrity-checked, verified-backup protected, transactionally upgraded, structurally validated, and idempotent while preserving data. Failed migration rolls back; unknown non-empty and future schemas fail closed without mutation. | real file migration matrix + official DSH startup |
| EVT-025 | Router failure terminal state | Repeated Router failure reaches the configured budget, commits one inspectable escalation, creates no Delivery, and omits raw provider errors/secrets. | unit + SQLite |
| EVT-026 | Incomplete Event recovery | The background scan resumes `received`/`routing` Events and reaches a single terminal decision without redelivery or duplicate attempts. | fake-clock integration + restart |
| EVT-027 | Conflicting provider identity | Reuse of one source delivery identity with different content fails closed, preserves the original terminal Event, and creates no second record. | SQLite security integration |
| EVT-028 | Monitor lifecycle | Inspect, cadence update, pause, resume, run-now guard, and stop use optimistic versions, preserve baseline, and persist terminal actor/reason/time. | SQLite + Host/client contract |
| EVT-029 | Historical management snapshot | Live and terminal Waits/Monitors plus recent Events and decisions remain inspectable without reactivating or mutating them. | management Remote + browser |
| EVT-030 | Escalation notification outcome | One configured provider receives bounded escalation content once; absent and failed providers record visible `unavailable`/`failed` outcomes without leaking raw errors. | service + SQLite |
| EVT-031 | Trusted cross-source convergence | A trusted webhook and Monitor transition sharing one canonical correlation key create one Event/Delivery regardless of source order; public payload correlation fields have no authority. | connector-monitor composition |
| EVT-032 | Notification safe retry | Duplicate ingestion never retries a terminal notification; an explicit retry is allowed only for unavailable/failed outcomes, increments attempts, and stores a bounded provider receipt. | service + SQLite + browser |
| EVT-033 | Global admission budgets | Exact rate and concurrency limits reject only excess Event admission with stable 429/503 responses while management remains usable. | HTTP + concurrency integration |
| EVT-034 | Management pagination and focus | Stable keyset pages, state/source filters, background refresh, dialog focus trap/return, Escape isolation, and draft preservation work in English and Chinese. | official DSH browser |
| EVT-035 | Live Bundle catalog | Packed Monitor extensions appear in a distinct creation catalog with live status, type/version/origin, Events, capabilities, lifecycle, permissions, and remediation; no credential/handle fields render. | official DSH browser |
| EVT-036 | Bundle catalog pagination/localization | A 24-type packed catalog has stable non-overlapping keyset pages; locale change reloads localized provider data; wide/narrow and light/dark layouts remain accessible. | service + official DSH browser |
| EVT-037 | Immutable rollback | A successful target update adds one version; failed baseline changes nothing; rollback reuses retained content, records a new baseline, and preserves Monitor/Wait identity. | SQLite service |
| EVT-038 | Empty and fault presentation | Events-only UI renders loading/empty/history states, transitions from zero to one background Event, and exposes retryable failures without fabricating success. | official DSH browser + client contract |
