import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { Service } from "@deepseek-ai/cordis";

import {
  RELAY_EVENTS_API_VERSION,
  validateMonitorProvider,
  validateRouterProvider,
} from "./contracts/index.mjs";
import { RelayRuntime } from "./src/runtime/runtime.mjs";
import { RelayStore } from "./src/runtime/store.mjs";

export class RelayEventsService extends Service {
  apiVersion = RELAY_EVENTS_API_VERSION;

  constructor(ctx, { databasePath, inbox, dispatchPollIntervalMs = 1_000, clock, idFactory } = {}) {
    super(ctx, "relayEvents");
    assert.equal(typeof inbox?.deliver, "function", "Events requires inbox.deliver()");
    const resolvedPath = resolveDatabasePath(databasePath);
    if (resolvedPath !== ":memory:") mkdirSync(dirname(resolvedPath), { recursive: true });
    this.store = new RelayStore(resolvedPath, { ...(clock ? { clock } : {}), ...(idFactory ? { idFactory } : {}) });
    this.router = createExactEventRouter();
    this.routerProvider = null;
    this.monitorProvider = null;
    this.operations = new OperationGate();
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

  registerWaits(input) { return this.operations.run(() => this.runtime.registerWaits(input)); }
  cancelWaits(sessionId) { return this.operations.run(() => this.runtime.cancelWaits(sessionId)); }
  listWaits() { return this.operations.run(() => this.runtime.listWaits()); }
  handleEvent(input) { return this.operations.run(() => this.runtime.handleEvent(input)); }
  dispatchSession(sessionId) { return this.operations.run(() => this.runtime.dispatchSession(sessionId)); }

  checkMonitor(monitorId, options) {
    if (!this.monitorProvider) throw new Error("Relay Monitors plugin is not installed");
    return this.operations.run(() => this.monitorProvider.checkMonitor(monitorId, options));
  }

  beginMonitorCheck(...args) { return this.operations.run(() => this.store.beginMonitorCheck(...args)); }
  completeMonitorCheck(...args) { return this.operations.run(() => this.store.completeMonitorCheck(...args)); }
  failMonitorCheck(...args) { return this.operations.run(() => this.store.failMonitorCheck(...args)); }
  abandonMonitorCheck(...args) { return this.operations.run(() => this.store.abandonMonitorCheck(...args)); }
  listDueMonitors(...args) { return this.operations.run(() => this.store.listDueMonitors(...args)); }

  async prepareMonitors(input) {
    if (!input.monitors?.length) return [];
    if (!this.monitorProvider) throw new Error("monitor proposals require relay-dsh-plugin-monitors");
    return this.monitorProvider.prepare(input);
  }

  async recoverQueuedDeliveries() {
    const sessionIds = this.store.listQueuedDeliverySessionIds();
    return Promise.all(sessionIds.map(sessionId => this.runtime.dispatchSession(sessionId)));
  }

  scheduleRecovery(delay = this.dispatchPollIntervalMs) {
    if (this.stopped) return;
    this.dispatchTimer = setTimeout(() => {
      void this.operations.run(() => this.recoverQueuedDeliveries()).catch(error => {
        this.ctx.logger?.error?.(`Relay delivery recovery failed: ${error?.stack ?? error}`);
      }).finally(() => this.scheduleRecovery());
    }, delay);
  }

  async stop() {
    if (this.stopped) return;
    this.stopped = true;
    if (this.dispatchTimer) clearTimeout(this.dispatchTimer);
    await this.operations.stop();
    this.store.close();
  }
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
      const exclusive = matches.find(({ wait }) => wait.exclusive);
      const selected = exclusive ? [exclusive] : matches;
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
