import { RelayEventsService } from "./events-service.js";
import { installRelayAgentBridge } from "./agent-bridge.js";
import { registerRelayEventIngress } from "./event-ingress.js";
import { DshInboxAdapter } from "./inbox-adapter.js";
import { RelayManagementGateway } from "./management-gateway.js";

export const name = "relay-dsh-plugin-events";
export const inject = ["agents", "sessions", "sessionPersistence", "tools", "typert", "webServer"];

export async function apply(ctx, config = {}) {
  const inbox = new DshInboxAdapter({
    resolveAgent: createSharedAgentLookup(ctx),
    debug: config.debug ?? false,
    async awaitDurable(agent) {
      await ctx.sessions.flush(agent.session);
    },
  });
  const events = new RelayEventsService(ctx, {
    databasePath: config.databasePath,
    dispatchPollIntervalMs: config.dispatchPollIntervalMs,
    inbox,
  });
  ctx.effect(() => () => events.stop(), "relayEvents.stop()");
  const fiber = ctx.plugin({ name: "relay events management remote", apply(scope) {
    new RelayManagementGateway(scope, { relayEvents: events });
  } });
  ctx.effect(() => () => fiber.dispose(), "relay events management remote");
  await fiber;
  ctx.effect(() => registerRelayEventIngress(ctx, {
    relayRuntime: events,
    token: config.ingressToken ?? process.env.RELAY_INGRESS_TOKEN,
    maxBodyBytes: positiveInteger(config.ingressMaxBodyBytes, 1_048_576),
  }), "relay events ingress");
  const attach = agent => {
    if (!ctx.agents.roots().includes(agent)) return;
    ctx.effect(() => installRelayAgentBridge(agent.ctx, {
      sessionId: agent.id,
      registerWaits: input => events.registerWaits(input),
      cancelWaits: sessionId => events.cancelWaits(sessionId),
    }), "relay events tools");
  };
  ctx.effect(() => ctx.on("agent/created", ({ agent }) => attach(agent)), "relay events agent bridge");
  for (const agent of ctx.agents.roots()) attach(agent);
}

function createSharedAgentLookup(ctx) {
  const lookup = ctx.typert.lookups.get("agent");
  if (!lookup) throw new Error("Relay requires DSH's configured shared Agent lookup");
  return async sessionId => {
    try {
      const agent = await lookup.resolve(sessionId);
      return agent ? { agent } : { error: { message: `session ${sessionId} was not found` } };
    } catch (error) {
      return { error: { message: error?.message ?? String(error) } };
    }
  };
}

function positiveInteger(value, fallback) {
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}
