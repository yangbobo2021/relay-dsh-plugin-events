import { TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";

export class RelayManagementGateway extends TypertRemoteService {
  constructor(ctx, { relayEvents }) {
    super(ctx, "relayManagement");
    this.relayEvents = relayEvents;
  }

  list(options = {}) {
    return this.relayEvents.managementSnapshot(options);
  }

  cancel(sessionId) {
    return { registration: this.relayEvents.cancelWaits(sessionId) };
  }

  async runNow(monitorId) {
    const result = await this.relayEvents.checkMonitor(monitorId, { force: true });
    return {
      result,
      registrations: this.relayEvents.listWaits(),
    };
  }

  inspectMonitor(monitorId) {
    return { monitor: this.relayEvents.inspectMonitor(monitorId) };
  }

  pauseMonitor(monitorId, expectedVersion) {
    return { monitor: this.relayEvents.pauseMonitor(monitorId, { expectedVersion }) };
  }

  resumeMonitor(monitorId, expectedVersion) {
    return { monitor: this.relayEvents.resumeMonitor(monitorId, { expectedVersion }) };
  }

  updateMonitorCadence(monitorId, intervalSeconds, expectedVersion) {
    return { monitor: this.relayEvents.updateMonitorCadence(monitorId, intervalSeconds, { expectedVersion }) };
  }

  stopMonitor(monitorId, expectedVersion, reasonCode, detail) {
    return { monitor: this.relayEvents.stopMonitor(monitorId, {
      expectedVersion,
      actor: "management-ui",
      reasonCode,
      detail,
    }) };
  }

  retryActivation(activationId) {
    return this.relayEvents.retryActivation(activationId);
  }

  retryNotification(eventId) {
    return { notification: this.relayEvents.retryNotification(eventId) };
  }

  connectorAction(connectorId, action, input) {
    return this.relayEvents.executeConnectorAction(connectorId, action, input);
  }
}
