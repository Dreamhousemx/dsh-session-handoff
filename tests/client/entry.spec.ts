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

  it('injects settings access and a session id into the card', () => {
    const scope = { getSnapshot: () => ({ value: { autoHandoffAtContextPercent: 70 } }), set: vi.fn() }
    const fake = fakeClientContext({
      configForms: { get: (ns: string) => (ns === 'include:dsh-session-handoff' ? scope : undefined) },
      sessions: { list: { getSnapshot: () => ({ current: 'sess-1' }) } },
    })
    apply(fake.ctx as never)

    const card = fake.registered.find((entry) => entry.options['key'] === ROW_CARD_KEY)!
    const injected = (card.options['inject'] as () => Record<string, unknown>)()
    expect(injected['sessionId']).toBe('sess-1')
    expect(typeof injected['getSettings']).toBe('function')
    expect((injected['getSettings'] as () => { autoHandoffAtContextPercent: number })()).toMatchObject({
      autoHandoffAtContextPercent: 70,
    })
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
