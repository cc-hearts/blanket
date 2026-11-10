/**
 * 渠道事实采集与纯逻辑辅助。
 *
 * 纯函数（tool 选择、路径推导、魔数判断）在这里，便于单测；
 * 真正调命令的部分放在文件后半段，尽量薄。
 */

import { closeSync, openSync, readFileSync, readSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { AgentSpec } from "../agents";
import { pickEntry, type MiseTool, type MiseToolMap } from "../mise";
import { parseVersion } from "../versions";
import { parseBrewOutdated } from "./latest";
import { run, type RunResult } from "./run";
import type { SystemFacts } from "./detect";

function isUnderPath(path: string, root: string): boolean {
  const normalized = root.endsWith("/") ? root.slice(0, -1) : root;
  return path === normalized || path.startsWith(`${normalized}/`);
}

function selectionFrom(tool: string, entry: MiseTool, active: boolean): MiseToolSelection {
  return {
    tool,
    active,
    version: entry.version,
    requestedVersion: entry.requested_version,
    installPath: entry.install_path,
  };
}

export interface MiseToolSelection {
  /** mise tool spec，例如 npm:@openai/codex */
  tool: string;
  /** 是否出现在任何 mise 配置中 */
  active: boolean;
  /** mise 记录的版本（可能是 next 这样的标签） */
  version: string;
  /** 配置请求的版本 */
  requestedVersion: string;
  installPath: string | null;
}

/**
 * 选出该 agent 实际对应的 mise tool。
 * realPath 给定时优先按 install_path 精确匹配，避免同一个 agent 有多个
 * mise 来源时升级了被遮蔽的那一个。
 */
export function pickMiseTool(
  agent: AgentSpec,
  active: MiseToolMap,
  installed: MiseToolMap,
  realPath?: string,
): MiseToolSelection | null {
  if (realPath) {
    for (const tool of agent.miseTools) {
      const activeMatch = (active[tool] ?? []).find(
        (entry) => entry.installed && entry.install_path !== null && isUnderPath(realPath, entry.install_path),
      );
      if (activeMatch) return selectionFrom(tool, activeMatch, true);

      const installedMatch = (installed[tool] ?? []).find(
        (entry) => entry.installed && entry.install_path !== null && isUnderPath(realPath, entry.install_path),
      );
      if (installedMatch) {
        // PATH 可能还指着升级前的旧版本目录（shell 激活的 PATH 不会自动刷新）。
        // 只要这个 tool 在配置里，就仍算 active，版本取配置里的版本。
        const configured = pickEntry(active[tool]);
        return selectionFrom(tool, configured ?? installedMatch, configured !== undefined);
      }
    }
  }

  for (const tool of agent.miseTools) {
    const entry = pickEntry(active[tool]);
    if (entry) return selectionFrom(tool, entry, true);
  }
  for (const tool of agent.miseTools) {
    const entry = pickEntry(installed[tool]);
    if (entry) return selectionFrom(tool, entry, false);
  }
  return null;
}

/** 从 realpath 反推 node_modules/<pkg> 目录；找不到返回 null */
export function findNodePackageDir(realPath: string, pkg: string): string | null {
  const marker = `/node_modules/${pkg}/`;
  const index = realPath.lastIndexOf(marker);
  if (index >= 0) return realPath.slice(0, index + marker.length - 1);
  const exact = `/node_modules/${pkg}`;
  return realPath.endsWith(exact) ? realPath : null;
}

/** `brew which-formula` 可能输出多行，取第一条 */
export function parseBrewWhichFormula(stdout: string): string | null {
  return (
    stdout
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? null
  );
}

const NATIVE_MAGICS: readonly (readonly number[])[] = [
  [0xcf, 0xfa, 0xed, 0xfe], // Mach-O 64 little-endian
  [0xce, 0xfa, 0xed, 0xfe], // Mach-O 32 little-endian
  [0xfe, 0xed, 0xfa, 0xce], // Mach-O 32 big-endian
  [0xfe, 0xed, 0xfa, 0xcf], // Mach-O 64 big-endian
  [0xca, 0xfe, 0xba, 0xbe], // universal / fat binary
  [0xbe, 0xba, 0xfe, 0xca], // universal little-endian
  [0x7f, 0x45, 0x4c, 0x46], // ELF
];

/** 文件头是不是真实可执行格式；shell / JS 脚本 wrapper 返回 false */
export function isNativeBinaryMagic(bytes: Uint8Array): boolean {
  if (bytes.length < 4) return false;
  return NATIVE_MAGICS.some((magic) => magic.every((byte, index) => bytes[index] === byte));
}

/** 读取文件头 4 字节并判断；读不了按“不是原生二进制”处理 */
export function looksLikeNativeBinary(path: string): boolean {
  let fd: number | null = null;
  try {
    fd = openSync(path, "r");
    const buffer = new Uint8Array(4);
    const read = readSync(fd, buffer, 0, 4, 0);
    return read === 4 && isNativeBinaryMagic(buffer);
  } catch {
    return false;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

/** 统一根目录的物理路径（macOS 上 /tmp → /private/tmp）；不存在时原样返回 */
export function normalizeRoot(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** 从 `<data>/installs/<tool>/<version>` 反推 `<data>` */
export function parseMiseDataDir(installPath: string): string | null {
  const marker = "/installs/";
  const index = installPath.indexOf(marker);
  return index > 0 ? installPath.slice(0, index) : null;
}

export function defaultBunRoots(env: Record<string, string | undefined>, home: string): string[] {
  const bunInstall = env.BUN_INSTALL ?? join(home, ".bun");
  return [join(bunInstall, "install", "global", "node_modules")];
}

export interface FactsDeps {
  run?: (argv: string[], opts?: { cwd?: string; timeoutMs?: number }) => Promise<RunResult>;
  which?: (bin: string) => string | null;
  env?: Record<string, string | undefined>;
  homedir?: string;
}

function resolveDeps(deps: FactsDeps) {
  return {
    run: deps.run ?? run,
    which: deps.which ?? ((bin: string) => Bun.which(bin)),
    env: deps.env ?? process.env,
    home: deps.homedir ?? homedir(),
  };
}

/** 采集与具体 agent 无关的渠道事实（每个渠道最多执行一次命令） */
export async function collectSystemFacts(deps: FactsDeps = {}): Promise<SystemFacts> {
  const { run: runner, which, env, home } = resolveDeps(deps);

  const npmRoots: string[] = [];
  if (which("npm") !== null) {
    const result = await runner(["npm", "root", "-g"], { timeoutMs: 30_000 });
    const root = result.stdout.trim().split("\n")[0]?.trim();
    if (result.code === 0 && root) npmRoots.push(normalizeRoot(root));
  }

  const pnpmRoots: string[] = [];
  if (which("pnpm") !== null) {
    const result = await runner(["pnpm", "root", "-g"], { timeoutMs: 30_000 });
    const root = result.stdout.trim().split("\n")[0]?.trim();
    if (result.code === 0 && root) pnpmRoots.push(normalizeRoot(root));
  }

  const brewPath = which("brew");
  const brewPrefixes: string[] = [];
  if (brewPath !== null) {
    brewPrefixes.push(normalizeRoot(dirname(dirname(brewPath))));
  }
  if (env.HOMEBREW_PREFIX) {
    const fromEnv = normalizeRoot(env.HOMEBREW_PREFIX);
    if (!brewPrefixes.includes(fromEnv)) brewPrefixes.push(fromEnv);
  }

  const miseDataDir = normalizeRoot(env.MISE_DATA_DIR ?? join(home, ".local", "share", "mise"));

  return {
    miseDataDir,
    miseShimDir: join(miseDataDir, "shims"),
    miseInstallPaths: [],
    npmRoots,
    bunRoots: defaultBunRoots(env, home).map(normalizeRoot),
    pnpmRoots,
    brewPrefixes,
  };
}

/** 缓存一次 brew outdated；brew 不可用或命令失败返回 null（不能当作“全部最新”） */
export async function brewOutdatedMap(
  deps: FactsDeps = {},
): Promise<Map<string, { current: string | null; latest: string | null; kind: "formula" | "cask" }> | null> {
  const { run: runner, which } = resolveDeps(deps);
  if (which("brew") === null) return null;
  const result = await runner(["brew", "outdated", "--json=v2"], { timeoutMs: 120_000 });
  if (result.code !== 0) return null;
  try {
    return parseBrewOutdated(JSON.parse(result.stdout));
  } catch {
    return null;
  }
}

/** 从二进制反查 brew formula；cask 不在此覆盖范围内 */
export async function whichFormula(bin: string, deps: FactsDeps = {}): Promise<string | null> {
  const { run: runner, which } = resolveDeps(deps);
  if (which("brew") === null) return null;
  const result = await runner(["brew", "which-formula", bin], { timeoutMs: 60_000 });
  return result.code === 0 ? parseBrewWhichFormula(result.stdout) : null;
}

export async function listBrewCasks(deps: FactsDeps = {}): Promise<string[]> {
  const { run: runner, which } = resolveDeps(deps);
  if (which("brew") === null) return [];
  const result = await runner(["brew", "list", "--cask"], { timeoutMs: 60_000 });
  if (result.code !== 0) return [];
  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

/** 运行 `<bin> --version` 并解析版本号 */
export async function probeVersion(
  bin: string,
  runner: (argv: string[], opts?: { cwd?: string; timeoutMs?: number }) => Promise<RunResult> = run,
): Promise<string | null> {
  const result = await runner([bin, "--version"], { timeoutMs: 20_000 });
  if (result.code !== 0) return null;
  return parseVersion(result.stdout) ?? parseVersion(result.stderr);
}

/** 从 node_modules/<pkg>/package.json 读取已安装版本 */
export function readNodePackageVersion(realPath: string, pkg: string): string | null {
  const dir = findNodePackageDir(realPath, pkg);
  if (dir === null) return null;
  try {
    const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { version?: unknown };
    return typeof manifest.version === "string" ? manifest.version : null;
  } catch {
    return null;
  }
}
