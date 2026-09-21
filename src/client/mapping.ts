/**
 * Status → visual mapping, as a pure function.
 *
 * All the judgement in the footer entry lives here so it can be tested without a
 * browser: which tone, which dot, what the row says, what the tooltip says. The
 * component only paints what this returns.
 *
 * Three rules are deliberate, and each exists because its absence makes a UI lie:
 *
 * 1. **A failed poll is not `unconfigured`.** When the status route itself fails
 *    (HTTP error, bad payload), the entry says "status unavailable" and keeps the
 *    reason. Showing "unconfigured" would turn a UI bug into a configuration
 *    mystery — the exact confusion this project already spent a round untangling.
 * 2. **Unknown is not empty.** Before the first answer arrives the entry says
 *    "reading…"; it never flashes a state it has not observed.
 * 3. **Colour never carries the state alone.** Every tone has a distinct dot
 *    *shape* and a sentence, so the entry stays readable without colour.
 *
 * @module dsh-node/client/mapping
 */

/** The node states this UI knows, mirroring `NodeState` on the host. */
export type NodeUiState =
  | 'unconfigured'
  | 'stopped'
  | 'connecting'
  | 'authenticating'
  | 'ready'
  | 'backoff'
  | 'auth_failed'
  | 'closing'

/** What the entry is currently showing. */
export type NodeUiInput =
  | { readonly kind: 'loading' }
  | { readonly kind: 'unavailable'; readonly reason: string }
  | { readonly kind: 'status'; readonly state: string; readonly lastErrorCode?: string; readonly reconnectAttempt?: number }

/** Dot tones. The theme maps these to colours; shape is decided here. */
export type NodeTone = 'idle' | 'pending' | 'ok' | 'bad' | 'unknown'

/** Dot shapes: a state must be readable with colour switched off. */
export type NodeDot = 'hollow' | 'ring' | 'solid' | 'alert'

/** What the entry renders for one input. */
export interface NodeVisual {
  /** Short label for the expanded column. */
  readonly label: string
  /** Full sentence for the tooltip and `aria-label`. */
  readonly detail: string
  readonly tone: NodeTone
  readonly dot: NodeDot
  /** Whether the dot should breathe (a state that is actively changing). */
  readonly animated: boolean
}

/** The display name of the entry, in both densities. */
export const NODE_ENTRY_LABEL = '节点'

/**
 * What to tell an operator whose node is not configured.
 *
 * Kept here with the rest of the copy: the panel and the tooltip must never drift
 * apart on what the fix is, and text is easier to test than a tree.
 */
export const UNCONFIGURED_HINT =
  '未配置：在 profile 的 cordis.patch.yml 里给 dsh-node 填上 coordinatorUrl 与 auth.token'
  + '（或设 DSH_NODE_TOKEN 环境变量），然后重启 DSH。文件里那段注释模板取消注释即可。'

/**
 * What to tell an operator when the panel itself could not read the state.
 *
 * This sentence exists to stop a UI failure from reading as a configuration problem.
 * @param reason - the failed read, as reported by the fetch layer.
 * @returns the sentence to show.
 */
export function unavailableHint(reason: string): string {
  return `读取状态失败：${reason}。这不代表节点未配置 —— 是这一行界面拿不到宿主的状态。`
}

/** Chinese label per state, so the footer row reads as a sentence fragment. */
const STATE_LABELS: Record<NodeUiState, string> = {
  unconfigured: '未配置',
  stopped: '已停止',
  connecting: '连接中',
  authenticating: '握手中',
  ready: '已连接',
  backoff: '重连中',
  auth_failed: '凭据被拒',
  closing: '关闭中',
}

/** Which tone/dot/animation each state owns. */
const STATE_STYLE: Record<NodeUiState, { tone: NodeTone; dot: NodeDot; animated: boolean }> = {
  // Not configured and stopped are both "nothing is happening, and that is a
  // decision" — hollow, calm, never animated.
  unconfigured: { tone: 'idle', dot: 'hollow', animated: false },
  stopped: { tone: 'idle', dot: 'hollow', animated: false },
  // Anything in flight breathes: it is the only cue that the app is still trying.
  connecting: { tone: 'pending', dot: 'ring', animated: true },
  authenticating: { tone: 'pending', dot: 'ring', animated: true },
  backoff: { tone: 'pending', dot: 'ring', animated: true },
  closing: { tone: 'pending', dot: 'ring', animated: false },
  ready: { tone: 'ok', dot: 'solid', animated: false },
  // A refused credential is the one state a human must act on, so it gets the
  // loudest shape as well as the loudest colour.
  auth_failed: { tone: 'bad', dot: 'alert', animated: false },
}

/** Whether a string is a state this UI has a mapping for. */
export function isKnownState(state: string): state is NodeUiState {
  return Object.hasOwn(STATE_STYLE, state)
}

/**
 * Turn one poll result into what the row shows.
 * @param input - the current UI input.
 * @returns the label, tooltip, tone, dot shape, and animation flag.
 */
export function nodeVisual(input: NodeUiInput): NodeVisual {
  if (input.kind === 'loading') {
    return {
      label: '读取中',
      detail: `${NODE_ENTRY_LABEL}：正在读取状态…`,
      tone: 'unknown',
      dot: 'hollow',
      animated: false,
    }
  }
  if (input.kind === 'unavailable') {
    // Rule 1: never degrade a UI failure into "unconfigured".
    return {
      label: '状态不可用',
      detail: `${NODE_ENTRY_LABEL}：状态不可用 —— ${input.reason}`,
      tone: 'unknown',
      dot: 'hollow',
      animated: false,
    }
  }

  if (!isKnownState(input.state)) {
    // A newer host with a state this build has never heard of. Saying so is
    // better than guessing a tone for it.
    return {
      label: '未知状态',
      detail: `${NODE_ENTRY_LABEL}：宿主上报了未知状态 "${input.state}"`,
      tone: 'unknown',
      dot: 'hollow',
      animated: false,
    }
  }

  const style = STATE_STYLE[input.state]
  const suffix = describeSuffix(input)
  return {
    label: STATE_LABELS[input.state],
    detail: `${NODE_ENTRY_LABEL}：${STATE_LABELS[input.state]}${suffix}`,
    tone: style.tone,
    dot: style.dot,
    animated: style.animated,
  }
}

/** The parenthetical tail of the tooltip: why, or how many retries. */
function describeSuffix(input: { readonly state: string; readonly lastErrorCode?: string; readonly reconnectAttempt?: number }): string {
  if (input.state === 'unconfigured') return '（缺少 coordinatorUrl 或 token，未发起连接）'
  if (input.state === 'stopped') return '（已停止重试，需人工介入）'
  if (input.state === 'auth_failed') {
    return input.lastErrorCode === undefined ? '（请核对 token）' : `（${input.lastErrorCode}，请核对 token）`
  }
  if (input.state === 'backoff' && (input.reconnectAttempt ?? 0) > 0) {
    const code = input.lastErrorCode === undefined ? '' : `，上次：${input.lastErrorCode}`
    return `（第 ${String(input.reconnectAttempt)} 次${code}）`
  }
  if (input.lastErrorCode !== undefined && input.state !== 'ready') return `（${input.lastErrorCode}）`
  return ''
}

/** The tone colour, as a theme variable with a literal fallback. */
export function toneColor(tone: NodeTone): string {
  switch (tone) {
    case 'ok':
      return 'var(--dsw-alias-state-success, #3fb950)'
    case 'pending':
      return 'var(--dsw-alias-state-warning, #d29922)'
    case 'bad':
      return 'var(--dsw-alias-state-error, #e5534b)'
    default:
      return 'var(--dsw-alias-label-tertiary, rgba(127,127,127,0.75))'
  }
}
