import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { Service } from "@deepseek-ai/cordis";

import {
  RELAY_EVENTS_API_VERSION,
  validateBoundEventSourceProvider,
  validateMonitorProvider,
  validateRouterProvider,
} from "./contracts/index.mjs";
import { RelayRuntime } from "./src/runtime/runtime.mjs";
import { RelayStore } from "./src/runtime/store.mjs";

export class RelayEventsService extends Service {
  apiVersion = RELAY_EVENTS_API_VERSION;

  constructor(ctx, { databasePath, inbox, dispatchPollIntervalMs = 1_000, routingFailureLimit = 3,
    deliveryFailureLimit = 5, deliveryRetryBaseMs = 1_000, globalEventsPerMinute = 600,
    globalConcurrentEvents = 32, clock, idFactory } = {}) {
    super(ctx, "relayEvents");
    assert.equal(typeof inbox?.deliver, "function", "Events requires inbox.deliver()");
    const resolvedPath = resolveDatabasePath(databasePath);
    if (resolvedPath !== ":memory:") mkdirSync(dirname(resolvedPath), { recursive: true });
    this.store = new RelayStore(resolvedPath, { ...(clock ? { clock } : {}), ...(idFactory ? { idFactory } : {}) });
    this.router = createExactEventRouter();
    this.routerProvider = null;
    this.monitorProvider = null;
    this.boundEventSources = new Map();
    this.notificationProvider = null;
    this.connectorProviders = new Map();
    this.bundleCatalogProvider = null;
    this.operations = new OperationGate();
    this.admission = new EventAdmissionGate({
      eventsPerMinute: globalEventsPerMinute,
      concurrentEvents: globalConcurrentEvents,
      clock: () => (clock ? clock() : new Date()).getTime(),
    });
    const service = this;
    this.runtime = new RelayRuntime({
      store: this.store,
      router: {
        route: input => service.router.route(input),
        get name() { return service.router.name ?? service.router.id; },
        get model() { return service.router.model ?? null; },
      },
      inbox,
      monitorRegistrar: { prepare: input => this.prepareMonitors(input) },
      workerId: "relay-events-dispatcher",
      routingFailureLimit,
      deliveryFailureLimit,
      deliveryRetryBaseMs,
    });
    this.stopped = false;
    this.dispatchTimer = null;
    this.dispatchPollIntervalMs = positiveInteger(dispatchPollIntervalMs, 1_000);
    this.scheduleRecovery(0);
  }

  registerRouter(provider) {
    if (this.stopped) throw new Error("Relay Events is shutting down");
    validateRouterProvider(provider);
    if (this.routerProvider) throw new Error(`router provider ${this.routerProvider.id} is already registered`);
    this.routerProvider = provider;
    this.router = provider;
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      if (this.routerProvider === provider) {
        this.routerProvider = null;
        this.router = createExactEventRouter();
      }
    };
  }

  registerMonitorProvider(provider) {
    if (this.stopped) throw new Error("Relay Events is shutting down");
    validateMonitorProvider(provider);
    if (this.monitorProvider) throw new Error(`monitor provider ${this.monitorProvider.id} is already registered`);
    this.monitorProvider = provider;
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      if (this.monitorProvider === provider) this.monitorProvider = null;
    };
  }

  registerBoundEventSource(provider) {
    if (this.stopped) throw new Error("Relay Events is shutting down");
    validateBoundEventSourceProvider(provider);
    if (this.boundEventSources.has(provider.id)) {
      throw new Error(`bound Event source provider ${provider.id} is already registered`);
    }
    const sources = new Set(provider.sources);
    for (const active of this.boundEventSources.values()) {
      for (const source of sources) {
        if (active.sources.has(source)) {
          throw new Error(`bound Event source ${source} is already registered by ${active.id}`);
        }
      }
    }
    const registration = { id: provider.id, sources, active: true };
    this.boundEventSources.set(provider.id, registration);
    const capability = {
      id: provider.id,
      handleEvent: ({ event, binding }) => {
        if (!registration.active || this.stopped) {
          throw new Error(`bound Event source provider ${provider.id} is not active`);
        }
        if (!sources.has(event?.source)) {
          throw new Error(`bound Event source provider ${provider.id} cannot ingest ${event?.source ?? "unknown"}`);
        }
        return this.admission.run(() => this.operations.run(async () => this.finalizeResult(
          binding == null
            ? await this.runtime.handleTrustedEvent(event, { providerId: provider.id })
            : await this.runtime.handleBoundEvent(event, binding, { providerId: provider.id }),
        )));
      },
      dismissEvent: ({ event, summary }) => {
        if (!registration.active || this.stopped) {
          throw new Error(`bound Event source provider ${provider.id} is not active`);
        }
        if (!sources.has(event?.source)) {
          throw new Error(`bound Event source provider ${provider.id} cannot ingest ${event?.source ?? "unknown"}`);
        }
        return this.admission.run(() => this.operations.run(async () => this.finalizeResult(
          await this.runtime.handleTrustedDismissal(event, { providerId: provider.id, summary }),
        )));
      },
      dispose: () => {
        if (!registration.active) return;
        registration.active = false;
        if (this.boundEventSources.get(provider.id) === registration) {
          this.boundEventSources.delete(provider.id);
        }
      },
    };
    return capability;
  }

  registerNotificationProvider(provider) {
    if (this.stopped) throw new Error("Relay Events is shutting down");
    if (!provider || typeof provider !== "object" || !/^[a-z][a-z0-9._-]{0,63}$/u.test(provider.id ?? "") || typeof provider.notify !== "function") {
      throw new TypeError("notification provider requires a lowercase stable id and notify()");
    }
    if (this.notificationProvider) throw new Error(`notification provider ${this.notificationProvider.id} is already registered`);
    this.notificationProvider = provider;
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      if (this.notificationProvider === provider) this.notificationProvider = null;
    };
  }

  registerConnectorProvider(provider) {
    if (this.stopped) throw new Error("Relay Events is shutting down");
    if (!provider || !/^[a-z][a-z0-9._-]{0,63}$/u.test(provider.id ?? "")
      || typeof provider.inspect !== "function" || typeof provider.execute !== "function") {
      throw new TypeError("connector provider requires a lowercase stable id, inspect(), and execute()");
    }
    if (this.connectorProviders.has(provider.id)) throw new Error(`connector provider ${provider.id} is already registered`);
    this.connectorProviders.set(provider.id, provider);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      if (this.connectorProviders.get(provider.id) === provider) this.connectorProviders.delete(provider.id);
    };
  }

  registerBundleCatalogProvider(provider) {
    if (this.stopped) throw new Error("Relay Events is shutting down");
    if (!provider || !/^[a-z][a-z0-9._-]{0,63}$/u.test(provider.id ?? "") || typeof provider.list !== "function") {
      throw new TypeError("Bundle catalog provider requires a lowercase stable id and list()");
    }
    if (this.bundleCatalogProvider) throw new Error(`Bundle catalog provider ${this.bundleCatalogProvider.id} is already registered`);
    this.bundleCatalogProvider = provider;
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      if (this.bundleCatalogProvider === provider) this.bundleCatalogProvider = null;
    };
  }

  registerWaits(input) { return this.operations.run(() => this.runtime.registerWaits(input)); }
  cancelWaits(sessionId) { return this.operations.run(() => this.runtime.cancelWaits(sessionId)); }
  listWaits() { return this.operations.run(() => this.runtime.listWaits()); }
  managementSnapshot({ eventCursor = null, eventLimit = 20, bundleCursor = null, bundleLimit = 20, locale = "en-US" } = {}) {
    return this.operations.run(async () => {
      assert.ok(Number.isSafeInteger(bundleLimit) && bundleLimit > 0 && bundleLimit <= 100, "Bundle catalog limit is invalid");
      const eventPage = this.store.listEventsPage({ cursor: eventCursor, limit: eventLimit });
      const providerBundleTypes = this.bundleCatalogProvider
        ? await this.bundleCatalogProvider.list({ locale: locale === "zh-CN" ? "zh-CN" : "en-US" })
        : [];
      if (!Array.isArray(providerBundleTypes)) throw new TypeError("Bundle catalog provider returned an invalid list");
      const allBundleTypes = [...providerBundleTypes];
      allBundleTypes.sort((left, right) => bundleCatalogKey(left).localeCompare(bundleCatalogKey(right), "en"));
      const after = bundleCursor == null ? null : decodeBundleCatalogCursor(bundleCursor);
      const remainingBundleTypes = after == null ? allBundleTypes : allBundleTypes.filter(entry => bundleCatalogKey(entry) > after);
      const bundleTypes = remainingBundleTypes.slice(0, bundleLimit);
      return {
        registrations: this.store.listAllWaitRegistrations(),
        bundle_types: bundleTypes,
        bundle_page: {
          next_cursor: remainingBundleTypes.length > bundleLimit && bundleTypes.length > 0
            ? encodeBundleCatalogCursor(bundleCatalogKey(bundleTypes.at(-1))) : null,
          total: allBundleTypes.length,
          limit: bundleLimit,
        },
        events: eventPage.items,
        event_page: {
          next_cursor: eventPage.next_cursor,
          total: eventPage.total,
          limit: eventLimit,
        },
        connectors: await Promise.all([...this.connectorProviders.values()].map(async provider => ({ id: provider.id, ...await provider.inspect() }))),
      };
    });
  }
  cleanupRetention(options) { return this.operations.run(() => this.store.cleanupRetention(options)); }
  executeConnectorAction(connectorId, action, input = {}) {
    return this.operations.run(async () => {
      const provider = this.connectorProviders.get(connectorId);
      assert.ok(provider, `connector provider ${connectorId} is not available`);
      await provider.execute(action, input);
      return { connector: { id: provider.id, ...await provider.inspect() } };
    });
  }
  inspectMonitor(monitorId) { return this.operations.run(() => this.store.inspectMonitor(monitorId)); }
  pauseMonitor(monitorId, options) { return this.operations.run(() => this.store.pauseMonitor(monitorId, options)); }
  resumeMonitor(monitorId, options) { return this.operations.run(() => this.store.resumeMonitor(monitorId, options)); }
  updateMonitorCadence(monitorId, intervalSeconds, options) {
    return this.operations.run(() => this.store.updateMonitorCadence(monitorId, intervalSeconds, options));
  }
  rebaselineMonitor(monitorId, proposal, options = {}) {
    return this.operations.run(async () => {
      const current = this.store.inspectMonitor(monitorId);
      assert.ok(current, `monitor ${monitorId} does not exist`);
      if (!this.monitorProvider) throw new Error("Relay Monitors plugin is not installed");
      const wait = this.store.getWaits(current.session_id).find(candidate => candidate.wait_id === current.wait_id);
      assert.ok(wait, `monitor wait ${current.wait_id} does not exist`);
      const [prepared] = await this.monitorProvider.prepare({ waits: [wait], monitors: [{
        monitor_id: monitorId,
        wait_id: current.wait_id,
        lifecycle: current.lifecycle,
        observer: proposal.observer ?? current.observer,
        artifact: proposal.artifact ?? current.artifact,
        detector: proposal.detector ?? current.detector,
        schedule: proposal.schedule ?? current.schedule,
        retry: proposal.retry ?? current.retry,
        capabilities: proposal.capabilities ?? current.capabilities,
      }] });
      return this.store.rebaselineMonitor(monitorId, prepared, options);
    });
  }
  stopMonitor(monitorId, options) { return this.operations.run(() => this.store.stopMonitor(monitorId, options)); }
  retryActivation(activationId) {
    return this.operations.run(async () => {
      const activation = this.store.retryActivation(activationId);
      const result = await this.runtime.dispatchSession(activation.session_id);
      return { activation: this.store.getActivation(activationId), result };
    });
  }
  retryNotification(eventId) {
    return this.operations.run(async () => {
      const event = this.store.inspectEvent(eventId);
      assert.ok(event, `event ${eventId} does not exist`);
      assert.ok(event.notification && new Set(["failed", "unavailable"]).has(event.notification.state),
        `notification for event ${eventId} is not retryable`);
      if (event.decision?.disposition === "escalate") return this.notifyEscalation(eventId, { force: true });
      if (event.deliveries?.some(delivery => delivery.state === "failed")) return this.notifyTerminalFailure(eventId, { force: true });
      throw new Error(`event ${eventId} has no retryable terminal notification`);
    });
  }
  handleEvent(input) {
    return this.admission.run(() => this.operations.run(async () => this.finalizeResult(await this.runtime.handleEvent(input))));
  }
  dispatchSession(sessionId) { return this.operations.run(() => this.runtime.dispatchSession(sessionId)); }

  checkMonitor(monitorId, options) {
    if (!this.monitorProvider) throw new Error("Relay Monitors plugin is not installed");
    return this.operations.run(() => this.monitorProvider.checkMonitor(monitorId, options));
  }

  beginMonitorCheck(...args) { return this.operations.run(() => this.store.beginMonitorCheck(...args)); }
  completeMonitorCheck(...args) { return this.operations.run(() => this.store.completeMonitorCheck(...args)); }
  failMonitorCheck(...args) { return this.operations.run(() => this.store.failMonitorCheck(...args)); }
  expireMonitorCheck(...args) { return this.operations.run(() => this.store.expireMonitorCheck(...args)); }
  abandonMonitorCheck(...args) { return this.operations.run(() => this.store.abandonMonitorCheck(...args)); }
  listDueMonitors(...args) { return this.operations.run(() => this.store.listDueMonitors(...args)); }

  async prepareMonitors(input) {
    if (!input.monitors?.length) return [];
    if (!this.monitorProvider) throw new Error("monitor proposals require relay-dsh-plugin-monitors");
    return this.monitorProvider.prepare(input);
  }

  async recoverQueuedDeliveries() {
    const sessionIds = this.store.listQueuedDeliverySessionIds();
    const results = await Promise.all(sessionIds.map(sessionId => this.runtime.dispatchSession(sessionId)));
    for (const result of results) {
      for (const eventId of result.eventIds ?? []) await this.notifyTerminalFailure(eventId);
    }
    return results;
  }

  async recoverPendingWork() {
    for (const eventId of this.store.listRoutableEventIds()) {
      try {
        await this.runtime.routeEvent(eventId);
        await this.notifyEscalation(eventId);
      } catch (error) {
        this.ctx.logger?.warn?.(`Relay routing recovery failed for ${eventId}: ${error?.message ?? error}`);
      }
    }
    return this.recoverQueuedDeliveries();
  }

  async finalizeResult(result) {
    await this.notifyEscalation(result.event.event_id);
    if (result.event.deliveries?.some(delivery => delivery.state === "failed")) {
      await this.notifyTerminalFailure(result.event.event_id);
    }
    result.event = this.store.inspectEvent(result.event.event_id);
    return result;
  }

  async notifyEscalation(eventId, { force = false } = {}) {
    const event = this.store.inspectEvent(eventId);
    if (event?.decision?.disposition !== "escalate") return null;
    const existing = event.notification;
    if (existing && !force) return existing;
    const provider = this.notificationProvider;
    if (!provider) return this.store.recordNotificationOutcome(eventId, { state: "unavailable" });
    try {
      const receipt = await provider.notify({
        event: { event_id: event.event_id, source: event.source, type: event.payload?.type ?? null },
        decision: {
          disposition: "escalate",
          summary: event.decision.summary,
          evidence: event.decision.evidence,
        },
      });
      return this.store.recordNotificationOutcome(eventId, {
        provider: provider.id, state: "delivered", receiptId: notificationReceiptId(receipt),
      });
    } catch (error) {
      const errorClass = typeof error?.errorClass === "string" ? error.errorClass.slice(0, 128) : "notification_failed";
      return this.store.recordNotificationOutcome(eventId, { provider: provider.id, state: "failed", errorClass });
    }
  }

  async notifyTerminalFailure(eventId, { force = false } = {}) {
    const event = this.store.inspectEvent(eventId);
    if (!event?.deliveries?.some(delivery => delivery.state === "failed")) return null;
    if (event.notification && !force) return event.notification;
    const provider = this.notificationProvider;
    if (!provider) return this.store.recordNotificationOutcome(eventId, { state: "unavailable" });
    try {
      const receipt = await provider.notify({
        event: { event_id: event.event_id, source: event.source, type: event.payload?.type ?? null },
        decision: {
          disposition: "escalate",
          summary: "Relay exhausted its Delivery retry budget.",
          evidence: ["delivery_retry_exhausted"],
        },
      });
      return this.store.recordNotificationOutcome(eventId, {
        provider: provider.id, state: "delivered", receiptId: notificationReceiptId(receipt),
      });
    } catch (error) {
      const errorClass = typeof error?.errorClass === "string" ? error.errorClass.slice(0, 128) : "notification_failed";
      return this.store.recordNotificationOutcome(eventId, { provider: provider.id, state: "failed", errorClass });
    }
  }

  scheduleRecovery(delay = this.dispatchPollIntervalMs) {
    if (this.stopped) return;
    this.dispatchTimer = setTimeout(() => {
      void this.operations.run(() => this.recoverPendingWork()).catch(error => {
        this.ctx.logger?.error?.(`Relay delivery recovery failed: ${error?.stack ?? error}`);
      }).finally(() => this.scheduleRecovery());
    }, delay);
  }

  async stop() {
    if (this.stopped) return;
    this.stopped = true;
    if (this.dispatchTimer) clearTimeout(this.dispatchTimer);
    await this.operations.stop();
    for (const registration of this.boundEventSources.values()) registration.active = false;
    this.boundEventSources.clear();
    this.notificationProvider = null;
    this.connectorProviders.clear();
    this.store.close();
  }
}

function bundleCatalogKey(entry) {
  return `${entry?.type_id ?? ""}\u0000${String(entry?.bundle_version ?? 0).padStart(12, "0")}\u0000${entry?.artifact_hash ?? ""}`;
}

function encodeBundleCatalogCursor(after) {
  return Buffer.from(JSON.stringify({ v: 1, after }), "utf8").toString("base64url");
}

function decodeBundleCatalogCursor(cursor) {
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (value?.v !== 1 || typeof value.after !== "string" || value.after.length > 1_000) throw new Error();
    return value.after;
  } catch {
    throw new TypeError("Bundle catalog cursor is invalid");
  }
}

function notificationReceiptId(receipt) {
  const value = typeof receipt === "string" ? receipt : receipt?.receipt_id ?? receipt?.id;
  return typeof value === "string" && value.trim() ? value.trim().slice(0, 256) : null;
}

class OperationGate {
  accepting = true;
  inFlight = new Set();

  run(operation) {
    if (!this.accepting) throw new Error("Relay Events is shutting down");
    const result = operation();
    if (!result || typeof result.then !== "function") return result;
    const task = Promise.resolve(result);
    this.inFlight.add(task);
    void task.then(
      () => this.inFlight.delete(task),
      () => this.inFlight.delete(task),
    );
    return task;
  }

  async stop() {
    this.accepting = false;
    await Promise.allSettled([...this.inFlight]);
  }
}

class EventAdmissionGate {
  constructor({ eventsPerMinute, concurrentEvents, clock }) {
    assert.ok(Number.isSafeInteger(eventsPerMinute) && eventsPerMinute > 0 && eventsPerMinute <= 1_000_000,
      "globalEventsPerMinute is invalid");
    assert.ok(Number.isSafeInteger(concurrentEvents) && concurrentEvents > 0 && concurrentEvents <= 10_000,
      "globalConcurrentEvents is invalid");
    this.eventsPerMinute = eventsPerMinute;
    this.concurrentEvents = concurrentEvents;
    this.clock = clock;
    this.window = Math.floor(clock() / 60_000);
    this.used = 0;
    this.active = 0;
  }

  run(operation) {
    const current = Math.floor(this.clock() / 60_000);
    if (current !== this.window) {
      this.window = current;
      this.used = 0;
    }
    if (this.used >= this.eventsPerMinute) throw admissionError("global_rate_limited", 429);
    if (this.active >= this.concurrentEvents) throw admissionError("global_concurrency_limited", 503);
    this.used += 1;
    this.active += 1;
    let result;
    try { result = operation(); }
    catch (error) { this.active -= 1; throw error; }
    return Promise.resolve(result).finally(() => { this.active -= 1; });
  }
}

function admissionError(errorClass, statusCode) {
  const error = new Error(errorClass === "global_rate_limited"
    ? "Relay global Event rate limit was reached"
    : "Relay global Event concurrency limit was reached");
  error.errorClass = errorClass;
  error.statusCode = statusCode;
  return error;
}

export function createExactEventRouter() {
  return {
    id: "relay.exact-event-type",
    name: "relay-exact-event-type",
    async route({ event, sessions }) {
      const eventType = event.type ?? event.event_type;
      const matches = sessions.flatMap(session => session.waits
        .filter(wait => wait.status === "active" && wait.expected_event === eventType)
        .map(wait => ({ session, wait })));
      if (matches.length === 0) {
        return {
          disposition: "dismiss",
          actionable: false,
          deliveries: [],
          evidence: eventType ? [`No active wait expects ${eventType}.`] : ["Event has no type."],
          summary: "No exact Relay wait matched the event.",
        };
      }
      const matchedSessionIds = new Set(matches.map(({ session }) => session.session_id));
      if (matchedSessionIds.size > 1 && matches.some(({ wait }) => wait.exclusive)) {
        return {
          disposition: "escalate",
          actionable: true,
          deliveries: [],
          evidence: [
            `Event type ${eventType} matches conflicting exclusive waits in ${matchedSessionIds.size} sessions.`,
          ],
          summary: `Cannot safely choose one owner for ${eventType}.`,
        };
      }
      const selected = matches;
      const deliveries = new Map();
      for (const { session, wait } of selected) {
        const delivery = deliveries.get(session.session_id) ?? {
          session_id: session.session_id, wait_ids: [],
          relation: `event type ${eventType} matches the registered wait`, confidence: 1,
        };
        delivery.wait_ids.push(wait.wait_id);
        deliveries.set(session.session_id, delivery);
      }
      return {
        disposition: "deliver",
        actionable: true,
        deliveries: [...deliveries.values()],
        evidence: [`Event type ${eventType} exactly matches ${selected.length} active wait(s).`],
        summary: `Deliver ${eventType} to its waiting session.`,
      };
    },
  };
}

function resolveDatabasePath(value) {
  const configured = value ?? process.env.RELAY_DATABASE_PATH;
  if (configured === ":memory:") return configured;
  return configured ? resolve(configured) : join(homedir(), ".relay", "relay.sqlite");
}

function positiveInteger(value, fallback) {
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}
