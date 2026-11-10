/**
 * TUI：把「agent × 权限开关」画成一张可上下移动、可切换、可预览再落盘的表格。
 *
 * 交互刻意做成两段式：space 只是把改动放进待办，a 才弹预览确认。
 * 这类开关一旦写错就是「agent 可以随便改我的机器」，所以不留一键直写。
 */

import { emitKeypressEvents } from "node:readline";
import { homedir } from "node:os";
import { c, displayWidth, pad, stripAnsi } from "../../pkg/ui";
import { compactDiff, diffLines } from "./diff";
import { applyChanges, type AgentSnapshot, type PendingChange } from "./engine";
import { readText } from "./files";
import type { ApplyResult, SwitchPlan, SwitchState } from "./types";

type Mode = "browse" | "confirm" | "applying" | "result";

interface Row {
  agent: AgentSnapshot;
  state: SwitchState;
  /** 该行能否被选中/切换 */
  selectable: boolean;
  /** 是否是该 agent 的第一行（用于只在首行画 agent 名） */
  first: boolean;
}

/** 把 ~ 前缀缩掉，让路径在窄终端里也看得见。 */
function shortPath(path: string): string {
  const home = homedir();
  return path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}

function keyOf(agentId: string, switchId: string): string {
  return `${agentId}:${switchId}`;
}

export class PermissionTui {
  private rows: Row[] = [];
  private cursor = 0;
  private mode: Mode = "browse";
  /** 待应用的改动：key → 目标状态 */
  private pending = new Map<string, boolean>();
  private plans: { change: PendingChange; plan: SwitchPlan; results: ApplyResult[] }[] = [];
  private message: string | null = null;
  private done = false;
  /** 确认/结果视图的滚动偏移（行） */
  private scroll = 0;
  /** diff 里每处改动上下保留的上下文行数 */
  private readonly diffContext = 2;
  private onKey: ((str: string, key: { name?: string; ctrl?: boolean; sequence?: string }) => void) | null = null;
  /** r 键重新读取时用的回调，由 run() 注入 */
  private reload: () => Promise<AgentSnapshot[]> = async () => this.snapshots;

  constructor(private readonly snapshots: AgentSnapshot[]) {
    this.rebuild();
  }

  /** 从快照重建行模型，并把光标夹回合法位置。 */
  private rebuild(): void {
    this.rows = [];
    for (const agent of this.snapshots) {
      agent.states.forEach((state, i) => {
        this.rows.push({ agent, state, selectable: state.supported && agent.error === undefined, first: i === 0 });
      });
    }
    if (this.cursor >= this.rows.length) this.cursor = Math.max(0, this.rows.length - 1);
    if (this.rows[this.cursor]?.selectable !== true) this.move(1);
  }

  /** 移动光标到下一个可选中行；direction=±1。 */
  private move(direction: number): void {
    const n = this.rows.length;
    if (n === 0) return;
    let i = this.cursor;
    for (let step = 0; step < n; step++) {
      i = (i + direction + n) % n;
      if (this.rows[i]?.selectable === true) {
        this.cursor = i;
        return;
      }
    }
  }

  /** 当前行的待定目标状态（没待定则返回现状）。 */
  private pendingTargets(): PendingChange[] {
    const changes: PendingChange[] = [];
    for (const row of this.rows) {
      const want = this.pending.get(keyOf(row.agent.target.id, row.state.id));
      if (want === undefined || want === row.state.enabled) continue;
      changes.push({ target: row.agent.target, switchId: row.state.id, on: want });
    }
    return changes;
  }

  /** 切换当前行的待定状态。 */
  private toggle(): void {
    const row = this.rows[this.cursor];
    if (row === undefined || !row.selectable) return;
    const key = keyOf(row.agent.target.id, row.state.id);
    const current = this.pending.get(key) ?? row.state.enabled;
    const next = !current;
    if (next === row.state.enabled) this.pending.delete(key);
    else this.pending.set(key, next);
    this.message = null;
  }

  private render(): void {
    const width = Math.max(60, Math.min(process.stdout.columns ?? 100, 120));
    const header: string[] = [
      "",
      ` ${c.bold("blanket · agent 权限开关")}`,
      ` ${c.dim("↑/↓ 移动/滚动 · space 切换 · a 应用 · r 重新读取 · q 退出")}`,
      "",
    ];

    // 确认 / 写入中 / 结果：底部提示固定，内容可滚动
    if (this.mode === "confirm" || this.mode === "applying" || this.mode === "result") {
      const body = this.renderPlan(width);
      const footer =
        this.mode === "confirm"
          ? [c.dim(" " + "─".repeat(Math.min(width - 2, 100))), ` ${c.bold("确认写入？")} ${c.green("y")} 确认 · ${c.red("n")} 取消 · ${c.dim("↑/↓ 滚动")}`, ""]
          : this.mode === "result"
            ? [c.dim(" " + "─".repeat(Math.min(width - 2, 100))), ` ${c.dim("按任意键返回 · 新会话/新项目才会用到新设置")}`, ""]
            : [""];
      this.paint(header, body, footer);
      return;
    }

    const body: string[] = [];
    const nameWidth = Math.max(...this.rows.map((r) => displayWidth(r.agent.target.name)), 12);
    const labelWidth = Math.max(...this.rows.map((r) => displayWidth(r.state.id === "full-access" ? "完全访问权限" : "信任所有项目")), 12);

    for (let i = 0; i < this.rows.length; i++) {
      const row = this.rows[i] as Row;
      const selected = i === this.cursor;
      const marker = selected ? c.cyan("▸") : " ";

      const name = row.first ? pad(row.agent.target.name, nameWidth) : pad("", nameWidth);
      const label = pad(row.state.id === "full-access" ? "完全访问权限" : "信任所有项目", labelWidth);

      let status: string;
      if (!row.state.supported) status = c.dim("– 不支持");
      else if (row.state.enabled) status = c.green("● 已开");
      else status = c.yellow("○ 已关");

      const key = keyOf(row.agent.target.id, row.state.id);
      const want = this.pending.get(key);
      let delta = "";
      if (want !== undefined && want !== row.state.enabled) {
        delta = want ? c.green(" → 将开") : c.dim(" → 将关");
      }

      const installed = row.first && !row.agent.installed ? c.dim(" (未安装)") : "";
      const line = ` ${marker} ${c.bold(name)}  ${label}  ${status}${delta}${installed}`;
      body.push(selected ? c.bold(line) : line);
    }

    body.push("");
    body.push(c.dim(" " + "─".repeat(Math.min(width - 2, 100))));

    const current = this.rows[this.cursor];
    if (current !== undefined) {
      body.push(` ${c.dim("说明")} ${stripAnsi(current.state.unsupportedReason ?? current.state.evidence)}`);
      if (current.agent.error !== undefined) body.push(` ${c.red("读取失败")} ${current.agent.error}`);
    }
    body.push("");

    const changes = this.pendingTargets();
    const footer: string[] = [];
    if (this.message !== null) footer.push(` ${c.yellow(this.message)}`);
    footer.push(
      changes.length > 0
        ? ` ${c.bold(c.yellow(`${changes.length} 项待应用`))} ${c.dim("— 按 a 查看将写入的内容")}`
        : ` ${c.dim("没有待应用的改动")}`,
    );
    footer.push("");

    this.paint(header, body, footer);
  }

  /** 渲染确认/结果视图：把每个计划要写的文件与变化行列出来。 */
  private renderPlan(width: number): string[] {
    const out: string[] = [];
    const rule = c.dim(" " + "─".repeat(Math.min(width - 2, 100)));

    if (this.mode === "confirm") {
      out.push(` ${c.bold("即将写入以下改动")}`);
      out.push(rule);
      for (const { change, plan } of this.plans) {
        const action = change.on ? c.green("开启") : c.dim("关闭");
        out.push(` ${action} ${c.bold(change.target.name)} · ${change.switchId === "full-access" ? "完全访问权限" : "信任所有项目"}`);
        if (plan.edits.length === 0) {
          out.push(c.dim(`   ${plan.note ?? "无需改动"}`));
          continue;
        }
        for (const edit of plan.edits) {
          out.push(`   ${c.cyan(shortPath(edit.path))}`);
          out.push(c.dim(`   ${edit.note}`));
          const before = readText(edit.path) ?? "";
          const result = diffLines(before, edit.next);
          if (result.added === 0 && result.removed === 0) {
            out.push(c.dim("   （内容无变化）"));
            continue;
          }
          // 行号 + 真 diff，并折叠掉远处未改动的行
          for (const line of compactDiff(result, this.diffContext)) {
            if (line.kind === "same" && line.text.startsWith("… 省略")) {
              out.push(c.dim(`   ${line.text}`));
              continue;
            }
            const no = line.kind === "add" ? line.newNo : line.oldNo;
            const gutter = String(no ?? "").padStart(5);
            const body = `${gutter} ${line.kind === "add" ? "+" : line.kind === "del" ? "-" : " "} ${line.text}`;
            out.push(
              line.kind === "add"
                ? c.green(`   ${body}`)
                : line.kind === "del"
                  ? c.red(`   ${body}`)
                  : `   ${body}`,
            );
          }
        }
        out.push("");
      }
      out.push(rule);
      out.push(` ${c.dim("改动前会自动备份到")} ${c.cyan("~/.blanket/backups/")}`);
      return out;
    }

    out.push(` ${c.bold(this.mode === "applying" ? "正在写入…" : "写入结果")}`);
    out.push(rule);
    for (const { change, plan, results } of this.plans) {
      const action = change.on ? c.green("开启") : c.dim("关闭");
      out.push(` ${action} ${c.bold(change.target.name)}`);
      if (plan.edits.length === 0) {
        out.push(c.dim(`   ${plan.note ?? "无需改动"}`));
        continue;
      }
      for (const result of results) {
        const mark =
          result.status === "written" ? c.green("✓") : result.status === "skipped" ? c.dim("=") : c.red("✗");
        out.push(`   ${mark} ${shortPath(result.path)} ${c.dim(result.note)}`);
        if (result.backup !== null && result.backup !== undefined) {
          out.push(c.dim(`     备份 ${shortPath(result.backup)}`));
        }
        if (result.error !== undefined) out.push(c.red(`     ${result.error}`));
      }
    }
    out.push(rule);
    return out;
  }

  /**
   * 画一屏：**头部与底部提示固定，中间内容可滚动**。
   *
   * 之前的实现只保留前 rows-1 行，内容一长就把最后的「确认写入？ y/n」切掉，
   * 界面看起来像卡死（其实在等一个看不见的 y）。所以这里把 footer 单独钉在底部，
   * 永不参与裁剪，并给中间内容标明滚动位置。
   */
  private paint(header: string[], body: string[], footer: string[]): void {
    const rows = Math.max(10, process.stdout.rows ?? 40);
    const avail = Math.max(1, rows - header.length - footer.length);
    const maxOffset = Math.max(0, body.length - avail);
    if (this.scroll > maxOffset) this.scroll = maxOffset;
    if (this.scroll < 0) this.scroll = 0;

    const slice = body.slice(this.scroll, this.scroll + avail);

    // 内容还有更多时，在最后一行位置提示，让用户知道能滚
    const more: string[] = [];
    if (maxOffset > 0) {
      const above = this.scroll;
      const below = maxOffset - this.scroll;
      more.push(
        c.dim(
          `   ${above > 0 ? `↑ ${above} 行` : ""}${above > 0 && below > 0 ? " · " : ""}${below > 0 ? `↓ ${below} 行` : ""}  （↑/↓ 滚动）`,
        ),
      );
    }

    const lines = [...header, ...slice, ...more, ...footer].slice(0, rows);
    process.stdout.write(`\x1b[2J\x1b[H${lines.join("\n")}`);
  }

  /** 进入确认视图前，把待定改动算成计划。 */
  private async prepare(): Promise<void> {
    const changes = this.pendingTargets();
    if (changes.length === 0) {
      this.message = "没有待应用的改动";
      this.render();
      return;
    }
    this.plans = await applyChanges(changes, true);
    this.mode = "confirm";
    this.scroll = 0;
    this.render();
  }

  /** 真正落盘。 */
  private async commit(): Promise<void> {
    const changes = this.pendingTargets();
    this.mode = "applying";
    this.render();
    this.plans = await applyChanges(changes, false);
    this.pending.clear();
    this.mode = "result";
    // 写完立刻回读一次，免得结果页退回列表时还显示旧的「已关」状态。
    const fresh = await this.reload();
    this.snapshots.length = 0;
    this.snapshots.push(...fresh);
    this.rebuild();
    this.render();
  }

  /** 重新读取所有 agent 的现状（r 键）。 */
  private async refresh(reload: () => Promise<AgentSnapshot[]>): Promise<void> {
    const fresh = await reload();
    this.snapshots.length = 0;
    this.snapshots.push(...fresh);
    this.pending.clear();
    this.plans = [];
    this.message = null;
    this.mode = "browse";
    this.rebuild();
  }

  /** 处理一个按键。 */
  private handle(str: string, key: { name?: string; ctrl?: boolean }): void {
    if (this.mode === "applying") return;

    // 确认/结果视图：↑/↓ 用来滚动内容，而不是移动列表光标
    if (this.mode === "confirm" || this.mode === "result") {
      switch (key.name) {
        case "up":
        case "k":
          this.scroll = Math.max(0, this.scroll - 1);
          this.render();
          return;
        case "down":
        case "j":
          this.scroll += 1;
          this.render();
          return;
        case "pageup":
          this.scroll = Math.max(0, this.scroll - 10);
          this.render();
          return;
        case "pagedown":
          this.scroll += 10;
          this.render();
          return;
        case "home":
          this.scroll = 0;
          this.render();
          return;
        default:
          break;
      }

      if (this.mode === "confirm") {
        if (str === "y" || str === "Y") void this.commit();
        else if (str === "n" || str === "N" || key.name === "escape") {
          this.mode = "browse";
          this.scroll = 0;
          this.render();
        }
        return;
      }

      // result：任意其它键返回列表
      this.mode = "browse";
      this.message = null;
      this.plans = [];
      this.scroll = 0;
      this.render();
      return;
    }

    if (key.ctrl && key.name === "c") {
      this.done = true;
      return;
    }
    switch (key.name) {
      case "q":
        this.done = true;
        return;
      case "up":
      case "k":
        this.move(-1);
        break;
      case "down":
      case "j":
        this.move(1);
        break;
      case "space":
      case "return":
        this.toggle();
        break;
      case "a":
        void this.prepare();
        return;
      case "r":
        void this.refresh(this.reload);
        return;
      default:
        break;
    }
    this.render();
  }

  /** 跑 TUI 主循环，直到用户退出。 */
  async run(reload: () => Promise<AgentSnapshot[]>): Promise<void> {
    this.reload = reload;
    const stdin = process.stdin;
    if (!stdin.isTTY) throw new Error("需要一个交互式终端才能跑 TUI（用 --check / --json 走非交互模式）");

    emitKeypressEvents(stdin);
    stdin.setRawMode(true);
    stdin.resume();

    this.onKey = (str, key) => this.handle(str, key);
    stdin.on("keypress", this.onKey);

    const cleanup = () => {
      if (this.onKey !== null) stdin.off("keypress", this.onKey);
      try {
        stdin.setRawMode(false);
      } catch {
        /* 已恢复 */
      }
      stdin.pause();
      process.stdout.write("\x1b[2J\x1b[H");
    };

    const onResize = () => this.render();
    process.stdout.on("resize", onResize);

    try {
      this.render();
      while (!this.done) await new Promise((resolve) => setTimeout(resolve, 40));
    } finally {
      process.stdout.off("resize", onResize);
      cleanup();
    }
  }
}
