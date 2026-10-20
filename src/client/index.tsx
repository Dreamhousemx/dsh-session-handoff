/**
 * dsh-session-handoff — browser half.
 *
 * Two contributions, deliberately independent:
 *
 * 1. **A configuration card.** On this host the settings surface for a plugin
 *    row is `plugins.row.config`, a *keyed* slot addressed by
 *    `<package name>#<row id>`. Registering it gives the row a Configure
 *    control on the Plugins page, which opens a page headed by this plugin's
 *    title and description and renders this component with `{ view, form }`.
 * 2. **A resident follower.** Started from `apply()`, not from the card: the
 *    card only exists while a Plugins page is open, and `/handoff` is typed in
 *    the conversation.
 *
 * ## Why registration goes through `slots.inject`
 *
 * `slots.inject(owner, callback)` runs the callback only where that slot is
 * declared, and disposes what it registered when the declaration collapses. It
 * is also the only correct place to call `slots.register`, because the slot key
 * must exist before the cell can be addressed.
 *
 * ## Why every contribution is guarded
 *
 * A throw from `apply()` raises the host's "failed to load plugins" banner and
 * takes the whole profile's plugin UI with it. Each contribution therefore
 * runs inside `guard()`, at both the eager call and the deferred callback, and
 * degrades to `console.error`.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { HandoffCard, type CardProps } from './card'
import { HandoffFollower, type SessionsLike } from './follow'
import type { HandoffSettings } from './protocol'

/** Stable browser-plugin name; equals the package name in package.json. */
export const name = 'dsh-session-handoff-client'

/**
 * Client services this half declares.
 *
 * Only `slots` is a hard requirement: without the slot registry there is no
 * card, and the follower alone is not worth activating for. Everything else is
 * read with `ctx.get(...)` instead, because a declared service that this
 * composition does not publish keeps the **whole bundle** dormant — the card
 * and the follower both silently disappear.
 *
 * The name is `configForms`, not `forms`: the Client service directory lists
 * `layout`, `locale`, `sessions`, `slots`, `theme`, `timer`, `uiWorkspace`,
 * `workspaces` — and `configForms` is the settings-mirror service the shipped
 * consumers reach through `ctx.get`. Assuming `forms` would have been a silent
 * total failure.
 */
export const inject = ['slots'] as const

/** Keyed slot that renders one plugin row's configuration page. */
export const CARD_SLOT = 'plugins.row.config'

/**
 * List slot that renders one page in the Settings navigation.
 *
 * This is the seat a user expects: Settings → 会话交接, next to General and
 * Models. The plugin-row cell above is only reachable through a plugin's own
 * detail page, which is not where someone adjusts a threshold.
 */
export const SECTION_SLOT = 'settings.section'

/** Section id; must be unique across the Settings nav. */
export const SECTION_ID = 'dsh-session-handoff'

/** Position in the nav, after Plugins (15) and before the market (40). */
export const SECTION_ORDER = 18

/** Nav label. A thunk so a localized string can be swapped without re-registering. */
export const SECTION_LABEL = (): string => '会话交接'

/**
 * Cell keys this card answers on.
 *
 * A bundle installed into a profile gets the entry id `include:<row id>`; a row
 * declared directly in a composition keeps `<row id>`. The slot is keyed by
 * `<package name>#<entry id>`, so both spellings are registered.
 */
export const CARD_KEY = 'dsh-session-handoff#dsh-session-handoff'

/** Key used when the loader assigned the row the `include:`-prefixed id. */
export const BUNDLE_CARD_KEY = 'dsh-session-handoff#include:dsh-session-handoff'

/** Key used when the row id is the bare patch id. */
export const ROW_CARD_KEY = 'dsh-session-handoff#dsh-session-handoff'

/** Settings namespace: the profile entry id the row established. */
export const SETTINGS_ENTRY = 'dsh-session-handoff'

/**
 * Settings namespaces worth probing.
 *
 * The settings mirror is keyed by the same entry id as the row, so a bundle
 * install exposes BOTH `include:dsh-session-handoff` and the bare id depending
 * on the host build. Reading only one leaves the form permanently empty.
 */
export const SETTINGS_ENTRIES = [
  'include:dsh-session-handoff',
  'dsh-session-handoff',
] as const

interface SettingsScopeLike {
  getSnapshot?: () => { value?: Partial<HandoffSettings> }
  set?: (value: Partial<HandoffSettings>) => Promise<unknown> | unknown
}

/** The Client settings mirror (`ctx.get('configForms')`). */
interface FormsLike {
  get?: (ns: string) => SettingsScopeLike | undefined
  whileServed?: (namespaces: readonly string[], callback: (served: Set<string>) => () => void) => unknown
}

/**
 * The Client `sessions` service.
 *
 * It exposes retain/scope/binding rather than a list with `current`/`byId`; the
 * browser's own session list lives on `uiWorkspace`/the shell. This plugin only
 * needs "what session is showing" and "open that one", so the shape is kept
 * deliberately loose and resolved at call time.
 */
interface ClientSessionsLike {
  currentSessionId?: () => string | undefined
  list?: {
    getSnapshot?: () => { current?: string | undefined; byId?: Record<string, { blank?: boolean }> }
  }
  refresh?: () => Promise<unknown> | unknown
  open?: (sessionId: string) => void
}

interface SlotRegistration {
  name: string
  key?: string
  id?: string
  order?: number
  priority?: number
  label?: string | (() => string)
  inject?: () => Record<string, unknown>
}

interface ClientRuntime {
  slots?: {
    inject?: (owner: string, callback: () => unknown) => unknown
    register?: (options: SlotRegistration, component: unknown) => unknown
  }
  effect?: (callback: () => () => void) => void
}

/**
 * Adapt the Client session service to the follower's needs.
 *
 * The follower only uses `list.getSnapshot()` for `current`/`byId`, plus
 * `refresh()` and `open()`. On a Client whose service exposes a different
 * surface those are absent, and the follower simply never finds a session to
 * follow — it degrades to "no jump" instead of throwing.
 */
function toFollowSessions(service: ClientSessionsLike | undefined): SessionsLike | undefined {
  if (service === undefined) return undefined
  return {
    ...(service.list === undefined ? {} : { list: service.list }),
    ...(service.refresh === undefined ? {} : { refresh: service.refresh }),
    ...(service.open === undefined ? {} : { open: service.open }),
  }
}

/** Run a contribution, degrading to a console error instead of blanking the UI. */
function guard<T>(label: string, run: () => T): T | undefined {
  try {
    return run()
  } catch (error) {
    console.error(`[dsh-session-handoff] ${label} 注册失败：`, error)
    return undefined
  }
}

/** The current session id from the live session list. */
function currentSessionId(sessions: SessionsLike | undefined): string | undefined {
  try {
    return sessions?.list?.getSnapshot?.().current
  } catch {
    return undefined
  }
}

/** Fetch one session's status snapshot; `undefined` on any failure. */
async function fetchState(sessionId: string) {
  try {
    const response = await fetch(`/dsh-session-handoff/state?sessionId=${encodeURIComponent(sessionId)}`, {
      headers: { accept: 'application/json' },
    })
    if (!response.ok) return undefined
    return await response.json()
  } catch {
    return undefined
  }
}

/** Wire the browser half. */
export function apply(ctx: ClientContext): void {
  const runtime = ctx as unknown as ClientRuntime

  /**
   * Read a Client service without declaring it.
   *
   * `ctx.get` never throws for an unpublished service; it returns `undefined`.
   * That is what keeps this bundle active on a composition that lacks the
   * settings mirror.
   */
  function softGet<T>(serviceName: string): T | undefined {
    try {
      return (ctx as unknown as { get(name: string): unknown }).get(serviceName) as T | undefined
    } catch {
      return undefined
    }
  }

  const configForms = softGet<FormsLike>('configForms')
  const sessionsService = softGet<ClientSessionsLike>('sessions')

  /**
   * Bind the settings mirror.
   *
   * The mirror is keyed by the loader's entry id, and a profile-installed bundle
   * is keyed `include:<row id>`. Guessing the spelling is what produced
   * "宿主的设置表单未就绪，无法保存": the scope stayed `undefined`, so every save
   * threw.
   *
   * `whileServed` is the host's own idiom: its callback receives the set of
   * namespaces actually served, which is live data rather than a captured guess,
   * and it re-runs when the mirror arrives — so a binding made before the mirror
   * populated still ends up correct. Preferring the bare id keeps the same order
   * the shipped consumers use.
   */
  const SETTINGS_CANDIDATES = [
    'dsh-session-handoff',
    'include:dsh-session-handoff',
  ] as const

  let settingsScope: SettingsScopeLike | undefined

  function resolveFrom(served: Set<string> | undefined): SettingsScopeLike | undefined {
    const namespaces = served === undefined ? SETTINGS_CANDIDATES : SETTINGS_CANDIDATES
    for (const ns of namespaces) {
      if (served !== undefined && !served.has(ns)) continue
      try {
        const scope = configForms?.get?.(ns)
        if (scope !== undefined) return scope
      } catch {
        // Next candidate.
      }
    }
    return undefined
  }

  const bindMirror = (): void => {
    if (configForms?.whileServed === undefined) {
      settingsScope = resolveFrom(undefined)
      return
    }
    try {
      configForms.whileServed([...SETTINGS_CANDIDATES], (served) => {
        settingsScope = resolveFrom(served)
        return () => {
          settingsScope = undefined
        }
      })
    } catch (error) {
      console.error('[dsh-session-handoff] 设置镜像绑定失败：', error)
      settingsScope = resolveFrom(undefined)
    }
  }

  bindMirror()

  // ---- 1. Resident follower -------------------------------------------------
  // The follower polls the current session and jumps to the handoff target. It
  // is started here, not from the card, because the card only exists while a
  // Plugins page is open.
  const sessionsForFollow = toFollowSessions(softGet<ClientSessionsLike>('sessions'))
  const follower = new HandoffFollower({
    sessions: sessionsForFollow,
    fetchState,
    currentSessionId: () => currentSessionId(sessionsForFollow),
    enabled: () => true,
    log: (message) => console.info(`[dsh-session-handoff] ${message}`),
  })
  const stopFollowing = follower.start()
  void sessionsService

  // ---- 2. Configuration card ------------------------------------------------
  const readSettings = (): HandoffSettings | undefined => {
    try {
      const snapshot = settingsScope?.getSnapshot?.()
      const value = snapshot?.value
      return value === undefined ? undefined : (value as HandoffSettings)
    } catch {
      return undefined
    }
  }

  /**
   * Persist the form.
   *
   * Re-resolves the scope at call time: the mirror can populate after this half
   * activates, so a scope captured at startup may be stale by the time the user
   * presses Save. Failing that, the message names the namespaces tried, because
   * "表单未就绪" alone gives a user nothing to act on.
   */
  const saveSettings = async (next: HandoffSettings): Promise<void> => {
    if (settingsScope?.set === undefined) settingsScope = resolveFrom(undefined)
    if (settingsScope?.set === undefined) {
      throw new Error(
        `宿主的设置表单未就绪，无法保存（已尝试 ${SETTINGS_CANDIDATES.join(' / ')}）。` +
          '若刚安装插件，请重启 dsh 后重试。',
      )
    }
    await settingsScope.set(next as Partial<HandoffSettings>)
  }

  /*
   * Two seats, deliberately.
   *
   * 1. **A settings section** (`settings.section`) — the page this plugin is
   *    actually about. It appears in the Settings nav beside General, Models,
   *    Plugins and the rest, which is where a user looks for "how much context
   *    before handoff". A `plugins.row.config` cell only renders inside a
   *    plugin's own detail page, several clicks away, so it is not a substitute.
   * 2. **A row-configuration cell** (`plugins.row.config`) — kept so the row's
   *    Configure control still opens something. Both entry-id spellings are
   *    registered: a profile-installed bundle is keyed `include:<row id>` while
   *    an inline row keeps the bare id.
   */
  const cardInject = (): Record<string, unknown> => ({
    getSettings: readSettings,
    saveSettings,
    sessionId: currentSessionId(sessionsForFollow),
  })

  const registerSection = (): unknown => {
    const slots = runtime.slots
    if (slots?.register === undefined) return undefined
    return slots.register(
      {
        name: SECTION_SLOT,
        id: SECTION_ID,
        order: SECTION_ORDER,
        label: SECTION_LABEL,
        inject: cardInject,
      },
      HandoffCard,
    )
  }

  guard('slots/settings.section', () => {
    const slots = runtime.slots
    if (slots?.inject === undefined) return registerSection()
    return slots.inject(SECTION_SLOT, () => registerSection())
  })

  const registerCard = (key: string): unknown => {
    const slots = runtime.slots
    if (slots?.register === undefined) return undefined
    return slots.register(
      {
        name: CARD_SLOT,
        key,
        priority: 30,
        inject: cardInject,
      },
      HandoffCard,
    )
  }

  const CARD_KEYS = [BUNDLE_CARD_KEY, ROW_CARD_KEY] as const

  guard('slots/plugins.row.config', () => {
    const slots = runtime.slots
    const registerAll = (): unknown[] => CARD_KEYS.map((key) => registerCard(key))
    if (slots?.inject === undefined) return registerAll()
    return slots.inject(CARD_SLOT, () => registerAll())
  })

  // ---- 3. Teardown ----------------------------------------------------------
  runtime.effect?.(() => () => {
    stopFollowing()
  })
}

/** Props the host hands the card; re-exported so the card type-checks. */
export type { CardProps }
