/**
 * 升级决策：给定“哪份安装、当前版本、最新版本”，算出该不该升、
 * 以及用哪条命令升。这里是纯函数，不执行任何东西。
 */

import type { AgentSpec } from "../agents";
import { compareVersions } from "../versions";
import type { ChannelId } from "./detect";

export interface ChannelInstall {
  channel: ChannelId;
  /** 渠道内身份：mise tool spec / npm 包名 / brew formula 或 cask 名 */
  identity: string;
  current: string | null;
  /** brew 区分 formula / cask；其它渠道忽略 */
  brewKind?: "formula" | "cask";
  /** mise 配置里请求的版本；用于识别 next 这类命名标签 */
  miseRequested?: string;
}

const EXACT_SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/**
 * 命名标签（next / beta / stable …）需要特殊处理：
 * `mise upgrade --bump` 会把标签改写成具体版本，等于悄悄切换发布通道。
 * latest、精确 semver、版本区间都按普通升级处理。
 */
export function isNamedMiseTag(requested: string | undefined): requested is string {
  if (requested === undefined || requested === "latest") return false;
  if (EXACT_SEMVER.test(requested)) return false;
  if (/^[~^<>=]/.test(requested)) return false;
  // 24、1.4、1.4.x 这类范围/部分版本按普通升级处理
  if (/^\d+(\.\d+){0,2}(\.?[xX*])?$/.test(requested)) return false;
  return /^[A-Za-z][A-Za-z0-9._-]*$/.test(requested);
}

export interface CommandOptions {
  bump: boolean;
  minimumReleaseAge: string | null;
}

/** 返回将要执行的命令；该渠道无法自动升级时返回 null */
export function buildUpgradeCommand(
  agent: AgentSpec,
  install: ChannelInstall,
  opts: CommandOptions,
): string[] | null {
  switch (install.channel) {
    case "mise": {
      if (isNamedMiseTag(install.miseRequested)) {
        const tagged = ["mise", "install", `${install.identity}@${install.miseRequested}`, "--force"];
        if (opts.minimumReleaseAge !== null) tagged.push("--minimum-release-age", opts.minimumReleaseAge);
        return tagged;
      }
      const argv = ["mise", "upgrade", install.identity];
      if (opts.bump) argv.push("--bump");
      if (opts.minimumReleaseAge !== null) argv.push("--minimum-release-age", opts.minimumReleaseAge);
      return argv;
    }
    case "npm":
      return ["npm", "install", "-g", `${agent.npmPackage ?? install.identity}@latest`];
    case "bun":
      return ["bun", "add", "-g", `${agent.npmPackage ?? install.identity}@latest`];
    case "pnpm":
      return ["pnpm", "add", "-g", `${agent.npmPackage ?? install.identity}@latest`];
    case "brew":
      return install.brewKind === "cask"
        ? ["brew", "upgrade", "--cask", install.identity]
        : ["brew", "upgrade", install.identity];
    case "native":
      return agent.nativeUpdate === null ? null : [...agent.nativeUpdate];
    case "unknown":
      return null;
  }
}

export type DecisionStatus = "up-to-date" | "ahead" | "outdated" | "skipped";

export interface DecisionOptions {
  /** buildUpgradeCommand 的结果；null = 该渠道没有自动升级方式 */
  command: string[] | null;
  /** mise 记录里有这个 tool，但没有出现在任何 mise 配置中 */
  miseInactive?: boolean;
  /** 渠道 CLI 缺失或不可执行 */
  channelAvailable?: boolean;
}

export interface Decision {
  status: DecisionStatus;
  current: string | null;
  target: string | null;
  command: string[] | null;
  note: string | null;
}

export function decideUpgrade(
  install: ChannelInstall,
  latest: string | null,
  opts: DecisionOptions,
): Decision {
  const base = { current: install.current, target: latest, command: null, note: null };

  if (install.channel === "unknown") {
    return { ...base, status: "skipped", note: "无法识别安装渠道，不会猜测升级方式" };
  }
  if (opts.miseInactive) {
    return {
      ...base,
      status: "skipped",
      note: `已安装但未在 mise 配置中；接管：mise use -g ${install.identity}@latest`,
    };
  }
  if (opts.channelAvailable === false) {
    return { ...base, status: "skipped", note: `${install.channel} 工具不可用，无法自动升级` };
  }
  if (opts.command === null) {
    return { ...base, status: "skipped", note: "没有可用的自动升级命令" };
  }
  if (latest === null) {
    return { ...base, status: "skipped", note: "无法确定最新版" };
  }
  if (install.current === null) {
    return { ...base, status: "skipped", note: "无法读取当前版本" };
  }

  const direction = compareVersions(latest, install.current);
  if (direction > 0) {
    return { ...base, status: "outdated", command: opts.command };
  }
  if (direction < 0) {
    return {
      ...base,
      status: "ahead",
      note: `本地版本 ${install.current} 高于最新版 ${latest}，不降级`,
    };
  }
  return { ...base, status: "up-to-date" };
}

export interface UpgradeEvaluation {
  status: "updated" | "up-to-date" | "failed";
  note: string | null;
}

/** 升级命令执行完后，用前后版本判断真实结果；版本没变不算失败，变低算失败 */
export function evaluateUpgradeResult(
  before: string | null,
  after: string | null,
  target: string | null,
): UpgradeEvaluation {
  if (after === null) {
    return { status: "failed", note: "升级后无法读取版本" };
  }
  if (before === null) {
    return { status: "failed", note: "升级前无法读取版本，无法确认结果" };
  }

  const change = compareVersions(after, before);
  if (change < 0) {
    return { status: "failed", note: `升级后版本反而变低（${before} → ${after}）` };
  }
  if (change === 0) {
    return { status: "up-to-date", note: "命令已执行，但版本未变化" };
  }
  if (target !== null && compareVersions(after, target) < 0) {
    return { status: "updated", note: `命令成功，但未达到目标版本 ${target}` };
  }
  return { status: "updated", note: null };
}
