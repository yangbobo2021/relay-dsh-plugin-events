# Events Delivery Acceptance Scenarios

Official DSH reference: `b150a551b8d465e31e418e1b2eaf5e79bbb7d28e`

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

