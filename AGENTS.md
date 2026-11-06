# AGENTS.md — dsh-node

本文件是本仓库的 Agent 入口。先读本文件，再按任务读取对应文档；不要凭记忆猜命令、接口或版本。

## 任务入口

| 任务 | 必读 |
| --- | --- |
| git push、提交并推送、发布 `vX.Y.Z`、构建 Release | [`docs/git-push.md`](docs/git-push.md) |
| 查询安装/运行版本、安装或切换指定 Release、回滚 | [`docs/install-version.md`](docs/install-version.md) |
| 修改 `dsh-node/1` 协议、握手、帧、错误码 | [`docs/COORDINATOR.md`](docs/COORDINATOR.md) |
| 了解实测结论、设计取舍、已知坑 | [`docs/GROUND-TRUTH.md`](docs/GROUND-TRUTH.md)、[`docs/log.md`](docs/log.md) |

两条硬规则：

- 用户说「git push」只推送已有提交，不自动提交工作区，不创建 Tag、不发布。
- 用户说「发布 vX.Y.Z」才走发布流程；版本号未指定时先询问，不擅自决定（不要把 `0.1.0` 直接改成 `0.2.0`）。

## 项目与常用命令

`dsh-node` 是 DSH Host 侧树外插件：一条出站 WebSocket 连到 Coordinator，把结构化 Remote 调用转发给本机 Typert Gateway。**不监听端口、不起入站服务、不新增 shell/eval/动态模块加载。**

```text
node >= 20；开发使用 Node 22+ 与 pnpm 11.8.0（package.json.packageManager）
pnpm --config.verify-deps-before-run=false typecheck
pnpm --config.verify-deps-before-run=false build
pnpm --config.verify-deps-before-run=false test
pnpm pack --pack-destination dist
node tools/checksums.mjs dist
node tools/verify-package.mjs dist --sums dist/SHA256SUMS
```

注意：

- `typecheck` 绿不代表 `build` 绿：`build` 还会跑 `tsc -p tsconfig.build.json`，只编译 `src/**`，是发布类型边界。
- `client-bundle.test.ts` 读取构建产物 `lib/client.js`，所以**干净 checkout 必须先 build 再 test**；CI 顺序也是如此。
- `--config.verify-deps-before-run=false` 在这台机器上是必需的：pnpm 的依赖状态检查会再起一个 `pnpm install`，在非交互/受限沙箱里会中止。也可直接调 `node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit` 与 `node node_modules/vitest/vitest.mjs run`。
- 测试是 Vitest；`test/integration.test.ts` 会起真实 Cordis、真实 Typert Gateway、本地假 Coordinator，并绑定回环 WebSocket。不要把它改成纯 mock。
- 构建是 tsdown：宿主 ESM（`lib/index.js`）+ 客户端 classic-script bundle（`lib/client.js`）。`clean: false` 是刻意的：DSH Desktop 可能持有 `lib/*.js`，Windows 上删除目录会 EPERM。

## 版本与构建元数据

- `package.json.version` 是唯一版本源。不要新增第二个手写版本常量，不要把 `PLUGIN_VERSION` 改回字面量。
- `src/build-info.ts` 的 `BUILD_INFO` / `PLUGIN_VERSION` 来自构建时嵌入的常量；**不要**改成运行时读取 `build-info.json`。运行时读盘会让旧进程在新文件被替换后谎报版本。
- `tools/build-info.mjs` 生成 `build-info.json` 并校验发布条件：合法语义版本、Tag 精确等于 `v<version>`、commit 存在、工作区干净（含未跟踪文件）。非发布构建一律 `channel=dev`；无 Git 时 commit/dirty 为 `null`。
- `build-info.json`、`lib/`、`dist/`、`*.tgz` 已忽略，不要提交。
- 本地状态路由 `/dsh-node/api/status` 的 `pluginVersion` 保留兼容，`buildInfo` 描述实际运行的构建；不要新增 WS 版本上报或 Coordinator 版本管理。

## 发布规则

- 发布只由 `v*` Tag 触发（`.github/workflows/release.yml`）；普通 push 只跑 CI。
- 发布前必须跑完 typecheck、test、build、pack、checksums、verify-package，不能只凭 typecheck。
- `pnpm pack` 会触发 `prepack` 的 `build-info --check`；缺失或版本漂移会失败。
- 已发布的 Tag/Release 不移动、不覆盖、不删除；修问题发新版本。
- 同一 Tag 只允许对相同 commit 的**草稿**重试；已发布则拒绝。`tools/release-policy.mjs` 负责这些判断，有单测。
- 正式版 `channel=stable` 可标记 latest；预发布 `channel=preview` 永不标记 latest；旧正式版补发不得抢走最新版的 latest。
- 不发布 npm 包（`private: true`）；Release 附件是 `dsh-node-X.Y.Z.tgz` + `SHA256SUMS`。
- 工作流文件、Release 行为若未实际运行，报告时标为「未验证」，不要用本地冒烟代替 GitHub 结果。

## 安装与数据安全

- 远程安装只看 [`docs/install-version.md`](docs/install-version.md)；不要编造 CLI 参数。当前 CLI：`dsh plugin --profile <name> add|remove|list ...`，参数转发给 profile 目录的 pnpm。
- 当前 `desktop` profile 可能是 `link:<本仓库>` 源码模式；切换到 tgz 只改 profile 依赖，**不删除、不覆盖源码目录**，不使用 `git clean`。
- 不删除、不移动 `<DSH_HOME>/storages/dsh-node/`（`config.json` 含 Token、`identity.json` 含 nodeId、`usage.sqlite`）和 `<DSH_HOME>/dsh-node/files/`（会话附件与产物快照）。升级只换包，不换身份，不清会话/附件/统计。
- 不删除正在使用的 `lib/`；构建原地覆盖。
- 重启 DSH 会中断正在执行的会话；没有授权时只报告需要重启，不自行重启用户真实 profile。
- 查询状态路由时端口按宿主实际配置确定，不硬编码；不使用未认证请求绕过鉴权，不关闭信任围栏。

## 代码与安全约束

- 宿主半侧（`src/**` 除 `src/client/**`）不碰 DOM；有测试守卫。
- 无入站监听、无 `child_process`、`eval`、`new Function`、裸 `require(`、动态 `import()`；有架构守卫逐文件扫描，绕过会被测试拦下。
- `ws`、`schemastery` 保持外置运行依赖，不打包进宿主 bundle；客户端 bundle 保持 `window.__ModuleLoader__.load({...})` 形式。
- 只有 `src/index.ts` 能注册前缀路由，且只有一个 `/dsh-node` 前缀；写路由仅限配置/连接控制，全部经过信任围栏。
- 不返回 Token、用户目录或环境秘密；状态快照在源头脱敏。

## Git 与改动纪律

- 改动前先看 `git status --short`、`git diff`、`git diff --cached`，保留他人未提交改动。
- 不使用 `git add .`；只暂存本任务相关文件。没有要求提交时不创建提交。
- 不使用 `--force`、`--force-with-lease`（除非用户明确要求且已核对远端）、`--tags`、`--mirror`。
- 修改现有文件前先读；优先复用已有模块，不做无关重构。
- 文档改相对路径后，从仓库根实际点开/解析一遍；不要让未来 Agent 读到 dsh-master 的旧路径。
- 完成后报告实际改动、运行的检查与结果、未验证项。

## 已知环境事实（2026-11-06）

- DSH Desktop 运行的是 `0.2.1-rc.2`；`desktop` profile 当前以 link 方式加载本仓库。
- 本机 Node `24.11.1`、pnpm `11.8.0`；`package.json.engines.node` 仍为 `>= 20`。
- `dsh --profile desktop --dump-config` 可以看到自动注入的 `dsh-node` 条目；`dsh.profile.bundles` 列出包名即可，不一定要手工 insert。
- 本机对 `/dsh-node/api/status` 的未认证 `curl` 返回 403（DSH Web 鉴权/信任围栏），同源浏览器请求路径见安装文档。
