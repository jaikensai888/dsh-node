# Coordinator 设计（规格 §13 Phase 4 / §14）

> 状态：**已实现**。代码在**兄弟仓库** `G:\claude_project\code-agent\dsh-coordinator`
> （包名 `dsh-coordinator`，2026-09-20 落地）。本文仍然是**契约**来源：
> 那边凡是与本文冲突的地方都是 bug。
>
> 那边的实测记录（跑过的命令与输出）在 `dsh-coordinator/docs/GROUND-TRUTH.md`；
> 本文里 §5、§7 的部分判断已经被实践更新，见文末的「实现后的修订」。
>
> 本文里凡是与运行环境有关的事实都标注了 `[实测]` / `[源码]`；未验证的推断标注 `[待验证]`。

---

## 1. 它是什么，不是什么

Coordinator 是**一个独立的 Node/TypeScript 服务**，也是 `dsh-node` 的对端。它的职责边界：

**是**

1. 接受节点**主动发起**的 WebSocket 连接（节点侧不监听任何端口）。
2. 验证 `protocolVersion` / token / `nodeId` / `mode`。
3. 返回 `hello.ok`，给出 connection id、心跳间隔、帧与并发上限。
4. 维护**节点在线状态**与**能力摘要**（`ready.capabilities`）。
5. 作为**协议适配层**：把节点能力映射到自己的 API 表面。
6. 处理节点返回的 unary result、stream data/end/error。

**不是**

- 不是第二个远程执行器。它**不**解析业务语义、**不**自己拼命令。
- 不要求节点监听入站端口（规格 §14 第 6 条）。
- 不把 `nodeName` 当安全身份（第 7 条）。
- 不把断开的节点永久显示为在线（第 8 条）。

---

## 2. 最小兼容契约（规格 §14，本实现必须满足）

| # | 契约 | dsh-node 侧现状 |
| --- | --- | --- |
| 1 | 接受节点主动发起的 WS 连接 | 节点连接 `ws://` / `wss://`，路径取自配置（例 `/node`） |
| 2 | 能验证 `protocolVersion` / token / `nodeId` / `mode` | 节点在 `hello` 里带全这四项；版本不匹配时节点会**致命停止**不重试 |
| 3 | 返回 `hello.ok`，含连接 ID、心跳间隔、帧/并发限制 | 节点读 `connectionId` / `heartbeatIntervalMs` / `maxFrameBytes` / `acceptedMode` |
| 4 | 能发 `rpc.request` / `stream.open` / 取消 / 心跳帧 | 全部已实现 |
| 5 | 能处理 unary result、stream data/end/error | 见 §4 |
| 6 | 不要求节点监听入站端口 | `[实测]` 节点零入站端口 |
| 7 | 不把 `nodeName` 当安全身份 | 节点自己也只把 `nodeName` 当展示元数据 |
| 8 | 断线要有明确状态，不能永久在线 | 见 §3.2 |

**⚠️ 第 3 条有一个必须做的动作：`hello.ok` 必须带 `connectionId`。**
节点把它当必需字段，缺失会让连接在握手段以 `node/protocol-invalid` 被判为**致命**（进入 `stopped`，不重试）。
这是最容易在 Coordinator 侧漏掉、后果又最难查的一条。

**⚠️ 心跳：Coordinator 必须回 `pong`。**
节点每 `heartbeatIntervalMs` 发一次 `ping`，容忍
`HEARTBEAT_MISSES_ALLOWED = 2` 个周期没有 `pong`，然后判定半开连接并重连。
规格 §14 第 4 条只写了「能发心跳帧」，没明说必须**回**；但节点的实现要求回。

---

## 3. 核心数据模型

### 3.1 节点注册表

```ts
interface NodeRecord {
  nodeId: string                 // 稳定身份，节点持久化在 <DSH_HOME>/storages/dsh-node/identity.json
  token: string                  // 期望的凭据（比对用，永不回传给任何客户端）
  nodeName?: string              // 展示元数据，非安全身份
  role?: string                  // 展示元数据
  revokedAt?: string             // 撤销后拒绝握手
}
```

**身份与凭据的绑定**（规格 §9.2 红线）：

- 服务端必须把 token 与 `nodeId` **绑定**，不能只凭节点上报的 `nodeId` 放行；
- 节点的 `nodeName` / `role` 是**用户可控**的展示字段，任何鉴权判断都不得引用它们；
- 先做「注册/审批/撤销/轮换」，再谈多租户 —— 见 §7。

### 3.2 连接与在线状态 `[决策]`

```ts
type NodeConnectionState =
  | 'connecting'      // 服务端视角：socket 已建立，未收到 hello
  | 'authenticating'  // 收到 hello，正在校验
  | 'ready'           // 收到 ready，能力摘要已登记
  | 'closing'
  | 'offline'         // 连接已断

interface NodeConnection {
  connectionId: string           // 服务端生成，与 hello.ok 里的一致
  nodeId: string
  state: NodeConnectionState
  socket: WebSocket
  connectedAt?: string
  lastPongAt?: string            // 服务端自己也要做半开检测
  surfaceHash?: string           // ready.dsh.remoteSurfaceHash
  capabilities?: NodeCapabilitySummary
  inFlight: Map<string, { kind: 'unary' | 'stream'; endpoint: string; startedAt: number }>
}
```

**断开必须是一个明确事件**，而不是「socket 对象还在就用」：

- socket `close` / `error` → 立刻置 `offline`，**取消该连接上所有在途 unary 与 stream**，
  并给上层一个 `NodeDisconnected` 事件（规格 §14 第 8 条）；
- **不做自动重放**。节点已经把在途 unary 以 `node/connection-lost` 失败、把流释放掉了；
  重放会重复创建 Session、重复发 Prompt、重复改文件（规格 §1.1 第 8 条）。
- 一个 `nodeId` 重新连上时，**新连接替换旧连接**，旧连接被关闭；
  两个连接同时 `ready` 是必须避免的状态。

### 3.3 能力摘要的缓存与失效 `[决策]`

`ready.capabilities` 是**连接级快照**：

- 每次 `ready` 覆盖缓存，同时更新 `surfaceHash`；
- `surfaceHash` 变化 ⇒ 该节点的能力集合变了（DSH 侧插件装卸/热重载都会导致），
  应当记一条审计事件，并让上层缓存失效；
- provider 重连后能力可能**收缩**，所以上层不能在断开后继续按旧摘要派发。

---

## 4. 协议适配层

### 4.1 对称性：unary 与 stream 必须分开 `[源码]`

DSH 的 Gateway 对载体形状是**严格**的，Coordinator 必须照做，否则节点会返回
`gateway/signature-invalid`：

| 方法类型 | 必须用 | 用错的后果 |
| --- | --- | --- |
| unary | `rpc.request` → `rpc.result` | 用 `stream.open` 调 unary → 节点的 `stream.error` 带 `gateway/signature-invalid` |
| stream | `stream.open` → `stream.ready/data/end/error` | 用 `rpc.request` 调 stream → `rpc.result` 带 `gateway/signature-invalid` |

判断依据就是 `ready.capabilities.remotes[].mode`（`unary` / `stream`）。
**不要靠猜或靠重试**。

### 4.2 请求标识与生命周期

- `requestId`（unary）与 `streamId`（stream）由 **Coordinator 生成**，必须唯一。
  节点对重复的**在途** id 会以 `node/protocol-invalid` 拒绝。
- unary 的终态是**恰好一个** `rpc.result`；stream 的终态是**恰好一个** `stream.end | stream.error`。
  Coordinator 侧也应当用「首次结算生效」的写法，忽略重复终态（节点不会发，但防御性编程成本低）。
- `stream.data.seq` 从 **1** 开始、每流独立、每次 +1。Coordinator 应当检测**缺口**：
  缺口说明有帧没到（当前实现里不会发生，但这是协议给的检查手段）。
- **超时归 Coordinator 管**。节点侧只有 `requestTimeoutMs`（本地上限），
  stream 没有总时长上限 —— 所以「这个 follow 流看 30 秒就够了」这种事必须由 Coordinator 自己计时并
  发 `stream.cancel`。

### 4.3 错误处理：不要把所有失败当一回事 `[决策]`

| 错误码族 | 含义 | Coordinator 应当 |
| --- | --- | --- |
| `node/capability-unavailable` | 该节点没有这个能力 | 视为**能力问题**，更新/收缩自己的能力视图，不要重试 |
| `node/stream-limit` / `node/request-limit` | 节点并发满了 | **可以**退避后重试，或换节点 |
| `node/backpressure` | 消费太慢，节点主动终止该流 | 记录并**降低消费压力**；重开流要重新拉全量，不能假设续传 |
| `node/connection-lost` / `node/shutdown` | 连接没了 / 节点在停 | **不重放**；由业务决定是否重新发起 |
| `node/protocol-invalid` | 帧结构或协议版本不对 | 这是**Coordinator 自己的 bug**，要报警而不是重试 |
| 业务码（`session/not-found` …） | 业务失败 | 原样透传给上层 |
| `internal` | 见 §5 的 alpha.1 陷阱 | 不要当业务错误解析 |

### 4.4 背压：Coordinator 侧也有责任 `[决策]`

节点已经实现了「消费慢 → 暂停源 → 超时终止」。但**根因在 Coordinator**：
如果它读 socket 的速度跟不上，节点最终会以 `node/backpressure` 掉流。所以：

- 每条流的消费必须是**有界缓冲 + 明确丢弃/暂停策略**，不能无限往内存里堆；
- `stream.data` 的处理应当是**流式**的（必要时落盘/落库），而不是先攒全量再处理；
- 收到 `node/backpressure` 要当作**自身性能告警**，不是网络抖动。

---

## 5. ⚠️ 版本兼容陷阱（务必先读）

`[实测]` 运行中的 DSH 是 `0.1.2-alpha.1`，它的 Gateway 把 **`gateway/*` 边界错误统一投影成 `internal`**
（`rpcFailure()` 没有 `TypertGatewayError` 分支，而 `TypertGatewayError extends Error`、没有结构标记）。
后果与细节见 `docs/GROUND-TRUTH.md` §1.5.1。

对 Coordinator 的具体含义：

1. **不要依赖 `gateway/arguments-invalid`** 做参数校验反馈 —— 在 alpha.1 上你只会拿到 `internal`，
   而且它的 `message` 是给人看的文字。要判定「参数不对」，请在 Coordinator 侧**自己按能力摘要校验**。
2. 升级到 `alpha.2+` 后这类码会自然保留，节点的代码不需要改。
3. 因此 **Coordinator 必须在握手时记录节点上报的 DSH 版本** —— 但节点当前**没有**发 `dsh.version`
   （本机没有公开暴露版本号的服务，编造比省略更糟；`ready.dsh` 里只有 `remoteSurfaceHash`）。
   `[待验证]` 若要在 Coordinator 侧判定行为差异，需要先给节点加一个可信的版本来源。
   在那之前，Coordinator 应当**假设最保守的行为**（即：把 `internal` 也当作「可能不是业务错误」处理）。

---

## 6. 与 DSH 的类型化调用如何对接

规格 §2.1 给了两条路，Coordinator 可以选：

1. **复用 DSH 生成的 Remote Client 贡献**（保持类型化调用）；
2. **协议适配层**，按 `namespace + method` 转发。

关键约束 `[源码/实测]`：

- 官方 `api-remotes` 是**显式选择** contribution 的，不是动态扫描。
  所以第 1 条路要求对应的 Remote 包**被显式挂载**；
- 而 `dsh-node` 是**树外**插件，**无法**把自己的 Remote 塞进 `packages/api/remotes` 的组装
  （运行中的核心包是打包好的只读安装）。这就是 Phase 1 用 `ctx.dshNode` 普通 Cordis 服务
  代替 `dshNode.status()` typed Remote 的原因。

→ **建议**：Coordinator 侧走第 2 条（协议适配层），按 `ready.capabilities` 动态建模。
这样它不需要 DSH 的任何生成产物，也不需要 DSH 版本与 Coordinator 版本对齐。
类型安全靠**从能力摘要生成/校验**，而不是靠共享 .d.ts。

`[待验证]` 若将来要做「Coordinator 也提供 DSH 客户端半侧」，那才需要第 1 条，
届时要么把 dsh-node 收进官方仓库，要么由 Coordinator 提供自己的 Remote assembly。

---

## 7. 尚未定稿、需要显式决定的问题（规格 §16）

这些问题**故意不在** `dsh-node` 里决定，Coordinator 阶段必须逐个拍板：

1. 节点如何**注册、审批、撤销、轮换 token**；
2. 一个 node 是否允许多个 Coordinator 同时连接；
3. Coordinator 是否持久化 Session 元数据与事件；
4. 多个用户如何共享或隔离节点；
5. 项目经理 Agent 如何把任务拆分给不同角色的节点；
6. UI 如何展示 Node / Session / Terminal / Files / Events；
7. 任务失败后的重试、人工确认与审计策略；
8. 是否需要节点分组、标签、优先级与资源调度。

**安全上的最低要求**（在这些问题定稿前也必须满足）：

- 节点侧是 `full-access`：**一旦 Coordinator 或 token 泄露，风险接近「远程用户拥有该 DSH profile 的全部能力」**。
  所以部署建议是：专用操作系统账号、隔离工作区、限制出站地址、强制 WSS、定期轮换 token、记录调用审计。
- Coordinator 存的是**能远程操作别人机器**的凭据。它的存储、备份、访问控制等级应当按这个前提来定，
  而不是按「普通配置」。

---

## 8. 建议的落地顺序（代码阶段）

1. **协议骨架**：WS 服务端 + `hello`/`hello.ok`/`ready` + 心跳应答 + 断线事件。节点侧已就绪，可以先跑通握手。
2. **单节点 unary 转发**：注册表 + `rpc.request`/`rpc.result` + 能力摘要缓存。
3. **stream 转发**：`stream.open/data/end/error` + `seq` 缺口检测 + 有界消费 + 超时取消。
4. **节点管理 API**：列出节点、看在线状态与能力、撤销 token。
5. **会话视图**：Node → Sessions → Session detail（先只读，走 `session/list`、`session/page`）。
6. **审计与确认**：写操作留痕、危险操作人工确认。
7. **项目经理 Agent 的编排**：最后做，且必须建立在上面已稳定的调用语义之上。

---

## 9. 验证手段（现在就能用）

Phase 4 之前，`dsh-node` 自带一个只绑 loopback 的假 Coordinator，可以直接用来对打：

```powershell
node tools/fake-coordinator.mjs --probe pluginInventory/list,nope/missing
node tools/fake-coordinator.mjs --expect-token-env DSH_NODE_TOKEN
```

它已经实现了 `hello.ok` / `pong` / `rpc.request` / `stream.open` 的基本应答骨架，
并且**日志里永不写凭据**。把它当作 Coordinator 的**协议回归夹具**：
新写完的服务端应当能与它产生**逐帧一致**的交互（见 `test/integration.test.ts` 的断言）。

真 Coordinator 落地后，验证方向反过来：**它**带了两个夹具

```powershell
# 一个假节点（节点侧最小实现），用来把故障归因到协议还是服务端
node tools/fake-node.mjs --url ws://127.0.0.1:39480/node --node-id fake --token <secret>
# 一个真机验证驱动，只走 /api，可以用在真 DSH 节点上
node tools/verify-live.mjs --api http://127.0.0.1:39471 --unary pluginInventory/list
```

---

## 10. 实现后的修订（2026-09-20）

落地时被实践修正的三处，保留原文以免「设计说 A、代码做 B」无人察觉：

1. **§5 的版本陷阱已过期。** 那是 `@deepseek-ai` **0.1.2-alpha.1** 的行为；
   运行中的 DSH 已升到 **0.1.5-rc.2**，`remoteErrorOf` 是**结构化**判定
   （`isDSHRemoteError === true && typeof code === 'string'`），所以 `gateway/*` 与
   `nodeAdmin/*` 的 code **会原样保留**。`[实测]` 在 0.1.5-rc.2 上确认过
   （`/api/session/list` 缺 `_request` 时返回 `gateway/arguments-invalid`）。
   于是「Coordinator 要按能力摘要自己校验参数」不再是必需，只是**更好的**做法
   （早失败、错误更清楚）。
2. **§7 的「尚未定稿」在 Phase 4 里给了最小答案**：默认**关闭**登记（只认预先登记的
   `nodeId` + token），要自动登记必须显式给一个共享密钥；token 只对签发给它的 `nodeId` 有效；
   撤销会立刻断开在途连接；注册表**不落盘**（token 存哪里是部署决策，服务不替你决定）。
3. **§3.2 的「一个 nodeId 不允许两条 ready 连接」是**强制**的**：新连接替换旧连接，
   旧连接被关闭（`node/protocol-invalid` + `reconnect: false`），因此不存在「两个都 ready」的窗口。
