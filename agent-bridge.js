import { defineTool } from "@deepseek-ai/dsh-tools";

export function installRelayAgentBridge(
  ctx,
  { sessionId, registerWaits, cancelWaits },
) {
  if (!sessionId) throw new Error("Relay bridge requires the current DSH session id");
  if (typeof registerWaits !== "function") throw new Error("registerWaits callback is required");
  if (typeof cancelWaits !== "function") throw new Error("cancelWaits callback is required");

  ctx.tools.register(defineTool({
    name: "relay_register_waits",
    description: "Ask Relay to watch external conditions for this conversation, with optional bound Monitors.",
    parameters: {
      task_summary: { type: "string", required: true },
      waits: {
        type: "array",
        required: true,
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            wait_id: { type: "string", required: true },
            phase: { type: "string", required: true },
            exclusive: { type: "boolean", required: true },
            expected_event: { type: "string", required: true },
            caused_by: { type: "string", required: true },
            actors: { type: "array", required: true, items: { type: "string" } },
            entities: { type: "array", required: true, items: { type: "string" } },
            prior_exchange: { type: "string", required: true },
          },
        },
      },
      monitors: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            monitor_id: { type: "string", required: true },
            wait_id: { type: "string", required: true },
            lifecycle: {
              type: "string",
              required: true,
              enum: ["one_shot", "recurring"],
            },
            detector: {
              type: "object",
              required: true,
              additionalProperties: true,
              properties: {},
            },
            schedule: {
              type: "object",
              additionalProperties: false,
              properties: {
                interval_seconds: { type: "number", required: true },
                jitter_seconds: { type: "number" },
              },
            },
            observer: {
              type: "object",
              additionalProperties: false,
              properties: {
                provider: { type: "string", required: true },
              },
            },
            artifact: {
              type: "object",
              additionalProperties: true,
              properties: {},
            },
            capabilities: {
              type: "object",
              additionalProperties: true,
              properties: {},
            },
            retry: {
              type: "object",
              additionalProperties: true,
              properties: {},
            },
          },
        },
      },
      monitor_rearms: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            monitor_id: { type: "string", required: true },
            wait_id: { type: "string", required: true },
          },
        },
      },
    },
    output: acknowledgementSchema("registered"),
    async execute(args) {
      const registration = await registerWaits({
        sessionId,
        taskSummary: args.task_summary,
        context: {},
        waits: args.waits,
        monitors: args.monitors ?? [],
        monitorRearms: args.monitor_rearms ?? [],
      });
      return {
        registered: true,
        sessionId,
        waitCount: registration.waits.filter((wait) => wait.status === "active").length,
      };
    },
  }));

  ctx.tools.register(defineTool({
    name: "relay_cancel_waits",
    description: "Cancel every active Relay wait for this conversation.",
    parameters: {},
    output: acknowledgementSchema("cancelled"),
    async execute() {
      await cancelWaits(sessionId);
      return { cancelled: true, sessionId, waitCount: 0 };
    },
  }));

}

function acknowledgementSchema(flag) {
  return {
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        [flag]: { type: "boolean", required: true },
        sessionId: { type: "string", required: true },
        waitCount: { type: "number", required: true },
      },
    },
    render: (_args, value) => [{ type: "text", text: JSON.stringify(value) }],
  };
}
