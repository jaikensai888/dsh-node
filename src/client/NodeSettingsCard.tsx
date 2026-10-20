import { useState } from 'react'
import { ConfigPanel } from './ConfigPanel.js'

/** Connection settings shared by current plugin pages and the legacy settings card. */
export function NodeSettingsCard({ view }: { view?: 'summary' | 'page' } = {}): JSX.Element {
  const [open, setOpen] = useState(view === 'page')
  if (view === 'summary') return <span>本机节点与 dsh-coordinator 的连接。</span>
  const Container = view === undefined ? 'li' : 'div'
  return (
    <Container style={{
      listStyle: 'none', overflow: 'hidden', borderRadius: 12,
      border: '.5px solid var(--dsw-alias-border-l2, rgba(127,127,127,.24))',
      background: 'var(--dsw-alias-bg-layer-3, transparent)',
    }}>
      <button
        type="button"
        aria-expanded={open}
        style={{
          display: 'flex', alignItems: 'center', gap: 12, width: '100%',
          padding: 16, border: 'none', background: 'none', color: 'inherit',
          font: 'inherit', textAlign: 'left', cursor: 'pointer',
        }}
        onClick={() => { setOpen(!open) }}
      >
        <span style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: 1, minWidth: 0 }}>
          <strong style={{ fontSize: 14 }}>dsh-node</strong>
          <span style={{ fontSize: 13, color: 'var(--dsw-alias-label-tertiary, #9aa4ae)' }}>
            本机节点与 dsh-coordinator 的连接。
          </span>
        </span>
        <span aria-hidden="true">{open ? '⌃' : '⌄'}</span>
      </button>
      {open ? <div style={{ padding: '0 16px 16px' }}><ConfigPanel connectionOnly /></div> : null}
    </Container>
  )
}
