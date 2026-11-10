/**
 * 安装渠道探测：把 PATH 上的一个二进制路径，归类到它所属的安装渠道。
 *
 * 判定顺序是设计的一部分，不能随便调整：
 *   npm → bun → pnpm → mise → brew → native → unknown
 *
 * 因为 npm 的全局根目录可能位于 mise 的 node 安装目录内，先查 mise 会把
 * `npm install -g` 的包误判成 mise 管理，从而用错升级命令。
 */

import { accessSync, constants, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import type { AgentSpec } from "../agents";
import { looksLikeNativeBinary } from "./facts";

export type ChannelId = "mise" | "npm" | "bun" | "pnpm" | "brew" | "native" | "unknown";

export interface SystemFacts {
  /** mise 数据目录，通常 ~/.local/share/mise */
  miseDataDir: string;
  /** mise shim 目录，通常 <miseDataDir>/shims */
  miseShimDir: string;
  /**
   * 该 agent 选中的 mise tool 的 install_path。
   * 只认这些精确路径，不认“任何在 mise/installs 下的路径”：npm 的全局根
   * 可能就在 mise 的 node 安装目录里，宽泛匹配会误判。
   */
  miseInstallPaths: string[];
  /** `npm root -g` 的所有结果 */
  npmRoots: string[];
  /** bun 全局 node_modules 根 */
  bunRoots: string[];
  /** `pnpm root -g` 的所有结果 */
  pnpmRoots: string[];
  /** Homebrew prefix：/opt/homebrew、/usr/local、/home/linuxbrew/.linuxbrew */
  brewPrefixes: string[];
}

export interface ClassifyContext {
  facts: SystemFacts;
  /** 便于测试注入；默认使用 fs.realpathSync */
  realpath?: (path: string) => string;
  /** 便于测试注入；默认读取文件头判断 Mach-O / ELF */
  nativeBinaryCheck?: (path: string) => boolean;
}

export interface PathInstall {
  channel: ChannelId;
  /** PATH 上的原始路径 */
  path: string;
  /** 解析软链后的真实路径 */
  realPath: string;
  /** 同一渠道同一份安装去重用 */
  key: string;
}

function isUnder(path: string, root: string): boolean {
  const normalized = root.endsWith("/") ? root.slice(0, -1) : root;
  return path === normalized || path.startsWith(`${normalized}/`);
}

function safeRealpath(path: string, ctx: ClassifyContext): string {
  try {
    return (ctx.realpath ?? realpathSync)(path);
  } catch {
    return path;
  }
}

function matchRoot(path: string, roots: readonly string[]): string | null {
  return roots.find((root) => isUnder(path, root)) ?? null;
}

/** 把一个 PATH 候选归类到安装渠道；永不猜测，识别不了就是 unknown */
export function classifyPath(rawPath: string, agent: AgentSpec, ctx: ClassifyContext): PathInstall {
  const realPath = safeRealpath(rawPath, ctx);
  const { facts } = ctx;

  const npmRoot = matchRoot(realPath, facts.npmRoots);
  if (npmRoot !== null) {
    return { channel: "npm", path: rawPath, realPath, key: `npm:${npmRoot}` };
  }

  const bunRoot = matchRoot(realPath, facts.bunRoots);
  if (bunRoot !== null) {
    return { channel: "bun", path: rawPath, realPath, key: `bun:${bunRoot}` };
  }

  const pnpmRoot = matchRoot(realPath, facts.pnpmRoots);
  if (pnpmRoot !== null) {
    return { channel: "pnpm", path: rawPath, realPath, key: `pnpm:${pnpmRoot}` };
  }

  // mise shim 是指向 mise 二进制的软链：必须按原始路径判断，
  // 否则 realpath 会把它解析到 ~/.local/bin/mise 而认不出来。
  if (isUnder(rawPath, facts.miseShimDir)) {
    return { channel: "mise", path: rawPath, realPath, key: "mise" };
  }
  if (matchRoot(realPath, facts.miseInstallPaths) !== null) {
    return { channel: "mise", path: rawPath, realPath, key: "mise" };
  }

  const brewPrefix = matchRoot(realPath, facts.brewPrefixes);
  if (brewPrefix !== null) {
    return { channel: "brew", path: rawPath, realPath, key: `brew:${brewPrefix}` };
  }

  // native 需要三个正向信号同时成立：有自带更新命令、位于已知原生目录、
  // 且是真实二进制而不是 wrapper 脚本。少一个就判 unknown，绝不猜。
  const inNativeDir = agent.nativeDirs.some((dir) => isUnder(rawPath, dir));
  if (
    agent.nativeUpdate !== null &&
    inNativeDir &&
    (ctx.nativeBinaryCheck ?? looksLikeNativeBinary)(rawPath)
  ) {
    return { channel: "native", path: rawPath, realPath, key: `native:${realPath}` };
  }

  return { channel: "unknown", path: rawPath, realPath, key: `unknown:${rawPath}` };
}

export interface InstallSelection {
  effective: PathInstall | null;
  shadowed: PathInstall[];
}

/** PATH 顺序里的第一份生效安装；同渠道重复项去重，其余进 shadowed */
export function selectInstallations(candidates: readonly PathInstall[]): InstallSelection {
  const seen = new Set<string>();
  const unique: PathInstall[] = [];
  for (const candidate of candidates) {
    if (seen.has(candidate.key)) continue;
    seen.add(candidate.key);
    unique.push(candidate);
  }
  return { effective: unique[0] ?? null, shadowed: unique.slice(1) };
}

/** 按 PATH 顺序列出所有命中（跳过不可执行文件，同一路径去重） */
export function whichAll(bin: string, pathEnv: string = process.env.PATH ?? ""): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  for (const dir of pathEnv.split(":")) {
    if (dir.length === 0) continue;
    const candidate = resolve(join(dir, bin));
    try {
      accessSync(candidate, constants.X_OK);
    } catch {
      continue;
    }
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    found.push(candidate);
  }
  return found;
}
