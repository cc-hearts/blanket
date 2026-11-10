#!/usr/bin/env bun
/**
 * blanket · agent 权限开关
 *
 * 目的：一次性把「完全访问权限」这类开关在所有 agent 上打开，省掉每个项目、
 * 每个会话都要点一次同意的重复劳动。
 *
 * 默认进 TUI；也可以非交互使用（--check / --json / --on / --off）。
 * 所有写入前都会备份到 ~/.blanket/backups/，并且是原子写。
 *
 * 用法见 README.md 或 `bun run perm -- --help`。
 */

import { AGENT_TARGETS, findTargets } from "./perm/registry";
import { applyChanges, inspectAll, type AgentSnapshot, type PendingChange } from "./perm/engine";
import { PermissionTui } from "./perm/tui";
import { SWITCHES, type SwitchId } from "./perm/types";
import { c, renderTable } from "../pkg/ui";

interface Options {
  json: boolean;
  check: boolean;
  dryRun: boolean;
  yes: boolean;
  on: boolean;
  off: boolean;
  switches: SwitchId[] | null;
  only: string[] | null;
}

const EXIT = {
  ok: 0,
  error: 1,
  notOpen: 3,
} as const;

const SWITCH_IDS = SWITCHES.map((s) => s.id);

function switchLabel(id: SwitchId): string {
  return SWITCHES.find((s) => s.id === id)?.label ?? id;
}

function printHelp(): void {
  process.stdout.write(`${c.bold("blanket · agent 权限开关")}

  bun run perm                      进 TUI（默认）：↑/↓ 移动 · space 切换 · a 应用 · q 退出
  bun run perm -- --check           只读检查；有 agent 未开完全访问时退出码 3
  bun run perm -- --json            JSON 输出当前状态
  bun run perm -- --on              非交互打开（默认完全访问权限），需 --yes 或 TTY 确认
  bun run perm -- --off             非交互关闭
  bun run perm -- --dry-run         只打印将要写入的内容，不落盘

选项
  --switch <a,b>    只处理指定开关：${SWITCH_IDS.join(", ")}
  --only <a,b>      只处理指定 agent（名字 / id，支持模糊匹配）
  -y, --yes         非交互模式下跳过确认
  -n, --dry-run     只报告不改动
  -c, --check       只读检查
  -j, --json        JSON 输出
  -h, --help        显示本帮助

说明
  所有被修改的文件都会先备份到 ${c.cyan("~/.blanket/backups/<时间戳>/")}，写入是原子的。
  完全访问权限意味着 agent 可以不经确认地改你机器上的任何文件 —— 只在信任的机器上用。

退出码：0 正常 · 1 出错 · 3 --check 且有未开启项
`);
}

function takeValue(flag: string, inline: string | undefined, argv: string[], i: number): { value: string; next: number } {
  if (inline !== undefined) return { value: inline, next: i };
  const value = argv[i + 1];
  if (value === undefined) throw new Error(`${flag} 需要一个值`);
  return { value, next: i + 1 };
}

function parseArgs(argv: string[]): Options {
  const opts: Options = {
    json: false,
    check: false,
    dryRun: false,
    yes: false,
    on: false,
    off: false,
    switches: null,
    only: null,
  };

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
      case "-j":
      case "--json":
        opts.json = true;
        break;
      case "-c":
      case "--check":
        opts.check = true;
        break;
      case "-n":
      case "--dry-run":
        opts.dryRun = true;
        break;
      case "-y":
      case "--yes":
        opts.yes = true;
        break;
      case "--on":
        opts.on = true;
        break;
      case "--off":
        opts.off = true;
        break;
      case "--switch": {
        const { value, next } = takeValue(flag, inline, argv, i);
        i = next;
        const ids = value.split(",").map((s) => s.trim()).filter(Boolean);
        for (const id of ids) {
          if (!SWITCH_IDS.includes(id as SwitchId)) {
            throw new Error(`未知开关 "${id}"（可用：${SWITCH_IDS.join(", ")}）`);
          }
        }
        opts.switches = ids as SwitchId[];
        break;
      }
      case "--only": {
        const { value, next } = takeValue(flag, inline, argv, i);
        i = next;
        opts.only = value.split(",").map((s) => s.trim()).filter(Boolean);
        break;
      }
      default:
        if (arg.startsWith("-")) throw new Error(`未知参数 ${arg}（用 --help 看用法）`);
    }
  }

  if (opts.on && opts.off) throw new Error("--on 与 --off 不能同时用");
  return opts;
}

/** 收集所有「已支持但未开启」的开关，用于 --check 的退出码。 */
function closedSwitches(snapshots: readonly AgentSnapshot[], switches: readonly SwitchId[]): string[] {
  const closed: string[] = [];
  for (const snap of snapshots) {
    if (snap.error !== undefined) continue;
    for (const state of snap.states) {
      if (!state.supported || state.enabled) continue;
      if (!switches.includes(state.id)) continue;
      closed.push(`${snap.target.name} · ${switchLabel(state.id)}`);
    }
  }
  return closed;
}

/** 只读报告（--check / 非 TTY 下的默认输出）。 */
function report(snapshots: readonly AgentSnapshot[], switches: readonly SwitchId[]): void {
  const rows: string[][] = [];
  for (const snap of snapshots) {
    const installed = snap.installed ? c.green("✓") : c.dim("–");
    for (const state of snap.states) {
      if (!switches.includes(state.id)) continue;
      const status = !state.supported
        ? c.dim("不支持")
        : state.enabled
          ? c.green("● 已开")
          : c.yellow("○ 已关");
      const detail = snap.error !== undefined ? c.red(snap.error) : state.unsupportedReason ?? state.evidence;
      rows.push([snap.target.name, installed, switchLabel(state.id), status, detail]);
    }
  }
  process.stdout.write(
    `\n${c.bold("blanket · agent 权限状态")}\n\n` +
      renderTable(
        [
          { title: "agent" },
          { title: "已装" },
          { title: "开关" },
          { title: "状态" },
          { title: "依据" },
        ],
        rows,
      ) +
      "\n\n",
  );
  const closed = closedSwitches(snapshots, switches);
  if (closed.length > 0) {
    process.stdout.write(`${c.yellow(`未开启：${closed.join("、")}`)}\n`);
    process.stdout.write(c.dim("打开：bun run perm   （TUI）或 bun run perm -- --on --yes\n\n"));
  } else {
    process.stdout.write(c.green("全部已开启。\n\n"));
  }
}

/** JSON 输出。 */
function emitJson(snapshots: readonly AgentSnapshot[], switches: readonly SwitchId[]): void {
  const payload = {
    switches: SWITCHES.map((s) => ({ id: s.id, label: s.label })),
    agents: snapshots.map((snap) => ({
      id: snap.target.id,
      name: snap.target.name,
      installed: snap.installed,
      binPath: snap.binPath,
      error: snap.error ?? null,
      switches: snap.states
        .filter((s) => switches.includes(s.id))
        .map((s) => ({
          id: s.id,
          label: switchLabel(s.id),
          supported: s.supported,
          enabled: s.enabled,
          evidence: s.evidence,
          unsupportedReason: s.unsupportedReason ?? null,
        })),
    })),
  };
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

/** 非交互应用：把选中的开关设成 on/off。 */
async function applyNonInteractive(
  snapshots: readonly AgentSnapshot[],
  switches: readonly SwitchId[],
  on: boolean,
  dryRun: boolean,
): Promise<number> {
  const changes: PendingChange[] = [];
  for (const snap of snapshots) {
    if (snap.error !== undefined) continue;
    for (const state of snap.states) {
      if (!state.supported || !switches.includes(state.id)) continue;
      if (state.enabled === on) continue;
      changes.push({ target: snap.target, switchId: state.id, on });
    }
  }

  if (changes.length === 0) {
    process.stdout.write(c.green(`\n已经是目标状态，无需改动。\n\n`));
    return EXIT.ok;
  }

  const results = await applyChanges(changes, dryRun);
  process.stdout.write(`\n${c.bold(dryRun ? "将要写入（--dry-run，未落盘）" : "写入结果")}\n\n`);

  let failed = 0;
  for (const { change, plan, results: applied } of results) {
    process.stdout.write(`  ${on ? c.green("开启") : c.dim("关闭")} ${c.bold(change.target.name)} · ${switchLabel(change.switchId)}\n`);
    if (plan.edits.length === 0) {
      process.stdout.write(c.dim(`    ${plan.note ?? "无需改动"}\n`));
      continue;
    }
    if (dryRun) {
      for (const edit of plan.edits) {
        process.stdout.write(`    ${c.cyan(edit.path)}\n`);
        process.stdout.write(c.dim(`    ${edit.note}\n`));
      }
      continue;
    }
    for (const result of applied) {
      if (result.status === "failed") failed++;
      const mark = result.status === "written" ? c.green("✓") : result.status === "skipped" ? c.dim("=") : c.red("✗");
      process.stdout.write(`    ${mark} ${result.path} ${c.dim(result.note)}\n`);
      if (result.backup !== null && result.backup !== undefined) {
        process.stdout.write(c.dim(`      备份 ${result.backup}\n`));
      }
      if (result.error !== undefined) process.stdout.write(c.red(`      ${result.error}\n`));
    }
  }
  process.stdout.write("\n");
  return failed > 0 ? EXIT.error : EXIT.ok;
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const switches: SwitchId[] = opts.switches ?? SWITCH_IDS;

  const targets = findTargets(opts.only, AGENT_TARGETS);
  if (opts.only !== null && targets.length === 0) {
    throw new Error(`没有匹配的 agent：${opts.only.join(", ")}（可用：${AGENT_TARGETS.map((t) => t.id).join(", ")}）`);
  }

  const load = () => inspectAll(targets);
  const snapshots = await load();

  if (opts.json) {
    emitJson(snapshots, switches);
    process.exit(opts.check && closedSwitches(snapshots, switches).length > 0 ? EXIT.notOpen : EXIT.ok);
  }

  if (opts.check) {
    report(snapshots, switches);
    process.exit(closedSwitches(snapshots, switches).length > 0 ? EXIT.notOpen : EXIT.ok);
  }

  if (opts.on || opts.off) {
    const interactive = process.stdin.isTTY && process.stdout.isTTY;
    if (!opts.dryRun && !opts.yes && interactive) {
      // 交互确认一次，避免脚本里误触
      process.stdout.write(`\n将把所有 agent 的 ${switches.map(switchLabel).join("、")} 设为${opts.on ? "开启" : "关闭"}。确认？[y/N] `);
      const answer = await new Promise<string>((resolve) => {
        process.stdin.setRawMode?.(true);
        process.stdin.resume();
        process.stdin.once("data", (data) => {
          process.stdin.setRawMode?.(false);
          process.stdin.pause();
          resolve(String(data).trim().toLowerCase());
        });
      });
      if (answer !== "y" && answer !== "yes") {
        process.stdout.write("\n已取消。\n\n");
        process.exit(EXIT.ok);
      }
    }
    process.exit(await applyNonInteractive(snapshots, switches, opts.on, opts.dryRun));
  }

  // 默认：TUI
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    report(snapshots, switches);
    process.stdout.write(c.dim("（非交互终端：上面是只读报告；要改动请用 --on/--off）\n\n"));
    process.exit(EXIT.ok);
  }

  const tui = new PermissionTui(snapshots);
  await tui.run(load);
  process.exit(EXIT.ok);
}

main().catch((error: unknown) => {
  process.stderr.write(`${c.red("错误")} ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(EXIT.error);
});
