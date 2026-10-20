import type { Context } from '@deepseek-ai/cordis'
import z from 'schemastery'

/** Advertise the card; the existing config API remains the only persistence path. */
export function installNodeSettings(ctx: Context): void {
  ctx.inject(['settings'], (scoped) => {
    const settings = (scoped as Context & {
      settings?: { register?: (namespace: string, schema: unknown) => unknown }
    }).settings
    settings?.register?.('dsh-node', z.object({}))
  })
}
