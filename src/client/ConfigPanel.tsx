/**
 * The configuration form inside the footer popover.
 *
 * This is the whole point of the feature: a node that has no Coordinator URL and no
 * token is `unconfigured`, and until now the only way to fix that was to edit a YAML
 * file and restart DSH. The form writes `<DSH_HOME>/storages/dsh-node/config.json`
 * through the host's one write route and the node reconnects on the spot.
 *
 * Three deliberate behaviours:
 *
 * - **the token is write-only.** The host never returns it, so the field starts
 *   empty and says so. Leaving it empty means "keep the stored one"; there is an
 *   explicit 清除 action for removing it, and nothing depends on guessing which of
 *   the two an empty box meant;
 * - **a refusal keeps the form editable.** Validation happens on the host, with the
 *   same resolver the boot path uses, and its message is rendered inside the panel
 *   with the typed values still in place;
 * - **the node id is copyable.** Registering this node on the Coordinator needs it,
 *   and it is the one value on this screen a person has to carry somewhere else.
 *
 * @module dsh-node/client/ConfigPanel
 */

import { useCallback, useEffect, useState } from 'react'
import type { CSSProperties } from 'react'
import { fetchNodeConfig, saveNodeConfig, type NodeConfigSnapshot, type NodeConfigDraft } from './config-source.js'

/** Placeholder that also documents the expected shape. */
export const URL_PLACEHOLDER = 'ws://127.0.0.1:39472/node'

const inputStyle: CSSProperties = {
  width: '100%',
  boxSizing: 'border-box',
  padding: '5px 8px',
  fontSize: 12,
  lineHeight: '18px',
  borderRadius: 6,
  border: '1px solid var(--dsw-alias-border-secondary, rgba(127,127,127,0.32))',
  background: 'var(--dsw-alias-bg-primary, rgba(127,127,127,0.06))',
  color: 'inherit',
  fontFamily: 'inherit',
}

const labelStyle: CSSProperties = {
  fontSize: 12,
  color: 'var(--dsw-alias-label-secondary, #9aa4ae)',
  display: 'flex',
  alignItems: 'center',
  gap: 6,
}

const primaryButtonStyle: CSSProperties = {
  padding: '6px 12px',
  fontSize: 12,
  borderRadius: 6,
  border: 'none',
  cursor: 'pointer',
  fontFamily: 'inherit',
  background: 'var(--dsw-alias-bg-accent, #3b82f6)',
  color: '#fff',
}

const quietButtonStyle: CSSProperties = {
  padding: '4px 8px',
  fontSize: 11,
  borderRadius: 6,
  border: '1px solid var(--dsw-alias-border-secondary, rgba(127,127,127,0.32))',
  background: 'transparent',
  color: 'inherit',
  cursor: 'pointer',
  fontFamily: 'inherit',
  whiteSpace: 'nowrap',
}

/** One labelled field. */
function Field({ label, hint, children }: { label: string; hint?: string; children: JSX.Element }): JSX.Element {
  return (
    <label style={{ display: 'block', marginBottom: 8 }}>
      <span style={labelStyle}>
        {label}
        {hint === undefined ? null : <span style={{ color: 'var(--dsw-alias-label-tertiary, #8b949e)' }}>{hint}</span>}
      </span>
      <span style={{ display: 'block', marginTop: 3 }}>{children}</span>
    </label>
  )
}

/** The reason a layer supplied the value, in one word, for the source line. */
function sourceLabel(source: 'panel' | 'profile' | 'environment' | 'none'): string {
  switch (source) {
    case 'panel': return '面板'
    case 'profile': return 'profile 配置'
    case 'environment': return '环境变量'
    default: return '未设置'
  }
}

/**
 * The form.
 * @param props - `onSaved` fires after a successful save so the caller can re-poll.
 */
export function ConfigPanel({ onSaved }: { onSaved: (config: NodeConfigSnapshot) => void }): JSX.Element {
  const [loaded, setLoaded] = useState<NodeConfigSnapshot | undefined>(undefined)
  const [loadError, setLoadError] = useState<string | undefined>(undefined)
  const [coordinatorUrl, setCoordinatorUrl] = useState('')
  const [token, setToken] = useState('')
  const [nodeName, setNodeName] = useState('')
  const [role, setRole] = useState('')
  const [reveal, setReveal] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const [notice, setNotice] = useState<string | undefined>(undefined)
  const [copied, setCopied] = useState(false)

  const adopt = useCallback((config: NodeConfigSnapshot) => {
    setLoaded(config)
    setCoordinatorUrl(config.coordinatorUrl ?? '')
    setNodeName(config.nodeName ?? '')
    setRole(config.role ?? '')
    // Never prefilled: the host does not return it, and a password box that looks
    // filled invites the operator to think the value is there.
    setToken('')
  }, [])

  const load = useCallback((signal: AbortSignal) => {
    setLoadError(undefined)
    void fetchNodeConfig(signal).then(
      (config) => { adopt(config) },
      (failure: unknown) => {
        if ((failure as { name?: string }).name === 'AbortError') return
        setLoadError(failure instanceof Error ? failure.message : String(failure))
      },
    )
  }, [adopt])

  useEffect(() => {
    const controller = new AbortController()
    load(controller.signal)
    return () => { controller.abort() }
  }, [load])

  const submit = useCallback(() => {
    setError(undefined)
    setNotice(undefined)
    const url = coordinatorUrl.trim()
    if (url === '') {
      setError('请填写协调器地址。')
      return
    }
    if (!/^wss?:\/\//iu.test(url)) {
      setError('协调器地址必须以 ws:// 或 wss:// 开头（不是 http://）。')
      return
    }
    const typedToken = token.trim()
    if (typedToken === '' && loaded?.tokenSet !== true) {
      setError('请填写令牌。')
      return
    }

    const draft: NodeConfigDraft = {
      coordinatorUrl: url,
      nodeName: nodeName.trim(),
      role: role.trim(),
      // Omitted when untouched, which is how "keep the stored token" is expressed.
      ...(typedToken === '' ? {} : { token: typedToken }),
    }
    setBusy(true)
    void saveNodeConfig(draft).then(
      (config) => {
        setBusy(false)
        adopt(config)
        setNotice('已保存，节点正在用新配置重连。')
        onSaved(config)
      },
      (failure: unknown) => {
        setBusy(false)
        setError(failure instanceof Error ? failure.message : String(failure))
      },
    )
  }, [adopt, coordinatorUrl, loaded, nodeName, onSaved, role, token])

  const clearToken = useCallback(() => {
    setError(undefined)
    setNotice(undefined)
    setBusy(true)
    // `null` is the explicit clear. An empty string would mean "keep", so this is the
    // only way to remove a stored credential from the panel.
    void saveNodeConfig({
      ...(coordinatorUrl.trim() === '' ? {} : { coordinatorUrl: coordinatorUrl.trim() }),
      token: null,
    }).then(
      (config) => {
        setBusy(false)
        adopt(config)
        setNotice('令牌已清除。')
        onSaved(config)
      },
      (failure: unknown) => {
        setBusy(false)
        setError(failure instanceof Error ? failure.message : String(failure))
      },
    )
  }, [adopt, coordinatorUrl, onSaved])

  const copyNodeId = useCallback(() => {
    const id = loaded?.nodeId ?? ''
    if (id === '') return
    void navigator.clipboard?.writeText(id).then(
      () => {
        setCopied(true)
        window.setTimeout(() => { setCopied(false) }, 1500)
      },
      () => { setError('复制失败，请手动选择文本。') },
    )
  }, [loaded])

  const tokenHint = loaded?.tokenSet === true ? '已保存，留空则不修改' : '必填'

  return (
    <div style={{ borderTop: '1px solid var(--dsw-alias-border-secondary, rgba(127,127,127,0.24))', marginTop: 6, paddingTop: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
        <strong style={{ fontSize: 12, flex: 1 }}>节点配置</strong>
        <button type="button" style={quietButtonStyle} onClick={() => { load(new AbortController().signal) }}>
          重新读取
        </button>
      </div>

      {loadError === undefined ? null : (
        <div style={{ fontSize: 12, color: 'var(--dsw-alias-label-danger, #e5534b)', marginBottom: 6, lineHeight: '18px' }}>
          ⚠ 读取配置失败：{loadError}
        </div>
      )}
      {loaded?.configFileError === undefined ? null : (
        <div style={{ fontSize: 12, color: 'var(--dsw-alias-label-danger, #e5534b)', marginBottom: 6, lineHeight: '18px' }}>
          ⚠ {loaded.configFileError}
        </div>
      )}

      <Field label="协调器地址" hint="必填">
        <input
          style={inputStyle}
          type="text"
          value={coordinatorUrl}
          placeholder={URL_PLACEHOLDER}
          spellCheck={false}
          autoComplete="off"
          onChange={(event) => { setCoordinatorUrl(event.target.value); setError(undefined) }}
        />
      </Field>

      <Field label="令牌" hint={tokenHint}>
        <span style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <input
            style={inputStyle}
            type={reveal ? 'text' : 'password'}
            value={token}
            placeholder={loaded?.tokenSet === true ? '（已保存，不显示）' : '粘贴协调器给出的令牌'}
            spellCheck={false}
            autoComplete="off"
            onChange={(event) => { setToken(event.target.value); setError(undefined) }}
          />
          <button type="button" style={quietButtonStyle} onClick={() => { setReveal((current) => !current) }}>
            {reveal ? '隐藏' : '显示'}
          </button>
        </span>
      </Field>

      <div style={{ display: 'flex', gap: 8 }}>
        <span style={{ flex: 1 }}>
          <Field label="名称" hint="可选">
            <input
              style={inputStyle}
              type="text"
              value={nodeName}
              placeholder="例如 家里的台式机"
              onChange={(event) => { setNodeName(event.target.value) }}
            />
          </Field>
        </span>
        <span style={{ flex: 1 }}>
          <Field label="角色" hint="可选">
            <input
              style={inputStyle}
              type="text"
              value={role}
              placeholder="例如 build"
              onChange={(event) => { setRole(event.target.value) }}
            />
          </Field>
        </span>
      </div>

      {loaded === undefined ? null : (
        <div style={{ fontSize: 11, color: 'var(--dsw-alias-label-tertiary, #8b949e)', marginBottom: 8, lineHeight: '16px' }}>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <span style={{ flex: 1, wordBreak: 'break-all' }}>nodeId: {loaded.nodeId === '' ? '（尚未生成）' : loaded.nodeId}</span>
            <button type="button" style={quietButtonStyle} disabled={loaded.nodeId === ''} onClick={copyNodeId}>
              {copied ? '已复制' : '复制'}
            </button>
          </div>
          <div>当前地址来源：{sourceLabel(loaded.sources.coordinatorUrl)}；令牌来源：{sourceLabel(loaded.sources.token)}</div>
          <div style={{ wordBreak: 'break-all' }}>配置文件：{loaded.configFile}</div>
        </div>
      )}

      {error === undefined ? null : (
        <div style={{ fontSize: 12, color: 'var(--dsw-alias-label-danger, #e5534b)', marginBottom: 6, lineHeight: '18px' }}>
          ⚠ {error}
        </div>
      )}
      {notice === undefined ? null : (
        <div style={{ fontSize: 12, color: 'var(--dsw-alias-label-success, #57ab5a)', marginBottom: 6, lineHeight: '18px' }}>
          {notice}
        </div>
      )}

      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <button type="button" style={primaryButtonStyle} disabled={busy} onClick={submit}>
          {busy ? '保存中…' : '保存并连接'}
        </button>
        {loaded?.tokenSet === true ? (
          <button type="button" style={quietButtonStyle} disabled={busy} onClick={clearToken}>
            清除令牌
          </button>
        ) : null}
      </div>
    </div>
  )
}
