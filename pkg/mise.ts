/**
 * 极简 mise CLI 封装：只做“调命令 + 解析 JSON”两件事。
 *
 * 所有命令都默认在用户家目录下执行，保证视角固定为**全局 mise 配置**
 * （~/.config/mise/config.toml），不受当前仓库里可能存在的本地 mise.toml 影响。
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface MiseSource {
  type: string;
  path: string | null;
}

export interface MiseTool {
  version: string;
  requested_version: string;
  install_path: string | null;
  source: MiseSource | null;
  installed: boolean;
  active: boolean;
}

export type MiseToolMap = Record<string, MiseTool[]>;

/** 从可能出现的多个条目里挑出“当前应生效”的那一个（优先已安装，取最后一条） */
export function pickEntry(entries: MiseTool[] | undefined): MiseTool | undefined {
  if (!entries || entries.length === 0) return undefined;
  const installed = entries.filter((e) => e.installed);
  const pool = installed.length > 0 ? installed : entries;
  return pool[pool.length - 1];
}

/** 从 stderr 里挑出值得给用户看的提示行 */
export function collectWarnings(stderr: string): string[] {
  return stderr
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /WARN|Error|error|ignored|failed/i.test(l))
    .filter((l) => l.length > 0);
}

function parseJson<T>(text: string): T | null {
  const start = text.indexOf("{");
  if (start < 0) return null;
  try {
    return JSON.parse(text.slice(start)) as T;
  } catch {
    return null;
  }
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** 一次升级的“计划”：dry-run 时来自解析输出，实际执行后由版本对比得出 */
export interface UpgradePlan {
  /** `upgrade --dry-run` 输出里 "Would install pkg@x.y.z" 的目标版本，null 表示已是最新 */
  targetVersion: string | null;
  /** "Would bump pkg@x.y.z in <file>" 里被改写的配置文件路径 */
  configFile: string | null;
  /** 原始命令结果，便于排错 */
  raw: RunResult;
}

/**
 * 解析 `mise upgrade --dry-run` 的输出。
 *
 * 之所以不用 `mise outdated`：它不接受 `--minimum-release-age`，在“发布冷静期”
 * 存在时会漏报最新版；dry-run 与真实升级走同一条命令路径，结果天然一致。
 */
export function parseUpgradePlan(result: RunResult): UpgradePlan {
  const installLine = result.stdout.match(/^Would install\s+(.+)$/m)?.[1];
  const bumpLine = result.stdout.match(/^Would bump\s+(.+)$/m)?.[1];
  // "npm:@openai/codex@0.162.1" 这类带 scope 的包名里本身有 @，只能从右边切
  const targetVersion = installLine ? (installLine.split("@").at(-1) ?? null) : null;
  const configFile = bumpLine ? (bumpLine.match(/\s+in\s+(.+)$/)?.[1] ?? null) : null;
  return { targetVersion, configFile, raw: result };
}

export class MiseError extends Error {
  constructor(
    message: string,
    readonly hint?: string,
  ) {
    super(message);
    this.name = "MiseError";
  }
}

export class Mise {
  private constructor(
    readonly bin: string,
    readonly cwd: string,
  ) {}

  /** 在 PATH 和常见安装路径里找 mise，找不到就抛出带安装指引的错误 */
  static discover(cwd: string = homedir()): Mise {
    const candidates: Array<string | null> = [
      Bun.which("mise"),
      join(homedir(), ".local/bin/mise"),
      "/opt/homebrew/bin/mise",
      "/usr/local/bin/mise",
      join(homedir(), ".local/share/mise/bin/mise"),
    ];
    const found = candidates.find((p): p is string => p !== null && existsSync(p));
    if (!found) {
      throw new MiseError(
        "未找到 mise 可执行文件",
        "安装 mise：curl https://mise.run | bash  （或 brew install mise）",
      );
    }
    return new Mise(found, cwd);
  }

  get path(): string {
    return this.bin;
  }

  async run(
    args: string[],
    opts: { cwd?: string; timeoutMs?: number } = {},
  ): Promise<RunResult> {
    const proc = Bun.spawn({
      cmd: [this.bin, ...args],
      cwd: opts.cwd ?? this.cwd,
      stdout: "pipe",
      stderr: "pipe",
      env: process.env,
    });
    const timer = setTimeout(() => proc.kill(), opts.timeoutMs ?? 600_000);
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    clearTimeout(timer);
    return { code: code ?? 1, stdout, stderr };
  }

  async version(): Promise<string> {
    const r = await this.run(["--version"], { timeoutMs: 20_000 });
    return (r.stdout.trim().split("\n")[0] ?? "unknown").trim();
  }

  /** 当前配置（全局 + 执行目录向上链路）里声明的工具 */
  async listActive(): Promise<{ tools: MiseToolMap; warnings: string[] }> {
    const r = await this.run(["ls", "-J", "-c"]);
    return { tools: parseJson<MiseToolMap>(r.stdout) ?? {}, warnings: collectWarnings(r.stderr) };
  }

  /** 所有已安装的工具（含没有出现在任何配置里的 inactive 版本） */
  async listInstalled(): Promise<{ tools: MiseToolMap; warnings: string[] }> {
    const r = await this.run(["ls", "-J", "--installed"]);
    return { tools: parseJson<MiseToolMap>(r.stdout) ?? {}, warnings: collectWarnings(r.stderr) };
  }

  /**
   * 升级单个工具。
   * bump=true → 升到全局最新并改写配置里的版本；dryRun=true → 只输出计划。
   * minimumReleaseAge 见 `--age`：null 表示沿用 mise 自身设置。
   */
  async upgrade(
    tool: string,
    opts: { bump: boolean; minimumReleaseAge: string | null; dryRun: boolean },
  ): Promise<RunResult> {
    const args = ["upgrade", tool];
    if (opts.bump) args.push("--bump");
    if (opts.dryRun) args.push("--dry-run");
    if (opts.minimumReleaseAge !== null) {
      args.push("--minimum-release-age", opts.minimumReleaseAge);
    }
    return this.run(args);
  }

  async reshim(): Promise<RunResult> {
    return this.run(["reshim"], { timeoutMs: 120_000 });
  }

  /** 更新 mise 自身（需要 -y，否则会卡在交互确认） */
  async selfUpdate(): Promise<RunResult> {
    return this.run(["self-update", "-y"], { timeoutMs: 300_000 });
  }
}
