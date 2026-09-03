import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { Context } from "@deepseek-ai/cordis";

import { RelayEventsService } from "../events-service.js";
import { RelayStore } from "../src/runtime/store.mjs";

test("EPG-008: schema v4 upgrades delivery Wait snapshots through v10 without data loss", async () => {
  const directory = await mkdtemp(join(tmpdir(), "relay-events-v4-"));
  const databasePath = join(directory, "events.sqlite");
  try {
    new RelayStore(databasePath).close();
    const old = new DatabaseSync(databasePath);
    old.exec(`
      DROP INDEX events_trusted_correlation;
      ALTER TABLE events DROP COLUMN correlation_key;
      ALTER TABLE delivery_waits DROP COLUMN wait_snapshot_json;
      ALTER TABLE delivery_waits DROP COLUMN ordinal;
      DELETE FROM relay_schema;
      INSERT INTO relay_schema (version, applied_at) VALUES (4, '2026-01-01T00:00:00.000Z');
    `);
    old.close();

    const migrated = new RelayStore(databasePath);
    const columns = migrated.database.prepare("PRAGMA table_info(delivery_waits)").all().map(column => column.name);
    assert.ok(columns.includes("ordinal"));
    assert.ok(columns.includes("wait_snapshot_json"));
    assert.equal(migrated.database.prepare("SELECT MAX(version) AS version FROM relay_schema").get().version, 10);
    migrated.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("EP07-012: schema v5 adds durable Monitor lifecycle and notification evidence", async () => {
  const directory = await mkdtemp(join(tmpdir(), "relay-events-v5-"));
  const databasePath = join(directory, "events.sqlite");
  try {
    new RelayStore(databasePath).close();
    const old = new DatabaseSync(databasePath);
    for (const column of ["terminal_at", "terminal_actor", "terminal_reason_detail", "terminal_reason_code", "paused"]) {
      old.exec(`ALTER TABLE monitors DROP COLUMN ${column}`);
    }
    old.exec("DELETE FROM relay_schema; INSERT INTO relay_schema (version, applied_at) VALUES (5, '2026-01-01T00:00:00.000Z')");
    old.close();
    const migrated = new RelayStore(databasePath);
    const columns = new Set(migrated.database.prepare("PRAGMA table_info(monitors)").all().map(column => column.name));
    for (const column of ["paused", "terminal_reason_code", "terminal_reason_detail", "terminal_actor", "terminal_at"]) assert.ok(columns.has(column));
    assert.ok(migrated.database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='notification_outcomes'").get());
    assert.ok(migrated.database.prepare("PRAGMA table_info(events)").all().some(column => column.name === "correlation_key"));
    assert.equal(migrated.database.prepare("SELECT MAX(version) AS version FROM relay_schema").get().version, 10);
    migrated.close();
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("EPG-008/EP08-005: schema v9 adds notification retry count and provider receipt", async () => {
  const directory = await mkdtemp(join(tmpdir(), "relay-events-v9-"));
  const databasePath = join(directory, "events.sqlite");
  try {
    new RelayStore(databasePath).close();
    const old = new DatabaseSync(databasePath);
    old.exec(`
      ALTER TABLE notification_outcomes DROP COLUMN receipt_id;
      ALTER TABLE notification_outcomes DROP COLUMN attempt_count;
      DELETE FROM relay_schema;
      INSERT INTO relay_schema (version, applied_at) VALUES (9, '2026-01-01T00:00:00.000Z');
    `);
    old.close();
    const migrated = new RelayStore(databasePath);
    const columns = new Set(migrated.database.prepare("PRAGMA table_info(notification_outcomes)").all().map(column => column.name));
    assert.ok(columns.has("receipt_id"));
    assert.ok(columns.has("attempt_count"));
    assert.equal(migrated.database.prepare("SELECT MAX(version) AS version FROM relay_schema").get().version, 10);
    migrated.close();
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("EP01-001/002: continuation is normalized and persisted with legacy-compatible defaults", async () => {
  const service = createService();
  try {
    const complete = registration("continuation", "review.completed");
    complete.waits[0].continuation = {
      next_action: "Inspect the review and update the pull request.",
      success_condition: "Required review is approved.",
      constraints: ["Do not merge without approval."],
      artifacts: [{ kind: "github_pull_request", id: "octo/repo#42", label: "PR 42" }],
      on_failure: "Address requested changes and register the next wait.",
      on_timeout: "Notify the user that review is still pending.",
    };
    const stored = await service.registerWaits(complete);
    assert.deepEqual(stored.waits[0].continuation, {
      version: 1,
      ...complete.waits[0].continuation,
    });

    const legacy = await service.registerWaits(registration("continuation", "checks.completed"));
    assert.deepEqual(legacy.waits.find(wait => wait.status === "active").continuation, {
      version: 1,
      next_action: "",
      success_condition: "",
      constraints: [],
      artifacts: [],
      on_failure: "",
      on_timeout: "",
    });
    assert.equal(legacy.waits.find(wait => wait.expected_event === "review.completed").status, "superseded");
  } finally {
    await service.stop();
  }
});

test("EP01-004/005: invalid or oversized continuation leaves the previous wait active", async () => {
  const service = createService();
  try {
    await service.registerWaits(registration("atomic", "old.type"));
    for (const continuation of [
      [],
      { version: 2 },
      { constraints: "not-an-array" },
      { artifacts: [{ kind: "github_pull_request" }] },
      { next_action: "x".repeat(8_001) },
    ]) {
      const replacement = registration("atomic", "new.type");
      replacement.waits[0].continuation = continuation;
      await assert.rejects(service.registerWaits(replacement));
      const active = service.listWaits()[0].waits.filter(wait => wait.status === "active");
      assert.deepEqual(active.map(wait => wait.expected_event), ["old.type"]);
    }
  } finally {
    await service.stop();
  }
});

test("EP02-001/003/004: delivery contains only immutable matched Wait snapshots", async () => {
  const delivered = [];
  const service = createService({ async deliver(input) { delivered.push(structuredClone(input)); } });
  try {
    const proposal = registration("snapshot", "checks.completed");
    proposal.waits[0].continuation = {
      next_action: "Inspect failed checks.",
      artifacts: [{ kind: "github_pull_request", id: "octo/repo#7" }],
    };
    proposal.waits.push({
      ...proposal.waits[0],
      wait_id: "unrelated-review",
      expected_event: "review.completed",
    });
    await service.registerWaits(proposal);
    await service.handleEvent(event("snapshot-event", "checks.completed"));
    await service.registerWaits(registration("snapshot", "next.phase"));

    assert.equal(delivered.length, 1);
    const delivery = delivered[0].deliveries[0];
    assert.deepEqual(delivery.wait_ids, ["wait-snapshot-checks.completed"]);
    assert.equal(delivery.matched_waits.length, 1);
    assert.equal(delivery.matched_waits[0].status, "active");
    assert.equal(delivery.matched_waits[0].version, 0);
    assert.equal(delivery.matched_waits[0].continuation.next_action, "Inspect failed checks.");
    assert.deepEqual(delivery.matched_waits[0].continuation.artifacts, [
      { kind: "github_pull_request", id: "octo/repo#7" },
    ]);
    assert.ok(!JSON.stringify(delivery).includes("unrelated-review"));
    assert.match(delivery.routing_evidence[0], /exactly matches/);
  } finally {
    await service.stop();
  }
});

test("EP03-006/008: exact conflicts escalate independent of registration order", async () => {
  for (const order of [["a", "b"], ["b", "a"]]) {
    const delivered = [];
    const service = createService({ async deliver(input) { delivered.push(input); } });
    try {
      for (const session of order) await service.registerWaits(registration(session, "shared.type"));
      const result = await service.handleEvent(event(`conflict-${order.join("")}`, "shared.type"));
      assert.equal(result.event.decision.disposition, "escalate");
      assert.equal(result.event.deliveries.length, 0);
      assert.equal(delivered.length, 0);
      assert.deepEqual(
        service.listWaits().flatMap(item => item.waits).filter(wait => wait.status === "active").length,
        2,
      );
    } finally {
      await service.stop();
    }
  }
});

test("EP03-007: non-exclusive exact matches fan out atomically", async () => {
  const delivered = [];
  const service = createService({ async deliver(input) { delivered.push(input); } });
  try {
    for (const session of ["a", "b"]) {
      const proposal = registration(session, "shared.type");
      proposal.waits[0].exclusive = false;
      await service.registerWaits(proposal);
    }
    const result = await service.handleEvent(event("fanout", "shared.type"));
    assert.equal(result.event.decision.disposition, "deliver");
    assert.deepEqual(delivered.map(item => item.sessionId).sort(), ["a", "b"]);
  } finally {
    await service.stop();
  }
});

test("EP03-001/002: only a registered source capability can submit a trusted binding", async () => {
  const delivered = [];
  const service = createService({ async deliver(input) { delivered.push(input); } });
  try {
    await service.registerWaits(registration("bound-owner", "github.checks.completed"));
    const spoofed = await service.handleEvent({
      ...event("spoofed", "different.type"),
      session_id: "bound-owner",
      wait_id: "wait-bound-owner-github.checks.completed",
      trusted_binding: true,
    });
    assert.equal(spoofed.event.decision.disposition, "dismiss");
    assert.equal(delivered.length, 0);

    const capability = service.registerBoundEventSource({ id: "test.github", sources: ["github"] });
    const result = await capability.handleEvent({
      event: { ...event("trusted", "different.type"), source: "github" },
      binding: {
        session_id: "bound-owner",
        wait_id: "wait-bound-owner-github.checks.completed",
        wait_version: 0,
        source_subject: "octo/repo#42@abc",
      },
    });
    assert.equal(result.event.decision.disposition, "deliver");
    assert.equal(result.event.routing_attempts[0].router, "bound:test.github");
    assert.equal(delivered.length, 1);
    assert.equal(delivered[0].sessionId, "bound-owner");
    capability.dispose();
    assert.throws(() => capability.handleEvent({}), /not active/);
  } finally {
    await service.stop();
  }
});

test("EP04-006: trusted Connector dismissal is durable and bypasses Semantic Router", async () => {
  let routes = 0;
  const service = createService();
  try {
    service.registerRouter({ id: "test.semantic", async route() { routes += 1; throw new Error("router must not see unsupported Connector Events"); } });
    const capability = service.registerBoundEventSource({ id: "test.github", sources: ["github"] });
    const input = { ...event("unsupported-github", "github.unsupported"), source: "github", source_event_id: "delivery-unsupported" };
    const first = await capability.dismissEvent({ event: input, summary: "This signed GitHub event family is unsupported." });
    const duplicate = await capability.dismissEvent({ event: input, summary: "This signed GitHub event family is unsupported." });
    assert.equal(first.event.decision.disposition, "dismiss");
    assert.equal(first.event.decision.actionable, false);
    assert.equal(first.event.routing_attempts[0].router, "dismiss:test.github");
    assert.equal(duplicate.duplicate, true);
    assert.equal(routes, 0);
    assert.equal(first.event.deliveries.length, 0);
  } finally {
    await service.stop();
  }
});

test("EP03-003/004: stale and cross-Session bindings escalate without claiming waits", async () => {
  const delivered = [];
  const service = createService({ async deliver(input) { delivered.push(input); } });
  try {
    await service.registerWaits(registration("owner-a", "a.type"));
    await service.registerWaits(registration("owner-b", "b.type"));
    const capability = service.registerBoundEventSource({ id: "test.github", sources: ["github"] });
    for (const [id, binding] of [
      ["stale", { session_id: "owner-a", wait_id: "wait-owner-a-a.type", wait_version: 99 }],
      ["cross", { session_id: "owner-b", wait_id: "wait-owner-a-a.type", wait_version: 0 }],
    ]) {
      const result = await capability.handleEvent({
        event: { ...event(id, "provider.message"), source: "github" },
        binding,
      });
      assert.equal(result.event.decision.disposition, "escalate");
      assert.equal(result.event.deliveries.length, 0);
    }
    assert.equal(delivered.length, 0);
    assert.equal(service.listWaits().flatMap(item => item.waits).filter(wait => wait.status === "active").length, 2);
  } finally {
    await service.stop();
  }
});

test("EP04-004/EP11-002: conflicting provider identity reuse fails closed", async () => {
  const service = createService();
  try {
    await service.handleEvent({
      ...event("provider-first", "unsupported.provider"),
      source: "github",
      source_event_id: "delivery-42",
      fingerprint: "body-a",
    });
    await assert.rejects(service.handleEvent({
      ...event("provider-conflict", "unsupported.provider"),
      source: "github",
      source_event_id: "delivery-42",
      fingerprint: "body-b",
    }), /reused with conflicting content/);
    const inspected = service.store.inspectEvent("provider-first");
    assert.equal(inspected.decision.disposition, "dismiss");
    assert.equal(service.store.database.prepare("SELECT COUNT(*) AS count FROM events").get().count, 1);
  } finally {
    await service.stop();
  }
});

test("EP03-002/EP04-005: only trusted sources may use cross-source correlation keys", async () => {
  const service = createService();
  try {
    const first = await service.handleEvent({ ...event("public-correlation-a", "none"), correlation_key: "shared-key" });
    const second = await service.handleEvent({ ...event("public-correlation-b", "none"), correlation_key: "shared-key" });
    assert.equal(first.duplicate, false);
    assert.equal(second.duplicate, false);
    assert.equal(first.event.correlation_key, null);
    assert.equal(second.event.correlation_key, null);

    const source = service.registerBoundEventSource({ id: "test.correlation", sources: ["github"] });
    await service.registerWaits(registration("correlation-owner", "changed"));
    const bound = {
      session_id: "correlation-owner", wait_id: "wait-correlation-owner-changed", wait_version: 0,
    };
    const trusted = await source.handleEvent({
      event: {
        ...event("trusted-correlation", "changed"), source: "github",
        source_event_id: "delivery-trusted", correlation_key: "trusted-shared-key",
      }, binding: bound,
    });
    const replay = await source.handleEvent({
      event: {
        ...event("trusted-other-source-id", "changed"), source: "github",
        source_event_id: "poll-transition", fingerprint: "different", correlation_key: "trusted-shared-key",
      }, binding: bound,
    });
    assert.equal(trusted.duplicate, false);
    assert.equal(replay.duplicate, true);
    assert.equal(replay.event.event_id, trusted.event.event_id);
    await assert.rejects(source.handleEvent({
      event: {
        ...event("trusted-correlation", "changed"),
        source: "github",
        source_event_id: "delivery-trusted",
        fingerprint: "mutated-provider-body",
        correlation_key: "trusted-shared-key",
      },
      binding: bound,
    }), /reused with conflicting content/);
    assert.equal(service.store.database.prepare("SELECT COUNT(*) AS count FROM events").get().count, 3);
  } finally { await service.stop(); }
});

test("EP07-003/004/006/007/009: Monitor inspect, cadence, pause, resume, run guard, and stop are durable", async () => {
  let now = new Date("2026-01-01T00:00:00.000Z");
  const service = createService(undefined, { clock: () => new Date(now) });
  service.registerMonitorProvider({
    id: "test.monitors",
    async prepare({ monitors }) { return monitors.map(monitor => ({ ...monitor, baseline_observation: { state: "waiting" } })); },
    async checkMonitor() { return { status: "checked" }; },
  });
  try {
    const proposal = registration("lifecycle", "state.changed");
    proposal.monitors = [{
      monitor_id: "monitor-lifecycle", wait_id: proposal.waits[0].wait_id, lifecycle: "one_shot",
      observer: { provider: "fixture" }, detector: { kind: "field_transition", field: "state", to: "done", event_type: "state.changed" },
      schedule: { interval_seconds: 60 }, artifact: { kind: "trusted-provider" },
    }];
    await service.registerWaits(proposal);
    const initial = service.inspectMonitor("monitor-lifecycle");
    assert.equal(initial.state, "active");
    assert.equal(initial.version, 0);
    const paused = service.pauseMonitor("monitor-lifecycle", { expectedVersion: 0 });
    assert.equal(paused.state, "paused");
    assert.equal(paused.next_check_at, null);
    assert.equal(service.store.beginMonitorCheck("monitor-lifecycle", "worker", 1000, { force: true }).status, "paused");
    assert.throws(() => service.resumeMonitor("monitor-lifecycle", { expectedVersion: 0 }), /version changed/);
    now = new Date("2026-01-01T00:01:00.000Z");
    const resumed = service.resumeMonitor("monitor-lifecycle", { expectedVersion: 1 });
    assert.equal(resumed.state, "active");
    assert.equal(resumed.next_check_at, "2026-01-01T00:02:00.000Z");
    const updated = service.updateMonitorCadence("monitor-lifecycle", 120, { expectedVersion: 2 });
    assert.equal(updated.schedule.interval_seconds, 120);
    assert.equal(updated.next_check_at, "2026-01-01T00:03:00.000Z");
    assert.equal(updated.last_observation.data.state, "waiting");
    const stopped = service.stopMonitor("monitor-lifecycle", {
      expectedVersion: 3, actor: "session:lifecycle", reasonCode: "stopped_by_agent", detail: "No longer needed",
    });
    assert.equal(stopped.state, "cancelled");
    assert.deepEqual(stopped.terminal_reason, {
      code: "stopped_by_agent", detail: "No longer needed", actor: "session:lifecycle", at: "2026-01-01T00:01:00.000Z",
    });
    assert.deepEqual(service.store.listDueMonitors("2026-01-02T00:00:00.000Z"), []);
  } finally { await service.stop(); }
});

test("EP11-004: Monitor cadence, jitter, failure, and backoff budgets reject exact one-over-boundary proposals atomically", async () => {
  const service = createService();
  service.registerMonitorProvider({
    id: "test.budgets",
    async prepare({ monitors }) { return monitors.map(monitor => ({ ...monitor, baseline_observation: { state: "waiting" } })); },
    async checkMonitor() { return { status: "checked" }; },
  });
  try {
    const invalid = [
      { schedule: { interval_seconds: 0 } },
      { schedule: { interval_seconds: 86_401 } },
      { schedule: { interval_seconds: 60.5 } },
      { schedule: { interval_seconds: 60, jitter_seconds: 61 } },
      { retry: { degraded_after: 0, fail_after: 1 } },
      { retry: { degraded_after: 2, fail_after: 1 } },
      { retry: { degraded_after: 1, fail_after: 101 } },
      { retry: { degraded_after: 1, fail_after: 2, backoff_seconds: [0] } },
      { retry: { degraded_after: 1, fail_after: 2, backoff_seconds: Array(21).fill(1) } },
    ];
    for (const [index, override] of invalid.entries()) {
      const proposal = registration(`budget-${index}`, "state.changed");
      proposal.monitors = [{
        monitor_id: `monitor-budget-${index}`, wait_id: proposal.waits[0].wait_id, lifecycle: "one_shot",
        observer: { provider: "fixture" }, detector: { kind: "field_transition", field: "state", to: "done", event_type: "state.changed" },
        artifact: { kind: "trusted-provider" }, ...override,
      }];
      await assert.rejects(service.registerWaits(proposal), /monitor (?:interval|jitter|degraded|fail|backoff)/u);
      assert.equal(service.store.getWaitRegistration(proposal.sessionId), null, "invalid Monitor must not persist its Wait registration");
    }
  } finally { await service.stop(); }
});

test("EP07-005: target update commits a new baseline epoch and failed baseline preserves the old Monitor", async () => {
  let baselineFails = false;
  const service = createService();
  service.registerMonitorProvider({
    id: "test.rebaseline",
    async prepare({ monitors }) {
      if (baselineFails) throw new Error("synthetic baseline failure");
      return monitors.map(monitor => ({ ...monitor, baseline_observation: { target: monitor.artifact.target, state: "open" } }));
    },
    async checkMonitor() { return { status: "checked" }; },
  });
  try {
    const proposal = registration("rebaseline", "target.changed");
    proposal.monitors = [{
      monitor_id: "monitor-rebaseline", wait_id: proposal.waits[0].wait_id, lifecycle: "one_shot",
      observer: { provider: "fixture" }, artifact: { kind: "fixture", target: "target-a" },
      detector: { kind: "snapshot_changed", event_type: "target.changed" }, schedule: { interval_seconds: 60 },
    }];
    await service.registerWaits(proposal);
    const initial = service.inspectMonitor("monitor-rebaseline");
    const updated = await service.rebaselineMonitor("monitor-rebaseline", {
      artifact: { kind: "fixture", target: "target-b" },
    }, { expectedVersion: initial.version });
    assert.notEqual(updated.active_version_id, initial.active_version_id);
    assert.equal(updated.versions.length, 2);
    assert.equal(updated.last_observation.data.target, "target-b");
    assert.equal(updated.observations.length, 2);

    baselineFails = true;
    await assert.rejects(service.rebaselineMonitor("monitor-rebaseline", {
      artifact: { kind: "fixture", target: "target-c" },
    }, { expectedVersion: updated.version }), /synthetic baseline failure/);
    const unchanged = service.inspectMonitor("monitor-rebaseline");
    assert.equal(unchanged.active_version_id, updated.active_version_id);
    assert.equal(unchanged.version, updated.version);
    assert.equal(unchanged.versions.length, 2);
    assert.equal(unchanged.last_observation.data.target, "target-b");

    baselineFails = false;
    const rolledBack = await service.rebaselineMonitor("monitor-rebaseline", {
      artifact: initial.artifact,
    }, { expectedVersion: unchanged.version });
    assert.equal(rolledBack.active_version_id, initial.active_version_id, "rollback must reactivate the retained immutable version");
    assert.equal(rolledBack.versions.length, 2, "rollback must not duplicate an existing immutable version");
    assert.equal(rolledBack.observations.length, 3, "rollback must record a fresh baseline check");
    assert.equal(rolledBack.last_observation.data.target, "target-a");
  } finally { await service.stop(); }
});

test("EP08-001: Router failure budget commits an inspectable escalation", async () => {
  const service = createService(undefined, { routingFailureLimit: 3 });
  try {
    service.registerRouter({ id: "test.failing", async route() { throw new Error("model unavailable SECRET"); } });
    const input = event("router-failure", "provider.message");
    await assert.rejects(service.handleEvent(input), /model unavailable/);
    await assert.rejects(service.handleEvent(input), /model unavailable/);
    const terminal = await service.handleEvent(input);
    assert.equal(terminal.event.state, "resolved");
    assert.equal(terminal.event.decision.disposition, "escalate");
    assert.equal(terminal.event.routing_attempts.length, 3);
    assert.match(terminal.event.decision.summary, /could not safely route/);
    assert.ok(!JSON.stringify(terminal.event.decision).includes("SECRET"));
    assert.deepEqual(terminal.event.deliveries, []);
    assert.equal(terminal.event.notification.state, "unavailable");
  } finally {
    await service.stop();
  }
});

test("EP08-002/003: escalation notifies one registered provider with bounded content and records failures visibly", async () => {
  const notified = [];
  const delivered = createService();
  delivered.registerNotificationProvider({ id: "test.notifier", async notify(input) { notified.push(input); } });
  try {
    await delivered.registerWaits(registration("notify-a", "same.type"));
    await delivered.registerWaits(registration("notify-b", "same.type"));
    const result = await delivered.handleEvent(event("notify-event", "same.type"));
    assert.equal(result.event.decision.disposition, "escalate");
    assert.equal(result.event.notification.state, "delivered");
    assert.equal(result.event.notification.provider, "test.notifier");
    assert.equal(notified.length, 1);
    assert.deepEqual(Object.keys(notified[0].event).sort(), ["event_id", "source", "type"]);
    const duplicate = await delivered.handleEvent(event("notify-event", "same.type"));
    assert.equal(duplicate.duplicate, true);
    assert.equal(notified.length, 1);
  } finally { await delivered.stop(); }

  const failed = createService();
  failed.registerNotificationProvider({ id: "test.failing", async notify() {
    throw Object.assign(new Error("SECRET notifier body"), { errorClass: "provider_unavailable" });
  } });
  try {
    await failed.registerWaits(registration("fail-a", "same.type"));
    await failed.registerWaits(registration("fail-b", "same.type"));
    const result = await failed.handleEvent(event("failed-notification", "same.type"));
    assert.deepEqual(result.event.notification.state, "failed");
    assert.equal(result.event.notification.error_class, "provider_unavailable");
    assert.ok(!JSON.stringify(result.event.notification).includes("SECRET"));
  } finally { await failed.stop(); }
});

test("EP08-005/006: unavailable notification retries explicitly, records receipt, and cannot auto-duplicate", async () => {
  const service = createService();
  try {
    await service.registerWaits(registration("retry-notify-a", "same.type"));
    await service.registerWaits(registration("retry-notify-b", "same.type"));
    const first = await service.handleEvent(event("retry-notification", "same.type"));
    assert.equal(first.event.notification.state, "unavailable");
    assert.equal(first.event.notification.attempt_count, 1);
    const duplicate = await service.handleEvent(event("retry-notification", "same.type"));
    assert.equal(duplicate.event.notification.attempt_count, 1, "duplicate ingestion must not silently retry a notification");

    const calls = [];
    service.registerNotificationProvider({ id: "test.receipts", async notify(input) {
      calls.push(input);
      return { receipt_id: "provider-receipt-123" };
    } });
    const retried = await service.retryNotification(first.event.event_id);
    assert.equal(retried.state, "delivered");
    assert.equal(retried.provider, "test.receipts");
    assert.equal(retried.receipt_id, "provider-receipt-123");
    assert.equal(retried.attempt_count, 2);
    assert.equal(calls.length, 1);
    await assert.rejects(service.retryNotification(first.event.event_id), /not retryable/u);
    assert.equal(calls.length, 1);
  } finally { await service.stop(); }
});

test("EP08-008: background recovery terminalizes a stuck routing Event without redelivery", async () => {
  let attempts = 0;
  let resolveTerminal;
  const terminalized = new Promise(resolve => { resolveTerminal = resolve; });
  const service = createService(undefined, { routingFailureLimit: 2, dispatchPollIntervalMs: 5 });
  try {
    service.registerRouter({ id: "test.failing", async route() {
      attempts += 1;
      if (attempts >= 2) resolveTerminal();
      throw new Error("offline");
    } });
    await assert.rejects(service.handleEvent(event("background-routing", "provider.message")), /offline/);
    await terminalized;
    await new Promise(resolve => setTimeout(resolve, 10));
    const inspected = service.store.inspectEvent("background-routing");
    assert.equal(inspected.state, "resolved");
    assert.equal(inspected.decision.disposition, "escalate");
    assert.equal(attempts, 2);
  } finally {
    await service.stop();
  }
});

test("EP08-002/EP12-006: Delivery budget terminalizes durably and safe retry reuses the Activation", async () => {
  let now = new Date("2026-01-01T00:00:00.000Z");
  let rejectInbox = true;
  const attempts = [];
  const service = createService({ async deliver(input) {
    attempts.push(input.activationId);
    if (rejectInbox) throw new Error("synthetic inbox refusal SECRET");
  } }, {
    clock: () => new Date(now), deliveryFailureLimit: 2, deliveryRetryBaseMs: 1_000,
  });
  try {
    await service.registerWaits(registration("delivery-budget-owner", "delivery.ready"));
    const first = await service.handleEvent(event("delivery-budget-event", "delivery.ready"));
    assert.equal(first.dispatchResults[0].status, "retry");
    assert.equal(first.event.state, "dispatched");
    assert.equal(first.event.activations[0].attempt_count, 1);
    assert.equal(first.event.activations[0].next_attempt_at, "2026-01-01T00:00:01.000Z");

    now = new Date("2026-01-01T00:00:01.000Z");
    const exhausted = await service.handleEvent(event("delivery-budget-event", "delivery.ready"));
    assert.equal(exhausted.dispatchResults[0].status, "failed");
    assert.equal(exhausted.event.state, "resolved");
    assert.equal(exhausted.event.deliveries[0].state, "failed");
    assert.equal(exhausted.event.activations[0].terminal_reason_code, "delivery_retry_exhausted");
    assert.equal(exhausted.event.notification.state, "unavailable");
    assert.ok(!JSON.stringify(exhausted.event.notification).includes("SECRET"));

    const activationId = exhausted.event.activations[0].activation_id;
    rejectInbox = false;
    const retried = await service.retryActivation(activationId);
    assert.equal(retried.result.status, "accepted");
    assert.equal(retried.activation.activation_id, activationId);
    assert.deepEqual(attempts, [activationId, activationId, activationId]);
    const resolved = service.store.inspectEvent("delivery-budget-event");
    assert.equal(resolved.deliveries[0].state, "resolved");
    assert.equal(resolved.activations[0].terminal_reason_code, null);
  } finally { await service.stop(); }
});

test("EP11-009: retention redacts only eligible terminal detail and rolls back atomically on fault", async () => {
  const directory = await mkdtemp(join(tmpdir(), "relay-retention-"));
  const path = join(directory, "events.sqlite");
  const clock = () => new Date("2026-01-01T00:00:00.000Z");
  try {
    const service = createService(undefined, { databasePath: path, clock });
    await service.handleEvent({ ...event("terminal-a", "none"), body: "PRIVATE-A" });
    await service.handleEvent({ ...event("terminal-b", "none"), body: "PRIVATE-B" });
    service.store.ingestEvent({ ...event("unresolved", "pending"), body: "KEEP-UNRESOLVED" });
    await service.stop();

    let store = new RelayStore(path, { clock });
    const evidenceBefore = {
      decisions: store.database.prepare("SELECT COUNT(*) AS count FROM routing_decisions").get().count,
      events: store.database.prepare("SELECT COUNT(*) AS count FROM events").get().count,
    };
    store.database.exec(`
      CREATE TRIGGER fail_retention BEFORE UPDATE OF payload_json ON events
      WHEN NEW.id = 'terminal-b' BEGIN SELECT RAISE(ABORT, 'synthetic retention fault'); END;
    `);
    assert.throws(() => store.cleanupRetention({ terminalBefore: "2027-01-01T00:00:00Z" }), /synthetic retention fault/);
    assert.equal(store.inspectEvent("terminal-a").payload.body, "PRIVATE-A", "first row must roll back with the failed batch");
    assert.equal(store.inspectEvent("terminal-b").payload.body, "PRIVATE-B");
    store.database.exec("DROP TRIGGER fail_retention");

    const result = store.cleanupRetention({ terminalBefore: "2027-01-01T00:00:00Z" });
    assert.equal(result.redacted_events, 2);
    assert.deepEqual(store.inspectEvent("terminal-a").payload.__relay_retention_redacted, 1);
    assert.equal(store.inspectEvent("unresolved").payload.body, "KEEP-UNRESOLVED");
    assert.equal(result.retained_events, evidenceBefore.events);
    assert.equal(result.retained_decisions, evidenceBefore.decisions);
    assert.equal(store.inspectEvent("terminal-a").decision.disposition, "dismiss");
    store.close();

    store = new RelayStore(path, { clock });
    assert.equal(store.cleanupRetention({ terminalBefore: "2027-01-01T00:00:00Z" }).redacted_events, 0,
      "cleanup must be restart-safe and idempotent");
    assert.equal(store.inspectEvent("unresolved").payload.body, "KEEP-UNRESOLVED");
    store.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

function createService(inbox = { async deliver() {} }, options = {}) {
  return new RelayEventsService(new Context(), {
    databasePath: ":memory:",
    dispatchPollIntervalMs: 60_000,
    inbox,
    ...options,
  });
}

function registration(sessionId, eventType) {
  return {
    sessionId,
    taskSummary: `Wait for ${eventType}`,
    waits: [{
      wait_id: `wait-${sessionId}-${eventType}`,
      phase: "waiting",
      exclusive: true,
      expected_event: eventType,
      caused_by: "acceptance test",
      actors: [],
      entities: [],
      prior_exchange: "Continue the existing work.",
    }],
  };
}

function event(id, type) {
  return { event_id: id, source: "test", fingerprint: id, type };
}
