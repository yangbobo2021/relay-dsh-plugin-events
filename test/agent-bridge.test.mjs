import assert from "node:assert/strict";
import test from "node:test";

import { installRelayAgentBridge } from "../agent-bridge.js";

test("Agent tools derive Session ownership from the authenticated Agent context", async () => {
  const definitions = new Map();
  const calls = [];
  const dispose = installRelayAgentBridge({ tools: { register(definition) {
    definitions.set(definition.name, definition);
    return () => definitions.delete(definition.name);
  } } }, {
    sessionId: "authenticated-session",
    async registerWaits(input) { calls.push(input); return { waits: input.waits.map(wait => ({ ...wait, status: "active" })) }; },
    async cancelWaits(sessionId) { calls.push({ cancel: sessionId }); },
  });
  assert.deepEqual([...definitions.keys()].sort(), ["relay_cancel_waits", "relay_register_waits"]);
  const register = definitions.get("relay_register_waits");
  assert.equal("session_id" in register.parameters.properties, false);
  assert.ok(register.parameters.properties.monitors.items.properties.observer);
  await register.execute({
    task_summary: "wait",
    waits: [{
      wait_id: "w", phase: "p", exclusive: true, expected_event: "e", caused_by: "c",
      actors: [], entities: [], prior_exchange: "x",
    }],
  });
  assert.equal(calls[0].sessionId, "authenticated-session");
  await definitions.get("relay_cancel_waits").execute({});
  assert.deepEqual(calls[1], { cancel: "authenticated-session" });
  dispose();
  assert.equal(definitions.size, 0, "unloading Events removes tools from surviving Agents");
});
