import { describe, expect, it, vi } from 'vitest'
import { apply, BUNDLE_CARD_KEY, CARD_KEY, CARD_SLOT, inject, name, ROW_CARD_KEY } from '@src/client/index'

/**
 * A Cordis-like Client context.
 *
 * The point of these tests is *activation realism*: a Client bundle only runs
 * when every service listed in `inject` exists. Declaring a service this
 * composition does not publish keeps the whole bundle dormant, so the suite
 * pins the declared list and proves `apply()` still wires the card when the
 * optional services are absent.
 */
function fakeClientContext(services: Record<string, unknown> = {}) {
  const registered: Array<{ slot: string; options: Record<string, unknown> }> = []
  const effects: Array<() => void> = []

  const ctx = {
    get: (service: string) => services[service],
    effect: (callback: () => () => void) => {
      effects.push(callback())
    },
    slots: {
      inject: (slot: string, callback: () => unknown) => callback(),
      register: (options: Record<string, unknown>) => {
        registered.push({ slot: String(options['name']), options })
        return () => {}
      },
    },
  }

  return { ctx, registered, effects }
}

describe('client entry', () => {
  it('declares only services the Client actually publishes', () => {
    // The Client service directory is: layout, locale, sessions, slots, theme,
    // timer, uiWorkspace, workspaces (plus `configForms`, reached lazily).
    // `forms` is not one of them; declaring it would have kept this bundle dead.
    expect([...inject]).toEqual(['slots'])
    expect([...inject]).not.toContain('forms')
  })

  it('uses a stable name and answers on both entry-id spellings', () => {
    expect(name).toBe('dsh-session-handoff-client')
    expect(CARD_SLOT).toBe('plugins.row.config')
    // A profile-installed bundle is keyed `include:<row id>`; a row declared
    // inline in a composition keeps the bare id. Registering only one spelling
    // yields a row that is running but has no Configure control.
    expect(BUNDLE_CARD_KEY).toBe('dsh-session-handoff#include:dsh-session-handoff')
    expect(ROW_CARD_KEY).toBe('dsh-session-handoff#dsh-session-handoff')
    expect(CARD_KEY).toBe(ROW_CARD_KEY)
  })

  it('registers the card even when configForms and sessions are absent', () => {
    const fake = fakeClientContext()
    expect(() => apply(fake.ctx as never)).not.toThrow()

    const keys = fake.registered.map((entry) => entry.options['key'])
    expect(keys).toContain(BUNDLE_CARD_KEY)
    expect(keys).toContain(ROW_CARD_KEY)

    const card = fake.registered.find((entry) => entry.options['key'] === ROW_CARD_KEY)!
    expect(card.slot).toBe(CARD_SLOT)
    expect(typeof card.options['inject']).toBe('function')
  })

  it('injects a session id and a Host-backed settings reader', async () => {
    // Reads go through the plugin's own route now: the browser settings mirror
    // is not reachable from a static bundle, and reading it silently returned
    // defaults — the page kept showing 85% after 40% had been saved.
    const requested: string[] = []
    const fake = fakeClientContext({
      sessions: { list: { getSnapshot: () => ({ current: 'sess-1' }) } },
    })
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (url: string) => {
      requested.push(String(url))
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, settings: { autoHandoffAtContextPercent: 40 } }),
      }
    }) as unknown as typeof fetch

    try {
      apply(fake.ctx as never)
      const card = fake.registered.find((entry) => entry.options['key'] === ROW_CARD_KEY)!
      const injected = (card.options['inject'] as () => Record<string, unknown>)()
      expect((injected['getSessionId'] as () => string | undefined)()).toBe('sess-1')

      const settings = await (injected['getSettings'] as () => Promise<{
        autoHandoffAtContextPercent: number
      }>)()
      expect(settings.autoHandoffAtContextPercent).toBe(40)
      expect(requested.some((url) => url.includes('/dsh-session-handoff/config'))).toBe(true)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('posts saves to the Host route instead of a browser scope', async () => {
    const calls: Array<{ url: string; body: unknown }> = []
    const fake = fakeClientContext({})
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (url: string, init?: { body?: string }) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body ?? '{}')) })
      return { ok: true, status: 200, json: async () => ({ ok: true }) }
    }) as unknown as typeof fetch

    try {
      apply(fake.ctx as never)
      const section = fake.registered.find((entry) => entry.options['name'] === 'settings.section')!
      const injected = (section.options['inject'] as () => Record<string, unknown>)()
      await (injected['saveSettings'] as (next: unknown) => Promise<void>)({
        autoHandoffAtContextPercent: 40,
      })

      expect(calls).toHaveLength(1)
      expect(calls[0]!.url).toContain('/dsh-session-handoff/settings')
      expect(calls[0]!.body).toMatchObject({ settings: { autoHandoffAtContextPercent: 40 } })
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('never throws when the slot registry rejects the registration', () => {
    const fake = fakeClientContext()
    ;(fake.ctx.slots as { register: unknown }).register = () => {
      throw new Error('slot occupied')
    }
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(() => apply(fake.ctx as never)).not.toThrow()
    error.mockRestore()
  })
})
