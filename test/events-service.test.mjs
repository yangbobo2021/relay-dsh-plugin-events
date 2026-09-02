import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { Context } from "@deepseek-ai/cordis";

import { RelayEventsService } from "../events-service.js";

test("exact fallback delivers once and duplicate ingestion stays idempotent", async () => {
  const delivered = [];
  const service = createService({ async deliver(input) { delivered.push(structuredClone(input)); } });
  try {
    await service.registerWaits(registration("session-exact", "build.completed"));
    const first = await service.handleEvent(event("event-exact", "build.completed"));
    const duplicate = await service.handleEvent(event("event-exact", "build.completed"));
    assert.equal(first.event.state, "resolved");
    assert.equal(duplicate.duplicate, true);
    assert.equal(delivered.length, 1);
    assert.equal(delivered[0].sessionId, "session-exact");
  } finally {
    await service.stop();
  }
});

test("router registration is exclusive and disposal restores exact fallback", async () => {
  const delivered = [];
  const service = createService({ async deliver(input) { delivered.push(input); } });
  try {
    await service.registerWaits(registration("session-router", "exact.type"));
    const release = service.registerRouter({
      id: "test.semantic",
      async route({ sessions }) {
        return decision(sessions[0].session_id, sessions[0].waits[0].wait_id);
      },
    });
    assert.throws(() => service.registerRouter({ id: "test.other", async route() {} }), /already registered/);
    const semantic = await service.handleEvent(event("event-semantic", "different.type"));
    assert.equal(delivered.length, 1);
    assert.equal(semantic.event.routing_attempts[0].router, "test.semantic");
    release();
    const dismissed = await service.handleEvent(event("event-dismissed", "different.type.2"));
    assert.equal(dismissed.event.decision.disposition, "dismiss");
    assert.equal(delivered.length, 1);
  } finally {
    await service.stop();
  }
});

test("MB08-008: management catalog provider is live, localized, exclusive, and disappears on unload", async () => {
  const service = createService({ async deliver() {} });
  try {
    const calls = [];
    const dispose = service.registerBundleCatalogProvider({
      id: "test.catalog",
      async list(input) {
        calls.push(input);
        return [{ type_id: "time.deadline", status: "available", name: input.locale === "zh-CN" ? "计时器" : "Timer" }];
      },
    });
    assert.throws(() => service.registerBundleCatalogProvider({ id: "test.other", async list() { return []; } }), /already registered/u);
    const snapshot = await service.managementSnapshot({ locale: "zh-CN" });
    assert.equal(snapshot.bundle_types[0].name, "计时器");
    assert.deepEqual(calls, [{ locale: "zh-CN" }]);
    dispose();
    dispose();
    assert.deepEqual((await service.managementSnapshot()).bundle_types, []);
  } finally {
    await service.stop();
  }
});

test("MB08-008: invalid management catalog output fails instead of showing a false empty state", async () => {
  const service = createService({ async deliver() {} });
  try {
    service.registerBundleCatalogProvider({ id: "test.catalog", async list() { return null; } });
    await assert.rejects(service.managementSnapshot(), /invalid list/u);
  } finally {
    await service.stop();
  }
});

test("MB01-003/MB08-010: management Bundle catalog uses stable opaque keyset pages", async () => {
  const service = createService({ async deliver() {} });
  let entries = ["fixture.c", "fixture.a", "fixture.b"].map(type_id => ({ type_id, bundle_version: 1 }));
  try {
    service.registerBundleCatalogProvider({ id: "test.catalog", async list() {
      return Object.freeze(structuredClone(entries).map(Object.freeze));
    } });
    const first = await service.managementSnapshot({ bundleLimit: 2 });
    assert.deepEqual(first.bundle_types.map(entry => entry.type_id), ["fixture.a", "fixture.b"]);
    assert.deepEqual(entries.map(entry => entry.type_id), ["fixture.c", "fixture.a", "fixture.b"],
      "management must not sort or otherwise mutate provider-owned catalog output");
    assert.equal(first.bundle_page.total, 3);
    assert.equal(typeof first.bundle_page.next_cursor, "string");
    entries = [{ type_id: "fixture.aa", bundle_version: 1 }, ...entries];
    const second = await service.managementSnapshot({ bundleLimit: 2, bundleCursor: first.bundle_page.next_cursor });
    assert.deepEqual(second.bundle_types.map(entry => entry.type_id), ["fixture.c"], "a new earlier key cannot duplicate or shift the next page");
    assert.equal(second.bundle_page.next_cursor, null);
    await assert.rejects(service.managementSnapshot({ bundleCursor: "not-a-cursor" }), /cursor is invalid/u);
    await assert.rejects(service.managementSnapshot({ bundleLimit: 101 }), /limit is invalid/u);
  } finally {
    await service.stop();
  }
});

test("EP12-003 management Event history uses stable opaque keyset pagination", async () => {
  let sequence = 0;
  const service = createService({ async deliver() {} }, {
    idFactory: () => `generated-${String(++sequence).padStart(4, "0")}`,
  });
  try {
    for (let index = 0; index < 45; index += 1) {
      const id = `page-event-${String(index).padStart(2, "0")}`;
      await service.handleEvent(event(id, `unmatched.${index}`));
    }
    const first = await service.managementSnapshot({ eventLimit: 20 });
    assert.equal(first.events.length, 20);
    assert.equal(first.event_page.total, 45);
    assert.ok(first.event_page.next_cursor);
    const second = await service.managementSnapshot({ eventLimit: 20, eventCursor: first.event_page.next_cursor });
    assert.equal(second.events.length, 20);
    assert.equal(new Set([...first.events, ...second.events].map(item => item.event_id)).size, 40);

    // A newer row arriving after page one cannot shift page two or duplicate a row.
    await service.handleEvent(event("page-event-new", "unmatched.new"));
    const stableSecond = await service.managementSnapshot({ eventLimit: 20, eventCursor: first.event_page.next_cursor });
    assert.deepEqual(stableSecond.events.map(item => item.event_id), second.events.map(item => item.event_id));
    const third = await service.managementSnapshot({ eventLimit: 20, eventCursor: second.event_page.next_cursor });
    assert.equal(third.events.length, 5);
    assert.equal(third.event_page.next_cursor, null);
    await assert.rejects(service.managementSnapshot({ eventLimit: 20, eventCursor: "not-a-cursor" }), /cursor is invalid/);
  } finally {
    await service.stop();
  }
});

test("EP11-003 global Event rate limit resets by window and never starves management", async () => {
  let now = new Date("2026-01-01T00:00:00.000Z");
  const service = createService({ async deliver() {} }, {
    clock: () => new Date(now),
    globalEventsPerMinute: 2,
  });
  try {
    await service.handleEvent(event("rate-1", "none.1"));
    await service.handleEvent(event("rate-2", "none.2"));
    assert.throws(() => service.handleEvent(event("rate-3", "none.3")),
      error => error.errorClass === "global_rate_limited" && error.statusCode === 429);
    const snapshot = await service.managementSnapshot();
    assert.equal(snapshot.events.length, 2, "management must remain available after Event admission refusal");
    now = new Date("2026-01-01T00:01:00.000Z");
    await service.handleEvent(event("rate-4", "none.4"));
    assert.equal((await service.managementSnapshot()).event_page.total, 3);
  } finally {
    await service.stop();
  }
});

test("EP11-003 global concurrency limit refuses excess admission without corrupting the active delivery", async () => {
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  const delivered = [];
  const service = createService({ async deliver(input) { delivered.push(input.activationId); await blocked; } }, {
    globalConcurrentEvents: 1,
  });
  try {
    await service.registerWaits(registration("concurrency-owner", "concurrency.one"));
    const first = service.handleEvent(event("concurrency-1", "concurrency.one"));
    await new Promise(resolve => setImmediate(resolve));
    assert.throws(() => service.handleEvent(event("concurrency-2", "concurrency.two")),
      error => error.errorClass === "global_concurrency_limited" && error.statusCode === 503);
    assert.equal((await service.managementSnapshot()).event_page.total, 1);
    release();
    await first;
    assert.equal(delivered.length, 1);
    await service.handleEvent(event("concurrency-3", "concurrency.three"));
    assert.equal((await service.managementSnapshot()).event_page.total, 2);
  } finally {
    release?.();
    await service.stop();
  }
});

test("monitor baseline failure preserves the previous wait set", async () => {
  const service = createService({ async deliver() {} });
  try {
    await service.registerWaits(registration("session-monitor", "old.type"));
    service.registerMonitorProvider({
      id: "test.monitors",
      async prepare() { throw new Error("baseline unavailable"); },
      async checkMonitor() {},
    });
    await assert.rejects(service.registerWaits({
      ...registration("session-monitor", "new.type"),
      monitors: [{
        monitor_id: "monitor-1",
        wait_id: "wait-session-monitor-new.type",
        lifecycle: "one_shot",
        detector: { kind: "deadline_reached", deadline: new Date().toISOString(), event_type: "timer.elapsed" },
      }],
    }), /baseline unavailable/);
    const current = service.listWaits()[0];
    assert.equal(current.waits.find(wait => wait.status === "active").expected_event, "old.type");
  } finally {
    await service.stop();
  }
});

test("MB03-010: an expiring running check terminalizes its Monitor and cancels only its Wait", async () => {
  const service = createService({ async deliver() {} });
  try {
    service.registerMonitorProvider({
      id: "test.monitors",
      async prepare({ monitors }) { return monitors.map(monitor => ({ ...monitor, baseline_observation: { state: "waiting" } })); },
      async checkMonitor() {},
    });
    await service.registerWaits({
      ...registration("expiry-owner", "fixture.done"),
      monitors: [{
        monitor_id: "expiry-monitor", wait_id: "wait-expiry-owner-fixture.done", lifecycle: "one_shot",
        observer: { provider: "custom.bundle" }, artifact: { kind: "sandboxed-bundle" },
        detector: { kind: "custom.bundle", event_type: "fixture.done" }, schedule: { interval_seconds: 1 },
      }],
    });
    const started = service.beginMonitorCheck("expiry-monitor", "worker", 60_000, { force: true });
    const expired = service.expireMonitorCheck(started, "worker");
    assert.equal(expired.status, "expired");
    assert.equal(expired.monitor.state, "expired");
    assert.equal(expired.monitor.terminal_reason.code, "bundle_expired");
    assert.equal(service.listWaits().length, 0);
    assert.equal((await service.managementSnapshot()).events.length, 0);
  } finally {
    await service.stop();
  }
});

test("delivery recovery keeps activation identity across failure and restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "relay-events-recovery-"));
  const databasePath = join(directory, "events.sqlite");
  let failedActivation;
  let now = new Date("2026-01-01T00:00:00.000Z");
  const first = createService({
    async deliver(input) {
      failedActivation = input.activationId;
      throw new Error("temporary admission failure");
    },
  }, { databasePath, clock: () => new Date(now) });
  try {
    await first.registerWaits(registration("session-recovery", "deploy.done"));
    const result = await first.handleEvent(event("event-recovery", "deploy.done"));
    assert.equal(result.dispatchResults[0].status, "retry");
  } finally {
    await first.stop();
  }

  now = new Date("2026-01-01T00:00:01.000Z");
  const accepted = [];
  const second = createService({ async deliver(input) { accepted.push(input); } }, { databasePath, clock: () => new Date(now) });
  try {
    await second.recoverQueuedDeliveries();
    assert.equal(accepted.length, 1);
    assert.equal(accepted[0].activationId, failedActivation);
    assert.equal(second.store.inspectEvent("event-recovery").state, "resolved");
  } finally {
    await second.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("shutdown refuses new operations after in-flight work settles", async () => {
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  const service = createService({ async deliver() { await blocked; } });
  await service.registerWaits(registration("session-stop", "stop.type"));
  const handling = service.handleEvent(event("event-stop", "stop.type"));
  await new Promise(resolve => setImmediate(resolve));
  let stopped = false;
  const stopping = service.stop().then(() => { stopped = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(stopped, false);
  assert.throws(() => service.listWaits(), /shutting down/);
  release();
  await handling;
  await stopping;
});

test("MB03-009: shutdown drains an in-flight custom rebaseline and rejects a late update", async () => {
  let release;
  let entered;
  let calls = 0;
  const began = new Promise(resolve => { entered = resolve; });
  const blocked = new Promise(resolve => { release = resolve; });
  const service = createService({ async deliver() {} });
  service.registerMonitorProvider({
    id: "test.monitors",
    async prepare({ monitors }) {
      calls += 1;
      if (calls > 1) { entered(); await blocked; }
      return monitors.map(monitor => ({ ...monitor, baseline_observation: { revision: calls } }));
    },
    async checkMonitor() {},
  });
  const proposal = registration("rebaseline-stop", "fixture.done");
  proposal.monitors = [{
    monitor_id: "monitor-rebaseline-stop",
    wait_id: "wait-rebaseline-stop-fixture.done",
    lifecycle: "one_shot",
    observer: { provider: "custom.bundle" },
    detector: { kind: "custom.bundle", event_type: "fixture.done" },
    schedule: { interval_seconds: 60 },
    artifact: { kind: "sandboxed-bundle", sha256: "a".repeat(64) },
  }];
  await service.registerWaits(proposal);
  const update = service.rebaselineMonitor("monitor-rebaseline-stop", {
    schedule: { interval_seconds: 120 },
    artifact: { kind: "sandboxed-bundle", sha256: "b".repeat(64) },
  });
  await began;
  let stopped = false;
  const stopping = service.stop().then(() => { stopped = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(stopped, false, "shutdown must wait for the rebaseline operation");
  assert.throws(() => service.rebaselineMonitor("monitor-rebaseline-stop", {}), /shutting down/u);
  release();
  const updated = await update;
  assert.equal(updated.schedule.interval_seconds, 120);
  await stopping;
});

function createService(inbox, options = {}) {
  return new RelayEventsService(new Context(), {
    databasePath: ":memory:",
    dispatchPollIntervalMs: 60_000,
    inbox,
    ...options,
  });
}

test("exact fallback groups several matching non-exclusive waits into one Session delivery", async () => {
  const accepted = [];
  const service = createService({ async deliver(input) { accepted.push(input); } });
  try {
    const proposal = registration("many", "done");
    proposal.waits[0].exclusive = false;
    proposal.waits.push({ ...proposal.waits[0], wait_id: "another-wait" });
    await service.registerWaits(proposal);
    const result = await service.handleEvent(event("many-event", "done"));
    assert.equal(result.event.deliveries.length, 1);
    assert.equal(result.event.deliveries[0].wait_ids.length, 2);
    assert.equal(accepted.length, 1);
  } finally { await service.stop(); }
});

test("the background recovery loop retries admission without a new external Event", async () => {
  let calls = 0;
  let recovered;
  const done = new Promise(resolve => { recovered = resolve; });
  const service = createService({ async deliver() {
    if (++calls === 1) throw new Error("offline");
    recovered();
  } }, { dispatchPollIntervalMs: 5 });
  try {
    await service.registerWaits(registration("automatic", "done"));
    await service.handleEvent(event("automatic-event", "done"));
    await done;
    assert.equal(calls, 2);
  } finally { await service.stop(); }
});

function registration(sessionId, eventType) {
  return {
    sessionId,
    taskSummary: `Wait for ${eventType}`,
    waits: [{
      wait_id: `wait-${sessionId}-${eventType}`,
      phase: "waiting",
      exclusive: true,
      expected_event: eventType,
      caused_by: "test",
      actors: [],
      entities: [],
      prior_exchange: "continue",
    }],
  };
}

function event(id, type) {
  return { event_id: id, source: "test", fingerprint: id, type };
}

function decision(sessionId, waitId) {
  return {
    disposition: "deliver",
    actionable: true,
    deliveries: [{ session_id: sessionId, wait_ids: [waitId], relation: "semantic", confidence: 0.9 }],
    evidence: ["test"],
    summary: "deliver",
  };
}
