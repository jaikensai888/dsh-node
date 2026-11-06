# dsh-node Git push 与版本发布流程

日期：2026-11-06。适用仓库：`https://github.com/jaikensai888/dsh-node`。

本文是**目标仓库内**的操作入口。`AGENTS.md` 遇到「git push / 发布版本」时先读本篇；只读本仓库即可执行，不依赖 dsh-master 中的草稿。

## 当前状态

- 版本号唯一来源是 `package.json.version`。源码中没有第二个手写版本常量；`src/build-info.ts` 的 `PLUGIN_VERSION` 由构建时嵌入的元数据导出。
- 构建会生成 `build-info.json`，并把同一对象嵌入宿主编译产物。字段固定为 `version`、`commit`、`builtAt`、`channel`、`dirty`。
- `.github/workflows/ci.yml` 在普通分支 / PR 上执行 typecheck、构建、测试、打包、SHA256 和实际 tgz 安装冒烟；不发布。
- `.github/workflows/release.yml` 只在推送 `v*` Tag 时执行：校验 Tag、构建、测试、打包、冒烟、创建**草稿** Release、上传并校验附件、发布。
- **本文所述的 GitHub 托管运行、Tag 推送和 Release 创建尚未在本机执行过。** 本地代码、工作流文件、打包和隔离安装冒烟是实际运行过的；线上行为首次发布时验证，不能把本地结果当成 GitHub 已通过。

## 收到用户指令时如何判断

| 用户指令 | 执行动作 |
| --- | --- |
| git push / 推送代码 | 推送目标仓库当前分支已有的提交；不默认提交工作区内容，不创建 Tag |
| 提交并推送 | 审查并提交本任务相关改动，完成验证，再推送当前分支 |
| 发布 vX.Y.Z / 构建并发布指定版本 | 按「指定版本发布」完整执行，创建版本 Tag 并跟踪 Release |
| 升级到 vX.Y.Z | 按 [`install-version.md`](install-version.md) 操作目标 profile；不创建发布版本 |

优先从当前任务、cwd、remote 和分支确认目标；只有不能可靠判断时才询问。用户说「git push」不自动授权跨仓库操作。
本流程采用**显式发布**：普通分支推送只跑 CI，版本 Tag 才发布 Release。版本号未指定时不要擅自选择（尤其不要把 `0.1.0` 直接改成 `0.2.0`）。

## 普通推送

1. 在目标仓库读取 `AGENTS.md`；检查 `git status --short`、`git diff`、`git diff --cached`、`git branch -vv`、`git remote -v`。
2. 保留用户已有改动，不使用 `git add .` 收进无关文件；没有要求提交时不自行创建提交。
3. 检查 upstream、待推送提交及其验证证据。相关代码改动没有有效验证时，运行对应检查；文档改动检查路径、内容和 diff。
4. 执行普通 `git push`；无 upstream 时确认目标后显式设置。禁止默认使用 `--force`、`--tags`、`--mirror`。
5. 若被拒绝，先检查分支分歧和远端状态，不自动重写历史或破坏本地工作。
6. 报告仓库、分支、提交和推送结果；若有 CI，则查看并报告结果，失败不能宣称全部完成。

```powershell
git status --short
git diff
git branch -vv
git remote -v
git push
gh run list --branch main --limit 5   # 有 GitHub CLI 时查看 CI
```

Git 所有权检查失败时不要修改全局安全配置；报告阻碍，按环境允许方式解决后继续，不能把失败视为检查通过。

## 指定版本发布

发布的是**已编译安装包**，不是 npm 包（`package.json` 仍是 `private: true`）。示例 `0.2.0` 只说明格式，不是已批准的首发版本。

### 1. 确认版本与前置条件

- 用户明确给出目标版本；未指定且无法推断时询问。
- 确认仓库、分支（默认 `main`）、远端、当前提交，以及该 Tag / Release 是否已存在。
- 工作区必须干净：发布构建会拒绝任何未提交或未跟踪的源码文件。`build-info.json`、`lib/`、`dist/` 已被忽略，不算脏。

```powershell
git fetch --tags
git status --short --branch
git log -1 --format='%H %s'
gh release view v0.2.0            # 预期：release not found
git ls-remote --tags origin v0.2.0
```

### 2. 只改 `package.json` 版本

```powershell
# 把 "version": "0.1.0" 改为目标版本；预发布用 0.3.0-rc.1
# 不要改 src/index.ts 或新增第二个版本常量；构建会从 package.json 生成
pnpm install --frozen-lockfile
```

版本规则：

- `package.json` 里不带 `v`；Tag 带 `v`。
- 正式版 `X.Y.Z` → `channel: "stable"`；`X.Y.Z-rc.1` / `-beta.1` / `-alpha.1` → `channel: "preview"`。
- Tag 必须精确等于 `v` + `package.json.version`，否则发布工作流在构建前失败。

### 3. 本地完整门禁（不能只跑 typecheck）

```powershell
pnpm install --frozen-lockfile
pnpm typecheck
pnpm build
pnpm test
pnpm pack --pack-destination dist
node tools/checksums.mjs dist
node tools/verify-package.mjs dist --sums dist/SHA256SUMS
node tools/build-info.mjs --check
```

`client-bundle.test.ts` 读取构建产物 `lib/client.js`，所以干净 checkout 必须 **先 build 再 test**；CI 也按这个顺序。

预期结果：

- `pnpm typecheck` 同时覆盖应用代码和 `tsconfig.build.json` 的发布类型边界。
- `pnpm test` 全绿。
- `pnpm build` 生成 `build-info.json`；本地非发布构建 `channel=dev`，这是正常的。正式发布元数据由工作流用 `DSH_NODE_RELEASE=1` 生成。
- `pnpm pack` 触发 `prepack` 的 `build-info --check`，缺失或版本漂移会直接失败。
- `tools/checksums.mjs` 写出 `dist/SHA256SUMS`；`tools/verify-package.mjs` 会把**实际 tgz** 安装到临时目录，验证生产依赖、导出、客户端 bundle、构建元数据和「替换磁盘文件不改变运行版本」。
- `build-info --check` 只校验本地生成文件与 `package.json` 一致，不会把 dev 构建当成正式发布。

如果需要在本机模拟正式发布的元数据（工作区必须已提交且干净）：

```powershell
$env:DSH_NODE_RELEASE = '1'
$env:DSH_NODE_RELEASE_TAG = 'v0.2.0'
pnpm build
pnpm pack --pack-destination dist
node tools/checksums.mjs dist
node tools/verify-package.mjs dist --sums dist/SHA256SUMS
Remove-Item Env:DSH_NODE_RELEASE, Env:DSH_NODE_RELEASE_TAG
```

这条模拟路径仍要求 Tag 名与 `package.json` 完全匹配；它不代替 GitHub 上「Tag 指向的提交」校验。

### 4. 提交并推送待发布提交

1. 审查只包含本次版本相关文件的 diff（版本号、必要的发布说明/文档）。
2. 提交并推送目标分支。
3. 等该提交的 CI 通过；CI 未通过不得打发布 Tag。

```powershell
git diff
git add package.json README.md docs/*.md   # 按实际改动列文件，不用 git add .
git commit -m "release: dsh-node v0.2.0"
git push
gh run watch
```

### 5. 创建并推送 annotated Tag

```powershell
git tag -a v0.2.0 -m "dsh-node v0.2.0"
git push origin v0.2.0        # 显式推送这一个 Tag；不要 --tags
```

Tag 必须指向已在 `main` 上验证过的提交。默认只发布 `main` 的提交；其他分支需任务明确指定。
已发布的 Tag 和 Release 不移动、不覆盖、不删除；需要修改就发新版本。

### 6. 跟踪发布工作流

`release.yml` 的顺序：

1. checkout 精确 Tag（`fetch-depth: 0`，可获得 commit 历史）。
2. 固定 Node.js `22.x`、pnpm `11.8.0`，`pnpm install --frozen-lockfile`。
3. `node tools/build-info.mjs --check-release --tag "$GITHUB_REF_NAME"`：校验语义版本、Tag 精确匹配、commit 存在、工作区干净（包含未跟踪文件）。
4. typecheck。
5. `DSH_NODE_RELEASE=1 DSH_NODE_RELEASE_TAG=<tag> pnpm build`：生成 `channel=stable|preview`、`dirty=false` 的元数据。
6. test（读取已构建的 `lib/client.js`）。
7. `pnpm pack`、`checksums`、`verify-package`（实际安装 tgz）。
8. 读取该 Tag 已有 Release、最新正式版 Tag，交给 `tools/release-policy.mjs` 决策。
9. 需要时创建草稿 Release，上传 `dsh-node-X.Y.Z.tgz` 与 `SHA256SUMS`。
10. **先校验草稿**：附件恰好两个、下载后 `sha256sum -c` 通过。
11. 发布草稿并校验 `isDraft=false`、`isPrerelease`、Tag 名；写入 Step Summary。

线上查看：

```powershell
gh run list --workflow release.yml --limit 5
gh run watch <run-id>
gh release view v0.2.0 --json isDraft,isPrerelease,tagName,url,assets
```

### 7. 发布策略（由 `tools/release-policy.mjs` 执行并有单测）

| 情况 | 决策 |
| --- | --- |
| Tag 不是合法 `v<semver>` 或与 `package.json.version` 不一致 | 失败，不构建、不发布 |
| 工作区脏 / 无 commit | 失败，不发布 |
| 普通版本 `X.Y.Z` | `channel=stable`、`prerelease=false` |
| 预发布 `X.Y.Z-rc.N` 等 | `channel=preview`、`prerelease=true`，永不标记 latest |
| 没有更早的正式 Release | 正式版标记 latest |
| 目标版本高于最新正式版 | 标记 latest |
| 目标版本低于最新正式版（补发历史版本） | 发布但不改 latest |
| 同 Tag 已有**已发布** Release | 拒绝替换；改版本号重发 |
| 同 Tag 有**草稿**且目标 commit 相同 | 允许重试：覆盖上传同一草稿的附件 |
| 同 Tag 有草稿但目标 commit 不同 | 拒绝；人工检查陈旧草稿，不自动删除 |
| 中断在上传/校验阶段 | 草稿保留；同一 commit 重跑 Tag 流程可继续 |

工作流内不会「创建 Release 再触发另一个工作流」；草稿、上传、校验、发布都在同一个 job 内完成，避免半成品公开。

### 8. 发布后验证

```powershell
$tag = 'v0.2.0'
$version = '0.2.0'
$dir = Join-Path $env:TEMP "dsh-node-$tag"
New-Item -ItemType Directory -Force $dir | Out-Null
gh release download $tag --dir $dir --pattern '*'
Get-ChildItem $dir
Push-Location $dir
$expected = ((Select-String -Path .\SHA256SUMS -Pattern "dsh-node-$version\.tgz$").Line -split '\s+')[0]
$actual = (Get-FileHash ".\dsh-node-$version.tgz" -Algorithm SHA256).Hash.ToLower()
if ($expected -ne $actual) { throw "SHA256 mismatch" }
Pop-Location
```

Linux/macOS：

```bash
gh release download v0.2.0 --dir /tmp/dsh-node-v0.2.0 --pattern '*'
(cd /tmp/dsh-node-v0.2.0 && sha256sum -c SHA256SUMS)
```

同时确认：

- Release 非草稿，Tag / 版本 / commit 与预期一致。
- 附件只有 `dsh-node-X.Y.Z.tgz` 和 `SHA256SUMS`，大小正常，可下载。
- 正式版与预发布版的 `isPrerelease` 正确；历史正式版没有把 latest 抢回去。
- 返回 Tag、commit、Actions 和 Release 链接、验证结果。**发布成功不等于任何远端节点已经升级**；升级另按 `install-version.md` 操作。

## 发布产物

| 产物 | 内容 |
| --- | --- |
| `dsh-node-X.Y.Z.tgz` | `lib/`（宿主 ESM + 客户端 bundle + 类型）、`build-info.json`、`package.json`、`cordis.patch.yml`、README、LICENSE |
| `SHA256SUMS` | 上述 tgz 的 SHA-256；只证明内容一致，不代替来源信任 |
| Release Notes | 版本、Node.js / pnpm / DSH 要求、安装文档链接、最近提交摘要 |

`ws`、`schemastery` 仍是外置运行依赖，由 profile 的生产依赖安装；不能只解压 `lib/` 就宣称安装完成。

## 失败处理

| 阶段 / 现象 | 处理 |
| --- | --- |
| Tag 与版本不一致、工作区脏、无 Git 元数据 | 修复后重新提交；删除**未发布**的错误 Tag 前先确认远端状态，不移动已发布 Tag |
| typecheck / test / build / pack / 安装冒烟失败 | 保留诊断；不发布；修复后用新提交；不要跳过失败步骤 |
| 草稿附件缺失或下载校验失败 | 草稿不公开；同一 Tag / 同一 commit 重跑；不要手工补一个未校验附件后发布 |
| 同 Tag 已发布 | 拒绝替换；发新补丁版本 |
| 草稿属于不同 commit | 不自动覆盖；人工确认陈旧草稿归属后由有权限者处理，再决定是否重发 |
| GitHub API / 权限 / 网络失败 | 明确报告未完成项与日志位置，不声称发布成功；恢复后重跑同一 Tag（同 commit） |
| Release 已公开但附件损坏 | 不回填覆盖已发布历史；发新版本并在说明中标注损坏版本 |
| 启用不可变 Release | 必须先草稿并上传齐全再公开；本工作流已按此顺序实现，但仓库设置需有权限者开启并验证 |

## 权限、版本固定与安全

- `release.yml` 仅申请 `contents: write`；`ci.yml` 仅 `contents: read`。
- 发布并发按 Tag 分组，`cancel-in-progress: false`，不会在上传中途取消。
- Actions 使用 `actions/checkout@v4`、`pnpm/action-setup@v4`、`actions/setup-node@v4`、`actions/upload-artifact@v4` 这类**版本标签**，没有用浮动 `main`，也未在本机核实并固定到具体 commit SHA。若组织要求 SHA 固定，首次发布前由维护者审计后替换并记录。
- Node.js 固定 `22.x`（当前 LTS，包含测试所需的 `node:sqlite`）；包本身仍声明 `engines.node >= 20`，没有提高运行要求。pnpm 固定 `11.8.0`，与 `package.json.packageManager` 一致。
- 工作流不读取或写入任何节点 Token；Release 附件不含配置、会话、附件或统计数据。

## 首次实际发布前仍需确认

以下项目**尚未验证**，不能凭本文件宣称已通过：

1. 仓库设置中的 Actions 权限允许 `contents: write`，且没有环境保护规则阻止 Tag 工作流。
2. `gh release view` / `gh release download` 对本仓库的**草稿** Release 行为；首次发布会实际检验。
3. Actions 版本标签对应可用的 runner，以及 GitHub 托管环境下 `tar`、`jq`、`sha256sum` 的可用性。
4. 是否启用不可变 Release；若启用，草稿 → 上传 → 校验 → 发布顺序不变。
5. 首个版本号由用户决定，本文不代选；`0.1.0` 不会自动变成 `0.2.0`。

首次发布操作清单：

```text
[ ] 用户确认版本号，例如 0.2.0
[ ] 只改 package.json.version，提交并推送
[ ] main 的 CI 通过
[ ] 本地 pnpm typecheck / test / build / pack / checksums / verify-package 通过
[ ] git tag -a v0.2.0 -m "dsh-node v0.2.0"
[ ] git push origin v0.2.0
[ ] 跟踪 release.yml，确认草稿附件校验和最终发布
[ ] 下载 Release 附件复核 SHA256SUMS
[ ] 返回 Tag、commit、Actions、Release 链接和验证结果
```

## 本次本地验证记录（2026-11-06）

实际运行过：

- `pnpm typecheck`：通过。
- `pnpm test`：26 个测试文件、632 个测试通过。
- `pnpm build`：通过，生成 `build-info.json`（本地 `channel=dev`）与 `lib/index.js` / `lib/client.js`。
- `pnpm pack --pack-destination dist`：生成 `dist/dsh-node-0.1.0.tgz`（0.1.0 仅反映当前 `package.json`，不是发布决定）。
- `node tools/checksums.mjs dist`：生成 `dist/SHA256SUMS`。
- `node tools/verify-package.mjs dist --sums dist/SHA256SUMS`：PASS；实际安装 tgz、解析 `ws`/`schemastery`、导入宿主包、校验客户端 bundle 和元数据一致性，并验证替换 `build-info.json` 后新进程仍报告嵌入版本。
- 缺少 `build-info.json` 时 `pnpm pack` 被 `prepack` 拒绝：验证了失败路径。

**未运行**：GitHub Actions、真实 `git push`、`git tag`、Release 创建/附件校验、Node 22 runner、不可变 Release 设置。首次发布时必须重新验证，不能引用本机结果替代。

## 参考

- [GitHub Release 管理](https://docs.github.com/en/repositories/releasing-projects-on-github/managing-releases-in-a-repository)
- [GitHub Actions 触发事件](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows)
- [GitHub Actions 工作流权限](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#permissions)
