# Relay DSH Events Plugin Specification

Status: Accepted; `0.2.1` baseline plus Event Productization contracts

## Purpose

`relay-dsh-plugin-events` is the provider-neutral durable event core for official
DeepSeek Harness. It stores Waits and Events, selects a registered Router (or an
exact fallback), creates idempotent Deliveries, and admits each Delivery through
the owning existing DSH Session.

## Boundary

The plugin owns:

- Wait, Event, routing-attempt, routing-decision, Delivery, Activation, and Monitor
  persistence in one local SQLite database;
- the `relayEvents` Cordis service and its versioned Router/Monitor provider slots;
- Agent-authored versioned Wait continuation and immutable matched-Wait Delivery
  snapshots;
- capability-scoped trusted bound-Event source registration;
- exact event-type fallback routing when no Router provider is registered;
- delivery to the existing DSH Session, stable Activation identity, and background
  recovery of queued Deliveries;
- `relay_register_waits` and `relay_cancel_waits` Agent tools;
- generic JSON ingress at `POST /api/relay/events`;
- the Waiting Events management Remote and Settings section.

The plugin does not own:

- model calls or semantic routing policy;
- Monitor observation, detection, scheduling, or generated code;
- email, CI, or provider-specific Webhook normalization;
- conversation creation or an execution backend;
- provider-specific notification transport implementation. Events owns provider
  registration, bounded escalation calls, durable outcomes, receipt IDs, attempt
  counts, and explicit safe retry.

## Public Service Contract

`ctx.relayEvents.apiVersion` is `1`. The public service exposes high-level event
operations, two replaceable providers, and capability-scoped bound sources:

- `registerRouter(provider)` accepts exactly one active Router with stable `id` and
  `route({ event, eventRecord, sessions })`;
- `registerMonitorProvider(provider)` accepts exactly one active Monitor provider
  with `prepare`, `checkMonitor`, and lifecycle-safe disposal;
- `registerBundleCatalogProvider(provider)` accepts one live, secret-safe Monitor
  Bundle catalog projection; management snapshots keyset-page it independently from
  Event history and never infer creation capabilities from persisted instances;
- `registerBoundEventSource(provider)` accepts non-overlapping declared Event source
  names and returns an unforgeable capability whose `handleEvent({ event, binding })`
  path can select one active Wait without semantic routing;
- Wait/Event operations: `registerWaits`, `cancelWaits`, `listWaits`,
  `handleEvent`, and `dispatchSession`;
- Monitor persistence operations: `beginMonitorCheck`, `completeMonitorCheck`,
  `failMonitorCheck`, `abandonMonitorCheck`, and `listDueMonitors`. No SQLite
  handle, mutable map, or DSH Agent object crosses the service boundary.
- `registerNotificationProvider(provider)` accepts at most one capability-scoped
  escalation notifier. Missing and failed notification attempts remain durable,
  inspectable outcomes and never fabricate a Session.
- Monitor lifecycle operations inspect, pause, resume, update cadence, run now, and
  stop with optimistic versions and durable terminal actor/reason evidence.
  Rebaseline creates an immutable version or reactivates an identical retained
  version for rollback, always recording a fresh baseline before switching it active.

Provider registration is owned by the registering Cordis fiber. Duplicate active
providers fail closed. Unloading a provider restores the exact fallback Router or
the Monitor-unavailable state without unloading Events.

Wait continuation is normalized to version 1 and persisted inside the immutable Wait
card. A Delivery stores the exact matched Wait snapshot and routing evidence at commit
time. Public Event payload fields cannot assert a trusted binding, and a stale or
cross-Session binding escalates without claiming a Wait.

## Reliability

- Event ingestion is idempotent by source identity and fingerprint. Reusing one
  provider identity with conflicting content fails closed.
- Capability-scoped sources and bound Monitors may provide a bounded canonical
  correlation key for cross-source convergence. Generic public Event content cannot
  set that key.
- Routing decisions are validated against the current Wait snapshot and committed
  once.
- Delivery creation and Wait claim are atomic.
- Exact routing escalates conflicting cross-Session exclusive matches instead of
  selecting an owner by iteration order. Non-exclusive matches may fan out.
- Delivery retries reproduce the committed matched Wait snapshots even after the
  Session registers replacement Waits.
- Failed admission keeps the same Event, Delivery, and Activation IDs queued.
- Admission succeeds when the stable inbox message has been flushed to DSH
  persistence, not when the model turn finishes. A retry recognizes the persisted
  Activation message and does not enqueue another follow-up.
- Reappearing Monitor trigger keys do not create another Delivery or pause a
  rearmed Monitor; its replacement Wait stays active.
- Router failures are durably counted. Exhausting the configured failure budget
  commits one inspectable `escalate` decision without exposing provider errors or
  secrets and without creating a Delivery.
- A background recovery scan advances both incomplete `received`/`routing` Events
  and queued Deliveries, including after Host restart.
- A background recovery scan retries queued Deliveries after failure or Host restart.
- Events never create DSH Sessions and never switch the selected Web Session.
- Shutdown stops new operations, waits for in-flight work, disposes routes/listeners,
  and closes SQLite last.
- The management snapshot includes live and historical registrations plus recent
  Events; management mutations use authoritative versions and never silently apply
  to stale rows.

## Security

- Loopback ingress may omit a token. Non-loopback ingress requires an exact Bearer
  token and fails closed when no token is configured.
- Event fields remain untrusted content in the injected DSH envelope.
- Agent-authored continuation is structurally bounded and remains separate from
  external Event content.
- Payload size is bounded before JSON parsing.
- Admission is globally bounded by a sliding rate window and an in-flight
  concurrency ceiling; overload returns fixed public errors and never exposes
  internal exception text.
- Provider-specific signatures are outside this generic ingress boundary.

## Delivery Acceptance

The release must pass unit, contract, packed-package, official-DSH, and composition
acceptance. The executable scenario list is in
[`docs/acceptance-scenarios.md`](docs/acceptance-scenarios.md).
