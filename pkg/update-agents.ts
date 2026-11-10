#!/usr/bin/env bun
/**
 * blanket · agent 更新脚本
 *
 * 扫描注册表里的 agent，识别它由哪个渠道安装（mise / npm / bun / pnpm /
 * brew / 原生安装器），按**原渠道**检查并升级，绝不迁移或卸载。
 *
 * 用法见 README.md 或 `bun run agents -- --help`。
 */

import { homedir } from "node:os";
import { AGENTS, matchAgent, type AgentSpec } from "./agents";
import { collectWarnings, Mise, MiseError, parseUpgradePlan, pickEntry } from "./mise";
import { c, renderTable } from "./ui";
import { whichAll, type ChannelId } from "./channels/detect";
import {
  brewOutdatedMap,
  collectSystemFacts,
  listBrewCasks,
  probeVersion,
  readNodePackageVersion,
  whichFormula,
} from "./channels/facts";
import { fetchLatestVersion, fetchVersion } from "./channels/latest";
import { addStalePathNote, executeUpgrade } from "./channels/execute";
import { inspectAgent, type AgentInspection } from "./channels/inspect";
import { isNamedMiseTag } from "./channels/plan";
import { run } from "./channels/run";

interface Options {
  dryRun: boolean;
  check: boolean;
  json: boolean;
  bump: boolean;
  minimumReleaseAge: string | null;
  updateMise: boolean;
  lenient: boolean;
  cwd: string;
  only: string[] | null;
}

const EXIT = { ok: 0, error: 1, attention: 2, outdated: 3 } as const;

function parseArgs(argv: string[]): Options {
  const opts: Options = {
    dryRun: false,
    check: false,
    json: false,
    bump: true,
    minimumReleaseAge: "0",
    updateMise: false,
    lenient: false,
    cwd: homedir(),
    only: null,
  };

  const takeValue = (flag: string, inline: string | undefined, rest: string[], i: number) => {
    if (inline !== undefined) return { value: inline, next: i };
    const value = rest[i + 1];
    if (value === undefined) throw new Error(`${flag} 需要一个值`);
    return { value, next: i + 1 };
  };

  const queries: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    const eq = arg.indexOf("=");
    const flag = eq >= 0 ? arg.slice(0, eq) : arg;
    const inline = eq >= 0 ? arg.slice(eq + 1) : undefined;

    switch (flag) {
      case "-h":
      case "--help":
        printHelp();
        process.exit(EXIT.ok);
      case "-n":
      case "--dry-run":
        opts.dryRun = true;
        break;
      case "-c":
      case "--check":
        opts.check = true;
        break;
      case "-j":
      case "--json":
        opts.json = true;
        break;
      case "--bump":
        opts.bump = true;
        break;
      case "--no-bump":
        opts.bump = false;
        break;
      case "--mise":
        opts.updateMise = true;
        break;
      case "--lenient":
        opts.lenient = true;
        break;
      case "--only":
      case "--agents": {
        const { value, next } = takeValue(flag, inline, argv, i);
        i = next;
        queries.push(...value.split(",").map((s) => s.trim()).filter(Boolean));
        break;
      }
      case "--age": {
        const { value, next } = takeValue(flag, inline, argv, i);
        i = next;
        opts.minimumReleaseAge = value;
        break;
      }
      case "--cd": {
        const { value, next } = takeValue(flag, inline, argv, i);
        i = next;
        opts.cwd = value;
        break;
      }
      default:
        if (flag.startsWith("-")) throw new Error(`未知参数：${arg}`);
        queries.push(arg);
    }
  }

  opts.only = queries.length > 0 ? queries : null;
  if (opts.check) opts.dryRun = true; // --check 是只读检查
  return opts;
}

function printHelp(): void {
  console.log(
    [
      c.bold("blanket agents — 按原安装渠道检查并升级 AI agent"),
      "",
      c.cyan("用法"),
      "  bun pkg/update-agents.ts [选项] [agent...]",
      "",
      c.cyan("渠道"),
      "  自动识别 mise / npm / bun / pnpm / Homebrew / agent 自带更新命令；",
      "  只升级 PATH 上实际生效的那一份，不会迁移或卸载其它安装。",
      "  渠道无法识别时只报告，不执行任何写入。",
      "",
      c.cyan("选项"),
      "  -n, --dry-run        只报告，不做任何改动",
      "  -c, --check          只读检查（等价 --dry-run），有可升级项时退出码 3",
      "  -j, --json           输出 JSON",
      "      --no-bump        只在当前 version 区间内升级（仅 mise，不改写钉版本）",
      "      --age <时长>     mise minimum-release-age，默认 0，如 24h、7d",
      "      --mise           顺便执行 mise self-update",
      "      --cd <目录>       mise 的工作目录，默认 ~（只看全局配置）",
      "      --lenient        有无法自动处理的 agent 时也返回退出码 0",
      "  -h, --help           本帮助",
      "",
      c.cyan("agent 选择"),
      `  可用：${AGENTS.map((a) => a.bin).join(", ")}`,
      "  支持按名字 / 二进制名 / npm 包名匹配：codex、claude、npm:@openai/codex、oh-my-pi",
      "",
      c.cyan("退出码"),
      "  0 全部成功/无需处理   1 升级失败   2 有 agent 无法自动处理   3 --check 且有可升级项",
    ].join("\n"),
  );
}

function statusLabel(status: AgentInspection["status"]): string {
  switch (status) {
    case "updated":
      return `${c.green("✔")} ${c.green("updated")}`;
    case "up-to-date":
      return `${c.gray("·")} ${c.gray("up-to-date")}`;
    case "ahead":
      return `${c.gray("·")} ${c.gray("up-to-date")} ${c.dim("(ahead)")}`;
    case "outdated":
      return `${c.yellow("↑")} ${c.yellow("outdated")}`;
    case "skipped":
      return `${c.yellow("⊘")} ${c.yellow("skipped")}`;
    case "not-installed":
      return `${c.gray("—")} ${c.gray("not installed")}`;
    case "failed":
      return `${c.red("✖")} ${c.red("failed")}`;
  }
}

function versionCell(inspection: AgentInspection): string {
  if (inspection.current === null) return c.dim("—");
  if (inspection.target !== null && inspection.target !== inspection.current) {
    return `${inspection.current} ${c.dim("→")} ${inspection.target}`;
  }
  return inspection.current;
}

async function main(): Promise<number> {
  let opts: Options;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`${c.red("✖")} ${error instanceof Error ? error.message : String(error)}`);
    return EXIT.error;
  }

  const json = opts.json;
  const log = (msg: string) => {
    if (!json) console.log(msg);
  };
  const warnings: string[] = [];

  // mise 现在是可选的：没有 mise 也要能升级 npm / brew / 原生安装的 agent。
  let mise: Mise | null = null;
  try {
    mise = Mise.discover(opts.cwd);
  } catch (error) {
    const message = error instanceof MiseError ? error.message : String(error);
    if (opts.updateMise) {
      console.error(`${c.red("✖")} 指定了 --mise，但${message}`);
      return EXIT.error;
    }
    warnings.push(`${message}；mise 渠道将被跳过`);
  }

  const miseVersion = mise === null ? null : await mise.version();

  // 选择目标 agent
  let targets = AGENTS;
  if (opts.only) {
    const picked: AgentSpec[] = [];
    for (const query of opts.only) {
      const agent = matchAgent(query);
      if (!agent) {
        console.error(
          `${c.red("✖")} 找不到匹配 "${query}" 的 agent，可用：${AGENTS.map((a) => a.bin).join(", ")}`,
        );
        return EXIT.error;
      }
      if (!picked.includes(agent)) picked.push(agent);
    }
    targets = picked;
  }

  // mise 自身更新（可选，失败不影响 agent 升级）
  let miseSelfUpdate: string | null = null;
  if (opts.updateMise && mise !== null) {
    if (opts.dryRun) {
      miseSelfUpdate = `dry-run：将执行 mise self-update -y（当前 ${miseVersion}）`;
    } else {
      const result = await mise.selfUpdate();
      const after = await mise.version();
      miseSelfUpdate =
        result.code === 0
          ? `${miseVersion} → ${after}`
          : `失败：${result.stderr.trim().split("\n")[0] ?? `退出码 ${result.code}`}`;
    }
  }

  const [active, installed] = mise
    ? await Promise.all([mise.listActive(), mise.listInstalled()])
    : [
        { tools: {}, warnings: [] },
        { tools: {}, warnings: [] },
      ];
  warnings.push(...active.warnings, ...installed.warnings);

  const facts = await collectSystemFacts();
  const brewOutdated = await brewOutdatedMap();
  const brewCasks = await listBrewCasks();

  const channelAvailable: Partial<Record<ChannelId, boolean>> = {
    mise: mise !== null,
    npm: Bun.which("npm") !== null,
    bun: Bun.which("bun") !== null,
    pnpm: Bun.which("pnpm") !== null,
    brew: Bun.which("brew") !== null,
    native: true,
  };

  const inspectDeps = {
    facts,
    active: active.tools,
    installed: installed.tools,
    brewOutdated,
    brewCasks,
    channelAvailable,
    readNodeVersion: readNodePackageVersion,
    probeVersion: (path: string) => probeVersion(path),
    fetchLatest: (pkg: string) => fetchLatestVersion(pkg),
    fetchTag: (pkg: string, tag: string) => fetchVersion(pkg, tag),
    miseUpgradePlan: async (spec: string) => {
      if (mise === null) return { targetVersion: null, code: 127 };
      const result = await mise.upgrade(spec, {
        bump: opts.bump,
        minimumReleaseAge: opts.minimumReleaseAge,
        dryRun: true,
      });
      warnings.push(...collectWarnings(result.stderr));
      const plan = parseUpgradePlan(result);
      return { targetVersion: plan.targetVersion, code: result.code };
    },
    whichFormula: (bin: string) => whichFormula(bin),
    options: {
      bump: opts.bump,
      minimumReleaseAge: opts.minimumReleaseAge,
    },
  };

  const inspections: AgentInspection[] = [];
  for (const agent of targets) {
    inspections.push(await inspectAgent(agent, whichAll(agent.bin), inspectDeps));
  }

  // 真正的升级：只执行 effective 渠道的命令
  let miseRan = false;
  if (!opts.dryRun) {
    for (let i = 0; i < inspections.length; i++) {
      const before = inspections[i] as AgentInspection;
      if (before.status !== "outdated") continue;
      if (before.channel === "mise") miseRan = true;

      inspections[i] = addStalePathNote(
        await executeUpgrade(before, {
          run: (argv) =>
            run(argv, {
              cwd: argv[0] === "mise" ? opts.cwd : homedir(),
              timeoutMs: 600_000,
            }),
          probeVersion: async (path) => {
            // mise 普通升级后安装路径会变（<tool>/<新版本>），旧路径探测不到新版本，
            // 必须重读 mise 记录；命名标签的目录是 <tool>/<tag>，原地刷新，直接探二进制。
            if (
              before.channel === "mise" &&
              before.miseTool !== null &&
              !isNamedMiseTag(before.install?.miseRequested)
            ) {
              const list = await mise?.listActive();
              return list === undefined ? null : (pickEntry(list.tools[before.miseTool])?.version ?? null);
            }
            return probeVersion(path);
          },
        }),
      );
    }

    if (miseRan && mise !== null) {
      const reshim = await mise.reshim();
      if (reshim.code !== 0) {
        warnings.push(`reshim 失败：${reshim.stderr.trim().split("\n")[0] ?? "未知错误"}`);
      }
    }
  }

  const count = (status: AgentInspection["status"]) =>
    inspections.filter((inspection) => inspection.status === status).length;

  const summary = {
    total: inspections.length,
    updated: count("updated"),
    upToDate: count("up-to-date") + count("ahead"),
    outdated: count("outdated"),
    skipped: count("skipped"),
    notInstalled: count("not-installed"),
    failed: count("failed"),
  };

  if (json) {
    console.log(
      JSON.stringify(
        {
          mise:
            mise === null
              ? null
              : { bin: mise.path, cwd: opts.cwd, version: miseVersion, selfUpdate: miseSelfUpdate },
          dryRun: opts.dryRun,
          results: inspections.map((inspection) => ({
            agent: inspection.agent.name,
            bin: inspection.agent.bin,
            channel: inspection.channel,
            identity: inspection.identity,
            path: inspection.path,
            current: inspection.current,
            target: inspection.target,
            status: inspection.status,
            command: inspection.command,
            note: inspection.note,
            shadowed: inspection.shadowed.map((install) => ({
              channel: install.channel,
              path: install.path,
            })),
          })),
          summary,
          warnings: [...new Set(warnings)],
        },
        null,
        2,
      ),
    );
  } else {
    const mode = opts.dryRun ? c.yellow("[dry-run]") : c.cyan("[update]");
    log(
      `${mode} 扫描 ${targets.length} 个 agent · mise ${c.dim(miseVersion ?? "未安装")} · cwd ${c.dim(opts.cwd)}`,
    );
    if (miseSelfUpdate) log(`  mise self-update：${miseSelfUpdate}`);

    log(
      renderTable(
        [
          { title: "AGENT", min: 12 },
          { title: "CHANNEL", min: 8 },
          { title: "VERSION", min: 12 },
          { title: "RESULT", min: 18 },
        ],
        inspections.map((inspection) => [
          inspection.agent.name,
          inspection.channel === null ? c.dim("—") : inspection.channel,
          versionCell(inspection),
          `${statusLabel(inspection.status)}${inspection.note ? ` ${c.dim(inspection.note)}` : ""}`.trimEnd(),
        ]),
      ),
    );

    log(
      `\n${c.bold("汇总")} 共 ${summary.total} 个：${c.green(`updated ${summary.updated}`)} · ${c.gray(
        `up-to-date ${summary.upToDate}`,
      )}${summary.outdated > 0 ? ` · ${c.yellow(`outdated ${summary.outdated}`)}` : ""}${
        summary.skipped > 0 ? ` · ${c.yellow(`skipped ${summary.skipped}`)}` : ""
      }${summary.failed > 0 ? ` · ${c.red(`failed ${summary.failed}`)}` : ""}${
        summary.notInstalled > 0 ? ` · ${c.gray(`not installed ${summary.notInstalled}`)}` : ""
      }`,
    );

    const shadowed = inspections.filter((inspection) => inspection.shadowed.length > 0);
    if (shadowed.length > 0) {
      log(`\n${c.yellow("另检测到其它安装（未生效，不会升级）：")}`);
      for (const inspection of shadowed) {
        const list = inspection.shadowed.map((install) => `${install.channel} ${install.path}`).join("；");
        log(`  • ${c.bold(inspection.agent.name)}：${list}`);
      }
    }

    const skipped = inspections.filter((inspection) => inspection.status === "skipped");
    if (skipped.length > 0) {
      log(`\n${c.yellow("已跳过：")}`);
      for (const inspection of skipped) {
        log(`  • ${c.bold(inspection.agent.name)}：${inspection.note ?? "未说明原因"}`);
      }
    }

    if (opts.dryRun && summary.outdated > 0) {
      log(`\n${c.cyan("将执行的升级命令：")}`);
      for (const inspection of inspections) {
        if (inspection.status === "outdated" && inspection.command !== null) {
          log(`  • ${c.bold(inspection.agent.bin)}：${inspection.command.join(" ")}`);
        }
      }
    }

    if (warnings.length > 0) {
      log(`\n${c.dim("提示：")}`);
      for (const warning of [...new Set(warnings)]) log(`  ${c.dim(warning)}`);
    }
  }

  if (summary.failed > 0) return EXIT.error;
  if (summary.skipped > 0 && !opts.lenient) return EXIT.attention;
  if (opts.check && summary.outdated > 0) return EXIT.outdated;
  return EXIT.ok;
}

process.exit(await main());
