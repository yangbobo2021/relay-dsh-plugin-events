# Relay DSH Events Plugin Specification

Status: Accepted for `0.1.0`

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
- notification delivery for escalated Events.

## Public Service Contract

`ctx.relayEvents.apiVersion` is `1`. The public service exposes high-level event
operations and two replaceable provider registrations:

- `registerRouter(provider)` accepts exactly one active Router with stable `id` and
  `route({ event, eventRecord, sessions })`;
- `registerMonitorProvider(provider)` accepts exactly one active Monitor provider
  with `prepare`, `checkMonitor`, and lifecycle-safe disposal;
- Wait/Event operations: `registerWaits`, `cancelWaits`, `listWaits`,
  `handleEvent`, and `dispatchSession`;
- Monitor persistence operations: `beginMonitorCheck`, `completeMonitorCheck`,
  `failMonitorCheck`, `abandonMonitorCheck`, and `listDueMonitors`. No SQLite
  handle, mutable map, or DSH Agent object crosses the service boundary.

Provider registration is owned by the registering Cordis fiber. Duplicate active
providers fail closed. Unloading a provider restores the exact fallback Router or
the Monitor-unavailable state without unloading Events.

## Reliability

- Event ingestion is idempotent by source identity and fingerprint.
- Routing decisions are validated against the current Wait snapshot and committed
  once.
- Delivery creation and Wait claim are atomic.
- Failed admission keeps the same Event, Delivery, and Activation IDs queued.
- Admission succeeds when the stable inbox message has been flushed to DSH
  persistence, not when the model turn finishes. A retry recognizes the persisted
  Activation message and does not enqueue another follow-up.
- Reappearing Monitor trigger keys do not create another Delivery or pause a
  rearmed Monitor; its replacement Wait stays active.
- A background recovery scan retries queued Deliveries after failure or Host restart.
- Events never create DSH Sessions and never switch the selected Web Session.
- Shutdown stops new operations, waits for in-flight work, disposes routes/listeners,
  and closes SQLite last.

## Security

- Loopback ingress may omit a token. Non-loopback ingress requires an exact Bearer
  token and fails closed when no token is configured.
- Event fields remain untrusted content in the injected DSH envelope.
- Payload size is bounded before JSON parsing.
- Provider-specific signatures are outside this generic ingress boundary.

## Delivery Acceptance

The release must pass unit, contract, packed-package, official-DSH, and composition
acceptance. The executable scenario list is in
[`docs/acceptance-scenarios.md`](docs/acceptance-scenarios.md).
