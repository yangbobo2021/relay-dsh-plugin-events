import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { validateRoutingDecision } from "../../contracts/index.mjs";

export class RelayRuntime {
  constructor({
    store,
    router,
    inbox,
    monitorRegistrar = null,
    workerId = `relay-dispatcher-${randomUUID()}`,
    leaseMs = 60_000,
    maxDispatchBatches = 100,
    routingFailureLimit = 3,
    deliveryFailureLimit = 5,
    deliveryRetryBaseMs = 1_000,
  }) {
    assert.ok(store, "store is required");
    assert.equal(typeof router?.route, "function", "router.route is required");
    assert.equal(typeof inbox?.deliver, "function", "inbox.deliver is required");
    if (monitorRegistrar != null) {
      assert.equal(typeof monitorRegistrar.prepare, "function", "monitorRegistrar.prepare is required");
    }
    this.store = store;
    this.router = router;
    this.inbox = inbox;
    this.monitorRegistrar = monitorRegistrar;
    this.workerId = workerId;
    this.leaseMs = leaseMs;
    this.maxDispatchBatches = maxDispatchBatches;
    assert.ok(Number.isSafeInteger(routingFailureLimit) && routingFailureLimit > 0, "routingFailureLimit must be positive");
    this.routingFailureLimit = routingFailureLimit;
    assert.ok(Number.isSafeInteger(deliveryFailureLimit) && deliveryFailureLimit > 0, "deliveryFailureLimit must be positive");
    assert.ok(Number.isSafeInteger(deliveryRetryBaseMs) && deliveryRetryBaseMs > 0, "deliveryRetryBaseMs must be positive");
    this.deliveryFailureLimit = deliveryFailureLimit;
    this.deliveryRetryBaseMs = deliveryRetryBaseMs;
  }

  async registerWaits({
    sessionId,
    taskSummary,
    context = {},
    waits,
    monitors = [],
    monitorRearms = [],
  }) {
    const validated = validateWaitRegistration({
      sessionId,
      taskSummary,
      context,
      waits,
      monitors,
      monitorRearms,
    });
    waits = validated.waits;
    let preparedMonitors = monitors;
    if (monitors.length > 0) {
      assert.ok(this.monitorRegistrar, "monitor proposals require a monitorRegistrar");
      preparedMonitors = await this.monitorRegistrar.prepare({ waits, monitors });
    }
    return this.store.registerWaits({
      sessionId,
      taskSummary,
      context,
      waits,
      monitors: preparedMonitors,
      monitorRearms,
    });
  }

  cancelWaits(sessionId) {
    return this.store.cancelWaits(sessionId);
  }

  listWaits() {
    return this.store.listWaitRegistrations();
  }

  async handleEvent(eventInput) {
    return this.handleUnboundEvent(eventInput, { allowCorrelation: false });
  }

  async handleTrustedEvent(eventInput, { providerId } = {}) {
    assert.equal(typeof providerId, "string", "trusted Event provider id is required");
    return this.handleUnboundEvent(eventInput, { allowCorrelation: true });
  }

  async handleTrustedDismissal(eventInput, { providerId, summary = "The trusted Connector dismissed an unsupported Event." } = {}) {
    validateEventInput(eventInput);
    assert.equal(typeof providerId, "string", "trusted Event provider id is required");
    assert.equal(typeof summary, "string", "trusted dismissal summary is required");
    assert.ok(summary.length > 0 && summary.length <= 2_000, "trusted dismissal summary is invalid");
    const ingestion = this.store.ingestEvent(eventInput, { allowCorrelation: true });
    const eventId = ingestion.event.event_id;
    let currentEvent = this.store.inspectEvent(eventId);
    if (currentEvent.state === "received" || currentEvent.state === "routing") {
      const snapshot = this.store.beginRouting(eventId);
      if (!snapshot.alreadyRouted) {
        const decision = {
          disposition: "dismiss",
          actionable: false,
          deliveries: [],
          evidence: [`trusted provider ${providerId} classified the Event as unsupported`],
          summary,
        };
        validateRoutingDecision({ decision, sessions: snapshot.sessions, label: `trusted dismissal ${eventId}` });
        this.store.recordRoutingAttempt({ eventId, router: `dismiss:${providerId}`, output: decision });
        this.store.commitRouting(snapshot, decision);
      }
    }
    currentEvent = this.store.inspectEvent(eventId);
    return { duplicate: ingestion.duplicate, event: currentEvent, registrations: [], dispatchResults: [] };
  }

  async handleUnboundEvent(eventInput, { allowCorrelation }) {
    validateEventInput(eventInput);
    const ingestion = this.store.ingestEvent(eventInput, { allowCorrelation });
    const eventId = ingestion.event.event_id;
    let currentEvent = this.store.inspectEvent(eventId);
    let sessionIds = [];

    if (currentEvent.state === "received" || currentEvent.state === "routing") {
      const routing = await this.routeEvent(eventId);
      sessionIds = routing.sessionIds;
    } else if (currentEvent.state === "dispatched") {
      sessionIds = [...new Set(currentEvent.deliveries
        .filter((delivery) => delivery.state === "queued")
        .map((delivery) => delivery.session_id))];
    }

    const dispatchResults = await Promise.all(
      sessionIds.map((sessionId) => this.dispatchSession(sessionId)),
    );
    currentEvent = this.store.inspectEvent(eventId);
    return {
      duplicate: ingestion.duplicate,
      event: currentEvent,
      registrations: sessionIds.map((sessionId) => this.store.inspectWaitRegistration(sessionId)),
      dispatchResults,
    };
  }

  async handleBoundEvent(eventInput, binding, { providerId } = {}) {
    validateEventInput(eventInput);
    validateTrustedBinding(binding);
    assert.equal(typeof providerId, "string", "bound Event provider id is required");
    const ingestion = this.store.ingestEvent(eventInput, { allowCorrelation: true });
    const eventId = ingestion.event.event_id;
    let currentEvent = this.store.inspectEvent(eventId);
    let sessionIds = [];

    if (currentEvent.state === "received" || currentEvent.state === "routing") {
      const snapshot = this.store.beginRouting(eventId);
      if (snapshot.alreadyRouted) {
        sessionIds = snapshot.result.sessionIds;
      } else {
        const decision = boundRoutingDecision(snapshot.sessions, binding, providerId);
        validateRoutingDecision({ decision, sessions: snapshot.sessions, label: `bound event ${eventId}` });
        this.store.recordRoutingAttempt({
          eventId,
          router: `bound:${providerId}`,
          output: decision,
        });
        sessionIds = this.store.commitRouting(snapshot, decision).sessionIds;
      }
    } else if (currentEvent.state === "dispatched") {
      sessionIds = [...new Set(currentEvent.deliveries
        .filter((delivery) => delivery.state === "queued")
        .map((delivery) => delivery.session_id))];
    }

    const dispatchResults = await Promise.all(
      sessionIds.map((sessionId) => this.dispatchSession(sessionId)),
    );
    currentEvent = this.store.inspectEvent(eventId);
    return {
      duplicate: ingestion.duplicate,
      event: currentEvent,
      registrations: sessionIds.map((sessionId) => this.store.inspectWaitRegistration(sessionId)),
      dispatchResults,
    };
  }

  async routeEvent(eventId) {
    const snapshot = this.store.beginRouting(eventId);
    if (snapshot.alreadyRouted) return snapshot.result;

    let routed;
    try {
      routed = await this.router.route({
        event: snapshot.event.payload,
        eventRecord: snapshot.event,
        sessions: snapshot.sessions,
      });
      const decision = routed?.decision ?? routed;
      validateRoutingDecision({
        decision,
        sessions: snapshot.sessions,
        label: `event ${eventId}`,
      });
      this.store.recordRoutingAttempt({
        eventId,
        router: this.router.name ?? "anonymous-router",
        model: this.router.model ?? null,
        output: decision,
        usage: routed?.telemetry ?? null,
      });
      return this.store.commitRouting(snapshot, decision);
    } catch (error) {
      this.store.recordRoutingAttempt({
        eventId,
        router: this.router.name ?? "anonymous-router",
        model: this.router.model ?? null,
        output: routed?.decision ?? routed ?? null,
        error: error.stack ?? error.message,
      });
      if (this.store.countRoutingAttempts(eventId) >= this.routingFailureLimit) {
        const terminal = {
          disposition: "escalate",
          actionable: true,
          deliveries: [],
          evidence: [`Router ${this.router.name ?? "anonymous-router"} exhausted its failure budget.`],
          summary: "Relay could not safely route this actionable Event.",
        };
        return this.store.commitRouting(snapshot, terminal);
      }
      throw error;
    }
  }

  async dispatchSession(sessionId) {
    const activationIds = [];
    let registration = this.store.inspectWaitRegistration(sessionId);
    for (let index = 0; index < this.maxDispatchBatches; index += 1) {
      const started = this.store.beginDispatch(sessionId, this.workerId, this.leaseMs);
      if (started.status !== "started") {
        return activationIds.length === 0
          ? started
          : {
              status: "accepted",
              activationId: activationIds.at(-1),
              activationIds,
              registration,
            };
      }

      try {
        await this.inbox.deliver({
          sessionId,
          activationId: started.activation.activation_id,
          deliveries: started.deliveries,
        });
        registration = this.store.completeDispatch(
          sessionId,
          started.activation.activation_id,
          this.workerId,
        );
        activationIds.push(started.activation.activation_id);
      } catch (error) {
        const failure = this.store.failDispatch(
          sessionId,
          started.activation.activation_id,
          this.workerId,
          error.stack ?? error.message,
          { failureLimit: this.deliveryFailureLimit, baseDelayMs: this.deliveryRetryBaseMs },
        );
        return {
          status: failure.status,
          activationId: started.activation.activation_id,
          activationIds,
          error: error.stack ?? error.message,
          eventIds: failure.eventIds,
          activation: failure.activation,
        };
      }
    }
    throw new Error(`session ${sessionId} exceeded ${this.maxDispatchBatches} dispatch batches`);
  }
}

export function validateWaitRegistration({
  sessionId,
  taskSummary,
  context,
  waits,
  monitors = [],
  monitorRearms = [],
}) {
  assert.equal(typeof sessionId, "string", "DSH session id is required");
  assert.equal(typeof taskSummary, "string", "task summary is required");
  assert.ok(context && typeof context === "object" && !Array.isArray(context), "context must be an object");
  assert.ok(Array.isArray(waits) && waits.length > 0, "at least one wait is required");
  const waitIds = waits.map((wait) => wait.wait_id).filter(Boolean);
  assert.equal(new Set(waitIds).size, waitIds.length, "wait IDs must be unique");
  for (const wait of waits) {
    assert.equal(typeof wait.phase, "string", "wait phase is required");
    assert.equal(typeof wait.exclusive, "boolean", "wait exclusive must be boolean");
    assert.equal(typeof wait.expected_event, "string", "wait expected_event is required");
    assert.equal(typeof wait.caused_by, "string", "wait caused_by is required");
    assert.ok(Array.isArray(wait.actors), "wait actors must be an array");
    assert.ok(Array.isArray(wait.entities), "wait entities must be an array");
    assert.equal(typeof wait.prior_exchange, "string", "wait prior_exchange is required");
  }
  const normalizedWaits = waits.map((wait) => ({
    ...wait,
    continuation: normalizeContinuation(wait.continuation),
  }));
  assert.ok(Array.isArray(monitors), "monitors must be an array");
  const monitorIds = monitors.map((monitor) => monitor.monitor_id);
  assert.equal(new Set(monitorIds).size, monitorIds.length, "monitor IDs must be unique");
  for (const monitor of monitors) {
    assert.equal(typeof monitor.monitor_id, "string", "monitor_id is required");
    assert.ok(waitIds.includes(monitor.wait_id), `monitor wait ${monitor.wait_id} is not proposed`);
    assert.ok(
      monitor.lifecycle === "one_shot" || monitor.lifecycle === "recurring",
      `monitor ${monitor.monitor_id} lifecycle is invalid`,
    );
    assert.ok(monitor.detector && typeof monitor.detector === "object", "monitor detector is required");
  }
  assert.ok(Array.isArray(monitorRearms), "monitorRearms must be an array");
  const rearmIds = monitorRearms.map((rearm) => rearm.monitor_id);
  assert.equal(new Set(rearmIds).size, rearmIds.length, "monitor rearm IDs must be unique");
  for (const rearm of monitorRearms) {
    assert.ok(waitIds.includes(rearm.wait_id), `monitor rearm wait ${rearm.wait_id} is not proposed`);
  }
  return { sessionId, taskSummary, context, waits: normalizedWaits, monitors, monitorRearms };
}

export function normalizeContinuation(value) {
  const input = value ?? {};
  assert.ok(input && typeof input === "object" && !Array.isArray(input), "wait continuation must be an object");
  const version = input.version ?? 1;
  assert.equal(version, 1, "wait continuation version must be 1");
  const continuation = {
    version,
    next_action: boundedString(input.next_action ?? "", "continuation next_action", 8_000),
    success_condition: boundedString(input.success_condition ?? "", "continuation success_condition", 4_000),
    constraints: boundedStringArray(input.constraints ?? [], "continuation constraints", 32, 2_000),
    artifacts: normalizeArtifacts(input.artifacts ?? []),
    on_failure: boundedString(input.on_failure ?? "", "continuation on_failure", 4_000),
    on_timeout: boundedString(input.on_timeout ?? "", "continuation on_timeout", 4_000),
  };
  assert.ok(JSON.stringify(continuation).length <= 32_000, "wait continuation exceeds 32000 characters");
  return continuation;
}

function normalizeArtifacts(value) {
  assert.ok(Array.isArray(value), "continuation artifacts must be an array");
  assert.ok(value.length <= 32, "continuation artifacts exceeds 32 items");
  return value.map((artifact, index) => {
    assert.ok(artifact && typeof artifact === "object" && !Array.isArray(artifact), `continuation artifact ${index} must be an object`);
    const normalized = {
      kind: boundedString(artifact.kind, `continuation artifact ${index} kind`, 64, true),
      id: boundedString(artifact.id, `continuation artifact ${index} id`, 2_048, true),
    };
    if (artifact.label != null) normalized.label = boundedString(artifact.label, `continuation artifact ${index} label`, 512);
    if (artifact.url != null) normalized.url = boundedString(artifact.url, `continuation artifact ${index} url`, 4_096);
    return normalized;
  });
}

function boundedStringArray(value, label, maxItems, maxLength) {
  assert.ok(Array.isArray(value), `${label} must be an array`);
  assert.ok(value.length <= maxItems, `${label} exceeds ${maxItems} items`);
  return value.map((item, index) => boundedString(item, `${label} item ${index}`, maxLength));
}

function boundedString(value, label, maxLength, required = false) {
  assert.equal(typeof value, "string", `${label} must be a string`);
  if (required) assert.ok(value.length > 0, `${label} is required`);
  assert.ok(value.length <= maxLength, `${label} exceeds ${maxLength} characters`);
  return value;
}

function validateEventInput(input) {
  assert.ok(input && typeof input === "object", "event input is required");
  assert.equal(typeof input.source, "string", "event source is required");
  assert.equal(typeof input.fingerprint, "string", "event fingerprint is required");
}

function validateTrustedBinding(binding) {
  assert.ok(binding && typeof binding === "object" && !Array.isArray(binding), "trusted binding is required");
  assert.equal(typeof binding.session_id, "string", "trusted binding session_id is required");
  assert.equal(typeof binding.wait_id, "string", "trusted binding wait_id is required");
  if (binding.wait_version != null) {
    assert.ok(Number.isSafeInteger(binding.wait_version) && binding.wait_version >= 0, "trusted binding wait_version is invalid");
  }
  if (binding.source_subject != null) {
    assert.equal(typeof binding.source_subject, "string", "trusted binding source_subject must be a string");
    assert.ok(binding.source_subject.length <= 2_048, "trusted binding source_subject exceeds 2048 characters");
  }
}

function boundRoutingDecision(sessions, binding, providerId) {
  const session = sessions.find((candidate) => candidate.session_id === binding.session_id);
  const wait = session?.waits.find((candidate) => candidate.wait_id === binding.wait_id);
  const reason = !session
    ? `bound Session ${binding.session_id} is not routable`
    : !wait
      ? `bound Wait ${binding.wait_id} does not belong to active Session ${binding.session_id}`
      : wait.status !== "active"
        ? `bound Wait ${binding.wait_id} is ${wait.status}`
        : binding.wait_version != null && wait.version !== binding.wait_version
          ? `bound Wait ${binding.wait_id} version changed`
          : null;
  if (reason) {
    return {
      disposition: "escalate",
      actionable: true,
      deliveries: [],
      evidence: [`trusted provider ${providerId}: ${reason}`],
      summary: "A trusted Event binding is stale or invalid.",
    };
  }
  const subject = binding.source_subject ? ` for ${binding.source_subject}` : "";
  return {
    disposition: "deliver",
    actionable: true,
    deliveries: [{
      session_id: session.session_id,
      wait_ids: [wait.wait_id],
      relation: `validated binding from ${providerId}${subject}`,
      confidence: 1,
    }],
    evidence: [`trusted provider ${providerId} bound the Event to Wait ${wait.wait_id}`],
    summary: `Deliver the trusted bound Event to Session ${session.session_id}.`,
  };
}
