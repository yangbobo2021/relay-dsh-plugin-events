import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import {
  Button,
  IconChevronRightOutline14,
  IconPlayOutline16,
  IconRefreshOutline16,
  IconTrashOutline16,
  Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { RelayManagementLocaleKey } from './locales.ts'
import css from './WaitingEventsSection.module.css'

interface WaitView {
  wait_id: string
  status: string
  expected_event?: string
  phase?: string
  version?: number
  continuation?: {
    next_action?: string
    success_condition?: string
    constraints?: string[]
    artifacts?: Array<{ kind: string; label?: string }>
    on_failure?: string
    on_timeout?: string
  }
}

interface MonitorView {
  monitor_id: string
  state: string
  version: number
  next_check_at: string | null
  schedule?: { interval_seconds?: number; jitter_seconds?: number }
  artifact?: { stable_subject?: string; repository?: string; pull_number?: number; name?: string }
  last_check?: { state?: string; error_class?: string | null; finished_at?: string | null } | null
  last_observation: { observed_at?: string; data?: Record<string, unknown> } | null
  last_trigger?: { trigger_key?: string; created_at?: string } | null
  consecutive_failures?: number
  terminal_reason?: { code: string; detail?: string; actor?: string | null; at?: string | null } | null
  detector?: { kind?: string; deadline?: string }
}

export interface RegistrationView {
  session_id: string
  task_summary: string
  updated_at: string
  context?: {
    deadline?: string
    deadline_intent?: { kind?: string; after_seconds?: number; input?: string; immediate?: boolean }
  }
  waits: WaitView[]
  monitors: MonitorView[]
}

interface EventView {
  event_id: string
  source: string
  state: string
  received_at: string
  payload?: { type?: string }
  decision?: { disposition?: string; summary?: string; evidence?: string[] } | null
  deliveries?: Array<{ delivery_id: string; state: string; session_id: string; relation?: string }>
  activations?: Array<{
    activation_id: string
    state: string
    attempt_count?: number
    next_attempt_at?: string | null
    terminal_reason_code?: string | null
    terminal_at?: string | null
  }>
  notification?: { state: string; provider?: string | null; error_class?: string | null; receipt_id?: string | null; attempt_count?: number } | null
}

export interface ManagementSnapshot {
  registrations: RegistrationView[]
  events: EventView[]
  connectors: ConnectorView[]
  event_page: { next_cursor: string | null; total: number; limit: number }
}

interface ConnectorView {
  id: string
  kind: 'github' | 'email' | 'router' | string
  state: string
  webhook_path?: string
  secret_count?: number
  secret_writable?: boolean
  api_polling?: boolean
  api_configured?: boolean
  push_configured?: boolean
  credentials_writable?: boolean
  configuration_writable?: boolean
  provider?: string
  model?: string
  last_success_at?: string | null
  last_error_class?: string | null
  accounts?: Array<{ account: string; status: string; updated_at: string; last_error_class?: string | null }>
}

export interface WaitingEventsInjected {
  list: (options: { eventCursor: string | null; eventLimit: number }) => Promise<ManagementSnapshot>
  cancel: (sessionId: string) => Promise<void>
  runNow: (monitorId: string) => Promise<void>
  pauseMonitor: (monitorId: string, version?: number) => Promise<void>
  resumeMonitor: (monitorId: string, version?: number) => Promise<void>
  updateMonitorCadence: (monitorId: string, intervalSeconds: number, version?: number) => Promise<void>
  stopMonitor: (monitorId: string, version?: number) => Promise<void>
  retryActivation: (activationId: string) => Promise<void>
  retryNotification: (eventId: string) => Promise<void>
  connectorAction: (connectorId: string, action: string, input?: Record<string, unknown>) => Promise<void>
  openSession: (sessionId: string) => void
  t: (key: RelayManagementLocaleKey, params?: Record<string, string | number>) => string
  getLocale: () => string
  subscribeLocale: (listener: () => void) => () => void
}

type WaitingEventsSectionProps = PropsRuntime<'settings.section'> & Partial<WaitingEventsInjected>

type ViewState =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ready'; snapshot: ManagementSnapshot }

const ACTIVE_WAIT = new Set(['active', 'claimed'])
const RUNNABLE_MONITOR = new Set(['active', 'degraded'])
const EVENT_PAGE_SIZE = 20
const BACKGROUND_REFRESH_MS = 5_000

export function WaitingEventsSection(props: WaitingEventsSectionProps): ReactNode {
  const { list, cancel, runNow, pauseMonitor, resumeMonitor, updateMonitorCadence, stopMonitor, retryActivation, retryNotification, connectorAction,
    openSession, t, getLocale, subscribeLocale, close, useSessions } = props
  if (list === undefined || cancel === undefined || runNow === undefined
    || pauseMonitor === undefined || resumeMonitor === undefined || updateMonitorCadence === undefined || stopMonitor === undefined
    || retryActivation === undefined || retryNotification === undefined || connectorAction === undefined || openSession === undefined || t === undefined
    || getLocale === undefined || subscribeLocale === undefined) return null

  const sessionTitles = useSessions(state => state.byId)
  const activeLocale = useSyncExternalStore(subscribeLocale, getLocale, getLocale)
  const [request, setRequest] = useState(0)
  const [state, setState] = useState<ViewState>({ status: 'loading' })
  const [refreshing, setRefreshing] = useState(false)
  const [eventCursors, setEventCursors] = useState<Array<string | null>>([null])
  const [eventStateFilter, setEventStateFilter] = useState('all')
  const [eventSourceFilter, setEventSourceFilter] = useState('')
  const [pending, setPending] = useState<string | null>(null)
  const [confirming, setConfirming] = useState<string | null>(null)
  const [operationError, setOperationError] = useState<string | null>(null)
  const [secretDraft, setSecretDraft] = useState('')
  const [gmailApiDraft, setGmailApiDraft] = useState('')
  const [gmailPushDraft, setGmailPushDraft] = useState('')
  const [routerProviderDraft, setRouterProviderDraft] = useState('')
  const [routerModelDraft, setRouterModelDraft] = useState('')
  const [cadenceDrafts, setCadenceDrafts] = useState<Record<string, string>>({})
  const confirmationReturn = useRef<{ element: HTMLElement | null; key: string } | null>(null)

  const load = useCallback(() => {
    setRefreshing(true)
    setRequest(value => value + 1)
  }, [])

  const eventCursor = eventCursors[eventCursors.length - 1] ?? null

  useEffect(() => {
    let current = true
    void list({ eventCursor, eventLimit: EVENT_PAGE_SIZE }).then(
      snapshot => { if (current) { setState({ status: 'ready', snapshot }); setRefreshing(false) } },
      () => { if (current) { setState({ status: 'error' }); setRefreshing(false) } },
    )
    return () => { current = false }
  }, [list, request, eventCursor])

  useEffect(() => {
    const timer = window.setInterval(() => { setRequest(value => value + 1) }, BACKGROUND_REFRESH_MS)
    return () => { window.clearInterval(timer) }
  }, [])

  const registrations = useMemo(
    () => state.status === 'ready' ? state.snapshot.registrations : [],
    [state],
  )
  const events = useMemo(
    () => state.status === 'ready' ? state.snapshot.events ?? [] : [],
    [state],
  )
  const visibleEvents = useMemo(() => events.filter(event =>
    (eventStateFilter === 'all' || event.state === eventStateFilter || event.decision?.disposition === eventStateFilter)
    && (!eventSourceFilter.trim() || event.source.toLocaleLowerCase().includes(eventSourceFilter.trim().toLocaleLowerCase()))),
  [events, eventSourceFilter, eventStateFilter])
  const connectors = useMemo(
    () => state.status === 'ready' ? state.snapshot.connectors ?? [] : [],
    [state],
  )

  const perform = async (key: string, operation: () => Promise<void>): Promise<void> => {
    setPending(key)
    setOperationError(null)
    try {
      await operation()
      setConfirming(null)
      load()
    } catch (error) {
      setOperationError(operationErrorText(error, t))
    } finally {
      setPending(null)
    }
  }

  const open = (sessionId: string): void => {
    if (sessionTitles[sessionId as SessionId] === undefined) {
      setOperationError(t('missingSession'))
      return
    }
    try {
      openSession(sessionId)
      close()
    } catch {
      setOperationError(t('missingSession'))
    }
  }

  const beginConfirmation = (key: string): void => {
    confirmationReturn.current = {
      element: document.activeElement instanceof HTMLElement ? document.activeElement : null,
      key,
    }
    setConfirming(key)
  }

  useEffect(() => {
    if (confirming === null) {
      const target = confirmationReturn.current
      requestAnimationFrame(() => {
        const fallback = target === null ? null : document.querySelector<HTMLElement>(
          `[data-relay-confirmation-trigger="${CSS.escape(target.key)}"]`,
        )
        if (target?.element?.isConnected) target.element.focus()
        else fallback?.focus()
        confirmationReturn.current = null
      })
      return
    }
    const findDialog = (): HTMLElement | undefined => [...document.querySelectorAll<HTMLElement>('[data-relay-confirmation]')]
      .find(element => element.dataset.relayConfirmation === confirming)
    requestAnimationFrame(() => { findDialog()?.querySelector<HTMLElement>('button:not(:disabled)')?.focus() })
    const onKeyDown = (event: KeyboardEvent): void => {
      const dialog = findDialog()
      if (!dialog) return
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        setConfirming(null)
        return
      }
      if (event.key !== 'Tab') return
      const controls = [...dialog.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled)')]
      if (controls.length === 0) return
      const first = controls[0]
      const last = controls[controls.length - 1]
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => { document.removeEventListener('keydown', onKeyDown, true) }
  }, [confirming])

  return (
    <section data-relay-management-root className={css.section} aria-busy={state.status === 'loading' || refreshing} aria-live="polite">
      <div className={css.toolbar}>
        <span className={css.total}>{registrations.length}</span>
        <Tooltip label={t('refresh')} side="bottom" delayMs={400}>
          <button className={css.iconButton} type="button" onClick={load} disabled={refreshing} aria-label={t('refresh')}>
            <IconRefreshOutline16 />
          </button>
        </Tooltip>
      </div>

      {operationError !== null ? <p className={css.error} role="alert">{operationError}</p> : null}
      {state.status === 'loading' ? <p className={css.message}>{t('loading')}</p> : null}
      {state.status === 'error' ? (
        <div className={css.failure}>
          <p role="alert">{t('loadError')}</p>
          <Button size="sm" variant="outline" onClick={load}>{t('retry')}</Button>
        </div>
      ) : null}
      {state.status === 'ready' && registrations.length === 0
        && events.length === 0 && connectors.length === 0 ? <p className={css.empty}>{t('empty')}</p>
        : null}

      {connectors.length > 0 ? (
        <section className={css.connectors} aria-labelledby="relay-connectors-title">
          <h3 id="relay-connectors-title">{t('connectors')}</h3>
          {connectors.map(connector => (
            <article className={css.connector} key={connector.id}>
              <div className={css.connectorHeader}>
                <strong>{connector.kind === 'github' ? 'GitHub' : connector.kind === 'email' ? t('email')
                  : connector.kind === 'router' ? t('semanticRouter') : connector.id}</strong>
                <span className={css.statusBadge}>{statusText(connector.state, t)}</span>
              </div>
              {connector.kind === 'router' ? (
                <>
                  <p className={css.connectorNote}>{connector.state === 'unconfigured'
                    ? t('routerFallbackWarning') : t('routerActive')}</p>
                  <dl className={css.details}>
                    <div><dt>{t('routerProvider')}</dt><dd>{connector.provider || t('notConfigured')}</dd></div>
                    <div><dt>{t('routerModel')}</dt><dd>{connector.model || t('notConfigured')}</dd></div>
                  </dl>
                  <div className={css.secretAction}>
                    <label htmlFor={`router-provider-${connector.id}`}>{t('routerProvider')}</label>
                    <input id={`router-provider-${connector.id}`} value={routerProviderDraft}
                      placeholder={connector.provider || undefined} maxLength={256}
                      disabled={connector.configuration_writable === false}
                      onChange={event => { setRouterProviderDraft(event.currentTarget.value) }} />
                    <label htmlFor={`router-model-${connector.id}`}>{t('routerModel')}</label>
                    <input id={`router-model-${connector.id}`} value={routerModelDraft}
                      placeholder={connector.model || undefined} maxLength={512}
                      disabled={connector.configuration_writable === false}
                      onChange={event => { setRouterModelDraft(event.currentTarget.value) }} />
                    <Button size="sm" variant="outline"
                      disabled={pending !== null || connector.configuration_writable === false
                        || !routerProviderDraft.trim() || !routerModelDraft.trim()}
                      onClick={() => { void perform(`connector:${connector.id}:configure`, async () => {
                        await connectorAction(connector.id, 'configure', {
                          provider: routerProviderDraft,
                          model: routerModelDraft,
                        })
                        setRouterProviderDraft('')
                        setRouterModelDraft('')
                      }) }}>{connector.state === 'unconfigured' ? t('configure') : t('update')}</Button>
                    {connector.configuration_writable === false ? <small>{t('routerReadOnly')}</small> : null}
                    {connector.state !== 'unconfigured' && connector.configuration_writable !== false
                      ? confirming === `connector:${connector.id}:disable` ? (
                        <div className={css.confirmation} role="alertdialog" aria-modal="true"
                          data-relay-confirmation={`connector:${connector.id}:disable`} aria-label={t('disableRouterConfirm')}>
                          <span>{t('disableRouterConfirm')}</span>
                          <Button size="sm" variant="outline" onClick={() => { setConfirming(null) }}>{t('keep')}</Button>
                          <Button size="sm" variant="primary"
                            onClick={() => { void perform(`connector:${connector.id}:disable`, () => connectorAction(connector.id, 'disable')) }}>
                            {t('confirmDisable')}
                          </Button>
                        </div>
                      ) : <Button size="sm" variant="outline"
                        data-relay-confirmation-trigger={`connector:${connector.id}:disable`}
                        onClick={() => { beginConfirmation(`connector:${connector.id}:disable`) }}>{t('disable')}</Button>
                      : null}
                  </div>
                </>
              ) : connector.kind === 'github' ? (
                <>
                  <dl className={css.details}>
                    <div><dt>{t('webhookPath')}</dt><dd>{connector.webhook_path ?? t('unavailable')}</dd></div>
                    <div><dt>{t('webhookSecret')}</dt><dd>{connector.secret_count ? t('configured') : t('notConfigured')}</dd></div>
                    <div><dt>{t('apiPolling')}</dt><dd>{connector.api_polling ? t('configured') : t('notConfigured')}</dd></div>
                    {connector.last_success_at ? <div><dt>{t('lastSuccess')}</dt><dd>{formatTime(connector.last_success_at, activeLocale)}</dd></div> : null}
                    {connector.last_error_class ? <div><dt>{t('lastError')}</dt><dd>{connector.last_error_class}</dd></div> : null}
                  </dl>
                  <div className={css.secretAction}>
                    <label htmlFor={`secret-${connector.id}`}>{connector.secret_count ? t('newWebhookSecret') : t('webhookSecret')}</label>
                    <input id={`secret-${connector.id}`} type="password" autoComplete="new-password" value={secretDraft}
                      disabled={connector.secret_writable === false}
                      onChange={event => { setSecretDraft(event.currentTarget.value) }} />
                    <Button size="sm" variant="outline" disabled={pending !== null || secretDraft.length < 16 || connector.secret_writable === false}
                      onClick={() => { void perform(`connector:${connector.id}:rotate`, async () => {
                        await connectorAction(connector.id, 'rotate_secret', { secret: secretDraft })
                        setSecretDraft('')
                      }) }}>{connector.secret_count ? t('rotate') : t('configure')}</Button>
                    {connector.secret_writable === false ? <small>{t('readOnlyCredential')}</small> : null}
                    {connector.secret_count && connector.secret_writable !== false ? confirming === `connector:${connector.id}:revoke` ? (
                      <div className={css.confirmation} role="alertdialog" aria-modal="true"
                        data-relay-confirmation={`connector:${connector.id}:revoke`} aria-label={t('revokeGitHubConfirm')}>
                        <span>{t('revokeGitHubConfirm')}</span>
                        <Button size="sm" variant="outline" onClick={() => { setConfirming(null) }}>{t('keep')}</Button>
                        <Button size="sm" variant="primary" onClick={() => { void perform(`connector:${connector.id}:revoke`, () => connectorAction(connector.id, 'revoke_secret')) }}>{t('confirmRevoke')}</Button>
                      </div>
                    ) : <Button size="sm" variant="outline" data-relay-confirmation-trigger={`connector:${connector.id}:revoke`}
                      onClick={() => { beginConfirmation(`connector:${connector.id}:revoke`) }}>{t('revoke')}</Button> : null}
                  </div>
                </>
              ) : connector.kind === 'email' ? (
                <>
                  <p className={css.connectorNote}>{connector.push_configured ? t('pushConfigured') : t('pushNotConfigured')} · {t('emailPrivacy')}</p>
                  <dl className={css.details}>
                    <div><dt>{t('gmailApiToken')}</dt><dd>{connector.api_configured ? t('configured') : t('notConfigured')}</dd></div>
                    <div><dt>{t('gmailPushToken')}</dt><dd>{connector.push_configured ? t('configured') : t('notConfigured')}</dd></div>
                  </dl>
                  <div className={css.secretAction}>
                    <label htmlFor={`gmail-api-${connector.id}`}>{t('gmailApiToken')}</label>
                    <input id={`gmail-api-${connector.id}`} type="password" autoComplete="new-password" value={gmailApiDraft}
                      disabled={connector.credentials_writable === false}
                      onChange={event => { setGmailApiDraft(event.currentTarget.value) }} />
                    <label htmlFor={`gmail-push-${connector.id}`}>{t('gmailPushToken')}</label>
                    <input id={`gmail-push-${connector.id}`} type="password" autoComplete="new-password" value={gmailPushDraft}
                      disabled={connector.credentials_writable === false}
                      onChange={event => { setGmailPushDraft(event.currentTarget.value) }} />
                    <Button size="sm" variant="outline"
                      disabled={pending !== null || connector.credentials_writable === false || gmailApiDraft.length < 16 || gmailPushDraft.length < 16}
                      onClick={() => { void perform(`connector:${connector.id}:configure`, async () => {
                        await connectorAction(connector.id, 'configure_credentials', { api_token: gmailApiDraft, push_token: gmailPushDraft })
                        setGmailApiDraft('')
                        setGmailPushDraft('')
                      }) }}>{connector.api_configured || connector.push_configured ? t('rotate') : t('configure')}</Button>
                    {connector.credentials_writable === false ? <small>{t('readOnlyCredential')}</small> : null}
                    {(connector.api_configured || connector.push_configured) && connector.credentials_writable !== false
                      ? confirming === `connector:${connector.id}:revoke` ? (
                        <div className={css.confirmation} role="alertdialog" aria-modal="true"
                          data-relay-confirmation={`connector:${connector.id}:revoke`} aria-label={t('revokeGmailConfirm')}>
                          <span>{t('revokeGmailConfirm')}</span>
                          <Button size="sm" variant="outline" onClick={() => { setConfirming(null) }}>{t('keep')}</Button>
                          <Button size="sm" variant="primary" onClick={() => { void perform(`connector:${connector.id}:revoke`, () => connectorAction(connector.id, 'revoke_credentials')) }}>{t('confirmRevoke')}</Button>
                        </div>
                      ) : <Button size="sm" variant="outline" data-relay-confirmation-trigger={`connector:${connector.id}:revoke`}
                        onClick={() => { beginConfirmation(`connector:${connector.id}:revoke`) }}>{t('revoke')}</Button>
                      : null}
                  </div>
                  {(connector.accounts?.length ?? 0) === 0 ? <p className={css.emptyHistory}>{t('noMailboxes')}</p> : (
                    <ul className={css.accounts}>
                      {connector.accounts?.map(account => {
                        const key = `connector:${connector.id}:disconnect:${account.account}`
                        return <li key={account.account}>
                          <div><strong>{account.account}</strong><small>{statusText(account.status, t)} · {formatTime(account.updated_at, activeLocale)}{account.last_error_class ? ` · ${account.last_error_class}` : ''}</small></div>
                          {account.status === 'paused'
                            ? <Button size="sm" variant="outline" onClick={() => { void perform(`${key}:resume`, () => connectorAction(connector.id, 'resume', { account: account.account })) }}>{t('resume')}</Button>
                            : <Button size="sm" variant="outline" onClick={() => { void perform(`${key}:pause`, () => connectorAction(connector.id, 'pause', { account: account.account })) }}>{t('pause')}</Button>}
                          {confirming === key ? <div className={css.confirmation} role="alertdialog" aria-modal="true"
                            data-relay-confirmation={key} aria-label={t('disconnectMailboxConfirm', { account: account.account })}>
                            <span>{t('disconnectMailboxConfirm', { account: account.account })}</span>
                            <Button size="sm" variant="outline" onClick={() => { setConfirming(null) }}>{t('keep')}</Button>
                            <Button size="sm" variant="primary" onClick={() => { void perform(key, () => connectorAction(connector.id, 'disconnect', { account: account.account })) }}>{t('confirmDisconnect')}</Button>
                          </div> : <Button size="sm" variant="outline" data-relay-confirmation-trigger={key}
                            onClick={() => { beginConfirmation(key) }}>{t('disconnect')}</Button>}
                        </li>
                      })}
                    </ul>
                  )}
                </>
              ) : null}
            </article>
          ))}
        </section>
      ) : null}

      {registrations.length > 0 ? (
        <ul className={css.registrations}>
          {registrations.map((registration) => {
            const liveWaits = registration.waits.filter(wait => ACTIVE_WAIT.has(wait.status))
            const liveMonitors = registration.monitors.filter(monitor =>
              ['active', 'paused', 'degraded', 'triggered'].includes(monitor.state))
            const isLive = liveWaits.length > 0 || liveMonitors.length > 0
            const title = sessionTitles[registration.session_id as SessionId]?.displayTitle ?? registration.task_summary
            const cancelKey = `cancel:${registration.session_id}`
            return (
              <li className={css.registration} key={registration.session_id}>
                <div className={css.registrationHeader}>
                  <button className={css.sessionButton} type="button" onClick={() => { open(registration.session_id) }}>
                    <span className={css.title}>{title}</span>
                    <IconChevronRightOutline14 aria-hidden="true" />
                  </button>
                  <span className={css.statusBadge}>{t(isLive ? 'waiting' : 'history')}</span>
                  <div className={css.actions}>
                    {!isLive ? null : confirming === registration.session_id ? (
                      <div className={css.confirmation} role="alertdialog" aria-modal="true"
                        data-relay-confirmation={registration.session_id} aria-label={t('cancelTarget', { target: title })}>
                        <span>{t('cancelTarget', { target: title })}</span>
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={pending !== null}
                          onClick={() => { setConfirming(null) }}
                        >
                          {t('keep')}
                        </Button>
                        <Button
                          size="sm"
                          variant="primary"
                          disabled={pending !== null}
                          onClick={() => { void perform(cancelKey, () => cancel(registration.session_id)) }}
                        >
                          {t('confirmCancel')}
                        </Button>
                      </div>
                    ) : (
                      <Tooltip label={t('cancel')} side="bottom" delayMs={400}>
                        <button
                          className={css.iconButton}
                          type="button"
                          disabled={pending !== null}
                          aria-label={t('cancel')}
                          data-relay-confirmation-trigger={registration.session_id}
                          onClick={() => { beginConfirmation(registration.session_id) }}
                        >
                          <IconTrashOutline16 />
                        </button>
                      </Tooltip>
                    )}
                  </div>
                </div>

                <p className={css.summary}>{registration.task_summary}</p>
                <div className={css.counts}>
                  <span>{t('waitCount', { count: liveWaits.length })}</span>
                  <span>{t('monitorCount', { count: liveMonitors.length })}</span>
                </div>
                {registration.context?.deadline ? (
                  <p className={css.timerSummary}>
                    <span>{t('deadline')}: {formatDeadline(registration.context.deadline, activeLocale)}</span>
                    <span>{t('timezone')}: {Intl.DateTimeFormat().resolvedOptions().timeZone}</span>
                    {registration.context.deadline_intent?.kind === 'relative'
                      ? <span>{t('afterSeconds', { count: registration.context.deadline_intent.after_seconds ?? 0 })}</span> : null}
                    {Date.parse(registration.context.deadline) <= Date.now() ? <span className={css.overdue}>{t('overdue')}</span> : null}
                  </p>
                ) : null}

                {registration.waits.length > 0 ? (
                  <ul className={css.waits}>
                    {registration.waits.map(wait => (
                      <li key={wait.wait_id}>
                        <span className={css.stateDot} data-state={wait.status} />
                        <div className={css.waitContent}>
                          <span className={css.waitText}>{wait.expected_event ?? wait.wait_id}</span>
                          {wait.continuation?.next_action ? <small>{t('nextAction')}: {wait.continuation.next_action}</small> : null}
                          {wait.continuation?.success_condition ? <small>{t('successCondition')}: {wait.continuation.success_condition}</small> : null}
                          {(wait.continuation?.artifacts?.length ?? 0) > 0
                            ? <small>{t('artifactCount', { count: wait.continuation?.artifacts?.length ?? 0 })}</small> : null}
                        </div>
                        <span className={css.rowState}>{statusText(wait.status, t)}</span>
                      </li>
                    ))}
                  </ul>
                ) : null}

                {registration.monitors.length > 0 ? (
                  <ul className={css.monitors}>
                    {registration.monitors.map(monitor => {
                      const runKey = `run:${monitor.monitor_id}`
                      const pauseKey = `pause:${monitor.monitor_id}`
                      const resumeKey = `resume:${monitor.monitor_id}`
                      const stopKey = `stop:${monitor.monitor_id}`
                      const cadenceKey = `cadence:${monitor.monitor_id}`
                      const monitorConfirmation = `monitor:${monitor.monitor_id}`
                      const runnable = RUNNABLE_MONITOR.has(monitor.state)
                      return (
                        <li key={monitor.monitor_id}>
                          <div className={css.monitorMain}>
                            <span className={css.stateDot} data-state={monitor.state} />
                            <div className={css.monitorTimes}>
                              <span>{statusText(monitor.state, t)}</span>
                              <small>
                                {monitor.next_check_at === null
                                  ? t('noSchedule')
                                  : `${t('nextCheck')} ${formatTime(monitor.next_check_at, activeLocale)}`}
                                {monitor.last_observation?.observed_at === undefined
                                  ? ''
                                  : ` · ${t('lastCheck')} ${formatTime(monitor.last_observation.observed_at, activeLocale)}`}
                              </small>
                              {monitorTarget(monitor) ? <small>{t('monitorTarget')}: {monitorTarget(monitor)}</small> : null}
                              {monitorObservationSummary(monitor, t) ? <small>{monitorObservationSummary(monitor, t)}</small> : null}
                              <small>{t('cadence')}: {t('secondsValue', { count: monitor.schedule?.interval_seconds ?? 0 })}
                                {' · '}{t('failureCount', { count: monitor.consecutive_failures ?? 0 })}
                                {monitor.last_check?.error_class ? ` · ${t('lastError')}: ${monitor.last_check.error_class}` : ''}</small>
                              {monitor.last_trigger?.created_at ? (
                                <small>{t('lastTransition')}: {formatTime(monitor.last_trigger.created_at, activeLocale)}</small>
                              ) : null}
                              {monitor.terminal_reason ? (
                                <small>{t('terminalReason')}: {reasonText(monitor.terminal_reason.code, t)}
                                  {monitor.terminal_reason.at ? ` · ${formatTime(monitor.terminal_reason.at, activeLocale)}` : ''}</small>
                              ) : null}
                            </div>
                          </div>
                          {['active', 'paused', 'degraded'].includes(monitor.state) ? (
                            <div className={css.cadenceAction}>
                              <label htmlFor={`relay-monitor-cadence-${monitor.monitor_id}`}>{t('cadenceSeconds')}</label>
                              <input id={`relay-monitor-cadence-${monitor.monitor_id}`} type="number" min={1} max={86400} step={1}
                                value={cadenceDrafts[monitor.monitor_id] ?? String(monitor.schedule?.interval_seconds ?? '')}
                                disabled={pending !== null}
                                onChange={event => {
                                  const value = event.currentTarget.value
                                  setCadenceDrafts(current => ({ ...current, [monitor.monitor_id]: value }))
                                }} />
                              <Button size="sm" variant="outline" disabled={pending !== null}
                                onClick={() => { void perform(cadenceKey, async () => {
                                  const input = document.getElementById(`relay-monitor-cadence-${monitor.monitor_id}`)
                                  const intervalSeconds = Number(input instanceof HTMLInputElement ? input.value : undefined)
                                  if (!Number.isSafeInteger(intervalSeconds) || intervalSeconds < 1 || intervalSeconds > 86400) {
                                    throw new Error('invalid cadence')
                                  }
                                  await updateMonitorCadence(monitor.monitor_id, intervalSeconds, monitor.version)
                                  setCadenceDrafts(current => Object.fromEntries(Object.entries(current)
                                    .filter(([monitorId]) => monitorId !== monitor.monitor_id)))
                                }) }}>{t('update')}</Button>
                            </div>
                          ) : null}
                          <Tooltip label={t('runNow')} side="bottom" delayMs={400} disabled={!runnable}>
                            <button
                              className={css.iconButton}
                              type="button"
                              data-relay-monitor-action="run"
                              disabled={!runnable || pending !== null}
                              aria-label={t('runNow')}
                              onClick={() => { void perform(runKey, () => runNow(monitor.monitor_id)) }}
                            >
                              <IconPlayOutline16 />
                            </button>
                          </Tooltip>
                          {monitor.state === 'paused' ? (
                            <Button size="sm" variant="outline" data-relay-monitor-action="resume" disabled={pending !== null}
                              onClick={() => { void perform(resumeKey, () => resumeMonitor(monitor.monitor_id, monitor.version)) }}>
                              {t('resume')}
                            </Button>
                          ) : RUNNABLE_MONITOR.has(monitor.state) ? (
                            <Button size="sm" variant="outline" data-relay-monitor-action="pause" disabled={pending !== null}
                              onClick={() => { void perform(pauseKey, () => pauseMonitor(monitor.monitor_id, monitor.version)) }}>
                              {t('pause')}
                            </Button>
                          ) : null}
                          {!['active', 'paused', 'degraded', 'triggered'].includes(monitor.state) ? null : confirming === monitorConfirmation ? (
                            <div className={css.confirmation} role="alertdialog" aria-modal="true"
                              data-relay-confirmation={monitorConfirmation} aria-label={t('stopTarget', { target: shortId(monitor.monitor_id) })}>
                              <span>{t('stopTarget', { target: shortId(monitor.monitor_id) })}</span>
                              <Button size="sm" variant="outline" disabled={pending !== null}
                                onClick={() => { setConfirming(null) }}>{t('keep')}</Button>
                              <Button size="sm" variant="primary" disabled={pending !== null}
                                onClick={() => { void perform(stopKey, () => stopMonitor(monitor.monitor_id, monitor.version)) }}>
                                {t('confirmStop')}
                              </Button>
                            </div>
                          ) : (
                            <Button size="sm" variant="outline" data-relay-monitor-action="stop" disabled={pending !== null}
                              data-relay-confirmation-trigger={monitorConfirmation}
                              onClick={() => { beginConfirmation(monitorConfirmation) }}>{t('stop')}</Button>
                          )}
                        </li>
                      )
                    })}
                  </ul>
                ) : null}
              </li>
            )
          })}
        </ul>
      ) : null}

      {state.status === 'ready' ? (
        <section className={css.history} aria-labelledby="relay-event-history-title">
          <div className={css.historyHeader}>
            <h3 id="relay-event-history-title">{t('eventHistory')}</h3>
            <span data-relay-event-total={state.snapshot.event_page.total}>{t('eventTotal', { count: state.snapshot.event_page.total })}</span>
          </div>
          <div className={css.filters} aria-label={t('eventFilters')}>
            <label htmlFor="relay-event-state-filter">{t('eventStateFilter')}</label>
              <select id="relay-event-state-filter" value={eventStateFilter} onChange={event => { setEventStateFilter(event.currentTarget.value) }}>
                <option value="all">{t('all')}</option>
                <option value="resolved">{t('resolved')}</option>
                <option value="received">{t('received')}</option>
                <option value="deliver">{t('delivered')}</option>
                <option value="escalate">{t('escalated')}</option>
                <option value="dismiss">{t('dismissed')}</option>
              </select>
            <label htmlFor="relay-event-source-filter">{t('eventSourceFilter')}</label>
              <input id="relay-event-source-filter" value={eventSourceFilter} maxLength={128} onChange={event => { setEventSourceFilter(event.currentTarget.value) }} />
          </div>
          {events.length === 0 ? <p className={css.emptyHistory}>{t('noEventHistory')}</p> : (
            <ol className={css.events}>
              {visibleEvents.map(event => (
                <li key={event.event_id}>
                  <div className={css.eventHeader}>
                    <strong>{event.payload?.type ?? t('unknownEvent')}</strong>
                    <span className={css.rowState}>{event.decision?.disposition ?? event.state}</span>
                  </div>
                  <p>{event.decision?.summary ?? t('noDecisionSummary')}</p>
                  {(event.decision?.evidence?.length ?? 0) > 0
                    ? <p>{t('evidence')}: {event.decision?.evidence?.join(' · ')}</p> : null}
                  <small>{event.source} · {formatTime(event.received_at, activeLocale)} · <span title={event.event_id}>{shortId(event.event_id)}</span></small>
                  {(event.deliveries?.length ?? 0) > 0 ? (
                    <ul className={css.eventDetails} aria-label={t('deliveries')}>
                      {event.deliveries?.map(delivery => (
                        <li key={delivery.delivery_id}>
                          {t('deliveryTo', { target: shortId(delivery.session_id) })} · {statusText(delivery.state, t)}
                          {delivery.relation ? <small>{delivery.relation}</small> : null}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                  {event.notification ? (
                    <div className={css.activation}>
                      <span>{t('notification')}: {statusText(event.notification.state, t)}
                        {event.notification.error_class ? ` · ${event.notification.error_class}` : ''}
                        {event.notification.receipt_id ? ` · ${t('notificationReceipt')} ${shortId(event.notification.receipt_id)}` : ''}
                        {event.notification.attempt_count ? ` · ${t('attemptCount', { count: event.notification.attempt_count })}` : ''}</span>
                      {['failed', 'unavailable'].includes(event.notification.state) ? (
                        <Button size="sm" variant="outline" disabled={pending !== null}
                          onClick={() => { void perform(`notification:${event.event_id}`, () => retryNotification(event.event_id)) }}>
                          {t('retryNotification')}
                        </Button>
                      ) : null}
                    </div>
                  ) : null}
                  {event.activations?.map(activation => {
                    const retryKey = `retry:${activation.activation_id}`
                    const retryable = activation.terminal_reason_code === 'delivery_retry_exhausted'
                    return (
                      <div className={css.activation} key={activation.activation_id}>
                        <span>{t('activation')} {shortId(activation.activation_id)} · {t('attemptCount', { count: activation.attempt_count ?? 0 })}</span>
                        {activation.next_attempt_at ? <small>{t('nextAttempt')} {formatTime(activation.next_attempt_at, activeLocale)}</small> : null}
                        {retryable ? <Button size="sm" variant="outline" disabled={pending !== null}
                          onClick={() => { void perform(retryKey, () => retryActivation(activation.activation_id)) }}>{t('retryDelivery')}</Button> : null}
                      </div>
                    )
                  })}
                </li>
              ))}
            </ol>
          )}
          {events.length > 0 && visibleEvents.length === 0 ? <p className={css.emptyHistory}>{t('noMatchingEvents')}</p> : null}
          <nav className={css.pagination} aria-label={t('eventPagination')}>
            <Button size="sm" variant="outline" disabled={refreshing || eventCursors.length === 1}
              onClick={() => { setRefreshing(true); setEventCursors(current => current.slice(0, -1)) }}>{t('previousPage')}</Button>
            <span>{t('pageNumber', { count: eventCursors.length })}</span>
            <Button size="sm" variant="outline" disabled={refreshing || state.snapshot.event_page.next_cursor === null}
              onClick={() => { const next = state.snapshot.event_page.next_cursor; if (next) { setRefreshing(true); setEventCursors(current => [...current, next]) } }}>{t('nextPage')}</Button>
          </nav>
        </section>
      ) : null}
    </section>
  )
}

function statusText(
  status: string,
  t: WaitingEventsInjected['t'],
): string {
  const known = new Set<RelayManagementLocaleKey>([
    'active', 'paused', 'claimed', 'degraded', 'triggered', 'failed', 'completed', 'cancelled',
    'consumed', 'superseded', 'expired', 'received', 'routing', 'dispatched', 'resolved', 'queued',
    'running', 'delivered', 'unavailable', 'healthy', 'unconfigured',
  ])
  return known.has(status as RelayManagementLocaleKey)
    ? t(status as RelayManagementLocaleKey)
    : status
}

function monitorTarget(monitor: MonitorView): string | null {
  if (monitor.artifact?.stable_subject) return monitor.artifact.stable_subject
  if (monitor.artifact?.repository && monitor.artifact.pull_number !== undefined) {
    return `${monitor.artifact.repository}#${monitor.artifact.pull_number}`
  }
  return monitor.artifact?.name ?? null
}

function monitorObservationSummary(monitor: MonitorView, t: WaitingEventsInjected['t']): string | null {
  const data = monitor.last_observation?.data
  if (!data) return null
  const parts: string[] = []
  if (typeof data.head_sha === 'string') parts.push(`${t('headRevision')}: ${shortId(data.head_sha)}`)
  if (typeof data.state === 'string') parts.push(`${t('pullRequestState')}: ${data.state}`)
  if (typeof data.review_decision === 'string') parts.push(`${t('reviewDecision')}: ${data.review_decision}`)
  if (Array.isArray(data.checks)) {
    const checks = data.checks.filter((item): item is Record<string, unknown> => item !== null && typeof item === 'object')
    const passed = checks.filter(check => check.conclusion === 'success').length
    parts.push(t('checkSummary', { passed, total: checks.length }))
  }
  return parts.length > 0 ? parts.join(' · ') : null
}

function operationErrorText(error: unknown, t: WaitingEventsInjected['t']): string {
  const message = error instanceof Error ? error.message : String(error)
  if (/invalid cadence/iu.test(message)) return t('invalidCadence')
  if (/version changed|stale|conflict/iu.test(message)) return t('staleOperation')
  if (/busy|lease|in progress/iu.test(message)) return t('busyOperation')
  if (/not installed|not available|unavailable|provider/iu.test(message)) return t('providerUnavailable')
  return t('operationError')
}

function reasonText(reason: string, t: WaitingEventsInjected['t']): string {
  const key = `reason_${reason}` as RelayManagementLocaleKey
  return key in reasonKeys ? t(key) : reason
}

const reasonKeys: Partial<Record<RelayManagementLocaleKey, true>> = {
  reason_stopped_by_user: true,
  reason_delivery_retry_exhausted: true,
}

function shortId(value: string): string {
  return value.length <= 20 ? value : `${value.slice(0, 8)}…${value.slice(-6)}`
}

function formatTime(value: string, locale: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat(locale.startsWith('zh') ? 'zh-CN' : 'en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date)
}

function formatDeadline(value: string, locale: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat(locale.startsWith('zh') ? 'zh-CN' : 'en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    timeZoneName: 'short',
  }).format(date)
}
