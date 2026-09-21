# dsh-node

一个 DSH **Host 侧树外插件**：让本机 DSH 主动连出去（出站 `ws://` / `wss://`），
把 Coordinator 发来的结构化 Remote 调用转发给本机已经注册的 Typert Gateway。

一句话：`dsh-node` 是「DSH 本地 Typert Gateway 的**出站** WebSocket 适配器」。

它**不监听任何端口、不起任何入站服务、不需要 SSH**。

```
Coordinator (尚不存在)  <── 单条出站 WS/WSS ──  dsh-node (Host 插件)
                                                     │
                                                     ▼
                                          ctx.typertGateway.invoke({namespace, method, args, signal})
                                                     │
                                                     ▼
                                          本机 DSH profile 已注册的 Remote
```

---

## 1. 已实现范围（Phase 1 + Phase 2 + Phase 3）

**做了**

| 能力 | 说明 |
| --- | --- |
| 出站连接 | 仅主动连接 `ws://` / `wss://`，URL 协议、凭据、secret 参数全部校验 |
| 握手鉴权 | `hello` → `hello.ok` → `ready`，token 走 `hello.auth`，**绝不进 URL** |
| unary 转发 | `rpc.request` → `ctx.typertGateway.invoke({ namespace, method, args, signal })` → `rpc.result` |
| **stream 转发** | `stream.open` → `stream.ready` → `stream.data`(带 `seq`) → `stream.end`/`stream.error`；`stream.cancel` 触发 `AbortSignal` |
| **背压** | 先暂停异步迭代器（`for await` + 等待 socket 排空），排空超时才以 `node/backpressure` 终止该流 |
| **stream 上限** | 并发 `maxStreams`、单帧 `maxFrameBytes`、待发 `maxBufferedBytesPerStream`，各自有稳定错误码 |
| **管理 Remote** | `nodeAdmin/*`：节点诊断、**受路径策略约束**的文件读写、skill 安装/读取/卸载、操作审计 —— 见 §4 |
| 取消 / 超时 | `rpc.cancel` / `stream.cancel` 按 id 触发 `AbortController`；unary 有本地 `requestTimeoutMs` |
| 心跳 | 应用层 `ping` / `pong`，容忍 2 个周期，半开连接会被判定为断线 |
| 重连 | 指数退避 + 抖动；连上并稳定 `stableResetMs` 后计数归零；`auth_failed` 慢速且有限重试 |
| 状态机 | `unconfigured` / `stopped` / `connecting` / `authenticating` / `ready` / `backoff` / `auth_failed` / `closing` |
| 能力摘要 | `ready.capabilities` 列出 endpoint + mode（`unary` / `stream`），并给出 `remoteSurfaceHash` |
| 脱敏状态 | `DshNodeStatus` 快照（含 `inFlightRequests` / `activeStreams`）+ 结构化日志，token 永不出现 |
| **状态入口（客户端半侧）** | 侧边栏页脚 `sidebar.footer.action` 的一行「节点」：状态点 + 浮层 + **配置表单**（存 `<DSH_HOME>/storages/dsh-node/config.json`，保存即重连）—— 见 §1.6 / §1.7 |
| 生命周期 | 全部资源由 `ctx.effect()` 回收：停重连、取消未完成请求与流、关 socket |

**没做（有意不做）**

- **Phase 4 的 Coordinator 服务端**：**已实现，但在另一个仓库** ——
  `G:\claude_project\code-agent\dsh-coordinator`（`dsh-coordinator`）。
  契约仍是本文档与 `docs/COORDINATOR.md`；那边的实测记录在它自己的 `docs/GROUND-TRUTH.md`。
- **界面上的「立即重连」按钮**：`reconnectNow()` 只在宿主侧存在；面板保存配置时本来就会重建
  并重连，单独一个"重连"按钮没有额外价值，暂不做。
- **在面板里改连接参数以外的设置**（退避、超时、`allowedRoots`、`maxStreams`…）：这些仍然只认
  `cordis.patch.yml`。`allowedRoots` 尤其**故意**不进面板 —— 把文件系统围栏放宽不该是一次点击的事。
- **`dshNode.status()` / `dshNode.reconnect()` typed Remote**：见 §6。
- **断线重放 / 流续传**：断线时未完成的 unary 请求以 `node/connection-lost` 失败、流被释放，
  由 Coordinator 决定是否重试或重开。自动重放会重复创建 Session、重复发 Prompt、重复改文件；
  流续传会重复 Coordinator 已经看过的值。v1 没有 cursor/resume，只有新的 `stream.open`。

---

## 1.6 状态入口（客户端半侧）—— 一行状态 + 一个配置表单

侧边栏**页脚**（`sidebar.footer.action`，和「画布」同一排）多一行「**节点**」：

```
展开态   ▣→  节点            已连接 ●
收起态   ┌──────┐
         │ ▣→ • │          ← 图标 + 右上角状态点
         └──────┘
```

- **图标是「方框 + 出站箭头」**：这个插件只出不进、不监听任何端口，箭头只朝外。
- **位置在「画布」上方**：`list` 槽位按 `(priority, order)` 升序排，本行 `order: 50`、画布 `100`。
- **状态点形状区分状态**（不只靠颜色）：`ready` 实心绿 / `connecting·authenticating·backoff` 环状琥珀 + 呼吸
  / `auth_failed` 实心红 / `unconfigured·stopped` 空心灰 / 读取失败 空心灰 +「状态不可用」。
- **点一下向上弹浮层**：nodeId、名称/角色、模式、协调器 origin（无 token）、连接 ID、
  最近握手时间、最近失败码、在途/活动流、插件版本，**以及配置表单**（见 §1.7）。
- **未配置时也显示这一行**（显示「未配置」并说明怎么开）—— 藏起来只会更难排查。

数据只来自三条路由（都过信任围栏）：

```
GET  /dsh-node/api/status       → 200 {"ok":true,"value":<已脱敏的 DshNodeStatus + 版本/模式/uptime/updatedAt>}
GET  /dsh-node/ping             → 200 {"ok":true,"value":{"plugin":"dsh-node","state":…}}
GET  /dsh-node/api/diagnostics  → 200 宿主对客户端模块合成的判断
GET  /dsh-node/api/config       → 200 当前配置（**永远不含令牌**，只有 tokenSet）
POST /dsh-node/api/config       → 200 保存并立即重连（全插件唯一的写路由，见 §1.7）
```

`/api/diagnostics` 是为一类**静默故障**准备的：客户端模块合成失败时宿主**不写任何日志**，
插件在宿主里跑得好好的、界面上却什么都没有。它报出自己在不在启动清单里、bundle 路径是什么：

```json
{"clientModulesService":true,"entries":[…,"dsh-node",…],"selfComposed":true,
 "selfClientPath":"…\\dsh-node\\lib\\client.js"}
```

⚠️ 一条隐性约定：`package.json` 的 `exports` 里**必须**包含 `"./package.json": "./package.json"`。
宿主用 `require.resolve('<包名>/package.json')` 定位插件清单；有 `exports` 却导出不全就会解析失败、
**静默跳过**整个客户端半侧（有守卫测试锁定，别删）。

三条硬约束（都有测试锁定）：

1. **几乎只读**：`GET`/`HEAD` 覆盖全部路由，**唯一**的写操作是 `/api/config` 的 `POST`
   （不接受路径、不接受任意写入），其余任何方法回 405。
2. **无凭据**：载荷就是宿主自己的脱敏快照，`coordinatorOrigin` 只有 `scheme://host:port`；
   配置视图只有 `tokenSet: true/false`，令牌值永不回传。
3. **有围栏**：每个请求都要过 `isTrustedNodeRequest`（Host 必须回环或部署声明可信、
   拒绝 `sec-fetch-site: cross-site`、拒绝外来 `Origin`）—— 因为插件前缀路由**不经过**
   浏览器的会话 cookie 鉴权，DNS rebinding / 跨站请求必须在这里挡住。

客户端**轮询**（关闭时 15s、浮层打开时 2s、窗口隐藏时跳过），刻意不做推送：
一个状态点不该有生命周期可言。**界面自己坏了显示「状态不可用」，绝不显示「未配置」** ——
否则一个 UI bug 会伪装成配置问题。

---

## 1.7 在面板里配置节点（`config.json`，不需要重启 DSH）

节点**没配置**时点开「节点」浮层，表单自动展开；已连接时点「编辑配置」展开。表单里是：

```
协调器地址 *   ws://127.0.0.1:39472/node          ← 必填，必须 ws:// 或 wss://
令牌 *         （已保存，不显示）  [显示]          ← 必填；已存过则留空 = 不修改
名称 / 角色    可选
nodeId: node-…  [复制]                            ← 在协调器上批准这个节点要用它
当前地址来源：面板；令牌来源：面板                  ← profile / 环境变量 也在这里显示
配置文件：C:\Users\<你>\.dsh\storages\dsh-node\config.json
[保存并连接]  [清除令牌]
```

**保存 = 立刻用新配置重连**（宿主停掉旧实例、按新配置重建并重连），**不需要重启 DSH**。
只有按钮一个：既然任何保存都要重建宿主才生效，再放一个"仅保存"只会骗人。

分层与优先级：

```
<DSH_HOME>/storages/dsh-node/config.json    面板写这里（与 identity.json 同目录，0600，原子写）
优先级：面板文件 > cordis.patch.yml > 环境变量（DSH_NODE_COORDINATOR_URL / DSH_NODE_TOKEN）
```

行为细节：

- **令牌只写不读**：视图里只有 `tokenSet`，表单里的令牌框**永远是空的**（留空即不修改）。
  要删掉已存的令牌用「清除令牌」（发送 `"token": null`）。
- **字段语义**：省略 = 不改；`""` = 对令牌表示"不修改"、对名称/角色表示"清空"；`null` = 显式清空。
- **不完整的保存会被拒绝**（缺地址或缺令牌 → 400 `node/config-incomplete`）：
  存一份不完整的配置会把一个本来能用的节点踢下线，所以宁可不存。
- **校验只有一处**：面板提交的文档走的是**与启动完全相同**的 `resolveNodeConfig`，
  不存在"面板说行、启动说不行"的可能。
- **失败留在面板里**：写文件失败、重启失败、校验失败都会把原因显示在表单下方，输入内容不丢；
  「重启失败」会明确说**文件已经保存**，免得重打一遍。
- **未配置的节点也会加载 identity**：否则 `nodeId` 要等到连上才有，而"在协调器上批准这个节点"
  需要的恰恰是它 —— 见 `docs/GROUND-TRUTH.md` §0.7.1。

安全边界（为什么可以这么做）：围栏挡的是 DNS rebinding 与跨站请求，**不是**本机用户；
能访问这条路由的本机用户本来就能读那个文件。文件是本次改动唯一新增的**静态密钥**，
所以它 `0600`、原子写、失败时连临时文件一起删掉。

---

## 1.5 管理 Remote（`nodeAdmin/*`）—— 唯一能改动本机的部分
**先明确风险**：节点是 `full-access`。**拿到 token 的 Coordinator 可以调用下面这些能力。**
本阶段按决定「全部默认注册开启」，所以这一节值得完整读一遍。

### 1.5.1 暴露面（受测试锁定：多一个端点必须显式改测试）

| endpoint | 参数 | 作用 |
| --- | --- | --- |
| `nodeAdmin/describe` | — | nodeId、状态、uptime、插件版本、能力数、三个开关是否开启 |
| `nodeAdmin/status` | — | 与本地等价的脱敏状态快照 |
| `nodeAdmin/capabilities` | — | 本机可派发的 endpoint + mode 全量列表 |
| `nodeAdmin/audit` | `limit` | 最近的管理操作（默认 50，上限为环形容量） |
| `nodeAdmin/fsList` | `path` | 列目录 |
| `nodeAdmin/fsStat` | `path` | stat |
| `nodeAdmin/fsRead` | `path` | 读文件（≤ 1 MiB） |
| `nodeAdmin/fsWrite` | `path`, `content` | 写文件（≤ 4 MiB，自动建父目录） |
| `nodeAdmin/fsRemove` | `path` | 删一个文件，或**一个空目录** |
| `nodeAdmin/skillsList` | — | 列出已装 skill（返回**层标签**，不返回主机路径） |
| `nodeAdmin/skillRead` | `name` | 读某个 skill 的 `SKILL.md` |
| `nodeAdmin/skillInstall` | `name`, `content` | 写入 `<主 skill 根>/<name>/SKILL.md`（≤ 1 MiB） |
| `nodeAdmin/skillRemove` | `name` | 删掉该 skill 目录 |

**没有**任何能执行 shell、eval、加载模块、或按任意路径读写的端点。测试逐条断言这一点。

### 1.5.2 文件路径策略（这是"默认开启"没有变成"任意读写"的原因）

`nodeAdmin/fs*` 的 `path` 必须落在**允许根**内，判定规则：

1. 必须**绝对路径**（`foo/bar`、`C:foo` 都拒）；
2. 根与目标都做 **realpath**（末尾不存在的部分回退到最深的已存在祖先再拼回），
   所以"根内一个指向根外的链接"会被抓住；
3. **段感知**包含判定，`/root-evil` 不会被当成 `/root` 的子路径。

**默认允许根 = 活跃 session 的工作目录**（`ctx.sessions.list()` 的 `header.cwd`）。
没有 session、也没有配置 `allowedRoots` 时，**所有 fs 端点一律拒绝** —— 不会退回"整个磁盘"。

skill 端点不接受路径，只接受**名字**（`^[A-Za-z0-9][A-Za-z0-9._-]*$`，≤64 字符），
且只在 skill 根的第一层写 `<name>/SKILL.md`。`../escape`、`a/b`、`/etc/passwd` 都回
`nodeAdmin/invalid-name`。

### 1.5.3 审计

每次管理调用记一条：`endpoint` / `outcome` / `code` / **操作种类**（不是路径）/ 字节数 / 耗时。
**不记参数、不记文件内容、不记绝对路径** —— 有测试断言审计序列化结果里既没有写入的内容也没有根路径。
环形缓冲，容量由 `auditCapacity` 控制（默认 256），不会无限增长。

### 1.5.4 错误码

`nodeAdmin/invalid-arguments`、`nodeAdmin/path-denied`、`nodeAdmin/not-found`、
`nodeAdmin/already-exists`、`nodeAdmin/too-large`、`nodeAdmin/invalid-name`。

这些是**业务码**，由 Remote 自己抛出，经 Gateway 的失败投影原样返回
（实现方式是给 `Error` 加 `isDSHRemoteError = true` 结构标记，不 import 官方包 —— 见 GROUND-TRUTH §0.3.2）。

### 1.5.5 想关掉它们

```yaml
config:
  adminFilesystemEnabled: false   # fs* 一律回 nodeAdmin/path-denied
  adminSkillsEnabled: false       # skill* 一律回 nodeAdmin/path-denied
  allowedRoots:                   # 显式扩大允许根（必须是绝对路径）
    - D:\projects\shared
  skillRoots:                     # 覆盖主 skill 根（第 0 个是安装目标）
    - C:\Users\jaike\.agents\skills
```

端点仍然会被注册（所以 `describe` 里的 `surfaces` 会显示 `false`），但一调用就拒绝。
这样 Coordinator 能区分「没有这个能力」和「有这个能力但被关掉了」。

---

## 2. 配置

Phase 1 只有两个来源：**profile patch 的 bootstrap config** 和**环境变量**。
（没有设置卡片，因此没有 `settings.installSection`。）

```yaml
# C:\Users\jaike\.dsh\profiles\web\cordis.patch.yml
- insert:
    - id: dsh-node
      name: 'dsh-node'
      config:
        coordinatorUrl: wss://coordinator.example.com/node
        nodeName: test-agent-a
        role: test-agent
        mode: full-access
        reconnect:
          initialDelayMs: 1000
          maxDelayMs: 30000
          jitterRatio: 0.2
          stableResetMs: 30000
        heartbeatIntervalMs: 20000
        handshakeTimeoutMs: 10000
        requestTimeoutMs: 120000
        maxFrameBytes: 4194304
        maxInFlightRequests: 64
        # Phase 2：stream 上限与背压
        maxStreams: 16
        maxBufferedBytesPerStream: 4194304
        sendStallTimeoutMs: 30000
        # Phase 3：nodeAdmin 管理面
        adminFilesystemEnabled: true
        adminSkillsEnabled: true
        auditCapacity: 256
        # allowedRoots / skillRoots 留空时：fs 只能动活跃 session 的工作目录，
        # skill 只能动 <DSH_HOME>/skills 与 <DSH_AGENTS_HOME>/skills
```

**不要**把 token 写进 yaml。用环境变量：

| 环境变量 | 用途 |
| --- | --- |
| `DSH_NODE_TOKEN` | **token（唯一来源之一）** |
| `DSH_NODE_COORDINATOR_URL` | Coordinator URL，便于 headless 部署 |
| `DSH_NODE_IDENTITY_FILE` | 覆盖身份文件路径（必须绝对路径） |
| `DSH_NODE_LOG_LEVEL` | `debug` / `info` / `warn` / `error`，默认 `info` |

`config.auth.token` 也可以写，但优先级低于「显式配置 > 环境变量 > 默认值」。

### 2.1 校验规则

- `coordinatorUrl` 协议只能是 `ws:` / `wss:`；`http:` / `https:` / `file:` / 非法 URL 全部拒绝。
- 拒绝带用户名密码的 URL。
- 拒绝 query / fragment 里出现 `token` / `access_token` / `auth` / `apikey` / `secret` / `password`
  这类参数名的 URL —— 红线是「token 绝不进 URL」，所以这种部署**必须响亮地失败**，而不是看起来能用。
- `mode` 只能等于 `full-access`。
- 所有延迟 / 大小 / 并发数必须是有限正数且在上下限内（见 `src/config.ts` 的 `BOUNDS`）。
- token 不能为空，且**不从 URL query / fragment 读取**。
- **未配置 URL 或 token → 状态 `unconfigured`：不建连接、不进重连循环**。这不是异常。

### 2.2 `full-access` 的准确含义

表示「`dsh-node` 本身不再增加一层节点级 Remote 白名单」。
**不**表示：拥有任意文件系统访问、任意 Shell、任意进程控制、任意模块加载，也不绕过
DSH 自己的参数校验与错误模型。节点能提供什么，完全取决于本机 profile 已加载的 Remote。

---

## 3. 协议摘要（`dsh-node/1`）

帧集合（Phase 1 + Phase 2）：

| 方向 | 帧 |
| --- | --- |
| Coordinator → Node | `hello.ok`、`rpc.request`、`rpc.cancel`、`stream.open`、`stream.cancel`、`ping`、`pong`、`close` |
| Node → Coordinator | `hello`、`ready`、`rpc.result`、`stream.ready`、`stream.data`、`stream.end`、`stream.error`、`ping`、`pong`、`close` |

方向是**强校验**的：Node 收到 `stream.data` 这类只应由自己发出的帧，会记 protocol-error 并忽略，
绝不当作指令执行。

`rpc.request`：

```json
{
  "type": "rpc.request",
  "protocolVersion": "dsh-node/1",
  "nodeId": "node-…",
  "requestId": "req-uuid",
  "endpoint": "session/create",
  "payload": { "args": { "workspaceId": "workspace-1" } }
}
```

- `endpoint` 必须是**恰好两段** `<namespace>/<method>`（与 Gateway 内部规则一致）。
- `payload` 必须**恰好**是 `{ args: <plain object> }`（与 Gateway 的载体要求一致）。
- **`payload.args` 原样透传**：节点不增、不删、不改名任何字段，因为 Gateway 会执行
  `assertExactArguments`，多一个少一个都报 `gateway/arguments-invalid`。

`rpc.result`：

```json
{ "type": "rpc.result", "requestId": "req-uuid", "result": { "ok": true, "value": {} } }
{ "type": "rpc.result", "requestId": "req-uuid",
  "result": { "ok": false, "error": { "code": "session/not-found", "message": "…", "details": {} } } }
```

### 3.1 错误码

节点自己产生 `node/*`：`node/config-invalid`、`node/auth-failed`、`node/protocol-invalid`、
`node/handshake-timeout`、`node/connection-lost`、`node/request-timeout`、`node/frame-too-large`、
`node/request-limit`、`node/stream-limit`、`node/backpressure`、`node/not-ready`、
`node/capability-unavailable`、`node/shutdown`。

映射原则：

- endpoint 不在本机已注册能力内 → `node/capability-unavailable`；
- **其余 `gateway/*` 与业务错误原码保留**（`code` / `message` / 安全的 `details`）。
  实现上直接复用 Gateway 自己的 `ctx.typertGateway.wireStream.failure(error)`，
  所以节点返回的内容和官方 HTTP / WebSocket 载体完全一致。
  只有「这个 endpoint 本机没有」这一族被折叠成 `node/capability-unavailable`
  （见 `src/index.ts` 的 `CAPABILITY_FAILURE_CODES`）。

> ⚠️ **在 DSH `0.1.2-alpha.1` 上有一个前提**：「`gateway/*` 原码保留」**做不到** ——
> 因为该版本的网关把 `gateway/*` 边界错误（如 `gateway/arguments-invalid`）全都投影成
> `internal`（它的 `rpcFailure()` 没有 `TypertGatewayError` 分支）。
> 节点忠实复现官方行为，所以在 alpha.1 上两条载体返回的 `internal` 逐字相同。
> 升级到 `alpha.2+` 后 `gateway/*` 原码自然保留，节点代码无需改动。
> **Coordinator 不要依赖 `gateway/arguments-invalid` 做参数校验反馈，除非已确认节点版本 ≥ alpha.2。**
> 详见 `docs/GROUND-TRUTH.md` §1.5.1（含实测报文）。

### 3.2 能力摘要与 `remoteSurfaceHash`

`ready.capabilities` 的形态：

```json
{
  "remotes": [{ "endpoint": "session/create", "mode": "unary" }],
  "remoteSurfaceHash": "sha256:…",
  "namespaces": ["…"]
}
```

`remoteSurfaceHash` 是对「排序后的 endpoint+mode 列表 + 无法枚举方法名的 namespace」做的 sha256。
它是一份**受控摘要**，不含任何本机路径、token、环境变量。

**结论（规格 §7.2 留的开放项已解决）**：Typert 确实有**公开**的能力枚举接口 ——
`ctx.typert.local.list(): readonly InvocationDescriptor[]`（`@deepseek-ai/dsh-typert-registry`），
每条带 `namespace` / `method` / `mode`。所以不需要私有字段反射。
另外，源码模式的插件（`TypertRemoteService` + `@Remote`，即没有走 typert 生成器的树外插件）
只暴露一个**公开**的 `typertRemote` 绑定，给出 namespace 但**拿不到方法名**，因为 marker 表是
`@deepseek-ai/dsh-typert-protocol` 的模块私有 `WeakMap`。
节点因此采用两层策略：

1. `ctx.typert.local.list()` → 精确 endpoint（`remotes`）；
2. 公开 `typertRemote.namespace` → 可派发的 namespace（`namespaces`，且只列出没有精确 endpoint 的那些）。

网关判定时：命中精确 endpoint 直接派发；否则若 namespace 已知则交给 Gateway 判定，
并把它那一族「不可用」错误折回 `node/capability-unavailable`；namespace 都不认识 → 节点本地直接拒绝，
**请求不会碰到任何业务方法**。

### 3.3 Stream 调用

```json
// Coordinator -> Node
{ "type": "stream.open", "streamId": "s-1", "requestId": "req-1",
  "endpoint": "session/follow", "payload": { "args": { "sessionId": "session-1" } } }

// Node -> Coordinator（顺序固定）
{ "type": "stream.ready", "streamId": "s-1", "requestId": "req-1" }
{ "type": "stream.data", "streamId": "s-1", "seq": 1, "value": {} }
{ "type": "stream.data", "streamId": "s-1", "seq": 2, "value": {} }
{ "type": "stream.end", "streamId": "s-1", "count": 2 }

// 失败时用 stream.error 代替 stream.end
{ "type": "stream.error", "streamId": "s-1", "count": 1,
  "error": { "code": "session/not-found", "message": "…", "details": {} } }

// Coordinator -> Node
{ "type": "stream.cancel", "streamId": "s-1", "reason": "operator stopped it" }
```

**不变量**（都有测试）：

- `seq` 从 **1** 开始、**每个流独立**、每次恰好 +1，所以 Coordinator 能发现丢帧或乱序。
- 每个流**恰好一个终态帧**（`stream.end` 或 `stream.error`），此后**不再有任何**该 `streamId` 的帧。
  重复 `stream.open` 同一 id 会被 `node/protocol-invalid` 拒绝，且不影响已存在的那个流。
- `stream.ready` 只在 Gateway **真的打开了**迭代器之后才发，所以 Coordinator 能区分
  「已打开但还没有数据」与「还在打开」。
- `stream.cancel` 用 **`gateway/cancelled`** 回复（与本地 DSH 调用方看到的同一码），
  并且**取消信号真的传到了业务生成器**（集成测试用注入的 `signal` 断言，而不是只看节点停没停）。

**背压模型**（规格 §8.2）：

1. `for await` 保证**下一个值只在上一帧被接受之后才向源索取** —— 慢的 Coordinator 会自然把源**暂停**；
2. 发送前若 socket 待发字节超过 `maxBufferedBytesPerStream`，**先等它排空**（`sendStallTimeoutMs` 内轮询）；
3. 排空超时 → 只终止**这一个**流，回 `node/backpressure`，绝不无限增长内存。

单帧超过 `maxFrameBytes` 时回 `node/frame-too-large`（而不是静默丢弃 —— 丢弃会让 Coordinator 以为流正常结束）。

> ⚠️ `maxBufferedBytesPerStream` 约束的是**传输层待发字节**，而 `ws` 一个 socket 只有一份缓冲，
> 所以这个数字是**连接级**的，作用是限制单条流能跑多超前，而不是给每条流做精确字节归属。

---

## 4. 状态与可观测性

```ts
ctx.dshNode.status
// {
//   state: 'ready', nodeId: 'node-…', nodeName?, role?,
//   coordinatorOrigin: 'wss://coordinator.example.com',   // 只保留 协议+主机+端口
//   connectionId?, reconnectAttempt, lastConnectedAt?,
//   lastError?: { code, message, at }, inFlightRequests, activeStreams
// }
```

`ctx.dshNode` 是**普通 Cordis 服务**（in-process），不是 typed Remote。它随插件 fiber 一起回收。

日志事件：`dsh-node/state-changed`、`dsh-node/connecting`、`dsh-node/connected`、
`dsh-node/disconnected`、`dsh-node/reconnect-scheduled`、`dsh-node/request-completed`、
`dsh-node/protocol-error`、`dsh-node/frame-too-large`。

**脱敏保证（有测试）**：

- 日志里 URL 只留 `scheme://host:port`，路径 / query / fragment 全部丢弃；
- 日志字段经过 `scrubValue`，凭据字段名与 token 字面量都会被替换成 `«redacted»`；
- `status` 快照会把 `lastError.message` 再洗一遍 —— 因为**状态是逐字返回给调用方的**，
  不像日志会过 sink；
- **Coordinator 送来的 `close.reason` 属于不可信输入**，在进入状态与日志前就会按本节点的 token
  做字面量擦除并截断（这是实现过程中发现并修掉的一个真实泄漏点）。

---

## 5. 部署

### 5.1 构建

```bash
pnpm install
pnpm --config.verify-deps-before-run=false typecheck
pnpm --config.verify-deps-before-run=false test
pnpm --config.verify-deps-before-run=false build   # 产出 lib/index.js 与 lib/types/**
```

> ⚠️ **`--config.verify-deps-before-run=false` 不是可选的。**
> `pnpm run` 的 deps 状态检查会再起一个 `pnpm install`，本机上一个会报
> `ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY`（`.npmrc` 里两个相关键对当前 pnpm 都不生效）。
> 等价的绕开方式：
>
> ```bash
> node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit
> node node_modules/vitest/vitest.mjs run
> ```
>
> ⚠️ **`typecheck` 绿不代表 `build` 绿。** `build` 会额外跑 `tsc -p tsconfig.build.json`，
> 它**只编译 `src/**`**（不含 `test/`），因此是真实的发布类型边界。
> 曾经就在这里漏过一个错误：`ctx.typert.register` 只在 `test/` import 具体类时才有类型，
> src-only 编译会失败。**两个都要跑。**

### 5.2 装进 profile

`name: 'dsh-node'` 必须能被 profile 的 Loader 解析。两种做法：

**(a) 开发期：做个目录联接（本机已实测通过）**

```powershell
# 让 profile 能按包名解析到这个 checkout
New-Item -ItemType Junction `
  -Path "C:\Users\jaike\.dsh\profiles\web\node_modules\dsh-node" `
  -Target "G:\claude_project\code-agent\dsh-node"
```

**(b) 正式：作为 profile 依赖安装**

```powershell
dsh plugin --profile web add dsh-node        # 转发给该 profile 的 pnpm
# 或手工在 profiles/web/package.json 的 dependencies 里写 "dsh-node": "link:G:/claude_project/code-agent/dsh-node"
```

然后在 profile 的 `cordis.patch.yml` 里插入一行（**必须用 `- insert:` 数组形式**）：

```yaml
- insert:
    - id: dsh-node
      name: 'dsh-node'
```

> 规格 §4.2 给的那段 `- id: / name:` 片段是 **bundle 内部 loader entry** 的写法，
> 不是 profile 用户层 patch 的写法。profile 层以 `dsh-drawio/cordis.patch.yml` 与本机
> `profiles/web/cordis.patch.yml` 的实际写法为准：顶层是 patch entry 数组，插入用 `insert`。

> ⚠️ **改完 `cordis.patch.yml` 必须重启 DSH**，不要指望热重载。
> 实测（2026-09-18，desktop profile）：`patchReload: "live"` 虽然写着，但
> `@deepseek-ai/cordis-plugin-hmr` 在运行树里**根本不 active**（`include:hmr` 是 disabled，
> 且没有任何运行期创建出来的 hmr entry），所以 `watchUserPatches()` 从未注册成功，
> 用户 patch 层不会被热重放。改 entry、改 config、换 token 来源之后，
> 运行中的实例都不会跟随变化。详见 `docs/GROUND-TRUTH.md` §11.2（含证据链）。

### 5.3 验证

**第一步：组合树**

```powershell
$env:DSH_HOME="C:\Users\jaike\.dsh"
dsh --profile desktop --dump-config | Select-String "dsh-node"
```

**实测输出**（本机 `dsh` 版本 `0.1.2-alpha.1`，`web` 与 `desktop` 两个 profile 都验过）：

```
- id: dsh-node
  name: dsh-node
```

退出码 0、无 error 标记。**请顺便确认 `- id: dsh-node` 只出现一次** —— 出现两次就是双挂载。
注意 `--dump-config` **只回放组合后的 loader 树，并不 boot**，所以它证明的是挂载正确，不是运行期无冲突。

**第二步：真实运行（推荐）**

本插件已在**运行中的 DSH Desktop（`desktop` profile）**上端到端验证通过
（完整方法见 `docs/GROUND-TRUTH.md` §11.1）：

- `pluginInventory/list` 报出 `{"entryId":"include:dsh-node","enabled":true,"fiberPhase":"active"}`；
- 用本地 fake WebSocket Coordinator 观测到节点主动连出、完成 `hello`/`hello.ok`/`ready`；
- 上报 74 个真实 endpoint（其中 3 个 `stream`）与 `remoteSurfaceHash`；
- 不存在的 endpoint 返回 `node/capability-unavailable`，业务方法零调用；
- `39471` 端口的监听者是我的 `node` 假服务，**不是 DSH** —— 节点侧无任何入站端口。

注意：**Phase 1 没有浏览器半侧**，所以在 DSH 界面上**看不到任何变化**是预期行为
（设置卡片、左下角状态入口都是 Phase 1 之后的事）。验证要看上面的运行证据，不要看 UI。

本阶段 Coordinator 还不存在，所以清掉验证用的临时配置后，节点会停在 `unconfigured`
（不建连接、不重连）——这是预期行为。

### 5.4 看日志（重要）

节点**没有 UI**（Phase 1 无浏览器半侧），所以状态全靠日志。它的记录走 `ctx.logger`，
落在 DSH 的运行日志里：

```
%APPDATA%\DSH Desktop\logs\dsh-<date>.log
```

```powershell
Get-Content "$env:APPDATA\DSH Desktop\logs\dsh-$(Get-Date -Format yyyy-MM-dd).log" |
  Select-String "dsh-node"
```

启动后应该看到（`unconfigured` 是没配 Coordinator 时的正确状态）：

```
[I] [dsh-node] dsh-node/state-changed {"state":"unconfigured","reason":"coordinatorUrl or token is not configured; no connection is attempted and no reconnect is scheduled"}
```

配好之后则是 `dsh-node/connecting` → `dsh-node/connected` → `dsh-node/request-completed`。

> ⚠️ 这些记录**只**走 `ctx.logger`。插件内部的 `console.log` 兜底在 DSH Desktop 里
> **不落任何文件**，所以你**不会**在 stdout 或别处看到它们。
> 另外，日志消息里的 `%` 会被转义成 `%%`（Cordis 的 logger 是 printf 风格，
> 不转义的话消息里的 `%s` 会吃掉后面的结构化字段）。

### 5.5 冒烟测试：本地 fake Coordinator

真实的 Coordinator 还不存在，所以仓库里带了一个只绑 loopback 的假 Coordinator，
可以随时验证节点能正常连出、握手、转发，而不需要任何外部服务：

```powershell
# 1) 让它监听（默认 127.0.0.1:39471）
node tools/fake-coordinator.mjs --help

# 2) 在 profile patch 里给 dsh-node 加上
#      config:
#        coordinatorUrl: ws://127.0.0.1:39471/node
#    并设置 DSH_NODE_TOKEN 后重启 DSH

# 3) 观察握手，并顺手验证一个已注册 endpoint 能通、一个不存在的被拒
node tools/fake-coordinator.mjs --probe pluginInventory/list,nope/missing

# 4) 验证节点用的确实是你给的那个 token（不把 token 写进命令行）
node tools/fake-coordinator.mjs --expect-token-env DSH_NODE_TOKEN
```

期望看到 `hello` → `hello.ok` → `ready`（带 endpoint 数与 `remoteSurfaceHash`），
以及两次 `PROBE` 的结果：一个是 `ok=true`，另一个是
`ok=false code=node/capability-unavailable`。

这个工具的两条硬性质：**只绑 `127.0.0.1`**（host 是常量，没有 `--host` 开关），
以及**永不在日志里写凭据**（`hello.auth.token` 写出前就被替换掉；
token 只能通过 `--expect-token-env` 从环境变量读，不进 shell 历史）。

### 5.6 卸载

删掉 patch 里的那一行，再删掉 `node_modules/dsh-node` 联接（`cmd /c rmdir <path>`，
不要用会递归删除目标目录的命令）。

---

## 6. 安全问题与红线

| 红线 | 落实方式 |
| --- | --- |
| token 绝不进 URL | URL 里出现凭据参数名直接判配置错误；token 只从 config / `DSH_NODE_TOKEN` 读 |
| token 不进日志 / 错误 / 状态 | `createNodeLogger` 统一擦除；`statusSnapshot` 二次擦洗；`close.reason` 属不可信输入 |
| 日志里 URL 只留 协议+主机+端口 | `redactUrl()`，有测试 |
| 不新增 Shell / eval / 任意模块加载 / 任意路径读写 | 源码里没有 `child_process` / `eval` / `new Function` / `require(` / 动态 `import()`；唯一的文件读写是身份文件，且路径必须绝对 |
| 不监听任何入站端口 | 源码里没有 `WebSocketServer` / `createServer` / `.listen(` / `registerUpgrade` —— 有架构守卫测试逐文件扫描 |
| 不自动重放未确认的写操作 | 断线时 `RequestManager.failAll(node/connection-lost)`；集成测试断言业务方法只被调用一次、新连接上没有补发的 `rpc.result` |
| 卸载 / 退出时全部回收 | 一切资源在 `ctx.effect()` 里创建；`stop()` 先清定时器再关 socket；`running` 守卫保证任何路径都不会再起重连定时器 |

**关于 typed Remote 的说明**：规格 §4.4 想要 `dshNode.status()` / `dshNode.reconnect()`。
那需要把本插件显式组装进 `packages/api/remotes`，而树外插件做不到 —— 运行中的核心包是打包好的
只读安装。因此 Phase 1 用 `ctx.dshNode` 这个**进程内 Cordis 服务**替代，
`reconnectNow()` 与 `status` 都在其上，未来做设置卡片时可以直接调用。

**关于 `settingsNavigation`**：DSH 里**不存在**这个 seam，规格 §5.4.1 自己也承认了。
Phase 1 完全不需要它。

**关于 `dsh.version`**：`hello.dsh` / `ready.dsh` 里只有 `remoteSurfaceHash`，没有 `version`。
本机运行安装里没有找到公开暴露 DSH 版本号的服务，而编造一个比省略更糟。
`remoteSurfaceHash` 才是对端真正需要的信息。

**关于 `gateway/*` 原码保留**：在 DSH `0.1.2-alpha.1` 上做不到（网关自身把这类边界错误
投影成 `internal`），详见 §3.1 的说明与 `docs/GROUND-TRUTH.md` §1.5.1。

---

## 7. nodeId 持久化（规格 §5.8 留的开放项，已定）

**位置**：`<DSH_HOME>/storages/dsh-node/identity.json`（默认 `C:\Users\jaike\.dsh\storages\dsh-node\identity.json`）。

**为什么不用 `ctx.storage.domain`**：DSH 确实有公开的 storage 设施
（`@deepseek-ai/dsh-storage-domain`），但它**依赖组合** —— 只有当部署挂载了 `storage-domain`
**并且**给该 domain 配了 `backend` 路由时才能打开，在 headless / SDK / 最小测试组合里可能根本不存在。
身份随组合变化正是规格明令禁止的失败模式（Coordinator 会把同一台机器看成两个节点）。
所以身份落在一个纯 JSON 文件里，任何 profile、任何组合都能一致地读写。位置沿用同机
`dsh-drawio` 已经在用的约定：`<dshHome>/storages/<plugin-id>/`。

**要点**

- `$DSH_HOME` 的优先级与官方 `@deepseek-ai/dsh-home-paths#resolveDshHome` 一致：
  显式覆盖 → `$DSH_HOME` → `~/.dsh`（空白的 `DSH_HOME` 视为未设置，不会解析成 cwd）。
- 首次用 `wx` **独占创建**，所以两个 DSH 进程同时启动也只会诞生一个身份。
- 损坏的文件会被**改名隔离**（`identity.json.corrupt-<ts>`）再重建，而不是静默覆盖。
- 配置提供 `nodeId` 时以配置为准，且**不落盘**。
- `nodeName` / `role` 只是展示元数据，**绝不承担认证职责**。
- token 不写在这里，也不和日志混放。

---

## 8. 开发

```bash
pnpm --config.verify-deps-before-run=false typecheck   # tsc --noEmit（含 test/）
pnpm --config.verify-deps-before-run=false test        # vitest run：8 个文件，355 个测试
pnpm --config.verify-deps-before-run=false build       # 声明（src-only）+ tsdown
```

测试布局：

| 文件 | 覆盖 |
| --- | --- |
| `test/config.test.ts` | 规格 §12.1 第 1–5 条：URL 协议、mode、unconfigured、脱敏、nodeId 持久化、数值上下限；外加日志目的地与 printf 转义 |
| `test/protocol.test.ts` | 第 8、9 条 + 帧尺寸：帧结构校验（含 `stream.*`）、未知类型、未知 nodeId、错误 protocolVersion、endpoint 与 payload 形状 |
| `test/reconnect.test.ts` | 第 3、6、7、9、16 条：状态机、指数退避、抖动、稳定归零、心跳、鉴权失败、`stop()` 后不再重连 |
| `test/request-manager.test.ts` | 第 10、11、14、15 条：关联、恰好一次结算、超时、取消、重复响应、并发上限、断线失败 |
| `test/stream-manager.test.ts` | 第 12、13 条：`seq` 单调无缺口、终态之后无帧、取消、并发/帧/缓冲上限、**背压真的暂停了迭代器** |
| `test/admin.test.ts` | Phase 3：暴露面锁定、路径栅栏（绝对路径 / realpath / 段感知）、skill 名校验、审计边界、一次操作一条记录 |
| `test/integration.test.ts` | **真实 Cordis + 真实 `ctx.typertGateway` + 真实注册的 Remote owner + 本地 fake Coordinator**，外加架构守卫 |
| `test/fake-coordinator.test.ts` | 夹具自身：凭据脱敏、参数解析、loopback-only、token 不进 argv |

规格 §12.1 的 16 条现在**全部有覆盖**（第 12、13 条在 Phase 2 落地）。

### 一条环境注意事项

`vitest.config.ts` 里写了 `pool: 'threads'`。Vitest 默认的 `forks` 池会为每个测试文件
用 piped stdio 起子进程；在受限的 Windows 沙箱里这会以 `spawn EPERM` 失败，套件会在收集阶段
就报「no tests」。worker 线程在进程内运行，同样的测试不需要放宽权限就能跑。
`integration.test.ts` 会绑定一个 loopback WebSocket server，那是进程内 I/O，同样不需要额外权限。
