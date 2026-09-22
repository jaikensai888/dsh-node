/**
 * The footer row: one status dot and, when the column is wide, one word.
 *
 * Geometry is copied from the row DSH itself puts in this slot (the settings row)
 * and from the diagram entry that already lives here, because a footer row that
 * picks its own numbers looks broken next to its neighbours:
 *
 * - wide column: 42px row, full width, 16px glyph, label text;
 * - rail: 36×36 circle, 18px glyph, no label;
 * - hover needs a real CSS rule — inline styles outrank class selectors, so the
 *   base background has to live in the same stylesheet as `:hover`.
 *
 * @module dsh-node/client/NodeStatusEntry
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { ConfigPanel } from './ConfigPanel.js'
import { NODE_ENTRY_LABEL, nodeVisual, toneColor, unavailableHint, UNCONFIGURED_HINT } from './mapping.js'
import type { NodeVisual } from './mapping.js'
import { createStatusPoller, setNodeConnection, type NodeStatusResult } from './status-source.js'

const ROW_HEIGHT_PX = 42
const RAIL_BUTTON_PX = 36
const GLYPH_PX_WIDE = 16
const GLYPH_PX_RAIL = 18

/** Hover styling has to be a class: an inline background would outrank `:hover`. */
const STYLE_ID = 'dsh-node-footer-entry'
const STYLE_RULES = [
  '.dsh-node-entry{background:transparent}',
  '.dsh-node-entry:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,0.12))}',
  '.dsh-node-entry:focus-visible{outline:2px solid var(--dsw-alias-border-focus,#4c8dff);outline-offset:-2px}',
  '@keyframes dsh-node-breathe{0%,100%{opacity:1}50%{opacity:.35}}',
  '.dsh-node-dot-breathe{animation:dsh-node-breathe 1.6s ease-in-out infinite}',
  '@media (prefers-reduced-motion: reduce){.dsh-node-dot-breathe{animation:none}}',
].join('')

/** Inject the stylesheet once per document. */
function ensureStyles(): void {
  if (typeof document === 'undefined' || document.getElementById(STYLE_ID) !== null) return
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = STYLE_RULES
  document.head.append(style)
}

/**
 * The glyph: a box with an arrow leaving it.
 *
 * The icon is the design: this plugin **dials out and listens on nothing**, so the
 * arrow leaves the box and nothing points back in. It is also deliberately unlike
 * the diagram entry's two-boxes-and-a-connector glyph, so the two rows never read
 * as the same thing.
 */
function NodeGlyph({ size }: { size: number }): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      style={{ flex: '0 0 auto', display: 'block' }}
    >
      <rect x="1.75" y="4.75" width="7.5" height="6.5" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
      <path d="M7.5 8h6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <path d="M11 5.5 13.5 8 11 10.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/** The status dot: shape carries the state, colour only reinforces it. */
function StatusDot({ visual, size }: { visual: NodeVisual; size: number }): JSX.Element {
  const colour = toneColor(visual.tone)
  const base: CSSProperties = {
    width: size,
    height: size,
    borderRadius: '50%',
    boxSizing: 'border-box',
    flex: '0 0 auto',
  }
  const shape: CSSProperties = visual.dot === 'solid'
    ? { background: colour, border: `1.5px solid ${colour}` }
    : visual.dot === 'ring'
      ? { background: 'transparent', border: `1.5px solid ${colour}` }
      : visual.dot === 'alert'
        ? { background: colour, border: `1.5px solid ${colour}` }
        : { background: 'transparent', border: `1.5px dashed ${colour}` }
  return (
    <span
      className={visual.animated ? 'dsh-node-dot-breathe' : undefined}
      style={{ ...base, ...shape }}
      data-tone={visual.tone}
      data-dot={visual.dot}
    />
  )
}

/** One `label / value` line in the popover. */
function Row({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div style={{ display: 'flex', gap: 10, padding: '3px 0', alignItems: 'baseline' }}>
      <span style={{ minWidth: 84, color: 'var(--dsw-alias-label-tertiary, #8b949e)', fontSize: 12 }}>{label}</span>
      <span style={{ fontSize: 12, wordBreak: 'break-all', flex: 1 }}>{value}</span>
    </div>
  )
}

/** Viewport coordinates for the popover, measured from the row when it opens. */
interface PopoverAnchor {
  readonly left: number
  /** Distance from the viewport bottom, so the panel grows upward. */
  readonly bottom: number
  readonly width: number
}

/** Format an ISO timestamp as local time, tolerating junk. */
function formatTime(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  const at = Date.parse(value)
  if (Number.isNaN(at)) return value
  return new Date(at).toLocaleTimeString()
}

/** How long ago, in whole minutes, or undefined when unknown. */
function agoMinutes(value: string | undefined): number | undefined {
  if (value === undefined) return undefined
  const at = Date.parse(value)
  if (Number.isNaN(at)) return undefined
  return Math.max(0, Math.round((Date.now() - at) / 60_000))
}

/** The popover body: a redacted snapshot, or the reason there is none. */
function Popover({ result, onClose, onRefresh, anchor }: {
  result: NodeStatusResult
  onClose: () => void
  /** Poll once right now, so a save is reflected without waiting a cadence tick. */
  onRefresh: () => void
  /** Viewport coordinates, measured from the row when it opened. */
  anchor: PopoverAnchor
}): JSX.Element {
  const snapshot = result.snapshot
  const visual = nodeVisual(result.input)
  const stateKey = result.input.kind === 'status' ? result.input.state : result.input.kind
  const canControlConnection = snapshot !== undefined && [
    'ready', 'connecting', 'authenticating', 'backoff', 'auth_failed', 'closing', 'paused',
  ].includes(snapshot.state)
  const connectionAction = snapshot?.state === 'paused' ? 'connect' : 'disconnect'
  const [connectionBusy, setConnectionBusy] = useState(false)
  const [connectionError, setConnectionError] = useState<string | undefined>(undefined)
  // An unconfigured node has nothing else to say, and configuring it is the only
  // useful action — so the form opens by itself, once. The latch matters: the poll
  // result is a fresh object every tick, and re-asserting "open" on every poll would
  // make the form impossible to collapse while the node is still unconfigured.
  const [configOpen, setConfigOpen] = useState(stateKey === 'unconfigured')
  const autoOpened = useRef(stateKey === 'unconfigured')
  useEffect(() => {
    if (autoOpened.current || stateKey !== 'unconfigured') return
    autoOpened.current = true
    setConfigOpen(true)
  }, [stateKey])
  const rows: JSX.Element[] = []
  if (snapshot !== undefined) {
    if (snapshot.nodeId !== undefined) rows.push(<Row key="nodeId" label="nodeId" value={snapshot.nodeId} />)
    if (snapshot.nodeName !== undefined || snapshot.role !== undefined) {
      rows.push(<Row key="name" label="名称 / 角色" value={`${snapshot.nodeName ?? '-'} / ${snapshot.role ?? '-'}`} />)
    }
    if (snapshot.mode !== undefined) rows.push(<Row key="mode" label="模式" value={snapshot.mode} />)
    if (snapshot.coordinatorOrigin !== undefined) rows.push(<Row key="origin" label="协调器" value={snapshot.coordinatorOrigin} />)
    if (snapshot.connectionId !== undefined) rows.push(<Row key="conn" label="连接 ID" value={snapshot.connectionId} />)
    const connectedAt = formatTime(snapshot.lastConnectedAt)
    if (connectedAt !== undefined) {
      const minutes = agoMinutes(snapshot.lastConnectedAt)
      rows.push(<Row key="seen" label="最近握手" value={minutes === undefined ? connectedAt : `${connectedAt}（${String(minutes)} 分钟前）`} />)
    }
    if (snapshot.lastError !== undefined) {
      const at = formatTime(snapshot.lastError.at)
      rows.push(
        <Row
          key="error"
          label="最近失败"
          value={`${snapshot.lastError.code ?? 'unknown'}${at === undefined ? '' : ` · ${at}`}`}
        />,
      )
    }
    if (snapshot.inFlightRequests !== undefined || snapshot.activeStreams !== undefined) {
      rows.push(
        <Row
          key="counter"
          label="在途 / 流"
          value={`${String(snapshot.inFlightRequests ?? 0)} / ${String(snapshot.activeStreams ?? 0)}`}
        />,
      )
    }
    if (snapshot.pluginVersion !== undefined) rows.push(<Row key="version" label="插件版本" value={snapshot.pluginVersion} />)
    const updated = formatTime(snapshot.updatedAt)
    if (updated !== undefined) rows.push(<Row key="updated" label="本次读取" value={updated} />)
  }

  return (
    <div
      role="dialog"
      aria-label={`${NODE_ENTRY_LABEL}状态`}
      style={{
        // `fixed`, anchored to the row's own rectangle. The row *must* clip its
        // content (`overflow: hidden`, so a long label ellipsises instead of
        // spilling), and an absolutely-positioned child of it would be clipped away
        // entirely — the popover would "open" and show nothing. Fixed positioning
        // also survives any ancestor that clips, which the sidebar's own column may.
        position: 'fixed',
        left: anchor.left,
        bottom: anchor.bottom,
        width: anchor.width,
        maxHeight: '60vh',
        overflow: 'auto',
        padding: '10px 12px',
        borderRadius: 10,
        border: '1px solid var(--dsw-alias-border-secondary, rgba(127,127,127,0.28))',
        background: 'var(--dsw-alias-bg-elevated, #1f2428)',
        color: 'var(--dsw-alias-label-primary, inherit)',
        boxShadow: '0 8px 24px rgba(0,0,0,0.28)',
        zIndex: 60,
        textAlign: 'left',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
        <StatusDot visual={visual} size={10} />
        <strong style={{ fontSize: 13, flex: 1 }}>{`${NODE_ENTRY_LABEL} · ${visual.label}`}</strong>
        <button
          type="button"
          onClick={onClose}
          style={{ border: 'none', background: 'transparent', color: 'inherit', cursor: 'pointer', fontSize: 12 }}
        >
          关闭
        </button>
      </div>

      {result.input.kind === 'unavailable' ? (
        <div style={{ fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-secondary, inherit)' }}>
          {unavailableHint(result.input.reason)}
          {snapshot === undefined ? '' : ' 下面是上一次成功读取到的状态。'}
        </div>
      ) : null}

      {snapshot !== undefined && snapshot.state === 'unconfigured' ? (
        <div style={{ fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-secondary, inherit)', marginBottom: 4 }}>
          {UNCONFIGURED_HINT}
        </div>
      ) : null}

      {rows.length > 0 ? rows : null}
      {snapshot === undefined && result.input.kind !== 'unavailable' ? (
        <div style={{ fontSize: 12, color: 'var(--dsw-alias-label-tertiary, #8b949e)' }}>尚未读到状态…</div>
      ) : null}

      {canControlConnection ? (
        <div style={{ marginTop: 8, paddingTop: 8, borderTop: '1px solid var(--dsw-alias-border-secondary, rgba(127,127,127,0.24))' }}>
          <button
            type="button"
            data-dsh-node-connection-action={connectionAction}
            disabled={connectionBusy}
            onClick={() => {
              setConnectionBusy(true)
              setConnectionError(undefined)
              void setNodeConnection(connectionAction).then(
                () => { onRefresh() },
                (error: unknown) => { setConnectionError(error instanceof Error ? error.message : String(error)) },
              ).finally(() => { setConnectionBusy(false) })
            }}
            style={{
              width: '100%',
              padding: '5px 8px',
              fontSize: 12,
              fontFamily: 'inherit',
              borderRadius: 6,
              cursor: connectionBusy ? 'wait' : 'pointer',
              border: '1px solid var(--dsw-alias-border-secondary, rgba(127,127,127,0.32))',
              background: 'transparent',
              color: 'inherit',
            }}
          >
            {connectionBusy ? '处理中…' : connectionAction === 'connect' ? '连接' : '断开'}
          </button>
          {connectionError === undefined ? null : (
            <div style={{ marginTop: 5, fontSize: 11, lineHeight: '16px', color: 'var(--dsw-alias-label-danger, #e5534b)' }}>
              ⚠ {connectionError}
            </div>
          )}
        </div>
      ) : null}

      <div style={{ marginTop: 6 }}>
        <button
          type="button"
          onClick={() => { setConfigOpen((current) => !current) }}
          aria-expanded={configOpen}
          data-dsh-node-config-toggle=""
          style={{
            width: '100%',
            padding: '5px 8px',
            fontSize: 12,
            fontFamily: 'inherit',
            borderRadius: 6,
            cursor: 'pointer',
            border: '1px solid var(--dsw-alias-border-secondary, rgba(127,127,127,0.32))',
            background: 'transparent',
            color: 'inherit',
          }}
        >
          {configOpen ? '收起配置' : '编辑配置'}
        </button>
      </div>
      {configOpen ? <ConfigPanel onSaved={onRefresh} /> : null}
    </div>
  )
}

/**
 * The footer entry.
 *
 * The tree is a **wrapper** holding the row button and, as a *sibling*, the
 * popover. Both details are load-bearing and both were wrong once:
 *
 * - the popover cannot be a child of the row, because the row clips its content
 *   (`overflow: hidden`, so a long label ellipsises) and an absolutely-positioned
 *   child of a clipping box is clipped away — the panel "opened" and showed nothing;
 * - the popover contains a close button, and a `<button>` may not contain another
 *   interactive element.
 *
 * @param props - `wide` comes from the slot owner; `undefined` means the wide column.
 */
export function NodeStatusEntry({ wide = true }: { wide?: boolean }): JSX.Element {
  const [result, setResult] = useState<NodeStatusResult>({ input: { kind: 'loading' }, polls: 0 })
  const [open, setOpen] = useState(false)
  const [anchor, setAnchor] = useState<PopoverAnchor | undefined>(undefined)
  const poller = useRef<ReturnType<typeof createStatusPoller> | undefined>(undefined)
  const row = useRef<HTMLButtonElement | undefined>(undefined)

  useEffect(() => {
    ensureStyles()
    const created = createStatusPoller({ onResult: setResult })
    poller.current = created
    created.start()
    return () => {
      created.stop()
      poller.current = undefined
    }
  }, [])

  // Opening the popover switches the cadence and forces a fresh read, so the
  // panel never opens on a value that is up to 15 seconds old.
  useEffect(() => {
    poller.current?.setOpen(open)
  }, [open])

  const toggle = useCallback(() => {
    setOpen((current) => {
      if (current) return false
      // Measure the row at open time: the sidebar animates, so a rectangle cached
      // at mount would put the panel in the wrong place after a collapse.
      const rect = row.current?.getBoundingClientRect()
      setAnchor(rect === undefined
        ? { left: 8, bottom: 8, width: 320 }
        : { left: rect.left, bottom: Math.max(8, window.innerHeight - rect.top + 6), width: Math.max(rect.width, 320) })
      return true
    })
  }, [])

  // Dismissal has to be possible without clicking the row again: a panel anchored
  // over the conversation that only its own trigger can close is a trap.
  useEffect(() => {
    if (!open) return undefined
    const onPointerDown = (event: Event): void => {
      const target = event.target as Node | null
      if (target !== null && row.current?.contains(target) === true) return
      if (target !== null && (target as HTMLElement).closest?.('[data-dsh-node-popover]') !== null) return
      setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  const visual = nodeVisual(result.input)
  const colour = toneColor(visual.tone)

  const rowStyle: CSSProperties = {
    boxSizing: 'border-box',
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    flex: 'none',
    width: wide ? '100%' : RAIL_BUTTON_PX,
    height: wide ? ROW_HEIGHT_PX : RAIL_BUTTON_PX,
    padding: wide ? '0 10px 0 8px' : 0,
    border: 'none',
    borderRadius: wide ? 12 : '50%',
    // The ellipsis for a long label, and the reason the popover is a sibling.
    overflow: 'hidden',
    position: 'relative',
    justifyContent: wide ? 'flex-start' : 'center',
    color: 'var(--dsw-alias-label-primary, inherit)',
    fontFamily: 'inherit',
    fontSize: 14,
    lineHeight: '22px',
    fontWeight: 400,
    textAlign: 'left',
    cursor: 'pointer',
  }
  const hostStyle: CSSProperties = {
    // Carries the row's own geometry, so the popover can be a sibling while the row
    // still lines up with the settings row above it.
    position: 'relative',
    flex: 'none',
    width: 'calc(100% + 4px)',
    margin: '4px -2px',
  }
  const railHostStyle: CSSProperties = {
    position: 'relative',
    flex: 'none',
    display: 'flex',
    justifyContent: 'center',
    margin: '8px 0 10px',
  }

  return (
    <div style={wide ? hostStyle : railHostStyle} data-dsh-node-entry-host="">
      <button
        ref={(element) => { row.current = element ?? undefined }}
        type="button"
        className="dsh-node-entry"
        onClick={toggle}
        title={visual.detail}
        aria-label={visual.detail}
        aria-expanded={open}
        aria-haspopup="dialog"
        data-node-state={result.input.kind === 'status' ? result.input.state : result.input.kind}
        style={rowStyle}
      >
        <NodeGlyph size={wide ? GLYPH_PX_WIDE : GLYPH_PX_RAIL} />
        {wide ? (
          <>
            <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', flex: 1 }}>{NODE_ENTRY_LABEL}</span>
            <span style={{ fontSize: 12, color: 'var(--dsw-alias-label-tertiary, #8b949e)', whiteSpace: 'nowrap' }}>
              {visual.label}
            </span>
          </>
        ) : null}
        {/* In the rail there is no room for a label, so the dot moves to the corner
            and has to carry the state alone — hence the distinct shapes. */}
        <span style={wide ? { paddingLeft: 2, color: colour, display: 'flex' } : { position: 'absolute', top: 4, right: 4, display: 'flex' }}>
          <StatusDot visual={visual} size={wide ? 9 : 10} />
        </span>
      </button>
      {open ? (
        <div data-dsh-node-popover="">
          <Popover
            result={result}
            onClose={() => { setOpen(false) }}
            onRefresh={() => { poller.current?.refresh() }}
            anchor={anchor ?? { left: 8, bottom: 8, width: 320 }}
          />
        </div>
      ) : null}
    </div>
  )
}
