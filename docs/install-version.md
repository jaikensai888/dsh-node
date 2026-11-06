# 查询版本与安装指定 Release

日期：2026-11-06。适用仓库：`https://github.com/jaikensai888/dsh-node`。

本文给远程 Agent 使用：从 GitHub Release 安装**指定版本**的已构建插件，保留配置、Token、`nodeId`、会话、附件和统计数据，并能判断「安装的版本」与「进程实际运行的版本」。只读本仓库即可执行。

> 先记住两条：
> 1. `build-info.json` 描述**安装的文件**；`/dsh-node/api/status` 的 `buildInfo` 描述**当前进程加载的构建**。两者不一致时，说明旧进程仍在运行，不能报告升级完成。
> 2. 插件代码或 tarball 变化必须重启 DSH 才生效；面板保存配置只重连，不会替换已加载的代码。

## 0. 适用范围与不做什么

本流程只安装/切换 `dsh-node` 插件包：

- 不做节点版本上报、Coordinator 版本管理、自动升级、专用升级工具或 npm 发布。
- 不修改 master/coordinator 业务代码。
- 不删除 `<DSH_HOME>/storages/dsh-node/`（配置、身份、用量队列）和 `<DSH_HOME>/dsh-node/files/`（会话附件与产物）。
- 不绕过 DSH 的本地信任围栏，不把 Token 写进命令行、日志或文档。
- 未获得授权时，不重启正在处理会话的 DSH，不升级用户真实 profile。

插件相关数据路径（安装/切换不得删除或移动）：

| 数据 | 默认路径 |
| --- | --- |
| 配置（含 Token）、`nodeId`、用量队列 | `<DSH_HOME>/storages/dsh-node/` |
| 会话附件与产物快照 | `<DSH_HOME>/dsh-node/files/` |
| 会话、消息、用户其他数据 | DSH 自身管理的数据目录；本插件安装不触碰 |

## 1. 前置检查

变量约定（按实际平台选择）：

```powershell
# Windows PowerShell
$dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $HOME '.dsh' }
$profileName = 'desktop'
$profileDir = Join-Path $dshHome "profiles\$profileName"
$pluginDir = Join-Path $profileDir 'node_modules\dsh-node'
```

```bash
# Linux / macOS
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
PROFILE=desktop
PROFILE_DIR="$DSH_HOME/profiles/$PROFILE"
PLUGIN_DIR="$PROFILE_DIR/node_modules/dsh-node"
```

检查 DSH、profile 和现有安装：

```powershell
dsh --version
Get-ChildItem (Join-Path $dshHome 'profiles') -Directory | Select-Object Name
dsh plugin --profile $profileName list dsh-node --depth 0
(Get-Content (Join-Path $profileDir 'package.json') -Raw | ConvertFrom-Json).dependencies.'dsh-node'
dsh --profile $profileName --dump-config | Select-String -SimpleMatch 'dsh-node'
```

```bash
dsh --version
ls "$DSH_HOME/profiles"
dsh plugin --profile "$PROFILE" list dsh-node --depth 0
node -p "require('$PROFILE_DIR/package.json').dependencies['dsh-node']"
dsh --profile "$PROFILE" --dump-config | grep -n 'dsh-node'
```

要点：

- `dsh plugin --profile <name> <args>` 把参数转发给该 profile 目录里的 pnpm；`list` / `add` / `remove` 都是 pnpm 语义。
- DSH Desktop 的启动器可能把 `DSH_HOME` 固定为它自己的用户目录，当前 shell 里的同名环境变量不一定生效；以实际存在的 `profiles/<name>` 和 `dsh plugin` 打印的路径为准，不要只凭 `$env:DSH_HOME` 猜测。
- `dsh-node` 必须出现在组合树里，且**只出现一次**。本仓库的 bundle 自带 `cordis.patch.yml`，profile 的 `dsh.profile.bundles` 列出 `dsh-node` 时会自动插入；手工 `insert` 与 bundles 同时存在会重复。
- 若 `dsh --profile ... --dump-config` 里没有 `dsh-node`，先在 profile 的 `package.json` 的 `dsh.profile.bundles` 数组末尾加入 `"dsh-node"`（保留原数组，不要整文件替换），再重新 dump 验证；不要同时保留手工 insert。

### 识别当前安装方式

```powershell
$spec = (Get-Content (Join-Path $profileDir 'package.json') -Raw | ConvertFrom-Json).dependencies.'dsh-node'
$spec
```

- `link:<绝对路径>`：源码链接。`$pluginDir` 是 junction，`build-info.json` 来自该源码目录最后一次构建；源码可能带本地改动（`channel=dev`、`dirty=true`），不能当作正式版本。
- 版本号或 `file:...tgz`：已安装的发布包。`$pluginDir/build-info.json` 是安装快照。
- 空/缺失：未安装，或只存在于手工 patch 中（这种组合会在启动时报找不到包）。

记录切换前的规格和源码路径（回滚要用）：

```powershell
$spec | Tee-Object -FilePath (Join-Path $dshHome 'dsh-node-previous-spec.txt')
Copy-Item (Join-Path $profileDir 'package.json') (Join-Path $dshHome 'dsh-node-profile-package.json.bak') -Force
Copy-Item (Join-Path $profileDir 'pnpm-lock.yaml') (Join-Path $dshHome 'dsh-node-profile-lock.yaml.bak') -Force
```

## 2. 读取「安装版本」

```powershell
if (Test-Path (Join-Path $pluginDir 'build-info.json')) {
  Get-Content (Join-Path $pluginDir 'build-info.json') -Raw | ConvertFrom-Json
} else {
  'build-info.json 不存在：旧包或未构建的链接源码'
}
Get-Content (Join-Path $pluginDir 'package.json') -Raw | ConvertFrom-Json | Select-Object name, version
```

```bash
cat "$PLUGIN_DIR/build-info.json" 2>/dev/null || echo 'build-info.json 不存在：旧包或未构建的链接源码'
node -p "require('$PLUGIN_DIR/package.json').version"
```

`build-info.json` 固定字段：

```json
{
  "version": "0.2.0",
  "commit": "完整提交 SHA",
  "builtAt": "2026-11-06T00:00:00.000Z",
  "channel": "stable",
  "dirty": false
}
```

- `channel=stable` 只应出现在由正式 Tag 构建的包；`preview` 为预发布；`dev` 为本地/非发布构建。
- 正式 Release 的 `dirty` 必须为 `false`。若为 `true` 或 `commit=null`，这不是可信的发布产物，停止安装并报告。
- `package.json.version` 与 `build-info.json.version` 必须一致；不一致的 tgz 不应被安装（`tools/verify-package.mjs` 会拒绝）。

## 3. 读取「实际运行版本」

本地状态路由：`GET /dsh-node/api/status`，返回 `{ ok, value }`，`value.pluginVersion` 与 `value.buildInfo` 来自**当前进程嵌入的常量**。

### 3.1 找到端口

不要硬编码端口。按部署方式确定：

- DSH Desktop：实际 Web UI 的 URL（例如窗口地址或运行上下文里的 `http://127.0.0.1:<port>`）。
- `dsh web` / 自定义：启动输出打印的 URL，或启动参数 `--port`。
- 反向代理：代理到 DSH 的同一个 origin，路径前缀不变。

### 3.2 查询

优先在 DSH 页面自带的浏览器控制台执行（同源、天然通过 DSH 的 Web 鉴权与插件信任围栏）：

```js
await (await fetch('/dsh-node/api/status', { cache: 'no-store' })).json()
```

同机命令行：

```powershell
$port = '<实际端口>'
curl.exe --noproxy '*' "http://127.0.0.1:$port/dsh-node/api/status"
```

```bash
PORT='<实际端口>'
curl --noproxy '*' -fsS "http://127.0.0.1:$PORT/dsh-node/api/status"
```

如果返回 `401/403`：这是 DSH Web 服务器或插件的信任围栏在拒绝**未认证/非受信来源**的请求，不代表节点坏了。使用浏览器控制台或与 UI 相同的已认证会话；不要关闭鉴权、不要改 `Host` 绕过、不要把端口暴露到公网。

### 3.3 解读

```json
{
  "ok": true,
  "value": {
    "state": "ready",
    "pluginVersion": "0.2.0",
    "buildInfo": {
      "version": "0.2.0",
      "commit": "……",
      "builtAt": "2026-11-06T00:00:00.000Z",
      "channel": "stable",
      "dirty": false
    }
  }
}
```

| 观察 | 结论 |
| --- | --- |
| `value.buildInfo.version` 与安装的 `build-info.json.version`、`commit` 都一致 | 运行版本已更新 |
| 安装文件已是新版本，但 `value.buildInfo` 仍是旧值 | 旧进程仍在运行；需要重启 DSH，不能报告升级完成 |
| `value` 没有 `buildInfo`，只有 `pluginVersion` | 运行的是加入构建元数据之前的旧构建；把「运行 build」标为未知，不要用磁盘文件推断 |
| `state` 为 `unconfigured` / `backoff` | 版本仍可信；连接状态与版本是两件事，先按状态排查配置/网络 |
| `404` 或连接被拒绝 | 路由未注册或 DSH 未启动；检查 profile 组合树和进程 |
| `403` | 鉴权/信任围栏；改用同源浏览器请求 |

旧节点没有 `buildInfo` 时，只能确认「安装版本」，运行版本必须明确写为**未验证**。

## 4. 下载指定 Release

从 GitHub Releases 获取，不要从不明镜像、聊天附件或源码自行打包替代。

```powershell
$version = '0.2.0'                  # 用户指定的版本，不带 v
$tag = "v$version"
$releaseDir = Join-Path $dshHome "dsh-node-releases\$tag"
New-Item -ItemType Directory -Force $releaseDir | Out-Null
$base = "https://github.com/jaikensai888/dsh-node/releases/download/$tag"
Invoke-WebRequest "$base/dsh-node-$version.tgz" -OutFile (Join-Path $releaseDir "dsh-node-$version.tgz")
Invoke-WebRequest "$base/SHA256SUMS" -OutFile (Join-Path $releaseDir 'SHA256SUMS')
Get-ChildItem $releaseDir
```

```bash
version=0.2.0
tag="v$version"
release_dir="$DSH_HOME/dsh-node-releases/$tag"
mkdir -p "$release_dir"
base="https://github.com/jaikensai888/dsh-node/releases/download/$tag"
curl -fL --retry 3 -o "$release_dir/dsh-node-$version.tgz" "$base/dsh-node-$version.tgz"
curl -fL --retry 3 -o "$release_dir/SHA256SUMS" "$base/SHA256SUMS"
ls -l "$release_dir"
```

有 GitHub CLI 时也可：

```powershell
gh release download $tag --dir $releaseDir --pattern '*'
```

### 校验 SHA-256

```powershell
Push-Location $releaseDir
$expected = ((Select-String -Path .\SHA256SUMS -Pattern "dsh-node-$version\.tgz$").Line -split '\s+')[0]
$actual = (Get-FileHash ".\dsh-node-$version.tgz" -Algorithm SHA256).Hash.ToLower()
if ($expected -ne $actual) { throw "SHA256 mismatch: expected $expected, got $actual" }
"checksum ok: $actual"
Pop-Location
```

```bash
(cd "$release_dir" && sha256sum -c SHA256SUMS)
```

校验只证明下载内容与 Release 清单一致，不代替对仓库/Release 来源的信任。校验失败时重新下载；仍失败则停止，不安装。

### 检查包内元数据（安装前）

```powershell
tar -xOf (Join-Path $releaseDir "dsh-node-$version.tgz") package/build-info.json
tar -xOf (Join-Path $releaseDir "dsh-node-$version.tgz") package/package.json
```

```bash
tar -xOf "$release_dir/dsh-node-$version.tgz" package/build-info.json
tar -xOf "$release_dir/dsh-node-$version.tgz" package/package.json
```

确认：

- `version` 等于目标版本；`channel` 与 Release 的预发布标记一致；`dirty=false`。
- `engines.node` 满足当前 DSH 运行时（包要求 `>= 20`）。
- DSH 版本满足 Release Notes 的兼容要求（当前 README 记录：`>= 0.1.2-alpha.2`，验证于 `0.2.1-rc.2`）。
- 包里有 `lib/index.js`、`lib/client.js`、`build-info.json`、`cordis.patch.yml`。

## 5. 安装到指定 profile

### 5.1 保留旧版本

- 旧规格是 `link:<路径>`：记录路径，并确认该源码目录仍存在；切换只改 profile 依赖，不删除源码。
- 旧规格是版本 / tgz：把旧 tgz 保存在 `$DSH_HOME/dsh-node-releases/<旧tag>/`；若只有已安装目录，先复制整个 `$pluginDir` 到备份目录（不要动 `node_modules/.pnpm` 内部链接）。
- 配置与数据不复制也不删除：`<DSH_HOME>/storages/dsh-node/`（配置/身份/用量）和 `<DSH_HOME>/dsh-node/files/`（附件/产物）保持原位。
- 若需要额外备份配置（含 Token），复制到受保护目录并限制权限；不要把 Token 放进工单、日志或聊天。

### 5.2 安装

```powershell
$tgz = Join-Path $releaseDir "dsh-node-$version.tgz"
dsh plugin --profile $profileName add $tgz
```

```bash
dsh plugin --profile "$PROFILE" add "$release_dir/dsh-node-$version.tgz"
```

- `dsh plugin add` 会把依赖写入 profile 的 `package.json` 和锁文件，并安装生产依赖 `ws`、`schemastery`。
- 路径含空格时整体加引号。
- 不要手工解压 `lib/` 覆盖到 profile；那会绕过依赖安装和版本记录。
- 安装失败时保留输出；不要用 `--force`、`git clean` 或删除 `node_modules` 来「修好」。

### 5.3 验证安装与生产依赖

```powershell
dsh plugin --profile $profileName list dsh-node --depth 1
$spec = (Get-Content (Join-Path $profileDir 'package.json') -Raw | ConvertFrom-Json).dependencies.'dsh-node'
$spec
```

```bash
dsh plugin --profile "$PROFILE" list dsh-node --depth 1
node -p "require('$PROFILE_DIR/package.json').dependencies['dsh-node']"
```

确认 `dsh-node` 指向下载的 tgz（pnpm 常记录为 `file:...`），并确认依赖可见。若 `list --depth 1` 没有显示 `ws`/`schemastery`，用 Node 从**真实包目录**解析（pnpm 的软链布局必须 realpath）：

```powershell
node -e "const fs=require('node:fs'),path=require('node:path'),{createRequire}=require('node:module');const p=fs.realpathSync(process.argv[1]);const r=createRequire(path.join(p,'package.json'));for(const d of ['ws','schemastery'])console.log(d,r.resolve(d))" $pluginDir
```

```bash
node -e "const fs=require('node:fs'),path=require('node:path'),{createRequire}=require('node:module');const p=fs.realpathSync(process.argv[1]);const r=createRequire(path.join(p,'package.json'));for(const d of ['ws','schemastery'])console.log(d,r.resolve(d))" "$PLUGIN_DIR"
```

两者都能解析才算生产依赖齐全。仅解压 `lib/` 不算安装完成。

### 5.4 验证 profile 组合

```powershell
dsh --profile $profileName --dump-config | Select-String -SimpleMatch 'dsh-node'
```

```bash
dsh --profile "$PROFILE" --dump-config | grep -n 'dsh-node'
```

必须恰好一条 `- id: dsh-node` / `name: dsh-node`。若为零：按第 1 节的 bundles 方式加入，再 dump 验证。若为两条：删除重复的手工 insert 或重复 bundle 条目，保留一种。

> 本机实测 `dsh plugin --profile <name> add <tgz>` 会把 `dsh-node` 自动写入新 profile 的 `dsh.profile.bundles`；已有 profile 是否自动写入取决于其配置，仍以 dump-config 的结果为准。

## 6. 重新加载 / 重启并验证运行版本

### 6.1 什么时候必须重启

- 安装/切换 tarball、替换 `lib/`、升级插件代码：**必须重启 DSH 进程**。README 明确记录 `patchReload: "live"` 不会替换运行中的插件代码。
- 面板里保存协调器地址/Token：宿主会重建节点并重连，不需要重启；这不改变已加载的构建。

### 6.2 重启

Windows（DSH Desktop）：

1. 确认没有正在执行的用户会话/任务；重启会中断它们。
2. 完全退出 DSH Desktop（托盘/任务管理器确认进程退出），再重新启动。
3. 不要把「关闭窗口」当成进程退出。

Linux/macOS / headless：

1. 停止原进程（前台 `Ctrl+C`，或系统服务 `systemctl restart <service>`）。
2. 用**原来的 profile 和参数**重新启动（如 `dsh --profile desktop` / `dsh web --profile web`）。
3. 确认旧进程已退出，端口由新进程占用。

未获授权时不要重启用户正在使用的实例；先报告需要重启并等待。

### 6.3 验证

```powershell
# 已安装（文件）
Get-Content (Join-Path $pluginDir 'build-info.json') -Raw | ConvertFrom-Json
# 实际运行（同源浏览器控制台或 curl；端口按实际）
# await (await fetch('/dsh-node/api/status', { cache: 'no-store' })).json()
```

```bash
cat "$PLUGIN_DIR/build-info.json"
# curl --noproxy '*' -fsS "http://127.0.0.1:$PORT/dsh-node/api/status"
```

通过条件：

- `buildInfo.version` 等于目标版本。
- `buildInfo.commit` 等于目标 Release 的构建提交（以包内 `build-info.json` 或 Tag 对应提交为准）。
- 正式版 `channel=stable` 且 `dirty=false`；预发布 `channel=preview`。
- `pluginVersion` 与 `buildInfo.version` 一致。
- `state` 为 `ready` 或至少是你预期的连接状态；版本验证不依赖连接成功。
- 旧进程未退出时，状态会继续返回旧 `buildInfo`；这应报告为「安装完成、运行版本未更新」，而不是升级成功。

## 7. 回滚到旧版本

```powershell
# 旧版本是 tgz
dsh plugin --profile $profileName add '<旧 tgz 绝对路径>'
# 旧版本是源码链接
dsh plugin --profile $profileName add "dsh-node@link:<旧绝对路径>"
```

```bash
dsh plugin --profile "$PROFILE" add '/path/to/dsh-node-<旧版本>.tgz'
# 或
dsh plugin --profile "$PROFILE" add "dsh-node@link:/path/to/dsh-node"
```

然后按第 6 节重启并验证旧 `buildInfo`。回滚只还原**包**：

- 配置、Token、`nodeId`、会话、附件和统计数据保持在 `<DSH_HOME>/storages/dsh-node/`、`<DSH_HOME>/dsh-node/files/` 及 DSH 原有数据目录，不删除。
- 不承诺跨不兼容数据迁移的任意降级；若新版本改过配置/数据格式，旧版本可能拒绝启动。此时报告具体错误，不通过删除数据「修好」。
- 不覆盖已提交的源码；从 tgz 切回 link 时，源码保持原样。

## 8. 多 profile 与共享数据

- 每个 profile 有独立的 `node_modules` / `package.json`；升级只操作命令行指定的 profile。
- `dsh-node` 的配置、身份和用量在 `$DSH_HOME/storages/dsh-node/`，会话附件与产物在 `$DSH_HOME/dsh-node/files/`，都由 `DSH_HOME` 决定，**不随 profile 分叉**。切换 profile 不会自动换 `nodeId` 或 Token。
- 不要让两个不同版本的 profile 同时用同一 `nodeId` 连接同一个协调器；会表现为重复节点/连接互相顶替。
- 改完一个 profile 后，确认其他 profile 的 dump-config 未被改动。

## 9. 源码 link、本地改动与构建产物

- 当前机器（2026-11-06）的 `desktop` profile 是 `link:G:/claude_project/code-agent/dsh-node`；这是源码模式，不是 Release 安装。
- link 模式下 `build-info.json` 由本仓库 `pnpm build` 生成；`channel=dev`、`dirty=true` 说明是开发构建，不能冒充正式版本。
- 切换安装包不会删除或覆盖 link 指向的源码；不要 `git clean`、不要删除 `lib/`（DSH 可能仍持有文件句柄；构建采用原地覆盖，删除目录在 Windows 上可能失败）。
- 若源码目录有用户未提交改动，先报告并保留，不要为了「干净安装」丢弃。

## 10. 失败排查

| 现象 | 先检查 | 处理 |
| --- | --- | --- |
| 宿主未启动 / 离线 | 进程与端口；磁盘上的 `build-info.json` 仍可读 | 安装可以先完成，但运行版本标为**未验证**；启动/重启后再查状态 |
| 重复安装同一版本 | `dsh plugin list` 与 `build-info.json` | 幂等；pnpm 可能提示 already up to date，不重复改变数据，仍需确认运行版本 |
| 下载 404 | Tag/版本号拼写；Release 是否已发布 | 用实际存在的 `vX.Y.Z`；不猜版本 |
| SHA256 不匹配 | 是否只下载了一半、代理/镜像是否改内容 | 重新下载；仍失败停止 |
| `pnpm add` / 安装失败 | 网络、registry、peer 依赖、磁盘权限 | 保留日志；不手工覆盖 `lib`；不删 `node_modules` 了事 |
| dump-config 没有 dsh-node | profile bundles / 手工 patch | 加入 bundles（只一种方式），重新 dump |
| dump-config 出现两条 | bundles + 手工 insert 重复 | 删除其一，保留一种 |
| 状态 404 | 插件未挂载、DSH 未启动、旧版无路由 | 检查组合树与进程；`/dsh-node/ping` |
| 状态 403 | DSH Web 鉴权、Host/Origin 信任围栏 | 用同源浏览器请求或已认证会话；不要绕过 |
| 安装版本新、运行版本旧 | 旧进程仍在运行 | 重启 DSH，再查 `buildInfo` |
| 运行版本没有 `buildInfo` | 旧构建 | 明确标记运行版本未知；升级并重启后再验证 |
| `state=unconfigured` | 不是版本问题；缺地址/Token | 按 README 配置；不要重新生成身份 |
| 协调器拒绝 Token | 配置/身份未变；协调器登记是否撤销 | 检查登记；不要擅自轮换 Token |
| 重启后会话中断 | 重启会终止正在执行的任务 | 事前获得授权并选择空闲窗口 |

## 11. Agent 执行清单

```text
[ ] 确认目标 profile、DSH_HOME、平台、DSH 版本
[ ] 记录旧依赖规格（link 路径或版本）与 profile package.json / lock 备份
[ ] 确认目标 Release 存在，版本号由用户指定
[ ] 下载 tgz + SHA256SUMS，校验 SHA256
[ ] 检查包内 build-info.json / package.json / engines / DSH 兼容性
[ ] dsh plugin --profile <name> add <tgz>
[ ] 验证生产依赖 ws、schemastery 可解析
[ ] dump-config 中 dsh-node 恰好一条
[ ] 获得授权后重启 DSH
[ ] 同源查询 /dsh-node/api/status，核对 buildInfo version/commit/channel/dirty
[ ] 核对安装目录 build-info.json 与运行 buildInfo 一致
[ ] 报告：安装版本、运行版本、连接状态、数据是否保留、未验证项
```

## 12. 本机已验证 / 未验证

已实际运行：

- `pnpm typecheck`、`pnpm test`（631 tests）、`pnpm build`。
- `pnpm pack` 生成 `dist/dsh-node-0.1.0.tgz`（版本仅为当前 `package.json`，不是发布决定）。
- `node tools/checksums.mjs dist` 生成 SHA256SUMS。
- `node tools/verify-package.mjs dist --sums dist/SHA256SUMS`：临时目录实际安装 tgz、解析生产依赖、导入宿主包、校验客户端 bundle，并验证替换 `build-info.json` 后新进程仍报告嵌入版本。
- 在一个临时 profile（`dsh-node-verify`，验证后已删除）执行过 `dsh plugin --profile dsh-node-verify add <tgz>`：命令成功，pnpm 安装了包及其生产依赖，并把 `dsh-node` 写入该 profile 的 `dsh.profile.bundles`。用户真实 `desktop` profile 未被改动。
- `dsh plugin --profile desktop list dsh-node --depth 0`、`dsh --profile desktop --dump-config`（只读查询）。

未验证：

- 未对用户真实 profile 执行升级、切换或重启；本文中的真实升级步骤未在本机跑通。
- 本机 DSH Desktop 的 `/dsh-node/api/status` 通过未认证 `curl` 返回 403；未验证同源浏览器会话下的实际响应。文档按同源浏览器请求给出路径。
- GitHub Release 下载 URL、`gh release download`、真实 Release 附件校验依赖首次发布后才能验证。
- 未验证真实 DSH 重启后的会话/附件/统计数据保留情况；只依据代码路径确认安装不触碰这些目录。

首次实际升级时，把上述未验证项逐条记录结果，不要把「本地 tgz 冒烟通过」当成「真实 profile 已升级」。
