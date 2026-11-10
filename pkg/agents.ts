/**
 * Agent 注册表 —— 本工具要扫描 / 维护的 agent 清单。
 *
 * 新增一个 agent 只需要在这里加一行：渠道探测、版本检查、升级命令
 * 都会按下面的字段自动覆盖。
 */

import { homedir } from "node:os";
import { join } from "node:path";

const HOME = homedir();
const LOCAL_BIN = join(HOME, ".local", "bin");

export interface AgentSpec {
  /** 展示名，例如 "Claude Code" */
  readonly name: string;
  /** 可执行文件名，用于在 PATH 上定位安装 */
  readonly bin: string;
  /**
   * mise tool spec 候选，按优先级排列。
   * 同一个 agent 可能被不同来源接管（例如 omp 既有 GitHub 源也有 npm 包），
   * 探测时取第一个出现在 mise 记录里的。
   */
  readonly miseTools: readonly string[];
  /** npm 包名；npm / bun / pnpm 渠道与最新版参考都用它 */
  readonly npmPackage: string | null;
  /** Homebrew cask 名；formula 由 `brew which-formula` 动态反查，无需配置 */
  readonly brewCask: string | null;
  /** agent 自带更新命令（原生安装器渠道）；null 表示没有原生更新能力 */
  readonly nativeUpdate: readonly string[] | null;
  /**
   * 允许识别为原生安装的目录（绝对路径前缀）。
   * 只有落在这里、且是真实二进制（不是脚本 wrapper）时才判 native；
   * 其余识别不了的一律 unknown，避免把别人的 shim 当原生安装升级。
   */
  readonly nativeDirs: readonly string[];
}

export const AGENTS: readonly AgentSpec[] = [
  {
    name: "Claude Code",
    bin: "claude",
    miseTools: ["npm:@anthropic-ai/claude-code"],
    npmPackage: "@anthropic-ai/claude-code",
    brewCask: "claude-code",
    nativeUpdate: ["claude", "install", "latest"],
    nativeDirs: [LOCAL_BIN],
  },
  {
    name: "Codex",
    bin: "codex",
    miseTools: ["npm:@openai/codex"],
    npmPackage: "@openai/codex",
    brewCask: null,
    nativeUpdate: ["codex", "update"],
    nativeDirs: [LOCAL_BIN],
  },
  {
    name: "OpenCode",
    bin: "opencode",
    miseTools: ["npm:@opencode/cli"],
    npmPackage: "@opencode/cli",
    brewCask: null,
    nativeUpdate: ["opencode", "upgrade"],
    nativeDirs: [LOCAL_BIN, join(HOME, ".opencode", "bin")],
  },
  {
    name: "pi",
    bin: "pi",
    miseTools: ["npm:@earendil-works/pi-coding-agent"],
    npmPackage: "@earendil-works/pi-coding-agent",
    brewCask: null,
    nativeUpdate: ["pi", "update", "self"],
    nativeDirs: [LOCAL_BIN],
  },
  {
    name: "omp",
    bin: "omp",
    // 本机实际由 GitHub 源管理；npm 包作为别名保留，避免换机器后漏报
    miseTools: ["github:can1357/oh-my-pi", "npm:@oh-my-pi/pi-coding-agent"],
    npmPackage: "@oh-my-pi/pi-coding-agent",
    brewCask: null,
    nativeUpdate: ["omp", "update"],
    nativeDirs: [LOCAL_BIN],
  },
  {
    name: "DeepSeek Harness",
    bin: "dsh",
    miseTools: ["npm:@deepseek-ai/dsh"],
    npmPackage: "@deepseek-ai/dsh",
    brewCask: null,
    nativeUpdate: null,
    nativeDirs: [],
  },
] as const;

/** 把 tool spec 拆成可用于匹配的片段：npm:@openai/codex → ["npm:@openai/codex", "@openai/codex", "@openai", "codex"] */
function searchKeys(agent: AgentSpec): string[] {
  const keys: string[] = [agent.name, agent.bin];
  for (const tool of agent.miseTools) {
    const stripped = tool.replace(/^(npm|github):/, "");
    keys.push(tool, stripped, ...stripped.split("/"));
  }
  if (agent.npmPackage) {
    keys.push(agent.npmPackage, ...agent.npmPackage.split("/"));
  }
  return keys;
}

/** 支持 `claude`、`codex`、`@openai/codex`、`npm:@opencode/cli`、`oh-my-pi` 等写法 */
export function matchAgent(query: string): AgentSpec | undefined {
  const q = query.trim().toLowerCase();
  if (q.length === 0) return undefined;
  const exact = AGENTS.find((a) => searchKeys(a).some((k) => k.toLowerCase() === q));
  if (exact) return exact;
  if (q.length < 3) return undefined;
  return AGENTS.find((a) => searchKeys(a).some((k) => k.toLowerCase().includes(q)));
}
