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

test("delivery recovery keeps activation identity across failure and restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "relay-events-recovery-"));
  const databasePath = join(directory, "events.sqlite");
  let failedActivation;
  const first = createService({
    async deliver(input) {
      failedActivation = input.activationId;
      throw new Error("temporary admission failure");
    },
  }, { databasePath });
  try {
    await first.registerWaits(registration("session-recovery", "deploy.done"));
    const result = await first.handleEvent(event("event-recovery", "deploy.done"));
    assert.equal(result.dispatchResults[0].status, "retry");
  } finally {
    await first.stop();
  }

  const accepted = [];
  const second = createService({ async deliver(input) { accepted.push(input); } }, { databasePath });
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
