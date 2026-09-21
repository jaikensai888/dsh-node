/**
 * The built client bundle, loaded the way the browser loads it.
 *
 * The composition step is only half the story: a bundle that composes can still
 * throw when the page materialises its factory, and that failure is invisible from
 * the host — the plugin simply never registers anything. This test closes that gap
 * without a DOM:
 *
 * - `lib/client.js` is evaluated with a stub `window.__ModuleLoader__`, exactly the
 *   wrapper the DSH build emits;
 * - its factory gets a stub `require` supplying only the platform modules the
 *   bundle is allowed to ask for, so an accidental dependency fails here;
 * - `apply` runs against a stub Cordis context whose `slots` records what was
 *   registered — asserting the entry id, slot, and order;
 * - the component is called once with stub hooks, so a render-time crash (a bad
 *   hook call, a missing field) fails here rather than in the user's sidebar.
 *
 * It reads the **built artifact**, not the source, on purpose: the artifact is what
 * ships, and this is the only place its wrapper is exercised.
 *
 * @module dsh-node/test/client-bundle
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { ENTRY_ID, ENTRY_ORDER, FOOTER_ACTION_SLOT } from '../src/client/index.js'
import { URL_PLACEHOLDER } from '../src/client/ConfigPanel.js'
import { NODE_ENTRY_LABEL } from '../src/client/mapping.js'

/** A registration captured from the stub slot registry. */
interface Registration {
  readonly options: Record<string, unknown>
  readonly component: (props: { wide?: boolean }) => unknown
}

/** Everything one load of the bundle produced. */
interface Loaded {
  readonly moduleId: string
  readonly exports: Record<string, unknown>
  readonly registrations: Registration[]
  /** Slot keys `inject` was called with. */
  readonly injected: string[]
  /** Effects registered on the context, run eagerly by the stub. */
  readonly effects: number
  /** The mini hook runtime, so a test can render, click, and re-render. */
  readonly hooks: HookRuntime
}

/**
 * Evaluate the built bundle under stubs and apply it.
 * @param options - `callComponent` decides whether the component is rendered at all.
 * @returns what the bundle registered.
 */
function loadBundle(options: { readonly callComponent?: boolean } = {}): Loaded {
  const bundlePath = fileURLToPath(new URL('../lib/client.js', import.meta.url))
  const source = readFileSync(bundlePath, 'utf8')

  let captured: { id: string; factory: (require: (id: string) => unknown) => Record<string, unknown> } | undefined
  const windowStub = {
    __ModuleLoader__: {
      load(registration: { id: string; factory: (require: (id: string) => unknown) => Record<string, unknown> }) {
        captured = registration
      },
    },
  }

  // The wrapper is a classic script, so it runs in a function scope with `window`
  // supplied explicitly — no `eval` in the production path, and no globals set here.
  const run = new Function('window', 'module', 'exports', source)
  const moduleStub = { exports: {} as Record<string, unknown> }
  run(windowStub, moduleStub, moduleStub.exports)
  if (captured === undefined) throw new Error('lib/client.js did not call window.__ModuleLoader__.load')
  const registration = captured as { id: string; factory: (require: (id: string) => unknown) => Record<string, unknown> }

  const requested: string[] = []
  const hooks = createHookRuntime()
  const reactStub = {
    useState: hooks.useState,
    useEffect: hooks.useEffect,
    useCallback: hooks.useCallback,
    useRef: hooks.useRef,
    createElement: hooks.createElement,
  }
  const jsxRuntimeStub = {
    jsx: hooks.jsx,
    jsxs: hooks.jsxs,
    Fragment: 'Fragment',
  }
  const requireStub = (id: string): unknown => {
    requested.push(id)
    if (id === 'react') return reactStub
    if (id === 'react/jsx-runtime') return jsxRuntimeStub
    throw new Error(`the client bundle required "${id}", which is not in the platform module table`)
  }

  const exports = registration.factory(requireStub)
  const registrations: Registration[] = []
  const injected: string[] = []
  let effects = 0

  const slots = {
    inject(key: string, callback: () => () => void) {
      injected.push(key)
      // The real registry runs the callback per declaration lifetime; the sidebar
      // declares its footer slot at boot, so the stub runs it immediately.
      return callback()
    },
    register(entryOptions: Record<string, unknown>, component: Registration['component']) {
      registrations.push({ options: entryOptions, component })
      return () => {}
    },
  }
  const ctx = {
    slots,
    effect(callback: () => unknown) {
      effects += 1
      const dispose = callback()
      return typeof dispose === 'function' ? dispose : () => {}
    },
  }

  const apply = exports['apply']
  if (typeof apply !== 'function') throw new Error('the client bundle exports no apply')
  ;(apply as (ctx: unknown) => void)(ctx)

  if (options.callComponent === true) {
    const registration0 = registrations[0]
    if (registration0 === undefined) throw new Error('nothing was registered')
    // Exercise the render path once, in both densities, with the stub hooks above.
    hooks.render(registration0.component as (props: unknown) => Element, { wide: true })
    hooks.render(registration0.component as (props: unknown) => Element, { wide: false })
  }

  return { moduleId: registration.id, exports, registrations, injected, effects, hooks }
}

/** A JSX element as the stub runtime builds it. */
interface Element {
  readonly type: unknown
  readonly props?: Record<string, unknown>
}

/** The mini runtime's surface. */
interface HookRuntime {
  readonly useState: <T>(initial: T) => [T, (next: T | ((current: T) => T)) => void]
  readonly useEffect: (callback?: () => unknown) => void
  readonly useCallback: <T>(fn: T) => T
  readonly useRef: <T>(initial: T) => { current: T }
  readonly createElement: (type: unknown, props: unknown) => Element
  readonly jsx: (type: unknown, props: unknown) => Element
  readonly jsxs: (type: unknown, props: unknown) => Element
  /** Invoke a component with its own hook cells, as React would. */
  call<T>(component: (props: unknown) => T, props: unknown): T
  render(component: (props: unknown) => Element, props: unknown): Element
  /** The tree produced by the most recent render, including re-renders from a setter. */
  latest(): Element
}

/**
 * A miniature hook runtime.
 *
 * Enough React to render a component, let a test click it, and render again with the
 * updated state — the only way to assert "clicking the row opens a panel" without a
 * browser.
 *
 * Hook cells are stored **per component**, keyed by the component function itself,
 * because that is what React does (each fiber owns its own hook list) and because a
 * single global cursor is wrong for this shape: `collect` calls nested components
 * *after* their parent has returned, so a shared counter would hand a child the
 * parent's cells and any value read across that boundary would be the wrong slot.
 */
function createHookRuntime(): HookRuntime {
  const stores = new Map<unknown, unknown[]>()
  let store: unknown[] = []
  let cursor = 0
  let lastRender: Element = { type: 'none' }
  let activeComponent: (props: unknown) => Element = () => ({ type: 'none' })
  let activeProps: unknown

  const storeOf = (component: unknown): unknown[] => {
    let own = stores.get(component)
    if (own === undefined) {
      own = []
      stores.set(component, own)
    }
    return own
  }

  const runtime: HookRuntime = {
    useState<T>(initial: T): [T, (next: T | ((current: T) => T)) => void] {
      const own = store
      const index = cursor
      cursor += 1
      if (!(index in own)) own[index] = initial
      const set = (next: T | ((current: T) => T)): void => {
        const value = typeof next === 'function' ? (next as (current: T) => T)(own[index] as T) : next
        own[index] = value
        // Re-render the tree at once, so the test can inspect the result of its click.
        lastRender = runtime.render(activeComponent, activeProps)
      }
      return [own[index] as T, set]
    },
    // Effects are counted, not run: the entry registers a poller and the config form
    // fetches its values, and a unit test wants neither a timer nor a network call.
    useEffect: (): void => { cursor += 1 },
    useCallback<T>(fn: T): T {
      cursor += 1
      return fn
    },
    useRef<T>(initial: T): { current: T } {
      const own = store
      const index = cursor
      cursor += 1
      if (!(index in own)) own[index] = { current: initial }
      return own[index] as { current: T }
    },
    createElement: (type: unknown, props: unknown): Element => ({ type, props }) as Element,
    jsx: (type: unknown, props: unknown): Element => ({ type, props }) as Element,
    jsxs: (type: unknown, props: unknown): Element => ({ type, props }) as Element,
    call<T>(component: (props: unknown) => T, props: unknown): T {
      const previousStore = store
      const previousCursor = cursor
      store = storeOf(component)
      cursor = 0
      try {
        return component(props)
      } finally {
        store = previousStore
        cursor = previousCursor
      }
    },
    render(component: (props: unknown) => Element, props: unknown): Element {
      activeComponent = component
      activeProps = props
      lastRender = runtime.call(component, props)
      return lastRender
    },
    latest: (): Element => lastRender,
  }

  return runtime
}

/**
 * Every host element in a rendered tree, depth-first.
 *
 * Function components are *rendered* while walking — a stub `jsx` only records
 * `{type, props}`, so the DOM inside a component is one call away, and a walker that
 * stopped at the component boundary would find nothing at all. The runtime is threaded
 * through so each component is invoked with its own hook cells.
 * @param element - the tree (or subtree) to walk.
 * @param runtime - the hook runtime that owns the cells.
 * @param out - accumulator.
 * @returns the host elements, in document order.
 */
function collect(element: unknown, runtime: HookRuntime, out: Element[] = []): Element[] {
  if (element === null || element === undefined || typeof element !== 'object') return out
  const node = element as Element
  if (typeof node.type === 'function') {
    return collect(runtime.call(node.type as (props: unknown) => Element, node.props), runtime, out)
  }
  out.push(node)
  const children = node.props?.['children']
  for (const child of Array.isArray(children) ? children : [children]) collect(child, runtime, out)
  return out
}

describe('the built client bundle', () => {
  it('loads through the DSH module wrapper and only asks for platform modules', () => {
    const loaded = loadBundle()
    expect(loaded.moduleId).toBe('dsh-node')
    expect(typeof loaded.exports['apply']).toBe('function')
  })

  it('registers exactly one entry in the sidebar footer, above the diagram entry', () => {
    const loaded = loadBundle()
    expect(loaded.injected).toEqual([FOOTER_ACTION_SLOT])
    expect(loaded.effects).toBe(1)
    expect(loaded.registrations).toHaveLength(1)
    const entry = loaded.registrations[0]
    expect(entry?.options).toMatchObject({
      name: FOOTER_ACTION_SLOT,
      id: ENTRY_ID,
      order: ENTRY_ORDER,
      registrant: 'dsh-node',
    })
    // Ascending sort, and the diagram entry declares 100 — anything at or above that
    // would put this row below the canvas.
    expect(ENTRY_ORDER).toBeLessThan(100)
  })

  it('renders without throwing in both densities, and reports its state', () => {
    // Before the first poll the entry shows "reading…", which is the state a
    // render-time smoke test can assert without faking a fetch.
    const loaded = loadBundle()
    const entry = loaded.registrations[0]
    if (entry === undefined) throw new Error('nothing was registered')
    for (const wide of [true, false]) {
      const tree = loaded.hooks.render(entry.component as (props: unknown) => Element, { wide })
      const button = collect(tree, loaded.hooks).find(element => element.type === 'button')
      expect(button, `no button in the ${wide ? 'wide' : 'rail'} tree`).toBeDefined()
      expect(button?.props?.['data-node-state']).toBe('loading')
      expect(String(button?.props?.['aria-label'])).toContain(NODE_ENTRY_LABEL)
      // The row must clip (a long label ellipsises) and the popover must not live
      // inside it — the bug that made clicking look broken.
      expect(button?.props?.['style']).toMatchObject({ overflow: 'hidden' })
      // The rail has no room for a label, so the wide flag must change the width.
      expect((button?.props?.['style'] as { width?: unknown }).width).toBe(wide ? '100%' : 36)
    }
  })

  it('opens a panel on click, as a sibling of the row and never clipped by it', () => {
    const loaded = loadBundle()
    const entry = loaded.registrations[0]
    if (entry === undefined) throw new Error('nothing was registered')
    const tree = loaded.hooks.render(entry.component as (props: unknown) => Element, { wide: true })

    const before = collect(tree, loaded.hooks)
    const button = before.find(element => element.type === 'button')
    expect(button).toBeDefined()
    expect(button?.props?.['aria-expanded']).toBe(false)
    expect(before.some(element => element.props?.['role'] === 'dialog')).toBe(false)

    // Measure the row, then click it, exactly as the browser would.
    const measure = button?.props?.['ref'] as ((element: unknown) => void) | undefined
    measure?.({ getBoundingClientRect: () => ({ left: 10, top: 100, width: 200 }) })
    ;(button?.props?.['onClick'] as (() => void) | undefined)?.()

    const after = collect(loaded.hooks.latest(), loaded.hooks)
    const dialog = after.find(element => element.props?.['role'] === 'dialog')
    expect(dialog, 'clicking the row produced no dialog').toBeDefined()
    // Fixed positioning anchored to the measured row: that is what escapes the
    // row's own `overflow: hidden` and any clipping ancestor.
    expect(dialog?.props?.['style']).toMatchObject({ position: 'fixed', left: 10, width: 320 })
    // The panel must say something useful even before the first poll lands — the
    // state the entry is actually in when an operator clicks it.
    expect(JSON.stringify(dialog)).toContain(NODE_ENTRY_LABEL)
    expect(JSON.stringify(dialog)).toContain('尚未读到状态')
    // And the dialog is *not* inside the button: a button may not contain a button.
    expect(collect(button, loaded.hooks).some(element => element.props?.['role'] === 'dialog')).toBe(false)
  })

  it('opens the configuration form from the panel, with the fields the operator needs', () => {
    // The path that matters most: a node with no configuration must be configurable
    // from the sidebar. The bundle test cannot fake a poll (the stub skips effects),
    // which is why the toggle has to exist independently of a successful read — the
    // form stays reachable even while the status route is unreachable.
    const loaded = loadBundle()
    const entry = loaded.registrations[0]
    if (entry === undefined) throw new Error('nothing was registered')
    const tree = loaded.hooks.render(entry.component as (props: unknown) => Element, { wide: true })

    const row = collect(tree, loaded.hooks).find(element => element.type === 'button')
    const measure = row?.props?.['ref'] as ((element: unknown) => void) | undefined
    measure?.({ getBoundingClientRect: () => ({ left: 10, top: 100, width: 200 }) })
    ;(row?.props?.['onClick'] as (() => void) | undefined)?.()

    const toggle = collect(loaded.hooks.latest(), loaded.hooks)
      .find(element => element.props?.['data-dsh-node-config-toggle'] !== undefined)
    expect(toggle, 'the panel offers no way to configure the node').toBeDefined()
    expect(toggle?.props?.['children']).toBe('编辑配置')
    // Closed by default while a connection exists: the status is what the operator
    // wants first, and the form is one click away.
    expect(collect(loaded.hooks.latest(), loaded.hooks).some(element => element.type === 'input')).toBe(false)

    ;(toggle?.props?.['onClick'] as (() => void) | undefined)?.()
    const open = collect(loaded.hooks.latest(), loaded.hooks)
    const inputs = open.filter(element => element.type === 'input')
    // Address, token, name, role.
    expect(inputs).toHaveLength(4)
    const placeholders = inputs.map(input => input.props?.['placeholder'])
    expect(placeholders).toContain(URL_PLACEHOLDER)
    // The token box is a password field that starts empty: the host never returns the
    // value, and a pre-filled-looking box would be a lie.
    const token = inputs.find(input => input.props?.['type'] === 'password')
    expect(token?.props?.['value']).toBe('')
    expect(inputs.find(input => input.props?.['placeholder'] === URL_PLACEHOLDER)?.props?.['value']).toBe('')
    // The save button is present and labelled with what it does.
    expect(JSON.stringify(open)).toContain('保存并连接')
  })
})
