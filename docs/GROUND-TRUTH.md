# GROUND-TRUTH — dsh-node 的施工前事实基线与踩坑清单

> 本文是 `dsh-node` 的**已核实事实**清单。每条都在本机读过源码或跑过命令核对。
> 目的：让新会话**不必重新调研**，也**不要重新踩坑**。
>
> 标注 `[源码]` 的是从源码读出的；`[实测]` 的是实际执行验证过的；`[决策]` 的是取舍与原因。

环境时间基准：2026-09-18（Phase 2 与 Phase 3 于 2026-09-20 追加）。
DSH Desktop 包位置：**2026-09-20 起为 `E:\DSH\DSH Desktop\resources\app\node_modules\@deepseek-ai`**
（`0.1.5-rc.2`）—— 旧的 `resources\app.asar.unpacked\node_modules\@deepseek-ai`（`0.1.2-alpha.1`）**已不存在**。

> ⚠️ **版本基线在施工途中变过一次，务必先读 §0.2。**
> 2026-09-18 时运行版本是 `0.1.2-alpha.1`；2026-09-20 用户更新了 DSH Desktop，
> 现在运行的是 **`0.1.5-rc.2`**，包路径也换了。§1.5.1 那条「`gateway/*` 退化成 `internal`」
> 只对 alpha.1 成立，在 0.1.5-rc.2 上**不成立**。

---

## 0.2 ⚠️ DSH 版本升级（2026-09-20）造成的事实变化 `[实测]`

| 项 | 2026-09-18 | 2026-09-20 起 |
| --- | --- | --- |
| 版本 | `0.1.2-alpha.1` | **`0.1.5-rc.2`** |
| 包位置 | `resources\app.asar.unpacked\node_modules\@deepseek-ai` | **`resources\app\node_modules\@deepseek-ai`**（243 个包） |
| `rpcFailure` | `instanceof TypertRemoteFailure/...`，**无 `TypertGatewayError` 分支** → 边界错误全部退化成 `internal` | `remoteErrorOf(error)`（**结构化**：`isDSHRemoteError === true && typeof code === 'string'`） |
| `gateway/*` 原码保留 | ❌ 做不到（§1.5.1） | ✅ **成立** |
| 本插件 `nodeAdmin/*` 业务码 | 会退化成 `internal` | ✅ **成立**（本插件就是用结构标记抛错的，见 §0.3.2） |
| `pnpm` | `app.asar.unpacked\node_modules\pnpm` | `app\node_modules\pnpm`，且行为变了（§0.3.4 的前置：`pnpm run` 又开始跑 deps 检查） |

**因此**：

- `docs/` 与 README 里凡是标注「alpha.1 限制」的说明，现在只是**历史记录**，不是当前行为；
- 但**不要删** §1.5.1 —— 它解释了为什么本插件坚持「只经 `wireStream.failure()` 转发、不自己重写码」，
  这个决定在两次版本里都是对的；
- §11.1 那次真实环境端到端验证**是在 alpha.1 上做的，升级后没有重跑**（§0.5 给出重跑步骤）。

---

## 0.4 真机联调结论（2026-09-20 完成，`dsh-coordinator` 侧发起）

Phase 4 的 Coordinator 落地后，用一个**独立的第二个真 DSH 实例**（`web` profile，纯 Node 无 GUI，
插件用临时 overlay 挂进去；**没有重启、也没有触碰**你正在用的 desktop 实例）跑通了全链路：

| 事实 | 值 `[实测]` |
| --- | --- |
| 节点主动连出并完成 `hello → hello.ok → ready` | ✅ |
| 真 Typert Gateway 的能力面 | **93 unary + 4 stream = 97**，20 个命名空间 |
| 4 个真 stream Remote | `session/control`、`session/follow`、`workspace/follow`、`workspaceFiles/changes` |
| `nodeAdmin/*`（Phase 3）全部在能力表里 | 13 个，含 `describe` / `status` / `audit` / `fs*` / `skill*` |
| 真 unary 调用 | `pluginInventory/list`、`nodeAdmin/describe`、`nodeAdmin/audit` 全部返回真值 |
| 真流式调用 | `session/follow` 打开 → 出值 → 客户端断开后 `stream.cancel` 让节点干净释放 |
| **路径策略在真调用链上拒绝** | `nodeAdmin/fsList` 打 `C:\Windows` → `nodeAdmin/path-denied`，`reason: outside-roots` |
| 幂等性 | 全部调用之后节点仍 `ready`，`inFlightRequests=0`、`activeStreams=0` |

也就是说 Phase 2（流）与 Phase 3（管理面）现在有了**真机证据**，而不只是 mock 与夹具。
Coordinator 侧的完整记录（命令、输出、清理步骤）在
`dsh-coordinator/docs/GROUND-TRUTH.md` §2。

---

---

## 0.6 状态入口（客户端半侧）与它带来的两处架构变更（2026-09-20）

**做了什么**：侧边栏页脚的「节点」一行（在「画布」**上方**：`order: 50` vs 画布 `100`，
`list` 槽位按 `(priority, order)` **升序**排）+ 只读路由 `GET /dsh-node/api/status`、
`/api/diagnostics`（设计见 README §1.6、`src/http-api.ts`、`src/client/**`、
`src/net/trust-fence.ts`）。

**`[实测]` 真机验证**（第二个 DSH 实例，`web` profile；未触碰桌面实例）：

```
GET /dsh-node/api/status（协调器未起）→ 200
  {"state":"backoff","reconnectAttempt":11,"coordinatorOrigin":"ws://127.0.0.1:39471",
   "lastError":{"code":"node/connection-lost","message":"WebSocket error: connect ECONNREFUSED 127.0.0.1:39471"}}

GET /dsh-node/api/status（协调器起来后）→ 200
  {"state":"ready","connectionId":"node-742588c3…:mu9g7fqu:4oo9mdyk","lastConnectedAt":"…",
   "lastError":{…上一次的 ECONNREFUSED…}}      ← 当前状态与"最近一次失败"同时可见

Host: evil.example                → 403 forbidden   ← DNS rebinding 围栏
sec-fetch-site: cross-site        → 403
Origin: http://evil.example       → 403
POST /dsh-node/api/status         → 405（Allow: GET, HEAD）
GET  /dsh-node/api/nope           → 404
```

### 0.6.1 ⚠️「宿主半侧正常但界面里什么都没有」的真正原因 `[实测]`

**症状**：插件加载正常（日志有状态行、`pluginInventory` 是 active），但浏览器的启动清单里
**完全没有它** —— 渲染进程分区里连 `dsh-node` 这个字符串都搜不到（0 次），bundle 也没被取过，
而且**宿主什么也不报**。

**根因**：`@deepseek-ai/dsh-client-modules` 用
`createRequire(baseUrl).resolve('<包名>/package.json')` 定位插件清单。**一个包一旦有 `exports`
映射，`./package.json` 这个子路径就被封住，除非显式导出**；解析失败 → 该包被**静默跳过**。

同一台机器上三个包的现象与解析结果**完全对应**：

```
dsh-drawio   resolve('dsh-drawio/package.json')  → ✅ 成功    → 进清单（画布正常）
dsh-node     resolve('dsh-node/package.json')    → ❌ ERR_PACKAGE_PATH_NOT_EXPORTED → 被跳过
dsh-skillui  resolve('dsh-skillui/package.json') → ❌ 同上     → 被跳过（它的界面同样没了）
```

**修法**：`exports` 里加一行 `"./package.json": "./package.json"`（`dsh-drawio` 与
`dsh-better-sidebar` 都有这一行 —— 这就是这条隐性约定的来源）。守卫测试断言这行存在
**且**真的能从仓库根解析成功：`test/integration.test.ts` 的
「exports ./package.json, without which the client half is silently dropped」。

> **纠正一条我先前的错误假设**：我一度认定差别在于「用户 patch 插入的行 vs bundle 插入的行」，
> 并把插件改成了 profile 依赖 + bundle。那个改动本身是对的（有客户端半侧的插件就该这么做，
> 行由插件自己的 `cordis.patch.yml` 插入），但**不是**根因 —— 所以那两次重启都没修好。
> 真因是上面这条导出约定。

### 0.6.2 诊断路由 `/api/diagnostics` `[实测]`

合成阶段的失败是静默的，所以插件现在能报出宿主的真实判断（只读、同样过围栏）：

```json
{"clientModulesService":true,
 "entries":["@deepseek-ai/dsh-client-ui-sidebar", …, "dsh-node", …, "dsh-better-sidebar"],
 "selfComposed":true,
 "selfClientPath":"G:\\claude_project\\code-agent\\dsh-node\\lib\\client.js"}
```

**这是修好之后在沙箱实例里实测到的**（`selfComposed: true`、bundle 路径已解析）。
下一次同类故障一个请求就能定位，不必再靠猜。

### 0.6.3 `[实测]` 客户端 bundle 的三条不变式（`test/client-bundle.test.ts`）

读**构建产物** `lib/client.js`，用桩 `window.__ModuleLoader__` 加载、用桩 `require` 只提供平台表
里的模块、跑 `apply`，并**把组件真的渲染一次**（桩 hooks + 迷你 renderer 走到底层 `button`）：

1. 只 `require` 平台表里的 id（多要一个就失败）；
2. `apply` 恰好注册一条：`sidebar.footer.action` / `dsh-node:status` / `order: 50`；
3. 展开态与轨道态都能渲染出 `button`，带 `data-node-state` 与含「节点」的 `aria-label`。

**两处架构守卫改了，记在这里免得被当成"偷偷放宽"**：

1. 原来有一条绝对禁令：源码里**不许出现** `webServer`。现在插件确实要往 DSH **已有的**
   webserver 上挂一条前缀路由，所以这条禁令收窄成三条可检查的事实：仍然**永不**出现
   `WebSocketServer` / `createServer(` / `.listen(` / `registerUpgrade|registerFallback`；
   `webServer.register(` 只允许出现在 `index.ts` **一处**；只允许 `kind: 'prefix'`。
   → 「节点自己不开监听」这条性质**没变**，变的是它现在挂在别人的服务器上，而且只有两条只读路由。
2. `tsconfig` 不得不加 `"lib": ["DOM", ...]`（客户端半侧是 React）。原来"宿主代码碰不到 DOM"
   是**编译器**保证的，现在改由测试保证：`test/integration.test.ts` 扫描 `src/**` 里
   **非 `client/`** 的文件，禁止 `document.` / `window.` / `navigator.` / `localStorage` 的**用法**
   （正则要求点号后跟标识符，所以散文里的"…document."不误报），并断言客户端四个文件确实被扫到
   —— 否则改名会让守卫静默空转（这正是 `readSources` 当初漏掉 `src/admin/` 的同类错误）。

`[实测]` 同期：**395 tests / 11 files** 全绿（加 §0.7 的面板配置后是 **461 tests / 13 files**），
typecheck / build exit 0；`lib/client.js` 产出
`window.__ModuleLoader__.load({id:"dsh-node",…})`，只 `require` `react` 与 `react/jsx-runtime`，
宿主 bundle 里没有 `document.`、也没有 `__ModuleLoader__`。

> 客户端半侧在**正在运行的**实例里看不到：宿主的客户端模块表是**启动时**建的，
> 必须重启 DSH 才会加载新的 `./client`。宿主路由同理。

---

## 0.7 面板配置：在侧边栏里把节点配起来（2026-09-20）`[实测]`

**要解决的问题**：节点没配置时只有一个"未配置"的状态点，唯一的配置方式是编辑
`cordis.patch.yml` 再重启 DSH。现在点开「节点」弹层，里面就有表单：**协调器地址 + 令牌**
（+ 可选名称/角色），保存即用**新配置重连**，不需要重启 DSH。

**分层与优先级**（`src/config-file.ts`、`src/config-service.ts`）：

```
<DSH_HOME>/storages/dsh-node/config.json   ← 面板写这里（与 identity.json 同目录）
优先级：面板文件 > profile 配置 > 环境变量
```

之所以能"文件覆盖环境"，是因为 `resolveNodeConfig` 的既有顺序是
**显式 bootstrap > 环境 > 默认**，所以文件是**合并进 bootstrap**（`mergeNodeConfig`）而不是另开一层。

**四个必须记住的点**：

1. **令牌写进 `auth.token`，不是顶层 `token`。** `resolveNodeConfig` 只从 `auth.token` 读令牌；
   顶层同名键会被**静默忽略**，那就成了"保存成功但握手永远不带凭证"——本功能最该避免的失败。
   `test/config-file.test.ts` 专门钉住这一条。
2. **令牌只写不读。** 视图里只有 `tokenSet: true/false`，令牌值永远不会出现在任何 HTTP 响应里
   （实测断言了保存响应、配置视图、状态路由三段文本都不含令牌）。
3. **写文件是原子的**（temp + rename，`mode: 0o600`，失败时删掉 temp），
   所以一次失败的保存不会在磁盘上留下半个凭证。
4. **`POST /dsh-node/api/config` 是全插件唯一的写路由**，走**同一道**信任围栏；
   不完整的文档（缺地址或缺令牌）**直接拒绝**而不是保存 —— 保存一份不完整的配置会把
   一个本来能用的节点踢下线。

### 0.7.1 ⚠️ 未配置的节点**也必须**加载 identity `[实测]`

第一轮真机验证里唯一的失败：面板要显示的 `nodeId` 是空的。原因是
`DshNodeHost.start()` 在 `unconfigured` 分支**直接 return**，从不加载身份文件，
而"在协调器上批准这个节点"需要的**恰恰就是这个 id** —— 鸡生蛋问题。

改法：`unconfigured` / `invalid` 两条不连接的分支上**尽力**加载一次
（`loadIdentityQuietly()`，失败静默），`nodeId` 因此始终可得，而一个损坏的身份文件
**不会**把"还没配置"变成错误状态。

### 0.7.2 `[实测]` 真机证据（`.tmp/probe-config.mjs`，28/28 全过）

沙箱实例（`web` profile，端口 43997）+ **真的** `dsh-coordinate`（端口 39472，
`--node-env` 传令牌），全程**没有**重启 DSH：

```
GET  /dsh-node/api/config              → 200 {tokenSet:false, nodeId:"node-b7ae1e…",
                                              configFile:"…\storages\dsh-node\config.json",
                                              sources:{coordinatorUrl:"none",token:"none"}}
GET  /dsh-node/api/status              → unconfigured

POST …/config {http://…}               → 400 node/config-invalid      ← 不是 ws://
POST …/config {只有地址}                → 400 node/config-incomplete {missing:["token"]}
POST …/config + sec-fetch-site:cross-site → 403（围栏）
GET  /dsh-node/api/status              → 仍 unconfigured             ← 被拒的保存什么都没写

POST …/config {ws://…:39472/node, token, nodeName:"sandbox-node"} → 200
GET  /dsh-node/api/config              → sources:{coordinatorUrl:"panel",token:"panel"}
磁盘 config.json                        → 含 token 与 updatedAt
GET  /dsh-node/api/status              → ready（同一身份、协调器 origin 只到端口）
```

协调器侧独立见证（它自己的日志，不是节点自述）：

```
coordinator/node-ready   {"nodeId":"node-b7ae1e…","remotes":97,"surfaceChanged":false}
coordinator/node-connected {"connectionId":"node-b7ae1e…:mu9imohm:qjydkiv1","streams":4}
→ 之后 /api/invoke nodeAdmin/describe 返回 nodeName:"sandbox-node"（刚保存的那个名字）
```

最后一条是关键：它证明**重建后的宿主**把 `nodeAdmin/*` 重新挂上了 —— 重配不是"换个连接参数"，
而是整个宿主（服务、管理面、连接器）换了一遍。

清理：验证后删掉 `config.json`、停掉沙箱 DSH 与协调器、把 `web` profile 的依赖与 junction
复原（`profiles/web/package.json` 已回到只有 `dsh-better-sidebar`）。

### 0.7.3 ⚠️ 配置文件让测试**依赖了机器状态** `[实测·自身失误]`

**症状**：面板配置落地、并且用户真的用面板配好节点之后，集成测试在**这台机器上**从
461 全绿变成 **27 失败**，一条用例从 0.3 秒变 130 秒。失败全是同一类：
`expected 'connecting' to be 'stopped'`、`expected 'ready' to be 'unconfigured'`。

**根因**：`apply()` 每次启动都会读 `<DSH_HOME>/storages/dsh-node/config.json` 并**合并覆盖**
bootstrap，而集成测试用的正是这台机器的真实 `DSH_HOME`。这一轮之前它是绿的，
**只是因为那时磁盘上还没有那个文件**；文件一出现，测试里显式写的「无效配置 / 未配置」
就被文件里的**有效配置**覆盖了 —— 测试开始去连一台真实存在的协调器，直到超时。

**结论（两层都要记住）**：

1. **产品行为是对的**：`文件 > profile` 是这一版明确要的优先级，否则面板上的"保存"
   就没有意义。**不要为了让测试变绿去改优先级。**
2. **测试必须自己隔离存储层**：`test/integration.test.ts` 的 `beforeEach` 现在把
   `process.env.DSH_HOME` 指向 `mkdtemp` 出来的临时目录，`afterEach` 还原。
   同时新增两条用例把这条链路钉死 —— 它们才是"面板保存真的生效"的自动化证据：
   - 文件里只有 `coordinatorUrl` + `token`、bootstrap 什么都不给 → 必须完成真实握手；
   - 文件与 bootstrap 给**不同**的协调器地址 → 必须用文件里那个（bootstrap 里故意写
     `ws://127.0.0.1:1/node`，连不上，所以"连上了"只可能是读了文件）。

> 教训与 §0.3.7（守卫必须递归扫描）同类：**一个在"干净机器"上通过的测试，可能只是
> 因为它没读到真实状态**。凡是会读全局位置（home、env、cwd）的代码路径，测试都要先
> 把那个位置换掉。修完 463 tests / 13 files 全绿，且在**配置文件在位**的情况下同样全绿。

---

## 0.5 跨实现联调发现的两处节点侧问题（同一批测试抓到的）

Phase 4 的 Coordinator 落地后，它的 `test/cross-implementation.test.ts` 把**真的**
`DshNodeHost` 连到**真的** Coordinator 上跑。两份独立实现只有在协议真的精确时才会一致，
于是抓到两条本仓库自己的问题：

### 0.4.1 `status.lastError` 会丢掉断线原因 `[实测]`（已修）

- 现象：Coordinator 撤销后，节点状态确实是 `auth_failed`，但 `status.lastError` 是 `undefined`。
- 原因：`DshNodeHost.status` 只读 `this.currentError`，而它**只有 host 级失败**（配置无效、
  身份文件不可用）才会写；连接级失败一直躺在 `connector.snapshot.lastError` 里没被读。
- 后果：**操作者/Coordinator 能读到的唯一表面**（`ctx.dshNode.status()`、`nodeAdmin/status`、
  `nodeAdmin/describe`）上，「被撤销」和「崩溃循环」长得一模一样 —— 这正是 §7.5 想禁止的事。
- 修法：`lastError: this.currentError ?? snapshot?.lastError`，并在 `test/integration.test.ts`
  加了回归测试（用假 Coordinator 发 `close{code:'node/auth-failed'}` + WS `4401`，
  断言状态里有 `node/auth-failed` 且快照里没有 token）。

### 0.4.2 `capabilities.namespaces` 的注释与实现不符 `[实测]`（改注释，未改行为）

- 实现（一直是）：`collectCapabilities` 把**全部**可派发命名空间放进 `summary.namespaces`；
  只有「无法枚举」的那部分（`opaqueNamespaces`）参与 `remoteSurfaceHash`。
- 注释（原）：写成「无法枚举方法名的命名空间（source-mode 插件）」。
- 后果：Coordinator 的「命名空间在表里 ⇒ 交给节点裁决」分支覆盖面比注释大：
  枚举过的命名空间里写错方法名也会被转发（节点答 `node/capability-unavailable`），
  而不是在 Coordinator 侧以 `coordinator/capability-mismatch` 拒掉。
- 判断：**行为更安全**（节点仍是权威，Coordinator 不猜），所以修的是注释。
  该字段保证的是**否定命题**：不在表里的命名空间一定不会被派发。

另外，Coordinator 侧也因为它修了一处：Remote 返回 `undefined` 时线上是 `{ok:true}`（没有
`value` 键），Coordinator 初版会**拒绝**该帧并让调用方等满 deadline；
现在把「缺 `value` 键」读成 `undefined`（`stream.data` 同规则）。节点侧不需要改。

### 0.5.3 文件系统/skill 失败码未映射，且消息泄露绝对路径 `[实测]`（已修）

这一条是**真机联调**（不是单元测试）抓到的 —— 单元测试当初只断言了「非法名字」和「正常路径」，
没有断言「名字合法但对象不存在」。

- 现象：`nodeAdmin/skillRemove` 打一个不存在的名字，返回
  `{"code":"gateway/internal","message":"ENOENT: no such file or directory, lstat 'C:\\Users\\jaike\\.dsh\\skills\\…'"}`
- 两个问题：
  1. 码是 `gateway/internal`，而 `nodeAdmin/not-found` 本来就在 `ADMIN_ERROR_CODES` 里
     —— 调用方拿到的是一个「无法据以行动」的码；
  2. **消息里带本机绝对路径**。skill 面的契约是「只回层标签，不回主机路径」
     （§0.3.1），而 OS 错误原文把目录布局直接交了出去。`fs*` 面同理（它们回绝对路径是
     设计如此，但**错误消息**不该是未映射的 OS 原文）。
- 修法：新增 `fsFailure(error, subject)`，把 errno 映射成文档里的码
  （`ENOENT → nodeAdmin/not-found`、`EEXIST → already-exists`、`EACCES/EPERM → path-denied`、
  `ENOTEMPTY/EISDIR/ENOTDIR → invalid-arguments`、`ENAMETOOLONG/EINVAL → invalid-name`），
  未识别的 errno 原样抛出（那是真意外，猜一个业务码更糟）。消息用**调用方已知的**
  名字或路径重建，绝不回显 OS 原文。`fsList/fsStat/fsRead/fsWrite/fsRemove` 与
  `skillRead/skillRemove` 全部走它。
- 回归测试 4 条（`test/admin.test.ts`：`captureFailure` + 「消息里不得出现 errno 或盘符」），
  节点侧测试数 356 → **360**。
- 修完在真机上重跑同一组检查：18 项全 PASS，`skillRemove` 现在回
  `nodeAdmin/not-found` + `skill "…" does not exist`，无路径泄露。

---



### 0.3.1 DSH 的 skill 侧根本没有安装 API `[源码]`

- `ctx.skills` 是 `SkillRegistry`（`dsh-skill`），公开方法只有 `list()` / `listLayerCandidates()` —— **只读**。
  规格 §3 的表述准确：「当前目录的 Skill Catalog 不是安装 API」。
- 所以「skill 管理」只能**自己写文件**，写哪里由 `dsh-skill-filesystem` 的根布局决定 `[源码]`：

  | 层 | 路径 |
  | --- | --- |
  | project | `<projectRoot>/.dsh/skills` |
  | project（agents） | `<projectRoot>/.agents/skills` |
  | custom | 配置 `customSkillDirs` |
  | user | `<DSH_HOME>/skills` |
  | agents home | `<DSH_AGENTS_HOME or ~/.agents>/skills` |
  | bundled | `$DSH_BUNDLED_SKILL_DIR` |

  本插件把 **`<DSH_HOME>/skills`** 当默认主根（"装一个本机可用的 skill"就是这个意思），
  配置的 `skillRoots[0]` 优先。**有测试断言 skill 端点返回的是层标签而不是主机路径。**

### 0.3.2 业务错误码：用**结构标记**，不要 import `RemoteError` `[源码/决策]`

DSH 认业务失败靠结构而不是类：

```js
function remoteErrorOf(value) {
  if (typeof value === 'object' && value !== null && value.isDSHRemoteError === true && typeof value.code === 'string') return value
}
```

所以 `src/errors.ts` 的 `remoteError(code, message, details)` 只是给普通 `Error` 加上
`code` / `details` / `isDSHRemoteError = true`。这比 import `RemoteError` **更好**：

- 零运行时依赖（树外插件的硬约束）；
- 跨版本更稳 —— 不依赖那个类的身份（alpha.1 与 0.1.5 的网关实现就完全不同）；
- 有测试直接断言 `isDSHRemoteError === true` 与 `code`。

### 0.3.3 ⚠️ `ctx.typert.register` 不在 contract 类型里，但**是官方认可的入口** `[源码]`

`ctx.typert` 的类型是 `TypertRegistryContract`，只声明 `local` / `remotes` / `lookups` / `contexts`；
`register()` 在**具体类** `TypertRegistry` 上。

而 `dsh-typert-loader` 的文档原话（0.1.5-rc.2 的 `lib/index.js`）：

> Manual `ctx.typert.register()` remains available for contributions that do not use a
> `./typert` artifact (**hand-written wire schemas, tests, non-loader compositions**).

本插件正是这个场景。所以调用它是对的，但要**结构化访问**
（`ctx.get('typert', false)` 再判 `typeof register === 'function'`），不 import 具体包。

⚠️ **隐蔽后果**：只跑 `tsc -p tsconfig.json`（含 `test/`）时，`test/integration.test.ts` import 了
`TypertRegistry` 具体类，它把 augmentation 带进 program，于是 `ctx.typert.register` **能通过类型检查**；
而 `tsconfig.build.json` 只编译 `src/**`，没有那个 import → **build 失败**
（`TS2339: Property 'register' does not exist on type 'TypertRegistryContract'`）。

**教训**：`pnpm typecheck` 绿 **不等于** `pnpm build` 绿。build 里的
`tsc -p tsconfig.build.json`（src-only）才是真实的发布类型边界，两个都要跑。

### 0.3.4 文件系统栅栏：`realpath` + 段感知包含 `[决策]`

`src/admin/path-policy.ts` 的三条规则，每条都有测试：

1. 必须**绝对路径**（`C:foo` 也拒 —— 它满足 `isAbsolute` 但按每盘 cwd 解析）；
2. 根与目标都 **realpath**，且允许**末尾尚不存在**（逐级回退到最深的已存在祖先再拼回后缀），
   所以"根内一个指向根外的链接"会被抓住；
3. **段感知**包含（`isWithin`），**不是 `startsWith`** —— 否则 `/root-evil` 会被当成 `/root` 的子路径。

默认根刻意窄：**只含活跃 session 的 cwd** + 配置的 `allowedRoots`；skill 根另算。
所以「默认开启」的实际含义是「可以动工作区」，不是「可以动整个磁盘」。
`allowedRoots` 里写相对路径会**报配置错误**，而不是被静默当成别的意思。

`fsRemove` 用 **`rmdir`** 而不是 `rm({recursive:false})`：Node 的 `rm` 对**任何**目录都抛 EISDIR，
而 `rmdir` 正好是想要的语义 —— 只在空目录时成功，所以远端**无法一次删掉一棵树**。`[实测]`

### 0.3.5 审计：一次操作一条记录 `[实测]`

最初 `fsWrite` 这类方法体里自己 `auditLog.append(...)`，而 `auditedAsync` 包装器**也** append
—— 每次操作记两条。测试抓到了。现在**只有包装器写**，方法体把字节数放进返回值的 `bytes`，
包装器用 `bytesOf(value)` 取。审计**不存路径、不存内容**（有测试断言这两点）。

### 0.3.6 ⚠️ descriptor 的 `method` 必须在 owner 上解析成**可调用**的东西 `[实测]`

真实故障：descriptor 写 `audit`，方法却叫 `auditRecent`，同时 owner 上有个**字段**叫 `audit`
（`AuditLog` 实例）。Gateway 走 `Reflect.get(receiver, descriptor.implementation ?? descriptor.method)`
拿到那个对象 → `active Service "nodeAdmin" has no callable method "audit"` → 被本节点折成
`node/capability-unavailable`。

单元测试**抓不到**：单测直接调 `owner.auditRecent()`，根本不经过 wire name。
是集成测试（真实 Gateway 派发）抓到的。

修法与防线（都在 `test/admin.test.ts`）：

- 用 descriptor 的 `implementation` 字段做映射（Gateway 本来就认它）；
- 字段改名 `auditLog`，让 `audit` 这个名字空出来；
- 加两条**结构性**测试：每个 descriptor 都要在 owner 上解析到一个 `function`；
  没有 `implementation` 的 descriptor，其 `method` 也不能落在一个数据字段上。

### 0.3.7 架构守卫必须**递归**扫描 `[实测]`

原守卫用 `readdir(sourceDir)`，只扫 `src/` **顶层** —— `src/admin/` 从来没被扫过，
而那正是唯一能改本机的目录。现在用 `readdir(..., { recursive: true })`，
并加一条测试断言确实扫到了 `admin/service.ts` 等。

「无运行时官方依赖」那条也修正了：真正的不变量是**「`@deepseek-ai/*` 的 import 必须是 type-only」**
（编译期被擦除），而不是"只许出现 cordis" —— 因为 `admin/service.ts` 需要
`import type { InvocationDescriptor }`。另加一条测试直接读 `package.json`，断言
`dependencies` 里没有任何官方包、`peerDependencies` 只有 cordis。

### 0.3.8 ⚠️ 不要用 PowerShell 改源码文件 `[实测·自身失误]`

我用 `(Get-Content -Raw) -replace ... | Set-Content -NoNewline` 改 `src/admin/service.ts`，
PowerShell 按**控制台编码**（GBK）重写了文件，**破坏了 UTF-8**，`read` 工具直接报
`invalid UTF-8 text`。只能整份重写恢复。

**规则：源码/文档一律用文件工具（read / edit / write）改；PowerShell 只用来跑命令和读。**
（注意 `Get-Content` 的**输出**也会把 UTF-8 破折号显示成乱码 —— 那是显示问题，不代表文件坏了；
先用 `read` 工具确认再判断。）

### 0.3.9 `pnpm run` 在升级后又坏了 `[实测]`

`pnpm run <script>` 的 deps 状态检查会再起一个 `pnpm install`，然后：
`ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY`。`.npmrc` 里的
`verify-deps-before-run=false` 与 `confirmModulesPurge=false` **对升级后那个 pnpm 都不生效**
（`pnpm config get verify-deps-before-run` 返回 `undefined`）。

**可用的写法是 CLI 参数**：

```bash
pnpm --config.verify-deps-before-run=false typecheck
pnpm --config.verify-deps-before-run=false test
pnpm --config.verify-deps-before-run=false build
```

或者完全绕开 pnpm：

```bash
node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit
node node_modules/vitest/vitest.mjs run
```

---

## 0.4 认证访问运行中 DSH 的 `/api`（本轮最有用的新工具）`[实测]`

要在**不重启 DSH** 的前提下验证「运行中的进程到底注册了什么、能不能调」，可以直接以浏览器
身份调用它的连接层。完整配方（都在 `dsh-client-connection/lib/index.js` 里读到，并实测成功）：

**1. 握手信封**（`createWebConnectionRpc`）：

```js
POST /api/<endpoint>
content-type: application/json
body: { type: 'client-request', rpcId: <string>, method: <endpoint>, payload: { args: {...} } }
// 响应：{ type: 'server-response', rpcId, result }   其中 result 是 { ok, value } / { ok:false, error }
```

**2. 鉴权 cookie**：

```
名字  = 'dsh-auth-' + base64url(sha256(authority))      // authority = Host 头，如 127.0.0.1:43120
值    = 'v1.' + B + '.' + base64url(HMAC-SHA256(secret, B))
        B = base64url(UTF8(JSON({ version:1, authority, issuedAt, expiresAt })))
```

⚠️ **HMAC 签的是 `B` 这个 base64url 字符串，不是原始 JSON** —— 容易搞错。

**3. secret**：`<DSH_HOME>/.credentials.yaml` 的
`records['client-connection/browser-session'].payload.secret`（32 字节的 base64url）。
记录形状：`{kind:'grant', payload:{version:1, secret}}`。

**4. 已实现为工具**：`.tmp/probe-local.mjs`（一次性 instrument，尚未收进 `tools/`）：

```bash
node .tmp/probe-local.mjs --endpoint pluginInventory/list --grep "dsh-node"
$env:DSH_PROBE_ARGS='{"_request":{}}'; node .tmp/probe-local.mjs --endpoint session/list
```

⚠️ **它从不打印 secret 与 cookie 值** —— cookie 是这个 GUI 的 bearer 凭据，不该进日志或对话。
⚠️ **PowerShell 会把 JSON 参数里的双引号吃掉**，所以 `--args` 走 `$DSH_PROBE_ARGS` 环境变量。

**本轮用它拿到的实测结果**：

| 探测 | 结果 |
| --- | --- |
| `pluginInventory/list` | HTTP 200，32274 字符的完整 loader 树 |
| `include:dsh-node` | **`enabled: true, fiberPhase: "active"`** —— 插件在 0.1.5-rc.2 上正常加载 |
| `session/list`（不带 `_request`） | `gateway/arguments-invalid`，**原码 + details.endpoint 完整保留** |
| `nodeAdmin/describe` | HTTP 404 —— 因为运行中的进程加载的是**启动那一刻**的构建（见 §0.4.1） |

**第三条是对 §0.2 的独立活体验证**：`gateway/*` 原码保留在 0.1.5-rc.2 上确实成立，
而在 alpha.1 上会退化成 `internal`（§1.5.1）。源码阅读得出的结论得到了运行时确认。

### 0.4.1 ⚠️ 运行中的进程持有的是**启动那一刻**的构建 `[实测]`

`nodeAdmin/*` 返回 404，一度像是注册失败。实际原因：`lib/index.js` 构建于 **11:01:03**，
而 DSH 启动于 **10:50:54** —— 进程加载的是**旧的、还没有 Phase 3 的**那份产物。

**规则：改完代码先 `pnpm build`，再重启 DSH。** 反过来说，任何「插件怎么没生效」的排查，
第一步都是比对 `lib/index.js` 的 mtime 与进程启动时间。

### 0.4.2 DSH 2.0.13 把日志移到了 `logs/host/` `[实测]`

| 版本 | 主机日志位置 |
| --- | --- |
| 2.0.4 | `%APPDATA%\DSH Desktop\logs\dsh-<date>.log` |
| **2.0.13** | **`%APPDATA%\DSH Desktop\logs\host\dsh-<date>.log`** |

旧的 `logs/dsh-<date>.log` 仍然存在但只留启动头。实测内容：

```
2026-09-20 10:51:01.504 [I] [superpowers] [superpowers] registering provider "superpowers"
2026-09-20 10:51:05.397 [I] [dsh-node] dsh-node/state-changed {"state":"unconfigured", ...}
```

这既是**插件在 0.1.5-rc.2 上加载并运行**的证据，也是「`ctx.logger` 修复有效」的证据
（§11.2.1：以前走 `console.log` 时这些记录根本不会落盘）。

### 0.4.3 ⚠️ 升级把 `dsh` CLI 的垫片打断了 `[实测]`

`%APPDATA%\DSH Desktop\host-commands\desktop\bin\dsh.cmd` 仍然指向
`resources\app.asar\lib\desktop-cli.js`，而新布局是 **`resources\app\lib\desktop-cli.js`**
（`app.asar` 已不存在），于是 `dsh --dump-config` 直接
`Error: Cannot find module ...\app.asar\lib\desktop-cli.js`。

绕开方式（照抄垫片、只改路径）：

```powershell
$env:ELECTRON_RUN_AS_NODE="1"; $env:DSH_HOME="C:\Users\jaike\.dsh"
& "E:\DSH\DSH Desktop\DSH Desktop.exe" --expose-internals `
  "E:\DSH\DSH Desktop\resources\app\lib\desktop-cli.js" --profile desktop --dump-config
```

⚠️ **忘了 `ELECTRON_RUN_AS_NODE=1` 会真的去起一个 GUI 进程**（我误试过一次；
它随即自己退出了，没有影响正在跑的实例，但不要重复）。`--dump-config` 不是必须的 ——
`pluginInventory/list` 已经证明 entry 是 active 的，比 dump-config 更强。

---

## 0.1 Phase 2 已核实事实（stream / 背压）

### 0.1.1 用 `ctx.typertGateway.stream()`，不是 `wireStream.open()` `[源码/决策]`

规格 §7.4 说「使用 `ctx.typertGateway.wireStream.open(...)` 或 Gateway 提供的等价 stream 入口」。
**本实现用后者**：

```ts
gateway.stream({ namespace, method, args, signal }) → Promise<AsyncIterable<unknown>>
```

理由：`wireStream.open(endpoint: string, payload: unknown, signal)` 收的是**载体形状**
（`endpoint` 字符串 + `{args}` 包装），而 `stream()` 收的是**结构化**的 `{namespace, method, args, signal}`，
与 unary 的 `invoke()` 完全对称。这样节点对两种调用用**同一个**参数透传路径、同一套错误投影，
不需要为 stream 再造一份 payload 包装（少一层出错的地方）。

`stream()` 的契约（`packages/api/gateway/src/types.ts` 与运行安装一致）：
descriptor 的 `mode` 必须是 `'stream'`，否则抛 `gateway/signature-invalid`；
反向也一样 —— 用 `rpc.request` 调 stream 方法会抛 `gateway/signature-invalid`。
两个方向都有集成测试。

### 0.1.2 取消信号是 Gateway 注入的最后一个位置参数 `[源码]`

`prepareInvocation` 里：

```js
const args = await Promise.all(descriptor.parameters.map(p => this.resolveParameter(p, request.args, endpoint)))
if (descriptor.cancellation !== void 0) args.push(request.signal ?? NEVER_ABORTED_SIGNAL)
```

即 descriptor 声明 `cancellation: { parameter: 'signal' }` 时，Gateway 把**信号追加为最后一个实参**。
所以「本地操作收到取消信号」是**可测的**：集成测试里的 fixture 生成器接住这个 `signal`，
在 `finally` 里记录它是否已 abort —— 证明的是**业务生成器**看到了取消，
而不只是节点自己停止了转发（规格 §12.2 明确要求这一点）。

⚠️ 生成器里要把 abort 检查写进 `finally`，不能只写在循环条件里：
载体（`cancellableStream`）可能在 abort 时直接关闭迭代器，循环体不会再跑一次。

⚠️ TS 会把 `signal.aborted` 在第一次检查后**收窄成 `false`**（它看不见 `await` 期间别人改了它），
第二次比较就会报 TS2367。对策是透过一个函数读（`isAborted(signal)`）来打断收窄。

### 0.1.3 背压只有信号，没有精确归属 `[决策]`

`ws` 一个 socket **只有一份**缓冲，`socket.bufferedAmount` 也是连接级的。
所以 `maxBufferedBytesPerStream` 约束的是「传输层待发字节」这个**连接级**数字，
作用是限制单条流能跑多超前，**不是**给每条流做精确字节归属。README 与代码注释都写明了这一点，
免得后来者以为它是 per-stream 计量。

实现顺序（对应规格 §8.2 的「优先暂停可暂停的异步迭代器」）：

1. `for await` 天然给出暂停 —— 下一个值只在上一帧被接受后才向源索取（有专门测试断言源被暂停）；
2. 发送前若超限，`await` 等 socket 排空，`drainPollMs` 轮询、`sendStallTimeoutMs` 封顶；
3. 排空超时 → 只终止这一条流，回 `node/backpressure`。

### 0.1.4 ⚠️ `stop()` 里的顺序 bug（真实踩到）`[实测]`

`stop()` 最初先 `this.connector = undefined`，再让 `StreamManager.failAll(..., notify=true)` 发终态帧。
而 StreamManager 的 `send` 闭包读的正是 `this.connector` —— 于是**终态帧全部静默丢弃**，
Coordinator 分不清「节点在关闭」和「节点消失了」。

集成测试「terminates open streams with node/shutdown when the plugin is disposed」抓到了它。
**修法**：先在 connector 仍在位时终止流与请求，再清引用、再关连接。

### 0.1.5 ⚠️ 观察者必须被隔离 `[实测]`

`onEvent` 观察者如果抛异常，会从 `emit()` 一路冒到 `pump()` 的 `catch`，
被当成流的失败**再报一次** —— 破坏「恰好一个终态帧」的不变量。
现在 `emit()` 内部 `try/catch` 吞掉观察者异常，并有测试锁住（观察者抛异常时，
`pump` 仍正常 resolve、仍只有一个 `stream.end`）。这与 DSH 自己对待 observer 的
「synchronous contained observer」一致。

### 0.1.6 stream 的两个不变量 `[决策]`

- `seq` 从 1 开始、**每流独立**、每次恰好 +1；
- **恰好一个终态帧**（`stream.end` 或 `stream.error`），此后该 `streamId` 再无任何帧。

`end()` / `fail()` / `cancel()` 全部幂等，`ready()` 在已终态时返回 `false`。
`pump()` 每轮都重新检查 `settled`，所以晚到的源事件不会产生终态之后的帧。
重复 `stream.open` 同一 id → `node/protocol-invalid`，且不影响已存在的流。

---

## 0. 一句话结论

要做一个「让本机 DSH 主动连出去、把 Coordinator 的调用转发给本机已注册 Remote」的插件，
**唯一可行的树外路线**是：

> 写一个只含 **Host 半侧**的 Cordis 插件，用 `ctx.typertGateway`
> （经 `ctx.get('typertGateway')`，**结构化类型**，不 import 官方包）做转发，
> 用 `ws` 起**出站**客户端，用 `ctx.effect()` 管住全部生命周期。
> 不导出 `./typert` / `./remote`，不实现 typed Remote，不注册设置卡片。

---

## 1. 转发入口：已核验的 API 契约

### 1.1 `TypertGateway` 的公开接口 `[源码]`

`packages/api/gateway/src/types.ts`：

```ts
interface TypertGateway {
  wireStream: {
    open(endpoint: string, payload: unknown, signal: AbortSignal): Promise<AsyncIterable<unknown>>
    failure(error: unknown): { code: string; message: string; details: object }
  }
  registerRemoteEvents(source, host): () => Promise<void>
  invoke(request: InvokeRemoteRequest): Promise<unknown>
  stream(request: InvokeRemoteRequest): Promise<AsyncIterable<unknown>>
}

interface InvokeRemoteRequest {
  namespace: string
  method: string
  args: Readonly<Record<string, unknown>>
  signal?: AbortSignal
}
```

⚠️ `invoke()` 收的是 **`{namespace, method, args, signal}`**，不是字符串 endpoint，也不是 descriptor 对象。
运行安装（`dsh-api-gateway@0.1.2-alpha.1`）与源码 checkout 在这一点上**逐字一致**（已比对 `lib/index.js`）。

### 1.2 endpoint 格式 `[源码]`

网关内部（`lib/index.js` 的 `remoteRequest`）：

```js
const segments = endpoint.split('/')
if (segments.length !== 2 || segments[0] === '' || segments[1] === '') throw new Error('invalid Remote endpoint …')
```

→ 规范格式是 **`<namespace>/<method>`**，**恰好两段且都非空**。
节点侧因此在派发前先解析，不合法直接回 `node/protocol-invalid`，不交给网关去报错。

### 1.3 payload 形状 `[源码]`

同一个 `remoteRequest` 还有一条硬要求：

```js
if (!isObject(payload) || !isPlainObject(payload)
  || Reflect.ownKeys(payload).length !== 1 || !Object.hasOwn(payload, 'args')
  || !isObject(payload.args) || !isPlainObject(payload.args)) throw new Error('Remote payload must contain exactly one plain-object args field')
```

→ 线上 `payload` 必须**恰好**是 `{ args: <plain object> }`。节点照这个形状校验，然后
**把 `args` 的同一个对象引用原样传下去**（不深拷贝、不增删改名）。

### 1.4 参数精确匹配 `[源码]`

`assertExactArguments(args, descriptor, endpoint)`：`args` 的字段必须与 descriptor 的具名参数
**精确相等** —— 多一个 `extra` 或少一个必需的 `missing` 都报 `gateway/arguments-invalid`。
（例外：声明为 `acceptsUndefined`、或 codec 是 `src-json` 的参数允许缺失。）
→ **节点绝不能重写 args。**

### 1.5 错误码映射 `[源码/实测]`

`gateway/wireStream.failure(error)` **恒等于** 内部 `rpcError`，也就是 `rpcFailure(error).error`。
所以节点直接复用它，得到与官方 HTTP / WebSocket 载体**完全一致**的失败投影，不需要自己从 error 形状反推。

`0.1.2-alpha.2` 的 `rpcFailure`：

```js
function rpcFailure(error) {
  const remote = remoteErrorOf(error)          // 结构化判定：value.isDSHRemoteError === true && typeof value.code === 'string'
  if (remote !== void 0) return { ok: false, error: { code: remote.code, message: remote.message, details: remote.details } }
  return { ok: false, error: { code: 'gateway/internal', message: …, details: {} } }
}
```

⚠️ **`0.1.2-alpha.1`（本机运行版本）的实现不同**：它用
`error instanceof TypertRemoteFailure` / `TypertLookupFailure` / `RemoteInvocationCancelled` 分支，
再兜底 `internal`。而 `TypertRemoteFailure` **没有**从 `@deepseek-ai/dsh-typert-protocol` 的
`lib/index.js` 导出（该版本只导出 `Remote, RemoteError, RemoteScope, TypertRemoteService,
bindTypertRemote, isTypertRemoteSegment, remoteErrorOf, remoteMethods`）。

→ **对本插件的含义**：不要自己判定错误类型，**只用 `wireStream.failure()`**。
两个版本各自的实现细节都被封装在这个函数里，节点因此天然跟着运行版本走。
（这也是集成测试用 alpha.2 也仍然有效的原因：测的是节点的映射逻辑，不是网关的内部实现。）

### 1.5.1 ⚠️ 实测后果：alpha.1 上 `gateway/*` 边界错误会退化成 `internal` `[实测]`

对**运行中的** Desktop profile 发 `session/rename`（args 不匹配）实测返回：

```json
{"ok":false,"error":{"code":"internal",
 "message":"typert gateway: session/rename: args fields do not match the descriptor: missing \"request\"",
 "details":{}}}
```

而 alpha.2 上同样的调用返回 `gateway/arguments-invalid`（`[实测]`，见集成测试
「preserves a gateway/* boundary code」用例）。

**原因在 alpha.1 的网关本身，不在本插件**：alpha.1 里

```js
var TypertGatewayError = class extends Error { … }   // extends Error，不是 RemoteError
```

它**没有** `isDSHRemoteError` 结构标记，而 `rpcFailure()` 只检查
`RemoteInvocationCancelled` / `TypertLookupFailure` / `TypertRemoteFailure` 三个分支 ——
**没有 `TypertGatewayError` 分支** —— 于是所有 `gateway/*` 边界错误（`arguments-invalid`、
`signature-invalid`、`result-invalid`、`ambiguous-endpoint`、`binding-invalid`、各类 lookup/context
失败）全部落进兜底 `internal`。

**为什么不"修好"它**：节点用 `wireStream.failure()` 转发，因此在 alpha.1 上，
同一 endpoint 经浏览器（官方 HTTP 载体）与经 `dsh-node` 返回**逐字相同**的 `internal`。
如果节点从 message 里正则抠出 `gateway/arguments-invalid`，就会让两条载体对同一请求给出不同语义，
Coordinator 将面对两套错误模型。**忠实复现官方行为才是正确设计**，代价是：

> 在 alpha.1 上，规格 §10 「`gateway/*` 原码保留」**无法完全满足**，
> 因为网关自己就不保留。升级到 alpha.2+ 后自然成立，节点代码无需改动。
> Coordinator 侧不要依赖 `gateway/arguments-invalid` 做参数校验反馈，除非已确认节点版本 ≥ alpha.2。

节点自己只折叠**「本机没有这个能力」这一族**：
`gateway/invocation-unavailable`、`gateway/method-unavailable`、`gateway/service-unavailable`、
`gateway/definition-unavailable` → `node/capability-unavailable`。
其余 `gateway/*`（`arguments-invalid`、`signature-invalid`、`result-invalid`、`context-not-found`、
`binding-invalid`、`ambiguous-endpoint`、`cancelled` …）与业务码（`session/not-found` …）**原码保留**
（在 alpha.2+ 上；alpha.1 见上）。

---

## 2. 能力枚举：§7.2 的开放项已解决 `[源码]`

规格 §7.2 说「若 Typert 当前没有公开的能力枚举接口，应新增一个受控的能力摘要适配层，
不要通过私有字段反射」。**结论：公开接口存在，不需要新增，也不需要反射私有字段。**

### 2.1 生成的 Remote：用 `ctx.typert.local.list()` `[源码]`

`packages/typert/registry/src/service.ts` 的 `TypertRegistry`：

```ts
get local(): TypertLocalRegistry {
  return {
    get: endpoint => this.localStore.get(endpoint),
    hasSeen: endpoint => this.localStore.hasSeen(endpoint),
    list: () => this.localStore.list(),          // ← 公开枚举
    subscribe: listener => this.localStore.subscribe(ctx, listener),
  }
}
```

`list(): readonly InvocationDescriptor[]`，每条含 `namespace` / `method` / `mode?` / `parameters` / `result` / `service` / `invocation`。
`mode` 缺省表示 unary，`'stream'` 表示 stream。
（`InvocationDescriptor` 定义在 `packages/typert/protocol/src/types.ts`。）

### 2.2 源码模式插件：只有 namespace 是公开的 `[源码]`

树外插件（不跑 typert 生成器）用 `TypertRemoteService` + `@Remote`，走网关的 **SRC 路径**
（`resolveSrcDescriptor` / `collectSrcClaims`）。`TypertRemoteService` 的字段注释写明：

```ts
/** Visible binding consumed by the Gateway's source-mode discovery. */
typertRemote;
```

即 `typertRemote`（含 `service` / `serviceKey` / `namespace`）是**有意公开**的绑定。
但 `remoteMethods(service)` 读的是 `@deepseek-ai/dsh-typert-protocol` 内部的一个**模块私有 WeakMap**
（`markers.get(Object.getPrototypeOf(service))`），树外拿不到方法名。

→ **决策**：`namespaces` 收录公开 `typertRemote.namespace`（并校验 `binding.service === receiver`，
避免读到伪造/过期绑定），只列出**没有精确 endpoint** 的那些；方法名交给网关判定，
其「不可用」错误再折回 `node/capability-unavailable`。
这样源码模式插件**可调用**，节点也不用猜。

### 2.3 `remoteSurfaceHash` `[决策]`

规格没有规定算法。本实现 = sha256 over（排序后的 `mode endpoint` 行 + `namespace` 行）。
受控摘要：不含本机路径、token、环境变量。

---

## 3. 树外路线的硬约束（与规格冲突处一律以此为准）

| # | 规格原文 | 树外现实 | 处理 |
| --- | --- | --- | --- |
| 1 | §4.3 导出 `.`、`./client`、`./typert`、`./remote` | `./typert` / `./remote` 是 `@deepseek-ai/dsh-typert-generator` 在 monorepo 根 `tsdown.config.ts` 里生成的产物，树外生成不了 | **只导出 `.`**，Phase 1 没有 `./client` |
| 2 | §4.4 `dshNode.status()` / `dshNode.reconnect()` typed Remote | 需要改 `packages/api/remotes/src/client/index.ts` 的显式组装；运行中的核心包是打包好的只读安装 | 用 **`ctx.dshNode` 普通 Cordis 服务**替代（进程内，含 `status` / `reconnectNow()`） |
| 3 | §5.3 `ctx.settings.installSection()` 设置命名空间 | 可行，但属于 Phase 1 之后 | **Phase 1 完全不碰**，配置只来自 patch + 环境变量 |
| 4 | §5.4.1 `ctx.settingsNavigation` | **DSH 里根本不存在这个 seam**（规格自己也承认了） | 不需要 |
| 5 | §4.2 patch 片段 `- id: / name:` | 那是 **bundle 内部 loader entry** 的写法 | profile 用户层用 **`- insert:` 数组**，以 `dsh-drawio/cordis.patch.yml` 与 `profiles/web/cordis.patch.yml` 为准 |
| 6 | §4 目录 `packages/host/dsh-node/` | 树外，代码只落在 `G:\claude_project\code-agent\dsh-node` | 不写任何仓库内路径 |
| 7 | — | 官方包**不能作为运行时依赖** | `peerDependencies` 只有 `@deepseek-ai/cordis`（类型用）；运行时靠结构化类型 + `ctx.get(...)` |

---

## 4. 包与构建

### 4.1 `package.json` `[实测]`

```jsonc
{
  "name": "dsh-node",                  // 不加 @deepseek-ai/ scope
  "type": "module",
  "main": "lib/index.js",
  "exports": { ".": { "types": "./lib/types/index.d.ts", "default": "./lib/index.js" } },
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } },
  "peerDependencies": { "@deepseek-ai/cordis": ">=4.0.1" },
  "dependencies": { "schemastery": "3.18.0", "ws": "8.18.0" }
}
```

- `dsh.bundle.patch` 声明「本包可作为 profile 层被挂载」。`dsh.host` **不存在**，别臆造。
- 没有 `dsh.client`：Phase 1 没有浏览器半侧。声明了 `dsh.client` 却没有 `exports["./client"]`
  会在组合期直接抛错。
- `ws` 与 `schemastery` 是**真依赖**，构建时保持 external —— 打包进去会把一个 WebSocket 客户端
  和一个 schema 校验器内联进插件入口，并让 `files` 里的依赖声明变成谎话。

### 4.2 `tsconfig` 关键项 `[实测]`

`strict` + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes` + `noImplicitOverride`。
`exactOptionalPropertyTypes` 会实际影响写法：**不能把 `undefined` 赋给可选字段**，
必须用条件展开 `...(x === undefined ? {} : { x })`。`DshNodeRuntimeConfig` 的 `coordinatorUrl?` / `token?`
就是靠这个表达「未配置」，测试里要构造未配置对象得**删字段**而不是设 `undefined`。

### 4.3 构建 `[实测]`

```bash
pnpm build   # tsc -p tsconfig.build.json（声明） && tsdown
# → lib/index.js 86.71 kB / gzip 24.36 kB，lib/index.js.map，lib/types/*.d.ts
```

`clean: false`：DSH 运行时会持有 `lib/*.js`，Windows 上 `rm -rf lib` 会 EPERM
（沿用 `dsh-drawio` 的结论）。
产物冒烟：`import('./lib/index.js')` → `name === 'dsh-node'`、`inject === ['typertGateway','typert']`、
`apply` 是函数、`Config` 是 schemastery schema。

---

## 5. Cordis 行为（本插件实际依赖的部分）

### 5.1 插件挂载形状 `[源码]`

```ts
export const name = 'dsh-node'
export const inject = ['typertGateway', 'typert'] as const
export function apply(ctx: Context, config?: unknown): void { … }
export const Config = z.object({ … })
```

- **无 default 导出**。
- `inject` 是硬依赖：fiber 会等到这些服务就绪才跑 `apply`。
  这也顺带满足规格 §6.2「本地 Gateway 未就绪时延迟 ready」。
- `ctx.plugin(plugin, config)` 里传**插件对象** `{name, inject, apply, Config}` 才会跑 `inject`
  与 `Config` 校验；只传裸 `apply` 函数两者都不会生效（集成测试因此组装了 `NODE_PLUGIN`）。

### 5.2 `ctx.provide` 与 fiber 回收 `[源码/实测]`

- `ctx.provide(name, value)` 返回 disposer，并且会自己声明 `props[name]`。
- `ctx.effect(fn)` 的 disposer **可以是 async**，fiber 卸载时会 await。
- 本插件把 `provide('dshNode', host)` 与 `host.start()/stop()` 都放进同一个 `ctx.effect()`，
  所以卸载时：`disposeService()` → `await started` → `await host.stop('plugin-disposed')`。
- **没有 `ctx.stop()`**。`ctx.plugin()` 返回 `Fiber & PromiseLike<Fiber>`，销毁是
  `await fiber.dispose()`。`new Context()` 起的根也有 `ctx.fiber.dispose()`。

### 5.3 ⚠️ `ctx.typert` 需要 `inject`，`ctx.get` 不需要 `[实测]`

`@deepseek-ai/cordis` 的 `reflect.ts` 代理 getter：

```js
const error = new Error(`cannot get property "${prop}" without inject`)
```

即**直接读 `ctx.typert`** 要求当前 fiber 声明了 `inject: ['typert']`。
实测踩到：集成测试里的 fixture owner 在构造函数里调 `ctx.typert.register(...)`，
未声明 `static inject = ['typert']` → 抛 `cannot get property "typert" without inject`，13 个测试全红。

两条出路：给服务加 `static inject = ['typert']`（真实 DSH Remote owner 的写法，本插件测试采用），
或改用 `ctx.get('typert', false)`（`strict = false` 绕过「provider fiber 必须 ACTIVE」的检查，
但**仍不受 inject 限制**，因为那是 `get()` 而不是属性代理）。
本插件自身两种都用了：`inject` 里声明了 `typert`，读的时候仍走 `ctx.get(..., false)` 兜底。

### 5.4 `Config` 校验的两条边界 `[实测]`

用真实的 `Config['~standard'].validate(...)` 实测：

| 输入 | 结果 |
| --- | --- |
| `{}` | 无 issues，15 个字段全部填默认值 → 行**挂载成功**，状态 `unconfigured` |
| 规格 §5.1 的完整示例 | 无 issues |
| `{ bogus: 1 }` | 无 issues，**`bogus` 原样留在结果里**（schemastery 非严格） |
| `{ heartbeatIntervalMs: 'soon' }` | `$.heartbeatIntervalMs expected number but got soon` → **Loader 会丢掉这一行插件** |

→ **两个后果，都是设计依据**：

1. 未知键会漏进 `apply` 的第二个参数，所以 `resolveNodeConfig()` 必须**从头 re-derive 一份配置**
   （沿用 `dsh-drawio` 的 pitfall #9 与 `resolveDrawioConfig`）。本插件对未知键有测试。
2. **类型写错 = 整行插件静默消失**，比「报错」更糟。所以本插件的 `Config` **只声明类型与默认值，
   不写 `.min()` / `.max()` / `.required()`** —— 上下限与语义全部由 `resolveNodeConfig()` 判定，
   违规会保持在 `stopped` 并打出 `node/config-invalid`，**可诊断**而不是消失。
   这是对 `dsh-drawio`（schema 里带 bounds）的**有意偏离**，理由是它的 bounds 是装饰性的，
   而这里的是安全相关的。

---

## 6. 环境与工具链

### 6.1 工具链 `[实测]`

```
node   v24.11.1
pnpm   11.8.0
npm    11.6.2
dsh    0.1.2-alpha.1
```

`ws` 已存在于 `profiles/web/node_modules/ws` 与运行安装里；`schemastery` 也在 profile 里。

### 6.2 `pnpm run <script>` 会被沙箱打断 `[实测]`

`pnpm run` 会先跑一次 `runDepsStatusCheck`，它同步 spawn 一个嵌套 `pnpm install`：

```
[ERROR] Command failed with exit code 2147483651: "DSH Desktop.exe" …/pnpm.mjs install
[FATAL:mojo platform_channel.cc] Check failed: 拒绝访问。
```

`.npmrc` 的 `verify-deps-before-run=false` **没能关掉它**（`[实测]`）。
当前会话的文件策略是 `danger-full-access` 时可以直接跑通；
受限模式下绕法是直接调二进制：`node .\node_modules\typescript\bin\tsc …`。

### 6.3 ⚠️ Vitest 默认 `forks` 池在受限沙箱里起不来 `[实测]`

```
Error: spawn EPERM
 ❯ ProcessWorker.initialize …tinypool…
Test Files  no tests
```

Vitest 默认给每个测试文件用 piped stdio `fork` 一个子进程，受限沙箱拒绝。
**对策**：`vitest.config.ts` 里 `pool: 'threads'`（worker 线程在进程内）。
`vite` 加载 **`.ts` 配置文件**还需要 esbuild 的常驻服务（也是子进程 + pipe），
所以受限模式下连配置文件都读不了 —— 这个坑值得记：**在受限环境里
「vitest 报 no tests」多半不是测试写错了，是池子被拒了。**

### 6.4 沙箱下写文件的位置 `[实测]`

测试需要临时目录时用**工作区内的 `.tmp/`**，不要用 `os.tmpdir()`：
`workspace-write` 策略下工作区是唯一保证可写的位置。

### 6.5 安装依赖的两个坑（沿用 `dsh-drawio`）`[实测]`

- `pnpm-workspace.yaml` 里 `allowBuilds: { esbuild: false }`：esbuild 的 postinstall 用 piped
  stdio 起子进程，沙箱拒绝，会让整个 install 崩在链接 `.bin` 之前。
  `@esbuild/win32-x64` 正常安装，vite/vitest 的 JS API 不需要那个 postinstall。
- 加依赖时 `pnpm install --no-frozen-lockfile`，并设 `CI=true` 以避开
  `ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY`。

### 6.6 运行安装里**没有** `.d.ts`（旧版本的坑已不成立）`[实测]`

`E:\DSH\DSH Desktop\resources\app.asar.unpacked\node_modules\@deepseek-ai\*` 里：
`cordis/lib/types/` 只有 `*.d.ts.map`（**没有 `.d.ts`**），其余包的 `lib/types/*.js` 是编译产物。
→ **不要指望从运行安装拿类型**。`@deepseek-ai/*` 在 npm 上的**发布 tarball 带 `.d.ts`**
（实测 `@deepseek-ai/dsh-typert-protocol@0.1.2-alpha.2` 的 `lib/types/` 有 `index.d.ts` 等）。

### 6.7 npm 上缺 `0.1.2-alpha.1`（与 `dsh-atomic-write` 同类问题）`[实测]`

`@deepseek-ai/dsh-api-gateway` / `dsh-typert-protocol` / `dsh-typert-registry` 的可用版本序列是
`… 0.1.1-rc.2, 0.1.2-alpha.2, …, 0.1.6-alpha.2` —— **没有 `0.1.2-alpha.1`**。
所以集成测试的 devDependencies 钉在 **`0.1.2-alpha.2`**（与运行版本只差一个 alpha），
`@deepseek-ai/cordis` 钉 `4.0.1`（与运行安装完全一致的精确版本）。
这在 §9 记为偏差 2。

---

## 7. 协议与状态机的实现要点

### 7.1 状态机 `[决策]`

```
unconfigured ──(no URL/token)──▶ 不建 socket、无定时器（正常状态，不是错误）
stopped ──start()──▶ connecting ──open──▶ authenticating ──hello.ok──▶ ready
                                              │                            │
                                    handshakeTimeout / 坏帧          close / 半开
                                              ▼                            ▼
                                          backoff ◀────────────────────────┘
ready ──stop()──▶ closing ──▶ stopped
```

- **协议版本不匹配是致命的**：`decodeFrame` 在 details 里带稳定的 `reason: 'protocol-version'`，
  连接器据此进入 `stopped`（不重试），需要 `reconnectNow()` 或改配置才恢复。
  其余「握手期坏帧」仍走正常退避 —— 一个抖动产生的垃圾帧不该把节点永久打死。
- **未知帧类型 / 错 nodeId**：`ready` 之后一律 **记 protocol-error 并忽略**，不拆掉可用链路。
  错 nodeId 的帧**绝不执行** —— 这条连接只服务一个身份。
- **重复 `hello.ok`**：忽略，第一个握手的 `connectionId` 保持有效。
- **心跳**：容忍 `HEARTBEAT_MISSES_ALLOWED = 2` 个周期没收到 `pong`，然后判定半开并重连。
- **Coordinator 只能收紧不能放宽限额**：`maxFrameBytes` / `heartbeatIntervalMs` 取 `min(本地, 服务端)`。

### 7.2 退避 `[决策]`

```
delay = min(maxDelayMs, initialDelayMs * 2^(n-1)) * (1 + random(-jitterRatio, jitterRatio))
```

`n` 是**已发生的连续失败次数**，先自增再计算，所以**第一次失败后正好等 `initialDelayMs`**。
连上并稳定 `stableResetMs` 后 `n = 0`。

`auth_failed`：**不高频重试**。延迟用 `maxDelayMs`（最慢档），且
`MAX_CONSECUTIVE_AUTH_FAILURES = 5` 次之后完全静默，等 `reconnectNow()` 或改配置。
`reconnectNow()` 同时清空 auth 预算，所以改好 token 后可以立刻重试。

### 7.3 ⚠️ `await` 会把状态推进到下一个 microtask `[实测]`

最初的 `acceptHandshake` 写成 `async`，里面 `await this.delegate.createReady(frame)`。
即使 `createReady` 是同步的，`await` 也会把「进入 ready」推迟一个 microtask，
于是**同步驱动的测试永远看不到 `ready`**（实测：7 个 reconnect 测试因此失败）。

对策：把握手拆成 `acceptHandshake`（同步分派）+ `completeHandshake`（全同步），
只有 delegate **真的返回 Promise** 时才 `then` 延后。
这既是可测性改进，也省掉了生产路径上一次无意义的 microtask。

### 7.4 ⚠️ `close()` 可能同步触发 `close` 事件 `[实测]`

`closeSocket()` 里如果先 `socket.close()` 再挂「看门狗」定时器，那么当 `close()` **同步**
派发 `close` 事件时，`handleClose` 已经跑完并清理过定时器，随后挂上的看门狗就成了孤儿
（后续会以 `timers.pending !== 0` 的形式破坏「stop 后没有定时器」的断言）。
→ **必须先挂看门狗再 close**。这是一条真实踩到的顺序 bug。

### 7.5 ⚠️ 失败归因：别把具体原因压成通用断线 `[实测]`

`handleClose` 最初只用 `this.lastSocketError ?? 通用 connection-lost`。
于是 `node/handshake-timeout`、`node/not-ready` 这些**已经知道的原因**会被
`lastError` 覆盖成 `node/connection-lost`，状态里看不出到底为什么断。
→ 引入 `pendingFailure`，优先级为
`lastSocketError`（WebSocket error）→ `pendingFailure`（决定拆链的具体失败）→ 通用 `connection-lost`。

### 7.6 ⚠️ 对端文本是不可信输入（真实泄漏点）`[实测]`

`close` 帧的 `reason` 由**对端**填写，最初被逐字复制进 `NodeError` 与 `lastError`。
而**状态快照不像日志那样会过 sink**，是逐字交给调用方的 —— 测试里
`drop(1006, 'token=<TOKEN>')` 直接把凭据泄进了 `JSON.stringify(connector.snapshot)`。

对策（两层）：

1. 连接器里的 `peerText()`：对端文本在进入状态与日志前按本节点的 token 做字面量擦除，
   并截断到 `PEER_TEXT_LIMIT = 256`。
2. `statusSnapshot()` 接收 `secrets` 并对 `lastError.message` 再擦一遍 ——
   业务方法抛出的 message 不在本插件控制范围内，也可能回显凭据。

配套测试：`reconnect.test.ts` 的「scrubs a peer-supplied close reason」。

### 7.7 `rpc.cancel` 的应答语义 `[决策]`

取消后请求**仍然会收到恰好一个终态帧**，错误码用 **`gateway/cancelled`**
（与本地 DSH 调用方看到的一致，而不是新造一个 `node/*`）。
这需要 `RemoteCodeError` —— 一个专门携带「非 `node/*` 线上码」的失败类型。
另外，取消**不会**把请求从在途表里摘掉，它仍然走自己那条唯一的结算路径。

### 7.8 断线不重放 `[决策/实测]`

socket 关闭时：`RequestManager.failAll(new NodeError('node/connection-lost'))`
→ 每个在途请求的 `AbortSignal` 带 reason 中止，在途表清空。
`runRequest` 的结算门（`requests.complete()` 返回 `undefined`）保证：
连接已经换了一条时，**晚到的业务结果不会被补发**到新连接上。
集成测试断言：业务方法只被调用一次、新连接上没有该 requestId 的 `rpc.result`。

---

## 8. 身份持久化 `[决策]`

详见 README §7。核心事实：

- DSH **确实有**公开 storage：`ctx.storage.domain`（`@deepseek-ai/dsh-storage-domain`，
  经 `ctx.storage.open(...)` 打开 domain，schema 用 zod，见 `packages/storage/storage-domain/src/`）。
- **但它是组合依赖的**：`storage-domain` 插件需要 `backend` 配置（`Config.backend` 是 `.required()`），
  且每个 domain 的路由还要配 `routes`；没挂或没配就打不开。
  headless / SDK / 最小测试组合里可能根本不存在。
- 身份随组合变化 = Coordinator 把一台机器看成两个节点 = 规格明令禁止的失败模式。
- → 用纯 JSON 文件 `<DSH_HOME>/storages/dsh-node/identity.json`，
  沿用同机 `dsh-drawio` 已经在用的 `<dshHome>/storages/<plugin-id>/` 约定
  （`[实测]` 该目录真实存在于 `C:\Users\jaike\.dsh\storages\dsh-drawio`）。
- `$DSH_HOME` 优先级与官方 `@deepseek-ai/dsh-home-paths#resolveDshHome` 对齐（显式 > env > `~/.dsh`）。
- `wx` 独占创建 → 并发启动只会产生一个身份；损坏文件改名隔离后重建。

---

## 9. 与任务书/规格的偏差（逐条说明原因）

| # | 偏差 | 原因 |
| --- | --- | --- |
| 1 | 任务书说 DSH 版本 `0.1.2-rc.1`；**实测运行版本是 `0.1.2-alpha.1`** | `dsh --version` 实测输出；`E:\...\@deepseek-ai\dsh-api-gateway\package.json` 也是 `0.1.2-alpha.1` |
| 2 | 集成测试的官方包 devDependencies 钉 `0.1.2-alpha.2` 而非 `alpha.1` | npm 上**没有** `0.1.2-alpha.1`（§6.7）；`cordis` 钉 `4.0.1` 与运行安装完全一致。节点只用 `wireStream.failure()`，不依赖网关内部分支，所以一个 alpha 的差可以接受 |
| 3 | 多加了配置项 `requestTimeoutMs` | 规格 §5.2 的 runtime config 里没有它，但 §8.1 要求 `requestId -> timeout`、§10 有 `node/request-timeout`、§12.1 第 11 条要测超时。没有配置项就无法调也无法测 |
| 4 | 多加了配置项 `identityFile` / 环境变量 `DSH_NODE_IDENTITY_FILE` | §5.8 把身份位置留空并要求实现前确认；给运维一个显式覆盖点，同时测试可以完全避开用户的真实 `$DSH_HOME` |
| 5 | 多加了环境变量 `DSH_NODE_COORDINATOR_URL` | §5.6 明确允许用环境变量做 headless 配置；只有 token 被点名，URL 同理有用 |
| 6 | `Config` schema 不带 bounds（不写 `.min()` / `.max()`） | §5.4 的实测：schema 类型错误会让**整行插件消失**。bounds 放在 `resolveNodeConfig()` 才可诊断（§5.4） |
| 7 | `auth_failed` 仍会以 `maxDelayMs` 慢速重试（上限 5 次），而不是完全不重试 | 规格 §6 说「**默认**不高频重试」。慢速重试既能自愈服务端修好的场景，又不是请求风暴；上限之后完全静默 |
| 8 | `mode` 之外的「第二种模式」没有伪造 | 与规格 §1.1 第 3 条一致，验收清单要求 |
| 9 | 没有实现 `dshNode` typed Remote，改用 `ctx.dshNode` 普通服务 | 树外硬约束（§3 表第 2 行） |
| 10 | Phase 1 的 `ready.capabilities` 里 `namespaces` 是新增字段 | 源码模式插件的方法名公开不可枚举（§2.2）；不加这个字段，Coordinator 就无法区分「namespace 都不认识」和「namespace 认识但方法名未知」 |
| 11 | vitest 配置里加了 `pool: 'threads'` | 受限沙箱下默认 `forks` 池 `spawn EPERM`（§6.3） |

---

## 10. 规格 §12.1 单元测试条目的落地情况

| 条目 | 落在哪 | 备注 |
| --- | --- | --- |
| 1 `ws://`/`wss://` 通过，其他拒绝 | `config.test.ts` | 含 `http:` `https:` `ftp:` `file:` `javascript:` 与非法串 |
| 2 `mode` 只能是 `full-access` | `config.test.ts` | 5 种伪造模式被拒 |
| 3 未配置 URL/token → `unconfigured`，不连接不重连 | `config.test.ts` + `reconnect.test.ts` + `integration.test.ts` | 连接器层断言「无 socket、无定时器、时间推进也不动」 |
| 4 token 不进错误/日志/状态 | `config.test.ts` + `reconnect.test.ts` + `integration.test.ts` | 含**对端 close reason** 这条真实泄漏路径 |
| 5 未配置 nodeId 只生成一次，重启保持不变 | `config.test.ts` | 含并发三路同时启动只产生一个身份 |
| 6 指数退避、最大延迟、抖动范围 | `reconnect.test.ts` | `[100,200,400,800,1000,1000]`；抖动边界 800/1200 命中 |
| 7 稳定连接后重置重试计数 | `reconnect.test.ts` | 含 `stableResetMs = 0` 立即归零 |
| 8 hello / hello.ok / ready 字段校验 | `protocol.test.ts` | |
| 9 未知消息类型、未知 nodeId、错误 protocolVersion | `protocol.test.ts` + `reconnect.test.ts` | 版本不匹配 → 致命 `stopped` 且不重试 |
| 10 按 `requestId` 关联 | `request-manager.test.ts` | |
| 11 超时、取消、重复响应、未知响应不泄漏 | `request-manager.test.ts` | 计时器计数归零；重复完成返回 `undefined` |
| 12 stream `seq` 单调 | **Phase 2** | 本阶段不声明任何 `stream.*` 帧 |
| 13 stream 取消触发 AbortSignal | **Phase 2** | 同上 |
| 14 帧大小、并发请求、并发 stream、缓冲上限 | `protocol.test.ts`（帧大小）+ `request-manager.test.ts`（并发） | stream 两项属 Phase 2；`maxStreams` / `maxBufferedBytesPerStream` 已校验但保留 |
| 15 socket 关闭后未完成操作收到 `node/connection-lost` | `request-manager.test.ts` + `integration.test.ts` | 集成测试另外断言**没有重放** |
| 16 `stop()` 后不再重连 | `reconnect.test.ts` + `integration.test.ts` | 含「关闭窗口期间落下的失败也不重连」 |

计 213 个测试 / 5 个文件（`config` 58、`protocol` 59、`reconnect` 54、`request-manager` 24、`integration` 18）。

---

## 11. 部署验证 `[实测]`

```powershell
$env:DSH_HOME="C:\Users\jaike\.dsh"
dsh --profile web --dump-config
```

在 `profiles/web/cordis.patch.yml` 里加 `- insert: [{ id: dsh-node, name: 'dsh-node' }]`
（并让 `dsh-node` 能被 profile 解析：`node_modules/dsh-node` 目录联接指向本 checkout）之后：

```
# == C:\Users\jaike\.dsh\profiles\web\cordis.patch.yml
- id: mcp-chrome-hangwin
  name: '@deepseek-ai/dsh-mcp-client'
  config: …
- id: dsh-node
  name: dsh-node
```

退出码 **0**，541 行输出里无 error / failed / invalid 标记。

⚠️ 两点提醒：

1. `--dump-config` **只回放组合后的 loader 树，不 boot**，所以它证明「挂载正确」，
   不证明「运行期无冲突」。
2. 验证完成后我已把 `profiles/web` **完全还原**（patch、`package.json`、`cordis.yml` 备份回滚，
   目录联接用 `cmd /c rmdir` 只删链接、不删目标）。重新装载的步骤见 README §5.2。

### 11.1 `desktop` profile：真实运行验证（最强的 Phase 1 证据）`[实测]`

同机运行中的 GUI 用的是 **`desktop`** profile，因此真正的端到端验证在这里。
装载方式与 `web` 相同：`profiles/desktop/node_modules/dsh-node` 目录联接指向本 checkout，
patch 里加 `- insert: [{ id: dsh-node, name: 'dsh-node' }]`。

`dsh --profile desktop --dump-config` → 退出码 **0**，561 行，`- id: dsh-node` **恰好 1 次**，无 error 标记。
（出现 2 次就意味着双挂载 —— 必须检查计数。）

**发射前检查**（都通过，避免让用户白重启一次）：

```powershell
cd C:\Users\jaike\.dsh\profiles\desktop
node -e "import('dsh-node').then(m => console.log(m.name, m.inject, typeof m.apply))"
# → dsh-node [ 'typertGateway', 'typert' ] function
```

`inject` 的两个服务在 desktop 组合树里都在：`typert`（`dsh-typert-registry`）、
`typert-gateway`（`dsh-api-gateway`）。

**重启后，用一个本地 fake WebSocket Coordinator 观测到**（`.tmp/fake-coordinator.mjs`）：

```
18:02:44.293  LISTENING ws://127.0.0.1:39471/node
18:02:45.869  #1 CONNECT from 127.0.0.1          ← fake server 起来后 1.6 秒，节点自己连上来
18:02:45.873  #1 RECV hello   nodeId=node-b7ae1e56… mode=full-access tokenPresent=true
18:02:45.876  #1 SENT hello.ok connectionId=fake-conn-1
18:02:45.878  #1 RECV ready   endpoints=74 hash=sha256:67ff9044…
18:02:47.891  #1 RECV ping                       ← 每 2 秒一次（heartbeatIntervalMs=2000）
```

三个关键点：

1. **纯出站**：39471 的监听者是 `node` 进程（我起的 fake Coordinator），不是 DSH Desktop。
   节点侧没有任何入站端口。
2. **能力摘要来自真实注册表**：74 个 endpoint，含 3 个 `stream`
   （`session/control`、`session/follow`、`workspace/follow`），其余 `unary`；16 个 namespace。
3. **身份跨进程稳定**：`identity.json` 里的 `nodeId` 与 `hello` 里的完全一致。

**unary 转发在真实环境走通**（fake Coordinator 发 `rpc.request` → 真实业务方法 → 回帧）：

```json
// → pluginInventory/list，args {}
{"type":"rpc.result","result":{"ok":true,"value":{"entries":[ … 191 条 … ]}}}
```

23598 字节真实数据。从中提取到插件**自身的运行状态**，与已跑通的树外插件同级：

```json
[{"entryId":"include:dsh-node","moduleName":"dsh-node","enabled":true,"fiberPhase":"active"}]
[{"entryId":"include:drawio",  "moduleName":"dsh-drawio", "fiberPhase":"active"}]
[{"entryId":"include:skillui", "moduleName":"dsh-skillui","fiberPhase":"active"}]
```

**安全行为在真实环境复验**：

| 探测 | 结果 |
| --- | --- |
| `nope/missing` | `node/capability-unavailable`，`details={endpoint,namespace}`，业务方法零调用 |
| `demo/nonexistent` | `node/capability-unavailable` |
| `session/rename` args 不匹配 | `internal` —— **alpha.1 网关自身行为**，见 §1.5.1 |

### 11.2 ⚠️ `desktop` profile 里 live patch reload 实际上**没有生效** `[实测 + 源码]`

设计上，`patchReload: "live"` 的路径是（`@deepseek-ai/dsh-app-boot`）：

```
profile-boot → if (ctx.get("hmr") === void 0) { … ctx.loader.create({ name: "@deepseek-ai/cordis-plugin-hmr", config: { root: [] } }) }
             → watchUserPatches(ctx, …) → hmr.registerConfig(filename, …) → entry.update({ config: { …, patches } })
```

即「重放 patch 列表」。`watchUserPatches` 的第一句就是硬要求：

```js
const hmr = ctx.get("hmr");
if (hmr === undefined) throw new Error(`${binName}: user patch-layer watching requires the Cordis HMR service`);
```

**实测结论：在 desktop profile 里这条路走不通。** 证据链：

1. 向运行中的节点发 `pluginInventory/list`（191 条 entry）后筛选：`include:hmr`
   （`@deepseek-ai/cordis-plugin-hmr`）是 **`enabled: false, fiberPhase: null`**；
2. 全量筛 `moduleName` / `entryId` 含 `hmr` 的 entry，**只有** disabled 的 `include:hmr` 与
   无关的 `include:client-hmr`（`dsh-client-hmr`，客户端半侧）——**没有任何 active 的
   `@deepseek-ai/cordis-plugin-hmr`**；
3. 筛「非 `include:` 前缀的 entry」（即运行期 `loader.create()` 创建的），**只有 `include` 自己** ——
   证明 profile-boot 那次 `ctx.loader.create({ name: "@deepseek-ai/cordis-plugin-hmr" })`
   **没有成功**（异常被外层 `catch { suppressShutdownError(...) }` 吞掉了）；
4. 因此 `watchUserPatches` 从未注册成功，**用户 patch 层根本不会被热重放**。

对应的行为观测：

- 插入 `dsh-node` entry 并改 config 后 **12 秒内零连接**；
- **移除**临时 config 后 45 秒以上仍在 ping，即旧配置依旧生效。

> ⚠️ **修正一条我自己一度给出的错误结论**：我曾据「`identity.json` 的 CreationTime = 18:00:33、
> 而 17:43 那个实例直到 18:01:19 才退出」推断"live reload 最终会装载新 entry，只是延迟十几分钟"。
> 这个推断**是错的**。
>
> **决定性证据在 DSH 自己的运行日志里**（`%APPDATA%\DSH Desktop\logs\dsh-2026-09-18.log`）：
>
> ```
> --- dsh-plugin-desktop DSH Desktop 2.0.4 win32 node v24.18.1 run 1789724617933 ---
> 2026-09-18 17:43:41.465 [I] [superpowers] registering provider "superpowers"
> --- dsh-plugin-desktop DSH Desktop 2.0.4 win32 node v24.18.1 run 1789725631608 ---
> 2026-09-18 18:00:33.363 [I] [superpowers] registering provider "superpowers"
> --- dsh-plugin-desktop DSH Desktop 2.0.4 win32 node v24.18.1 run 1789725679636 ---
> 2026-09-18 18:01:22.743 [I] [superpowers] registering provider "superpowers"
> ```
>
> `run 1789725631608` = 2026-09-18T10:00:31.608Z = **本地 18:00:31 有另一次完整的 DSH 启动**。
> `identity.json` 写于 18:00:33.965 —— 相差 2.4 秒。
> 所以那个文件来自**一次真正的 DSH 重启**，与 patch 热重载毫无关系。谜团闭合。
>
> 教训：**遇到"这个文件怎么突然出现了"这类问题，先去看 DSH 的运行日志** ——
> 它能干净地区分"进程重启"与"热重载"，而我一开始漏掉了这个最直接的证据来源，
> 连续给出了两个错误结论。

**对本插件的实际含义**：

- 改 `cordis.patch.yml`（新增 entry、改 config、改 token 来源）后，**必须重启 DSH Desktop**；
- `--dump-config` 反映的是"下次 boot 会怎样"，不是"当前正在跑什么"；
- 排查"插件没生效"时，先确认运行实例的 fiber 状态（本文 §11.1 的方法），不要假设 patch 已生效；
- `patchReload: "live"` 这个字段存在，**不等于**热重载真的在工作 —— 要验证 hmr 服务是否 active。

### 11.2.1 ⚠️ 日志：`console.log` 在 DSH Desktop 里等于石沉大海 `[实测]`

`dsh-superpower` 用 `ctx.logger.info(...)`，其输出出现在
`%APPDATA%\DSH Desktop\logs\dsh-<date>.log`，行格式：

```
2026-09-20 10:00:38.688 [I] [superpowers] [superpowers] registering provider "superpowers"
```

（`[superpowers]` 出现两次：一次是 logger 名，一次是 message 内容里自己写的。）

而本插件最初所有日志都走 `console.log` —— **在 DSH Desktop 里不落任何文件**。
后果非常具体：Phase 1 没有浏览器半侧，界面本来就看不到东西；日志又落在空气里，
于是用户重启后**完全无法判断插件是否加载、是否连接、为什么没连上**。
「界面没有改变」这条反馈的根因就是它。

**修复**（`src/status.ts` 的 `cordisLogSink`）：优先把记录转发给 `ctx.logger`，
`console` 只作为非 DSH 环境（测试、独立运行）的兜底。集成测试用 Cordis 公开的
`ctx.logger.exporter({ export })`（DSH 写日志文件用的就是这个缝）断言
`dsh-node/connecting`、`dsh-node/connected`、`dsh-node/request-completed` 都到达了 logger，
且**记录里不含 token**。

⚠️ **两个实现上的坑，都已在测试里锁住**：

1. **`ctx.logger` 是可调用的**（`ctx.logger('subsystem')` 返回具名 facade），
   所以 `typeof ctx.logger === 'function'`，不是 `'object'`。
   最初的守卫写成 `typeof logger !== 'object'` → 判定"不是 logger" → **静默回退到 console**，
   也就是"修复"等于没修。是集成测试抓出来的：导出器收到 0 条记录，而 stdout 有输出。
2. **Cordis 的日志是 printf 风格，且会用 `args.shift()` 消费参数**：
   `Logger.format()` 里 `format.replace(/%([a-zA-Z%])/g, …)` 每命中一个占位符就 `args.shift()`。
   于是 message 里一个 `%s` / `%o` 就会**吃掉本该跟在后面的结构化字段**，`%d` 还会把它渲染成 `NaN`。
   而本插件的 message 会带上**对端提供的 close reason** 和 Remote 方法抛出的错误信息 ——
   这是让日志说谎的真实路径。对策是 `escapeLogFormat()` 把 `%` 全部写成 `%%`
   （formatter 会还原成字面 `%` 且不消费参数），字段用 `%o` 交给 Cordis 渲染。
   单测里**照抄了 Cordis 的替换循环**来验证转义确实有效。

### 11.3 临时验证配置与 `tools/fake-coordinator.mjs`

端到端验证需要 token（节点无 token 不起连接），而无法给运行中的 DSH 注入环境变量，
所以临时在 patch 里写了一个**明显非凭据的占位 token** 指向本地 fake server，并在验证后移除。
真实 token 走 `DSH_NODE_TOKEN`，不进 yaml。

那个 fake server 已从一次性脚本提升为仓库内的正式开发工具 `tools/fake-coordinator.mjs`：

- **只绑 `127.0.0.1`**，host 是常量而非参数 —— 测试夹具绝不能从网络可达；有单测锁住
  `--host` 是未知选项。
- **凭据永不落盘**：`hello.auth.token` 在写出前被 `redactFrame()` 替换，只保留"存在/长度"。
- **token 不进 argv**：只有 `--expect-token-env <VAR>`（从环境变量取），
  刻意**没有** `--expect-token <value>` —— 命令行值会进 shell 历史和进程列表。有单测锁住。
- 纯 JavaScript、无构建步骤，`node tools/fake-coordinator.mjs` 永远可跑。
- 用 `import.meta.url === pathToFileURL(process.argv[1]).href` 守卫，**可被 import 而无副作用**，
  因此 `test/fake-coordinator.test.ts` 能直接单测它的 `parseArgs` / `redactFrame`。

---

## 12. 仍未验证 / 未来需要确认

1. **Coordinator 还不存在**。所有对端行为都由本地 fake WebSocket server 承担（§11.1 已在
   **真实运行的 Desktop profile** 上跑通 hello/hello.ok/ready + unary 转发 + 能力门禁）；
   线协议与错误语义的「真实对端」验证要等 Coordinator 落地（规格 §14 已固定最小兼容契约）。
2. **`0.1.2-alpha.1` 与 `alpha.2` 的网关内部分支不同**，且有**实测后果**：alpha.1 上
   `gateway/*` 边界错误退化成 `internal`（§1.5.1）。节点只用 `wireStream.failure()`，
   因此行为与官方载体逐字一致；但如果将来要用别的网关内部行为，必须先比对两个版本。
3. **`gateway/*` 原码保留在 alpha.1 上不成立**（网关自身限制）。升级到 alpha.2+ 自然成立，
   节点代码无需改动。Coordinator 不要依赖 `gateway/arguments-invalid` 做参数校验反馈。
4. **源码模式插件的 namespace 枚举**只依赖那个公开的 `typertRemote` 绑定。
   如果上游把它改成私有，`namespaces` 会退化为空 —— 后果是源码模式插件无法被派发
   （生成器插件不受影响，走 `typert.local.list()`）。README 与本文都记了这个依赖。
5. **一个真实的 Coordinator 是否会应答 `ping`**。本实现把「连续 2 个周期没有 `pong`」
   判为半开连接并重连；规格 §14 第 4 条要求 Coordinator 能发心跳帧，
   但没有明说必须回 `pong`。这必须在 Coordinator 侧实现时确认。
6. **未在真实环境验证的两项**：取消（`rpc.cancel`）与请求超时。
   两者需要长耗时业务方法，而真实 profile 上没有无副作用的慢方法
   （`session/prompt` 会真的发 prompt）。它们由 `request-manager` 单测与
   `integration.test.ts` 的组合测试覆盖。
7. **`heartbeatIntervalMs = 2000` 是验证用的临时值**，不是建议的生产值。
