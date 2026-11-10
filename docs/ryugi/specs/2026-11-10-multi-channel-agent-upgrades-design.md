# 多安装渠道的 agent 扫描与升级

日期：2026-11-10
状态：已实现

## 意图（为什么）

`bun run agents` 现在只会升级 **mise 管理** 的 agent； PATH 上由 npm / bun / pnpm / Homebrew / 原生安装器装的 agent 一律跳过，只给一条「用 mise 接管」的提示。

本机目前恰好所有 agent 都由 mise 管理，但这不是长期保证。目标是：

1. 扫描机器上已注册的 agent，**不管它由哪个渠道安装**；
2. 判断每个 agent 是否有新版本；
3. 按**它原本的安装渠道**升级 —— mise 装的用 mise，npm 装的用 npm，brew 装的用 brew，原生安装器装的用 agent 自带更新命令；
4. **绝不**为了升级而迁移、卸载、覆盖另一种渠道的安装。

一句话：把「只认 mise」的升级器，改成「识别渠道、各回各家」的升级器。

## 已确认的决策（来自对话）

| 决策 | 选择 |
| --- | --- |
| 扫描范围 | 注册表驱动；不自动发现未登记 agent；把已安装的 `dsh` 加入注册表 |
| 支持渠道 | mise、npm / bun / pnpm 全局包、Homebrew、agent 自带更新命令 |
| 多份安装共存 | 只升级 PATH 上实际生效的那一份；其余只在报告里列出，不碰 |
| 交互方式 | 保持现有 CLI（`--check` / `--json` / `--dry-run`），不新增 TUI |

## 目标 / 非目标 / 反目标

**目标**

- 每个注册 agent 报告：生效渠道、安装路径、当前版本、可升级版本、将执行的升级命令。
- 按渠道执行正确的升级命令；升级后重新探测版本并如实报告。
- `--check` 适合 cron / CI：只读，有可升级项退出码 3。
- 渠道无法识别时安全失败：只报告，不执行任何写入。

**非目标**

- 自动发现未注册的 agent（注册表仍是唯一清单）。
- 在渠道之间迁移（例如把 npm 安装改成 mise 安装）。
- 降级、切换 canary / stable 通道、处理 GUI app bundle。
- 支持私有 npm registry、代理配置、Windows。
- 给 npm / brew 渠道实现「发布冷静期」（`--age` 仅对 mise 生效）。

**反目标（即使功能“能跑”也算失败）**

- 用 A 渠道的命令去升级 B 渠道的安装（例如对 brew 装的 codex 跑 `npm i -g`）。
- 删除、移动、重装任何现有安装。
- 在渠道不确定时“猜一个”并写入。
- 对已是最新或比 registry 更新的版本执行降级式“升级”。

## 现状（已读代码）

- `pkg/agents.ts`：5 个 agent 的静态注册表（claude / codex / opencode / pi / omp）。
- `pkg/mise.ts`：mise CLI 封装；`listActive` / `listInstalled` / `upgrade --bump --dry-run` 解析。
- `pkg/update-agents.ts`：只把出现在 `mise ls -J -c` 里的 agent 视为可升级；其余归入 `unmanaged` 并给 `mise use -g` 接管提示。
- `pkg/ui.ts`：表格 / 颜色工具。
- 现有退出码：0 成功、1 失败、2 有未由 mise 管理的 agent、3 `--check` 且有可升级项。
- 权限开关是另一套注册表 `scripts/perm/registry.ts`，其中已有 `dsh`；本设计只扩展 `pkg/agents.ts`，不动权限模块。

## 本机已核实的事实（设计依据）

- 所有 agent 的 PATH 第一命中都在 `~/.local/share/mise/installs/...`；第二命中是 `~/.local/share/mise/shims/<bin>`，而 shim 是指向 `~/.local/bin/mise` 的软链。
- `npm root -g` 位于 mise 的 node 安装目录内：
  `/Users/carl/.local/share/mise/installs/node/24.22.0/lib/node_modules`。
  **因此渠道判定必须先查 npm global root，再查 mise 安装目录**，否则 npm 全局安装会被误判成 mise 管理。
- `pnpm root -g` = `~/Library/pnpm/global/v11`，`pnpm bin -g` = `~/Library/pnpm/bin`。
- bun 全局根目录约定为 `~/.bun/install/global/node_modules`（本机当前没有全局包；`bun pm ls -g` 在无 lockfile 时报错，不能依赖它）。
- `brew which-formula <command>` 可用，用于从二进制反查 formula；cask 不在其覆盖范围内。
- `brew outdated --json=v2` 一次返回所有可升级 formula / cask 的 `installed_versions` 与 `current_version`。
- 各 agent 的自带更新命令（本机 `--help` 实查）：
  - `claude install latest`（原生安装器；无交互确认）
  - `codex update`
  - `opencode upgrade`（自带 `--method` 自动识别，但我们只在 native 渠道调用）
  - `pi update self`
  - `omp update`（另有 `omp update --check`）
  - `dsh` 没有更新子命令
- npm registry 查询可用：`https://registry.npmjs.org/@scope%2Fname/latest` 返回 JSON（本机 curl 验证）。
- 各 agent `--version` 输出格式：`2.1.303 (Claude Code)`、`codex-cli 0.163.0`、`opencode v2.0.32`、`1.4.0`、`omp/18.12.3`、`0.2.1-rc.2`。
- **注册表与实机不一致**：`omp` 的 mise 配置是 `github:can1357/oh-my-pi`，但 `pkg/agents.ts` 写的是 `npm:@oh-my-pi/pi-coding-agent`；按现状脚本会漏掉 omp。设计必须修正并支持同一 agent 的多个 mise tool 别名。
- `dsh` 由 mise 管理：`npm:@deepseek-ai/dsh`，配置钉的是 `next` 标签。

## 设计

### 1. 渠道模型

```ts
type ChannelId = "mise" | "npm" | "bun" | "pnpm" | "brew" | "native" | "unknown";

interface Installation {
  channel: ChannelId;
  /** PATH 上的原始路径（不解析 symlink），用于展示 */
  path: string;
  /** 渠道内身份：mise tool spec / npm 包名 / brew formula 或 cask 名 / 原生更新命令 */
  identity: string;
  /** 探测到的已安装版本；未知为 null */
  version: string | null;
  /** 是否是 PATH 实际生效的那一份 */
  effective: boolean;
}
```

`unknown` 不是渠道，是「识别失败」的占位：只报告，绝不升级。

### 2. 注册表扩展（`pkg/agents.ts`）

```ts
interface AgentSpec {
  name: string;
  bin: string;
  /** mise tool spec 候选，按优先级排列；覆盖同一 agent 的不同安装来源 */
  miseTools: string[];
  /** npm 包名；npm/bun/pnpm 渠道与最新版参考都用它 */
  npmPackage: string | null;
  /** Homebrew cask 名（formula 由 brew which-formula 动态反查，无需配置） */
  brewCask: string | null;
  /** agent 自带更新命令；null = 没有原生更新能力 */
  nativeUpdate: string[] | null;
  /**
   * 允许识别为原生安装的目录（绝对路径前缀）。
   * 只有落在这里、且是真实二进制（不是脚本 wrapper）时才判 native；
   * 其余识别不了的一律 unknown，避免把别人的 shim 当原生安装升级。
   */
  nativeDirs: string[];
}
```

原生目录的默认值：所有提供 `nativeUpdate` 的 agent 都包含 `~/.local/bin`；
OpenCode 额外包含 `~/.opencode/bin`。`~/.claude/local` 是 Claude 的另一种本地安装方式，
用 `claude install latest` 会另装一份，属于跨安装方式，因此不列入原生目录（判 unknown）。

注册表内容：

| agent | bin | miseTools | npmPackage | brewCask | nativeUpdate |
| --- | --- | --- | --- | --- | --- |
| Claude Code | claude | `npm:@anthropic-ai/claude-code` | `@anthropic-ai/claude-code` | `claude-code`（实施时核实） | `["claude","install","latest"]` |
| Codex | codex | `npm:@openai/codex` | `@openai/codex` | 待核实 | `["codex","update"]` |
| OpenCode | opencode | `npm:@opencode/cli` | `@opencode/cli` | 待核实 | `["opencode","upgrade"]` |
| pi | pi | `npm:@earendil-works/pi-coding-agent` | 同左 | 无 | `["pi","update","self"]` |
| omp | omp | `github:can1357/oh-my-pi`, `npm:@oh-my-pi/pi-coding-agent` | `@oh-my-pi/pi-coding-agent` | 无 | `["omp","update"]` |
| DeepSeek Harness | dsh | `npm:@deepseek-ai/dsh` | `@deepseek-ai/dsh` | 无 | null |

`matchAgent` 的搜索键相应扩展到 `miseTools` + `npmPackage`。

### 3. 探测算法

**3.1 枚举 PATH 候选**

实现 `whichAll(bin): string[]`：按 `process.env.PATH` 顺序逐目录拼接，存在且可执行即收录，按绝对路径去重。第一项 = 生效安装。

**3.2 预先采集一次渠道事实（缓存）**

- `mise ls -J -c` 与 `mise ls -J --installed`
- `npm root -g`（若 npm 可用）
- bun 全局根：`$BUN_INSTALL/install/global/node_modules` 或 `~/.bun/install/global/node_modules`
- `pnpm root -g` 与 `pnpm bin -g`（若 pnpm 可用）
- brew prefix：`/opt/homebrew`、`/usr/local`（Intel macOS）、`/home/linuxbrew/.linuxbrew`
- `brew outdated --json=v2`（懒加载，仅在存在 brew 安装时查询）

任何渠道 CLI 缺失只影响该渠道：该渠道的安装仍可通过路径识别，但标记为「渠道工具不可用」，跳过升级。

**3.3 路径分类（顺序敏感）**

对每个候选路径：

1. **npm 全局**：`realpath` 落在 `npm root -g` 下 → `npm`。
   —— 必须排在 mise 之前，原因见「已核实的事实」。
2. **bun 全局**：`realpath` 落在 bun 全局 `node_modules` 下 → `bun`。
3. **pnpm 全局**：`realpath` 落在 `pnpm root -g` 下 → `pnpm`。
4. **mise**：
   - 原始路径在 `<mise shim 目录>/` 下（软链指向 mise）→ `mise`；
   - 或 `realpath` 落在**该 agent 选中的 mise tool 的 `install_path`** 下 → `mise`。
   **不能**用“任何在 `mise/installs/` 下的路径”判断：npm 的全局根就住在
   `mise/installs/node/<版本>/lib/node_modules` 里，一旦 `npm root -g` 获取失败，
   宽泛匹配会把 npm 全局安装误判成 mise。拿不到 `install_path` 就判 unknown。
   identity 取选中 tool 的 spec（见 3.5）；版本取 mise 记录；仅当记录是标签
   （如 `next`）时才改用二进制 `--version`。
5. **brew**：`realpath` 落在任一 brew prefix 下 → `brew`。identity 用 `brew which-formula <bin>` 的结果；为空时用 `agent.brewCask`（若该 cask 已安装）。
6. **native**：以上都不匹配，且同时满足：
   - `agent.nativeUpdate !== null`；
   - 原始路径落在 `agent.nativeDirs` 的某个前缀下；
   - 该文件是真实二进制（Mach-O 或 ELF 魔数），**不是** shell / JS 脚本 wrapper。
   identity = 更新命令首项。任何一条不满足 → `unknown`。

补充规则：

- 同一渠道的多个候选（例如 mise 真实安装路径 + mise shim）去重为一条，保留更靠近 PATH 头部的那条路径。
- **生效安装 = PATH 顺序里的第一条候选**，哪怕它最终是 `unknown`；其余记为 `shadowed`，只展示。
  绝不跳过“识别不了的 wrapper”去升级后面那份安装。
- mise 已安装但不在任何 mise 配置里（inactive）：渠道仍是 `mise`，状态 `skipped`，提示 `mise use -g <tool>@latest` 接管，**不**改用其它渠道升级。
- 若 PATH 生效项为 mise shim，版本/identity 一律取 mise 记录，不执行 shim。

**3.4 mise tool 选择（多别名）**

同一 agent 的 `miseTools` 可能同时存在（omp 的 GitHub 源与 npm 包）。选择顺序：

1. `install_path` 覆盖生效 PATH 候选 `realpath` 的 tool（最精确）；
2. 否则取第一个出现在 active 配置里的 tool；
3. 否则取第一个出现在 installed 列表里的 tool；
4. 都没有 → 不是 mise 渠道。

版本取 `pickEntry` 的版本；只有 **active 配置里**出现多个版本时，升级命令才精确到
`tool@version`。`installed` 里 24 小时内待清理的旧版本不算，否则探测命令会被钉在
当前版本上，永远发现不了新版本（实现时实测踩到过）。

**3.5 已安装版本**

- mise：`pickEntry(active).version`（inactive 时取 `installed`）。若记录版本是命名标签
  （如 `next`，既不是 semver 也不是 `latest`），则改用 `<bin> --version` 得到具体版本，
  否则 `compareVersions("next", "0.2.2-rc.1")` 没有意义。
- 若 PATH 生效路径落在 `installed` 里的旧版本目录、但该 tool 仍在 active 配置中：
  版本取配置版本（工具本身已是最新），并附「PATH 仍指向旧版本，重开 shell 后生效」提示。
  不能因为“这个具体版本目录未激活”就把整个 tool 判成 inactive。
- npm / bun / pnpm：从 `realpath` 向上找到 `node_modules/<pkg>`，读 `package.json.version`；失败则运行 `<bin> --version` 解析。
- brew：`brew outdated --json=v2` 的 `installed_versions.at(-1)`；不在列表时用 `brew list --versions <name>`。
- native / unknown：运行 `<bin> --version`，用 `parseVersion` 提取第一个版本号。

### 4. 最新版查询

| 渠道 | 来源 | 备注 |
| --- | --- | --- |
| mise（普通版本） | `mise upgrade <spec> [--bump] --dry-run [--minimum-release-age X]` | 参数与真实执行完全一致；`--no-bump` 时探测也不带 `--bump`，此时“不可升级”就是真实结果 |
| mise（命名标签，如 `next`） | npm registry 的对应 dist-tag（如 `/<pkg>/next`） | 非 npm 后端拿不到标签 → `latest = null`，只报告不升级 |
| npm / bun / pnpm | npm registry `latest` dist-tag（Bun `fetch`） | 不依赖 npm CLI；失败则 `latest = null` |
| brew | 缓存的 `brew outdated --json=v2` | formula 与 cask 各查一次 |
| native | 若 `npmPackage` 存在用 registry `latest`；否则 `null` | 拿不到最新版就只报告、不升级 |

`parseVersion(text)`：正则 `\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?`，取第一个匹配。

`compareVersions(a, b)`：按 semver 比较主次修订号；相等时按 prerelease 规则比较；只有 `latest > installed` 才视为 `outdated`。`installed > latest` 报 `ahead`（视为最新，附注说明，绝不降级）。

### 5. 渠道适配器

统一接口（`pkg/channels/`）：

```ts
interface ChannelAdapter {
  id: ChannelId;
  /** 该渠道工具是否可用；不可用 → 只报告，不升级 */
  available(): boolean;
  /** 返回将要执行的命令，供 dry-run / JSON 展示 */
  upgradeCommand(agent: AgentSpec, install: Installation, opts: Options): string[];
  /** 执行升级 */
  upgrade(agent: AgentSpec, install: Installation, opts: Options): Promise<RunResult>;
}
```

具体命令：

| 渠道 | 升级命令 | 额外动作 |
| --- | --- | --- |
| mise（普通版本） | `mise upgrade <tool> [--bump] [--minimum-release-age X]` | 全部完成后 `mise reshim` 一次 |
| mise（命名标签） | `mise install <tool>@<tag> --force [--minimum-release-age X]` | 保留配置里的标签，不改写成具体版本；完成后 reshim |
| npm | `npm install -g <pkg>@latest` | — |
| bun | `bun add -g <pkg>@latest` | — |
| pnpm | `pnpm add -g <pkg>@latest` | — |
| brew formula | `brew upgrade <formula>` | — |
| brew cask | `brew upgrade --cask <name>` | — |
| native | `agent.nativeUpdate` 原样执行 | — |

约束：

- 只有 `effective === true` 的安装会被升级。
- `options.dryRun` 时不执行任何升级命令，只产出命令字符串。
- mise 的 `--bump` / `--age` / `--cd` 只作用于 mise 适配器；其它渠道忽略并在 `--help` 里写明。
- 升级命令一律继承当前环境，超时沿用现有 `Mise.run` 的模型（默认 10 分钟，可调）。

### 6. 编排与结果

每个 agent 产出：

```ts
type Status =
  | "updated"       // 已升级，版本变化
  | "up-to-date"    // 已是最新 / installed > latest
  | "outdated"      // dry-run / check 下发现可升级
  | "skipped"       // mise inactive、渠道未知、渠道工具不可用、最新版未知
  | "not-installed" // 注册表里有，但机器上完全找不到
  | "failed";       // 升级命令失败，或升级后版本异常
```

流程：

1. 选 agent（`--only` / 位置参数）。
2. 采集渠道事实。
3. 对每个 agent 枚举 PATH 候选、分类、选出生效安装。
4. 查最新版，算状态。
5. 非 dry-run 且 `outdated` → 执行对应渠道升级命令 → 重新探测版本 → 生成结果。
   升级后判定（`evaluateUpgradeResult`）：
   - 新版本 > 旧版本 → `updated`；若仍低于 target，附注「命令成功，但未达到目标版本 X」。
   - 新版本 = 旧版本 → `up-to-date`，附注「命令已执行，但版本未变化」；不算失败。
   - 新版本 < 旧版本 → `failed`，附注「升级后版本反而变低」，绝不静默接受。
   - 命令退出码非 0 → `failed`。
6. 若有 mise 升级发生 → `reshim`。
7. 渲染表格 / JSON，计算退出码。

### 7. 输出

表格列：`AGENT | CHANNEL | VERSION | RESULT`

```
AGENT         CHANNEL   VERSION              RESULT
Claude Code   mise      2.1.303              · up-to-date
Codex         npm       0.160.0 → 0.163.0    ↑ outdated  将执行 npm install -g @openai/codex@latest
pi            native    1.4.0                · up-to-date
```

- 表格下方列出 `shadowed` 安装（「另检测到：brew /opt/homebrew/bin/codex 0.158.0（未生效）」）。
- 再列出 skipped 原因与接管提示。
- `--json`：每个结果含 `agent / bin / channel / identity / path / current / target / status / command / note / shadowed[]`；顶层含 `summary`（按渠道计数）与 `warnings`。

退出码（保持现有语义并扩展）：

| 码 | 含义 |
| --- | --- |
| 0 | 全部成功 / 无可升级项 |
| 1 | 有升级命令失败 |
| 2 | 有 agent 无法自动处理（渠道未知 / mise inactive / 渠道工具不可用 / 最新版未知）；`--lenient` 压成 0 |

`not-installed` 只作信息展示，不影响退出码（否则换一台少装一个 agent 的机器会永远返回 2）。
如果把某个 agent 用 `--only` 显式点名却完全没装，同样返回 0，并在报告里标 `not-installed`。
| 3 | `--check` 且存在可升级项 |

优先级：1 > 2 > 3（与现状一致）。

### 8. CLI

现有选项全部保留：`--dry-run`、`--check`、`--json`、`--bump`、`--no-bump`、`--age`、`--mise`、`--cd`、`--only`、`--lenient`、`--help`。

新增：无。

帮助文本与 README 的渠道矩阵同步更新。

### 9. 文件布局

```
pkg/
├── agents.ts                 注册表（扩展字段，新增 dsh，修正 omp）
├── mise.ts                   保留；补一个 reshim 之外的复用点
├── versions.ts               新增：parseVersion / compareVersions
├── ui.ts                     保留
├── update-agents.ts          重写编排与报表
└── channels/
    ├── types.ts              Installation / ChannelAdapter / Options
    ├── facts.ts              渠道事实采集（whichAll、npm root、pnpm root、brew prefix…）
    ├── detect.ts             路径分类 + 生效/遮蔽选择
    ├── registry.ts           npm registry latest 查询（Bun fetch）
    ├── mise.ts               mise 适配器
    ├── node.ts               npm / bun / pnpm 三个适配器（共用 node_modules 探测）
    ├── brew.ts               brew 适配器
    └── native.ts             native 适配器
tests/
├── permissions.test.ts       不动
├── versions.test.ts          新增
├── detect.test.ts            新增
└── plan.test.ts              新增（状态与命令决策，纯函数，无网络）
```

## 安全保证（对应「不要破坏原有安装方式」）

1. 渠道由**安装路径**判定，不由「哪个工具已安装」推测。
2. 只对生效安装执行**该渠道自己的**命令；命令表是显式白名单。
3. `unknown` 渠道、渠道工具缺失、最新版无法确定 → 只报告，不写入。
4. 不执行任何卸载 / 迁移 / `mise use` / `brew link`。
5. 升级前要求 `latest > installed`；不降级。
6. mise inactive 安装不绕过 mise 去升，提示用户接管。
7. 所有升级命令在 dry-run 下只展示、不执行。

## 测试

- `versions.test.ts`：6 种 `--version` 格式解析；semver 比较（含 prerelease、ahead 判定）。
- `detect.test.ts`：用固定 fixtures 验证顺序敏感分类：
  - mise node 下的 npm 全局路径 → `npm`（不是 mise）
  - 只有落在选中 tool 的 `install_path` 下才算 mise；同为 `mise/installs/` 但不在其中 → `unknown`
  - mise shim → `mise` 且与真实安装路径去重
  - bun / pnpm / brew prefix → 各自渠道
  - 原生目录里的真实二进制 → `native`；原生目录里的脚本 wrapper、或目录外的路径 → `unknown`
  - PATH 第一项即使是 `unknown` 也保持 effective，后面的安装进 shadowed
- `plan.test.ts`：latest 未知 → skipped；installed > latest → up-to-date(ahead)；latest > installed → outdated + 正确命令；mise inactive → skipped + takeover 提示；命名标签用 `mise install --force`；升级后版本不变 → up-to-date 加注、变低 → failed。
- 不写网络测试；registry 查询通过注入的 fetcher 在测试中打桩。
- 验收：`bun run typecheck`、`bun test`、`bun run agents:check`（只读）通过；再手动执行一次 `bun run agents` 确认 mise 渠道行为与现状一致。

## 实施顺序

1. `versions.ts` + 测试。
2. `channels/types.ts`、`facts.ts`、`detect.ts` + 测试。
3. `registry.ts` + 测试桩。
4. 渠道适配器（mise 先复用现状，node 三兄弟，brew，native）。
5. 重写 `update-agents.ts` 的编排 / 报表 / JSON / 退出码。
6. 更新 README、帮助文本；加 dsh、修 omp。
7. 全量验证（typecheck、test、dry-run、真实升级）。

## 留给实现者的判断

- npm registry URL 的最终编码方式与失败重试（已验：`@scope%2Fname` 可用）。
- brew cask 的具体名称（claude-code / codex / opencode 等），实施时用 `brew info --cask` 核实；未核实的留空，cask 检测自动退化为 unknown。
- 各原生更新命令是否需要额外非交互参数（本机 help 未见交互确认；如遇确认再加）。
- 各渠道命令超时值。
- `package.json` version picker 的边界（monorepo 包、嵌套 node_modules）。

## 验收标准

- 本机 `bun run agents` 对 6 个 agent（含 dsh）全部识别为 mise 渠道，行为与升级结果和现状一致；omp 不再漏报。
- 人为构造一个 npm 全局安装（或单测 fixture）时，报告渠道为 npm 且 dry-run 命令为 `npm install -g <pkg>@latest`，不会调用 mise。
- 人为构造 brew 安装时，命令为 `brew upgrade ...`。
- 渠道未知时报告 `unknown`，退出码 2，且没有任何写入。
- `--check` 只读，有可升级项退出码 3。
- README 与实际行为一致。

## 验证记录（2026-11-10，本机）

- `bun run typecheck` 通过；`bun test` 144 个用例全过（含新增的 versions / detect / plan / latest / facts / inspect / execute / run）。
- 本机 `bun run agents:dry`：6 个 agent 全部识别为 mise，版本与 `mise ls` 一致；omp 不再漏报。
- 隔离 fixture 实测：
  - npm 全局安装 → `channel=npm`，命令 `npm install -g @openai/codex@latest`，mise 安装进 shadowed；
  - fake brew prefix → `channel=brew`，命令 `brew upgrade codex`；
  - 脚本 wrapper → `channel=unknown`，退出码 2，未执行二进制。
- 本机 mise 渠道真实升级验证：claude / opencode / omp / dsh 升级成功，dsh 的
  `next` 标签在 `~/.config/mise/config.toml` 中保持不变，二进制升到 `0.2.2-rc.1`。
- 修复了三个实现期发现的 bug：`/tmp` realpath 归一化；mise 旧版本残留导致的版本钉死；
  升级后 PATH 仍指向旧版本目录被误判成 mise inactive。
