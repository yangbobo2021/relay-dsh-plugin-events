import { TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";

export class RelayManagementGateway extends TypertRemoteService {
  constructor(ctx, { relayEvents }) {
    super(ctx, "relayManagement");
    this.relayEvents = relayEvents;
  }

  list() {
    return { registrations: this.relayEvents.listWaits() };
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
}
