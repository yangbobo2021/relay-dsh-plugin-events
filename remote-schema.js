import { z } from "zod";

const sessionId = z.string().min(1);
const monitorId = z.string().min(1);
const activationId = z.string().min(1);
const eventId = z.string().min(1);
const expectedVersion = z.number().int().nonnegative().optional();
const registrations = z.array(z.unknown());
const events = z.array(z.unknown());
const connectors = z.array(z.unknown());
const managementListOptions = z.object({
  eventCursor: z.string().min(1).max(2048).nullable().optional(),
  eventLimit: z.number().int().min(1).max(100).optional(),
  bundleCursor: z.string().min(1).max(2048).nullable().optional(),
  bundleLimit: z.number().int().min(1).max(100).optional(),
  locale: z.enum(["en-US", "zh-CN"]).optional(),
});
const direct = (id, service, method, parameters, result, typeSymbol) => ({
  id: `relay-dsh-plugin-events#${id}`,
  service,
  namespace: service,
  method,
  invocation: { kind: "direct" },
  parameters,
  result: { mode: "strict", typeSymbol: `relay-dsh-plugin-events#${typeSymbol}`, schema: result },
});
const jsonParameter = (name, schema, typeSymbol) => ({
  name,
  wire: name,
  source: "json",
  codec: { mode: "strict", typeSymbol: `relay-dsh-plugin-events#${typeSymbol}`, schema },
});

export const RELAY_DESCRIPTORS = [
  direct("relayManagement/list", "relayManagement", "list", [
    jsonParameter("options", managementListOptions, "RelayManagementListOptions"),
  ], z.object({
    registrations,
    bundle_types: z.array(z.unknown()),
    bundle_page: z.object({
      next_cursor: z.string().nullable(),
      total: z.number().int().nonnegative(),
      limit: z.number().int().positive(),
    }),
    events,
    connectors,
    event_page: z.object({
      next_cursor: z.string().nullable(),
      total: z.number().int().nonnegative(),
      limit: z.number().int().positive(),
    }),
  }), "RelayManagementSnapshot"),
  direct("relayManagement/cancel", "relayManagement", "cancel", [
    jsonParameter("sessionId", sessionId, "SessionId"),
  ], z.object({ registration: z.unknown() }), "RelayCancelResult"),
  direct("relayManagement/runNow", "relayManagement", "runNow", [
    jsonParameter("monitorId", monitorId, "MonitorId"),
  ], z.object({ result: z.unknown(), registrations }), "RelayRunNowResult"),
  direct("relayManagement/inspectMonitor", "relayManagement", "inspectMonitor", [
    jsonParameter("monitorId", monitorId, "MonitorId"),
  ], z.object({ monitor: z.unknown().nullable() }), "RelayInspectMonitorResult"),
  direct("relayManagement/pauseMonitor", "relayManagement", "pauseMonitor", [
    jsonParameter("monitorId", monitorId, "MonitorId"),
    jsonParameter("expectedVersion", expectedVersion, "ExpectedVersion"),
  ], z.object({ monitor: z.unknown() }), "RelayMonitorMutationResult"),
  direct("relayManagement/resumeMonitor", "relayManagement", "resumeMonitor", [
    jsonParameter("monitorId", monitorId, "MonitorId"),
    jsonParameter("expectedVersion", expectedVersion, "ExpectedVersion"),
  ], z.object({ monitor: z.unknown() }), "RelayMonitorMutationResult"),
  direct("relayManagement/updateMonitorCadence", "relayManagement", "updateMonitorCadence", [
    jsonParameter("monitorId", monitorId, "MonitorId"),
    jsonParameter("intervalSeconds", z.number().int().min(1).max(86400), "IntervalSeconds"),
    jsonParameter("expectedVersion", expectedVersion, "ExpectedVersion"),
  ], z.object({ monitor: z.unknown() }), "RelayMonitorMutationResult"),
  direct("relayManagement/stopMonitor", "relayManagement", "stopMonitor", [
    jsonParameter("monitorId", monitorId, "MonitorId"),
    jsonParameter("expectedVersion", expectedVersion, "ExpectedVersion"),
    jsonParameter("reasonCode", z.string().min(1).max(128), "MonitorReasonCode"),
    jsonParameter("detail", z.string().max(2000), "MonitorReasonDetail"),
  ], z.object({ monitor: z.unknown() }), "RelayMonitorMutationResult"),
  direct("relayManagement/retryActivation", "relayManagement", "retryActivation", [
    jsonParameter("activationId", activationId, "ActivationId"),
  ], z.object({ activation: z.unknown(), result: z.unknown() }), "RelayActivationRetryResult"),
  direct("relayManagement/retryNotification", "relayManagement", "retryNotification", [
    jsonParameter("eventId", eventId, "EventId"),
  ], z.object({ notification: z.unknown() }), "RelayNotificationRetryResult"),
  direct("relayManagement/connectorAction", "relayManagement", "connectorAction", [
    jsonParameter("connectorId", z.string().min(1).max(64), "ConnectorId"),
    jsonParameter("action", z.string().min(1).max(64), "ConnectorAction"),
    jsonParameter("input", z.record(z.string(), z.unknown()), "ConnectorActionInput"),
  ], z.object({ connector: z.unknown() }), "RelayConnectorActionResult"),
];
