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
    async manageMonitor(sessionId, input) { calls.push({ manage: sessionId, input }); return { state: "paused" }; },
  });
  assert.deepEqual([...definitions.keys()].sort(), ["relay_cancel_waits", "relay_manage_monitor", "relay_register_waits"]);
  const register = definitions.get("relay_register_waits");
  assert.equal("session_id" in register.parameters.properties, false);
  assert.ok(register.parameters.properties.waits.items.properties.continuation);
  assert.ok(register.parameters.properties.monitors.items.properties.observer);
  await register.execute({
    task_summary: "wait",
    waits: [{
      wait_id: "w", phase: "p", exclusive: true, expected_event: "e", caused_by: "c",
      actors: [], entities: [], prior_exchange: "x",
      continuation: { next_action: "continue", artifacts: [{ kind: "pull_request", id: "repo#1" }] },
    }],
  });
  assert.equal(calls[0].sessionId, "authenticated-session");
  assert.equal(calls[0].waits[0].continuation.next_action, "continue");
  await definitions.get("relay_cancel_waits").execute({});
  assert.deepEqual(calls[1], { cancel: "authenticated-session" });
  const manage = definitions.get("relay_manage_monitor");
  assert.equal("session_id" in manage.parameters.properties, false);
  await manage.execute({ monitor_id: "monitor-1", action: "pause", expected_version: 4 });
  assert.deepEqual(calls[2], {
    manage: "authenticated-session",
    input: { monitorId: "monitor-1", action: "pause", expectedVersion: 4 },
  });
  assert.ok(manage.parameters.properties.action.enum.includes("update_target"));
  dispose();
  assert.equal(definitions.size, 0, "unloading Events removes tools from surviving Agents");
});
