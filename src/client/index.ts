import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
import { WaitingEventsSection, type ManagementSnapshot, type WaitingEventsInjected } from './WaitingEventsSection.tsx'
import { en, zh, type RelayManagementLocaleKey } from './locales.ts'
import { RELAY_REMOTE } from './remote.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'relay.management': RelayManagementLocaleKey
  }
}

interface RemoteResult<T> {
  ok: boolean
  value?: T
  error?: { code: string; message: string }
}

interface RelayManagementRemote {
  list(options: { eventCursor: string | null; eventLimit: number }): Promise<RemoteResult<ManagementSnapshot>>
  cancel(sessionId: string): Promise<RemoteResult<unknown>>
  runNow(monitorId: string): Promise<RemoteResult<unknown>>
  pauseMonitor(monitorId: string, expectedVersion?: number): Promise<RemoteResult<unknown>>
  resumeMonitor(monitorId: string, expectedVersion?: number): Promise<RemoteResult<unknown>>
  updateMonitorCadence(monitorId: string, intervalSeconds: number, expectedVersion?: number): Promise<RemoteResult<unknown>>
  stopMonitor(monitorId: string, expectedVersion: number | undefined, reasonCode: string, detail: string): Promise<RemoteResult<unknown>>
  retryActivation(activationId: string): Promise<RemoteResult<unknown>>
  retryNotification(eventId: string): Promise<RemoteResult<unknown>>
  connectorAction(connectorId: string, action: string, input: Record<string, unknown>): Promise<RemoteResult<unknown>>
}

export const inject = ['slots', 'locale', 'remote', 'sessions']

export async function apply(ctx: ClientContext): Promise<() => Promise<void>> {
  const unmount = await ctx.remote.$mount(RELAY_REMOTE as TypertRemoteContribution)
  const remote = ctx.get('remote.relayManagement' as never) as RelayManagementRemote | undefined
  if (remote === undefined) {
    await unmount()
    throw new Error('Relay Events management Remote capability did not mount')
  }
  ctx.effect(() => ctx.locale.register('relay.management', { zh, en }), 'relay-events: dictionaries')
  const t = ctx.locale.bind('relay.management') as WaitingEventsInjected['t']
  const unwrap = <T>(result: RemoteResult<T>): T => {
    if (result.ok && result.value !== undefined) return result.value
    throw new Error(result.error?.message ?? 'Relay Events management request failed')
  }
  const injected = (): WaitingEventsInjected => ({
    list: async options => unwrap(await remote.list(options)),
    cancel: async (sessionId) => { unwrap(await remote.cancel(sessionId)) },
    runNow: async (monitorId) => { unwrap(await remote.runNow(monitorId)) },
    pauseMonitor: async (monitorId, version) => { unwrap(await remote.pauseMonitor(monitorId, version)) },
    resumeMonitor: async (monitorId, version) => { unwrap(await remote.resumeMonitor(monitorId, version)) },
    updateMonitorCadence: async (monitorId, intervalSeconds, version) => {
      unwrap(await remote.updateMonitorCadence(monitorId, intervalSeconds, version))
    },
    stopMonitor: async (monitorId, version) => { unwrap(await remote.stopMonitor(monitorId, version, 'stopped_by_user', '')) },
    retryActivation: async (activationId) => { unwrap(await remote.retryActivation(activationId)) },
    retryNotification: async (eventId) => { unwrap(await remote.retryNotification(eventId)) },
    connectorAction: async (connectorId, action, input = {}) => { unwrap(await remote.connectorAction(connectorId, action, input)) },
    openSession: (sessionId) => { ctx.sessions.open(sessionId as SessionId) },
    t,
    getLocale: () => ctx.locale.getSnapshot().active,
    subscribeLocale: (listener) => ctx.locale.subscribe(listener),
  })
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'relay-waits',
    order: 20,
    label: () => t('nav'),
    locale: 'relay.management',
    inject: injected,
  }, WaitingEventsSection))
  return unmount
}
