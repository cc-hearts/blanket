# blanket

[English](README.md) · 中文

<svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide data-component="icon" style="font-size: 24px;"><path d="M15 6v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3V6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3"></path></svg>

个人命令库 / 脚本仓库，用 [bun](https://bun.sh) 跑脚本、用 [mise](https://mise.jdx.dev) 管工具版本。
运行脚本零依赖；`bun install` 只为类型检查装 `typescript` + `@types/bun`（见下文）。

两个脚本：

| 命令 | 干什么 |
| --- | --- |
| `bun run agents` | 按原安装渠道检测 + 升级 agent（mise / npm / bun / pnpm / Homebrew / 原生） |
| `bun run perm` | TUI：一次性开关各 agent 的「完全访问权限 / 信任所有项目」 |

## 目录

```
├── package.json              bun 脚本入口
├── scripts/
│   ├── permissions.ts        权限开关主脚本（TUI + 非交互 CLI）—— 唯一保留在 scripts/ 的脚本
│   └── perm/                 权限开关实现
│       ├── types.ts          公共词汇（开关、计划、结果）
│       ├── files.ts          原子写 + 备份 + YAML/JSON 最小文本手术
│       ├── diff.ts           真·行级 diff（供预览用，带上下文折叠）
│       ├── engine.ts         编排：计划 → 落盘
│       ├── tui.ts            交互界面
│       ├── registry.ts       适配器注册表
│       └── <agent>.ts        每个 agent 一个适配器
├── pkg/                      通用工具模块（非脚本，被 scripts/ 引用）
│   ├── agents.ts             agent 注册表（要维护谁，改这里）
│   ├── mise.ts               mise CLI 封装（跑命令、解析 JSON）
│   ├── versions.ts           版本号解析与比较
│   ├── ui.ts                 颜色 / 等宽表格
│   ├── update-agents.ts      agent 升级脚本（bun run agents）
│   └── channels/             渠道探测与升级实现
│       ├── detect.ts         PATH 路径 → 安装渠道
│       ├── facts.ts          渠道事实采集、版本探测
│       ├── inspect.ts        单个 agent 的检查编排
│       ├── plan.ts           升级决策与命令构造
│       ├── execute.ts        执行升级并复核版本
│       ├── latest.ts         npm registry / brew 最新版查询
│       └── run.ts            命令执行
├── tests/
│   └── *.test.ts             单元测试（bun test）
└── tsconfig.json             编辑器与类型检查用
```

## 用法

### 权限开关（`bun run perm`）

解决的是「每个项目都要点一次同意，太浪费时间」。默认进 TUI：

```bash
bun run perm                 # TUI：↑/↓ 移动 · space 切换 · a 应用 · r 重读 · q 退出
```

非交互用法（脚本 / CI）：

```bash
bun run perm -- --check                    # 只读；有未开启项退出码 3
bun run perm -- --json                     # JSON 输出
bun run perm -- --on --yes                 # 全部打开
bun run perm -- --on --dry-run             # 只打印将写入的内容
bun run perm -- --on --yes --switch full-access --only claude,codex
bun run perm -- --off --yes                # 关闭（只回退本工具写进去的值）
```

`--switch` 取值：`full-access`（完全访问权限）、`trust-all`（信任所有项目）。
`--only` 支持 agent 名或 id，可用 `dsh` / `claude` / `codex` / `opencode` / `pi` / `omp`。

安全设计：

- **两段式交互**：`space` 只是放进待办，`a` 才弹预览（带真实 diff）确认，不留一键直写。
- **预览是真 diff，不是按行对齐**：插入一行不会把后面所有行报成「改了」。
  远处未改动的行会折叠成 `… 省略 N 行未改动 …`，所以两千行的 `.claude.json` 也只看得到真正改的几行。
- **确认提示永远可见**：底部提示钉在屏幕底部、不参与裁剪，内容长了用 `↑/↓` 滚动。
- **写入前备份**到 `~/.blanket/backups/<时间戳>/`，写入是原子的（临时文件 + rename）。
- **最小文本手术**：只改目标那一行，保留注释、锚点、键顺序；改不懂的文件宁可报错也不覆盖。
- **幂等**：已经是目标状态时不写、不备份。
- **关闭只回退自己写的值**：不会覆盖你手动设的其它值（例如你自己设的 `read-only` 预设）。
- 实测「开 → 关」能把所有文件**字节级还原**（`omp` 除外，见下）。

#### 各 agent 的实际机制

| agent | 完全访问权限 | 信任所有项目 |
| --- | --- | --- |
| DeepSeek Harness | `~/.dsh/settings.yaml` 的 `permission.defaultPreset: danger-full-access`，**新会话**默认完全访问 | 不适用：DSH 权限按会话钉住，没有逐项目授权 |
| Claude Code | `~/.claude/settings.json` 的 `permissions.defaultMode: bypassPermissions` **+** `~/.claude.json` 的 `bypassPermissionsModeAccepted: true` | `~/.claude.json` 的 `projects.<当前目录>.hasTrustDialogAccepted: true`（没有全局开关，只能按目录） |
| Codex | `~/.codex/config.toml` 的 `approval_policy: "never"` + `sandbox_mode: "danger-full-access"` | `[projects."<当前目录>"]` 的 `trust_level = "trusted"`（没有全局开关） |
| OpenCode | `~/.config/opencode/opencode.json` 的顶层 `permission: "allow"` | 不适用：没有项目信任这一层 |
| pi | 不适用：pi 本来就不在每次工具调用前问审批 | `~/.pi/agent/settings.json` 的 `defaultProjectTrust: "always"`（真·全局） |
| omp | `~/.omp/agent/config.yml` 的 `tools.approvalMode: yolo` | 不适用：omp 没有项目信任门 |

不支持的开关在 TUI 里显示 `– 不支持`，并说明原因，而不是编一个键写进去。

几个容易踩的坑（都是实测确认过的）：

- **Claude Code 需要两个文件。** 只写 `settings.json` 的 `defaultMode` 可能被降级回 `default`：
  二进制里 bypass 的门控建在 `.claude.json` 的 `bypassPermissionsModeAccepted` 上，
  并有诊断文案说「consent was accepted but user settings do not show it … so bypass is not passed on」。
- **网上说 OpenCode 用 `session.permissions: "autoaccept"` 是错的。** 实测该键被 schema 直接丢弃；
  正确的是顶层 `permission: "allow"`（`opencode debug config` 会回显成通配 allow）。
- **网上说 Codex 的 `never` + `danger-full-access` 会被 requirements 拒绝，本机不成立。**
  那条限制只在存在托管 `requirements.toml` 时生效；本机没有该文件，
  在干净 `CODEX_HOME` 里实测 `codex doctor` 报 `config loaded`。
- **omp 的默认本来就是 `yolo`。** 所以「关闭」是显式降档到 `write` 而不是删键 ——
  删键等于没关。这也是唯一一个「开→关」不是字节还原的 agent。
- **omp 用严格 schema，未知键会报错而不是忽略**；并且它自己回写 config.yml 时会丢注释，
  所以改它最好在 omp 没跑的时候。

### 升级 agent（`bun run agents`）

扫描注册表里的 agent，识别它实际由哪个渠道安装，再用**同一个渠道**检查并升级：

```bash
bun run agents              # 按原渠道升级所有 agent
bun run agents:check         # 只读检查，有可升级项退出码 3（适合 cron / CI）
bun run agents:dry           # 只报告，不做任何改动
bun run agents:json          # 只读 JSON 输出（--json --dry-run）
bun run agents:mise          # 顺便 mise self-update
```

参数透传（只升某几个 / 覆盖默认行为）：

```bash
bun run agents -- codex omp
bun run agents -- claude --dry-run
bun run agents -- --age 24h --no-bump
```

也可以直接执行：`./pkg/update-agents.ts`。

类型检查与测试（可选，装一次开发依赖即可）：

```bash
bun install      # 只装 typescript + @types/bun
bun run typecheck
bun test         # 权限开关 + 渠道探测/版本比较的单元测试
```

### 渠道判定：各回各家

对每个 agent，按 PATH 顺序找到实际生效的那份安装，并识别渠道：

| 渠道 | 识别依据 | 升级命令 |
| --- | --- | --- |
| mise | mise install 路径 / shim / 选中 tool 的 `install_path` | `mise upgrade <tool> [--bump]` |
| mise 命名标签 | `requested_version` 是 `next` 这类标签 | `mise install <tool>@<tag> --force`，保留标签 |
| npm | 路径在 `npm root -g` 下 | `npm install -g <pkg>@latest` |
| bun | 路径在 bun 全局 `node_modules` 下 | `bun add -g <pkg>@latest` |
| pnpm | 路径在 `pnpm root -g` 下 | `pnpm add -g <pkg>@latest` |
| Homebrew | 路径在 brew prefix 下 | `brew upgrade <formula>` / `brew upgrade --cask <name>` |
| native | 已知原生目录里的真实二进制（Mach-O / ELF），且 agent 有自带更新命令 | `claude install latest` / `codex update` / `opencode upgrade` / `pi update self` / `omp update` |
| unknown | 识别不了 | 只报告，绝不写入 |

安全规则：

- **只升级 PATH 上实际生效的那一份**；同一 agent 的其它安装只在报告里列出（shadowed），不碰。
- **绝不跨渠道操作**：mise 装的不会跑 npm，brew 装的不会跑 mise。
- **识别不了就停**：脚本 wrapper、未知 shim、拿不到最新版、渠道工具缺失，全部只报告。
- **不降级**：只有最新版高于当前版本才升级；本地版本更高时标为 `up-to-date (ahead)`。
- **不切换发布通道**：`next` 这类标签用 `mise install --force` 原地刷新，不会改写成具体版本。
- mise 已安装但没出现在任何 mise 配置里（inactive）：跳过并提示 `mise use -g` 接管。
- 完全没装的 agent 显示 `not installed`，不影响退出码。

## 选项

### `bun run perm`

| 选项 | 说明 |
| --- | --- |
| `--on` / `--off` | 非交互打开 / 关闭（不给则进 TUI） |
| `--switch a,b` | 只处理指定开关：`full-access`、`trust-all`（默认全部） |
| `--only a,b` | 只处理指定 agent（名字或 id，支持模糊匹配） |
| `-y, --yes` | 非交互模式下跳过确认 |
| `-n, --dry-run` | 只打印将要写入的内容，不落盘 |
| `-c, --check` | 只读检查；有未开启项时退出码 3 |
| `-j, --json` | JSON 输出 |
| `-h, --help` | 帮助 |

退出码：`0` 正常 · `1` 出错 · `3` `--check` 且有未开启项。

### `bun run agents`

| 选项 | 说明 |
| --- | --- |
| `-n, --dry-run` | 只报告，不改任何东西 |
| `-c, --check` | 只读检查；有可升级项时退出码 3 |
| `-j, --json` | JSON 输出，字段含 `agent / channel / identity / path / current / target / status / command / note / shadowed` |
| `--bump` / `--no-bump` | 仅 mise：是否允许把配置里的钉版本改写成新版（默认 bump） |
| `--age <时长>` | 仅 mise：`minimum-release-age`，默认 `0` 立刻采用最新版；`24h`、`7d` 等 |
| `--mise` | 顺便 `mise self-update -y` |
| `--cd <目录>` | mise 执行目录，默认 `~`（只看全局配置，不受仓库本地 mise.toml 影响） |
| `--only a,b` | 只处理指定 agent |
| `--lenient` | 有无法自动处理的 agent 时也返回 0 |

退出码：`0` 全部成功/无需处理 · `1` 升级失败 · `2` 有 agent 无法自动处理（渠道未知 / mise inactive / 渠道工具不可用 / 最新版未知） · `3` `--check` 且有可升级项。

注意：`--json` 本身不改变“是否执行升级”；只读 JSON 请用 `bun run agents:json` 或 `bun run agents -- --json --dry-run`。

## 当前注册的 agent

| agent | 二进制 | mise tool | npm 包 | 原生更新命令 |
| --- | --- | --- | --- | --- |
| Claude Code | `claude` | `npm:@anthropic-ai/claude-code` | `@anthropic-ai/claude-code` | `claude install latest` |
| Codex | `codex` | `npm:@openai/codex` | `@openai/codex` | `codex update` |
| OpenCode | `opencode` | `npm:@opencode/cli` | `@opencode/cli` | `opencode upgrade` |
| pi | `pi` | `npm:@earendil-works/pi-coding-agent` | `@earendil-works/pi-coding-agent` | `pi update self` |
| omp | `omp` | `github:can1357/oh-my-pi`（别名 `npm:@oh-my-pi/pi-coding-agent`） | `@oh-my-pi/pi-coding-agent` | `omp update` |
| DeepSeek Harness | `dsh` | `npm:@deepseek-ai/dsh` | `@deepseek-ai/dsh` | — |

新增一个只需要在 `pkg/agents.ts` 的 `AGENTS` 里加一行，检测、升级、报表自动覆盖。
Homebrew formula 由 `brew which-formula` 动态反查；cask 名在注册表的 `brewCask` 字段。
原生安装只在 `nativeDirs` 里的真实二进制上才会识别，脚本 wrapper 一律按 unknown 处理。

权限开关另有一套注册表：`scripts/perm/registry.ts`。新增 agent 的权限适配器 =
在 `scripts/perm/` 加一个文件（导出 `AgentTarget`），再在 registry 里加一行。
适配器只负责「读现状 + 算出要写什么」，落盘、备份、原子写由 `engine.ts` 统一处理，
所以 `--dry-run` 是免费的，适配器也容易单测（见 `tests/permissions.test.ts`）。

## 几个可能踩坑的点

- **`--bump` 会改写 `~/.config/mise/config.toml`。** mise 的 `upgrade` 只能在配置的 version 区间内升级；像
  `"npm:@openai/codex" = "0.153.2"` 这种钉死版本，必须 `--bump` 才会升到最新并把配置里的版本号一起改掉
  （dry-run 会提前告诉你将改写哪个文件）。想保留钉版本语义就传 `--no-bump`，或者把配置改成 `latest`。
- **`--age` 默认 0。** mise 默认有 24h 的发布冷静期（`minimum_release_age`），刚发布的新版本会被推迟；
  这与 claude-code / opencode 在配置里显式写的 `minimum_release_age = "0"` 一致。想沿用冷静期传 `--age 24h`。
  注意 `mise outdated` 不接受 `--minimum-release-age`，会漏报最新版，所以脚本用 `upgrade --dry-run` 作为唯一口径。
- **旧版本 24 小时后才清理**，期间 `mise ls` 会看到两条并标注 `(pruned in 24h)`，属正常现象。
- **升级后当前 shell 可能还在跑旧版本。** mise 激活的 PATH 指向具体版本目录，升级不会改写已打开
  shell 的 PATH；脚本会提示「重开 shell 或重新激活 mise 后生效」。`mise x -- codex` 或新开
  shell 即可用新版。
- **命名标签不会被改写成具体版本。** dsh 的 mise 配置是 `next` 标签，升级走
  `mise install npm:@deepseek-ai/dsh@next --force`，配置里的 `next` 保持不变；
  `mise upgrade --bump` 会把标签改成具体版本，等于悄悄切换发布通道，所以脚本不用它。
- **PATH 上的 wrapper 分两种。** 如果 wrapper 是软链，`realpath` 会落到真实安装目录，按真实渠道处理；
  如果是脚本（例如某些工具自带的 shim），识别不了就标 `unknown` 并跳过，绝不猜测升级方式。
- **原生安装只在明确目录里识别。** 必须是 `nativeDirs`（默认 `~/.local/bin` 等）里的
  Mach-O / ELF 真实二进制；手动放进 `~/.local/bin` 的脚本不会被当成原生安装。
- **mise 现在是可选的。** 机器上没有 mise 时，npm / brew / 原生安装的 agent 仍会正常检查和升级。
- 脚本在 `~` 下执行 mise，只看全局配置。要针对某个仓库的本地 `mise.toml` 用 `--cd <目录>`。
