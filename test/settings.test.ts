import type { Context } from '@deepseek-ai/cordis'
import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { installNodeSettings } from '../src/settings.js'

describe('node settings discovery', () => {
  it('advertises a namespace without registering connection fields or credentials in the settings store', () => {
    const register = vi.fn()
    const inject = vi.fn((_keys: string[], callback: (ctx: unknown) => void) => {
      callback({ settings: { register } })
    })
    installNodeSettings({ inject } as unknown as Context)
    expect(inject.mock.calls[0]?.[0]).toEqual(['settings'])
    expect(register).toHaveBeenCalledOnce()
    const [namespace, schema] = register.mock.calls[0] as [string, (value: unknown) => unknown]
    expect(namespace).toBe('dsh-node')
    expect(schema({})).toEqual({})
  })

  it('keeps settings discovery optional for headless deployments', () => {
    installNodeSettings({
      inject: (_keys: string[], callback: (ctx: unknown) => void) => { callback({}) },
    } as unknown as Context)
  })

  it('declares the official settings modules needed to render the card', () => {
    const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      dsh: { client: { inject: string[] } }
    }
    expect(manifest.dsh.client.inject).toEqual(expect.arrayContaining([
      '@deepseek-ai/dsh-client-ui-settings', '@deepseek-ai/dsh-client-ui-settings-plugins',
    ]))
  })
})
