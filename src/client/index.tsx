/**
 * Client-half plugin: one row in the sidebar footer.
 *
 * The registration mirrors the diagram entry that already lives in this slot,
 * including the two lessons its comments record:
 *
 * - `slots.inject` **waits** for the sidebar to declare the slot instead of racing
 *   it: registering an undeclared slot throws, and a declaration that collapses
 *   later disposes the entry and re-runs the callback;
 * - `ctx.effect` wires the returned disposer to fiber disposal, so a hot reload or
 *   an unmount never leaves a duplicate registration behind (a duplicate id throws).
 *
 * The service is read structurally (`ctx.slots`) rather than through an official
 * type import: this plugin is out-of-tree and must not assume any `@deepseek-ai/*`
 * package is resolvable next to it at runtime.
 *
 * @module dsh-node/client
 */

import type { Context } from '@deepseek-ai/cordis'
import { NodeStatusEntry } from './NodeStatusEntry.js'

/** The official sidebar's footer slot — the same one the diagram entry uses. */
export const FOOTER_ACTION_SLOT = 'sidebar.footer.action'

/** Stable id for this entry; `list`-kind slots key their entries by id. */
export const ENTRY_ID = 'dsh-node:status'

/**
 * Order within the footer list.
 *
 * A `list`-kind slot sorts **ascending** by `(priority, order)`, so a smaller
 * number sits higher. The diagram entry declares `100`; this one deliberately sits
 * above it at `50`, because the node's state is what an operator glances at.
 */
export const ENTRY_ORDER = 50

/** The slice of the slot registry this plugin uses. */
interface SlotsService {
  register(options: Record<string, unknown>, component: (props: { wide?: boolean }) => JSX.Element): () => void
  /** Runs the callback per declaration lifetime of the slot; a no-op while undeclared. */
  inject(key: string, callback: () => () => void): () => void
}

/**
 * Cordis service names, not package names.
 *
 * Declaring `slots` here means this plugin applies only once the slot registry
 * exists — which is what makes the entry appear without racing the shell. It does
 * **not** depend on any other plugin's client half: this row shows the node's own
 * state and must survive a neighbour being broken (the failure mode that removed
 * the diagram entry from this very slot).
 */
export const inject = ['slots'] as const

/**
 * Register the footer row.
 * @param ctx - client context carrying the slot registry.
 */
export function apply(ctx: Context): void {
  const slots = (ctx as Context & { slots?: SlotsService }).slots
  if (slots === undefined) return

  ctx.effect(() => slots.inject(FOOTER_ACTION_SLOT, () => slots.register(
    {
      name: FOOTER_ACTION_SLOT,
      id: ENTRY_ID,
      order: ENTRY_ORDER,
      registrant: 'dsh-node',
    },
    (props: { wide?: boolean }) => <NodeStatusEntry wide={props?.wide !== false} />,
  )))
}
