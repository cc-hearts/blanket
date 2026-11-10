/**
 * 单个 agent 的检查编排：PATH 候选 → 渠道 → 身份 → 当前/最新版本 → 决策。
 *
 * 所有外部动作都通过 InspectDeps 注入，方便用纯 fixture 测试；
 * 真正的命令执行由 update-agents.ts 装配。
 */

import type { AgentSpec } from "../agents";
import { pickEntry, type MiseTool, type MiseToolMap } from "../mise";
import {
  classifyPath,
  selectInstallations,
  type ChannelId,
  type PathInstall,
  type SystemFacts,
} from "./detect";
import { normalizeRoot, pickMiseTool } from "./facts";
import type { BrewOutdatedEntry } from "./latest";
import {
  buildUpgradeCommand,
  decideUpgrade,
  isNamedMiseTag,
  type ChannelInstall,
  type CommandOptions,
  type DecisionStatus,
} from "./plan";

export type InspectStatus = DecisionStatus | "updated" | "failed" | "not-installed";

export interface AgentInspection {
  agent: AgentSpec;
  status: InspectStatus;
  channel: ChannelId | null;
  identity: string | null;
  /** mise 渠道的原始 tool spec（不含 @version），用于升级后重读 mise 记录 */
  miseTool: string | null;
  path: string | null;
  current: string | null;
  target: string | null;
  command: string[] | null;
  note: string | null;
  shadowed: PathInstall[];
  /** 生效安装的渠道信息；not-installed 时为 null */
  install: ChannelInstall | null;
}

export interface InspectDeps {
  facts: SystemFacts;
  active: MiseToolMap;
  installed: MiseToolMap;
  /** null = brew outdated 不可用，不能据此判断“已是最新” */
  brewOutdated: Map<string, BrewOutdatedEntry> | null;
  brewCasks: string[];
  channelAvailable: Partial<Record<ChannelId, boolean>>;
  readNodeVersion: (realPath: string, pkg: string) => string | null;
  probeVersion: (path: string) => Promise<string | null>;
  fetchLatest: (pkg: string) => Promise<string | null>;
  fetchTag: (pkg: string, tag: string) => Promise<string | null>;
  miseUpgradePlan: (spec: string) => Promise<{ targetVersion: string | null; code: number }>;
  whichFormula: (bin: string) => Promise<string | null>;
  realpath?: (path: string) => string;
  nativeBinaryCheck?: (path: string) => boolean;
  options: CommandOptions;
}

function installPathsFor(tool: string, active: MiseToolMap, installed: MiseToolMap): string[] {
  const entries: MiseTool[] = [...(active[tool] ?? []), ...(installed[tool] ?? [])];
  return [
    ...new Set(
      entries
        .map((entry) => entry.install_path)
        .filter((p): p is string => p !== null)
        .map(normalizeRoot),
    ),
  ];
}

function activeVersionCount(tool: string, active: MiseToolMap): number {
  // 只看配置里真正激活的版本。installed 里可能有 24h 内待清理的旧版本，
  // 把它算进来会错误地把探测命令钉成 `<tool>@<当前版本>`，永远看不到新版。
  return new Set((active[tool] ?? []).map((entry) => entry.version)).size;
}

function pathUnder(path: string, root: string): boolean {
  const normalized = root.endsWith("/") ? root.slice(0, -1) : root;
  return path === normalized || path.startsWith(`${normalized}/`);
}

function notInstalled(agent: AgentSpec): AgentInspection {
  return {
    agent,
    status: "not-installed",
    channel: null,
    identity: null,
    miseTool: null,
    path: null,
    current: null,
    target: null,
    command: null,
    note: null,
    shadowed: [],
    install: null,
  };
}

export async function inspectAgent(
  agent: AgentSpec,
  candidates: readonly string[],
  deps: InspectDeps,
): Promise<AgentInspection> {
  if (candidates.length === 0) return notInstalled(agent);

  const firstRealPath = (deps.realpath ?? ((p: string) => p))(candidates[0] as string);
  const miseSelection = pickMiseTool(agent, deps.active, deps.installed, firstRealPath);
  const facts: SystemFacts = {
    ...deps.facts,
    miseInstallPaths: miseSelection
      ? installPathsFor(miseSelection.tool, deps.active, deps.installed)
      : [],
  };

  const classified = candidates.map((candidate) =>
    classifyPath(candidate, agent, {
      facts,
      realpath: deps.realpath,
      nativeBinaryCheck: deps.nativeBinaryCheck,
    }),
  );
  const { effective, shadowed } = selectInstallations(classified);
  if (effective === null) return notInstalled(agent);

  let channel: ChannelId = effective.channel;
  let identity: string | null = null;
  let current: string | null = null;
  let brewKind: "formula" | "cask" | undefined;
  let miseRequested: string | undefined;
  let stalePathNote: string | null = null;

  switch (channel) {
    case "mise": {
      if (miseSelection === null) {
        channel = "unknown";
        current = null;
        break;
      }
      miseRequested = miseSelection.requestedVersion;
      const tagged = isNamedMiseTag(miseSelection.requestedVersion);
      identity =
        !tagged && activeVersionCount(miseSelection.tool, deps.active) > 1
          ? `${miseSelection.tool}@${miseSelection.version}`
          : miseSelection.tool;
      current = tagged ? await deps.probeVersion(effective.path) : miseSelection.version;

      // 升级后当前 shell 的 PATH 可能仍指向旧版本目录（mise activate 的 PATH 不会自动刷新）。
      // 工具本身是 active 的，只是实际执行的这份落后了；报告里说清楚。
      const configured = pickEntry(deps.active[miseSelection.tool]);
      if (miseSelection.active && configured?.install_path) {
        const onConfigured = pathUnder(effective.realPath, configured.install_path);
        const onInstalled = (deps.installed[miseSelection.tool] ?? []).some(
          (entry) => entry.install_path !== null && pathUnder(effective.realPath, entry.install_path),
        );
        if (!onConfigured && onInstalled) {
          stalePathNote = `PATH 上仍解析到旧版本（${effective.path}），新版本已安装；重开 shell 或重新激活 mise 后生效`;
        }
      }
      break;
    }
    case "npm":
    case "bun":
    case "pnpm": {
      identity = agent.npmPackage ?? agent.bin;
      current =
        (agent.npmPackage ? deps.readNodeVersion(effective.realPath, agent.npmPackage) : null) ??
        (await deps.probeVersion(effective.path));
      break;
    }
    case "brew": {
      const formula = await deps.whichFormula(agent.bin);
      if (formula !== null) {
        identity = formula;
        brewKind = "formula";
      } else if (agent.brewCask !== null && deps.brewCasks.includes(agent.brewCask)) {
        identity = agent.brewCask;
        brewKind = "cask";
      } else {
        // brew 路径但认不出 formula/cask：按未知渠道处理，绝不乱跑 brew upgrade
        channel = "unknown";
        current = null;
        break;
      }
      const outdated = deps.brewOutdated?.get(identity);
      current = outdated?.current ?? (await deps.probeVersion(effective.path));
      break;
    }
    case "native": {
      identity = agent.nativeUpdate?.[0] ?? agent.bin;
      current = await deps.probeVersion(effective.path);
      break;
    }
    case "unknown": {
      // 不执行未知二进制，连 --version 都不跑
      current = null;
      break;
    }
  }

  let latest: string | null = null;
  switch (channel) {
    case "mise": {
      if (miseSelection === null) break;
      if (isNamedMiseTag(miseSelection.requestedVersion)) {
        // 只有 npm 后端才知道对应 dist-tag 的具体版本；github 等后端拿不到就跳过
        const npmBacked = miseSelection.tool.startsWith("npm:");
        latest =
          agent.npmPackage === null || !npmBacked
            ? null
            : await deps.fetchTag(agent.npmPackage, miseSelection.requestedVersion);
      } else {
        const plan = await deps.miseUpgradePlan(identity as string);
        latest = plan.code === 0 ? (plan.targetVersion ?? current) : null;
      }
      break;
    }
    case "npm":
    case "bun":
    case "pnpm":
    case "native":
      latest = agent.npmPackage === null ? null : await deps.fetchLatest(agent.npmPackage);
      break;
    case "brew": {
      if (deps.brewOutdated === null) {
        latest = null;
      } else {
        const hit = identity === null ? undefined : deps.brewOutdated.get(identity);
        // 不在 brew outdated 列表里 = 已经是最新
        latest = hit?.latest ?? current;
      }
      break;
    }
    case "unknown":
      latest = null;
      break;
  }

  const install: ChannelInstall = {
    channel,
    identity: identity ?? "?",
    current,
    brewKind,
    miseRequested,
  };
  const command = buildUpgradeCommand(agent, install, deps.options);
  const decision = decideUpgrade(install, latest, {
    command,
    miseInactive: channel === "mise" && miseSelection !== null && !miseSelection.active,
    channelAvailable: deps.channelAvailable[channel] !== false,
  });

  const combinedNote =
    [decision.note, stalePathNote].filter((note): note is string => note !== null).join("；") || null;

  return {
    agent,
    status: decision.status,
    channel,
    identity,
    miseTool: channel === "mise" ? (miseSelection?.tool ?? null) : null,
    path: effective.path,
    current: decision.current,
    target: decision.target,
    command: decision.command,
    note: combinedNote,
    shadowed,
    install,
  };
}
