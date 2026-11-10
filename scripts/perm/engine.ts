/**
 * 编排层：把适配器的「计划」变成「落盘」，并统一负责备份与错误收集。
 *
 * 适配器不碰磁盘，所有写入都从这里出去 —— 于是 --dry-run 只是「打印计划不执行」，
 * 备份策略也只有一处。
 */

import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { writeWithBackup } from "./files";
import type { AgentTarget, ApplyResult, SwitchId, SwitchPlan, SwitchState } from "./types";

/** 一个 agent 的完整现状。 */
export interface AgentSnapshot {
  target: AgentTarget;
  /** 二进制是否在 PATH 上 */
  installed: boolean;
  /** 解析出的可执行文件路径 */
  binPath: string | null;
  states: SwitchState[];
  /** inspect 抛错时的说明 */
  error?: string;
}

/** 找出命令在 PATH 上的真实路径；找不到返回 null。 */
export function which(bin: string): string | null {
  try {
    const out = execFileSync("/usr/bin/which", [bin], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    const path = out.trim();
    return path.length > 0 && existsSync(path) ? path : null;
  } catch {
    return null;
  }
}

/** 读一个 agent 的现状；任何失败都降级成快照里的 error，不抛出。 */
export async function inspect(target: AgentTarget): Promise<AgentSnapshot> {
  const binPath = which(target.bin);
  try {
    const states = await target.inspect();
    return { target, installed: binPath !== null, binPath, states };
  } catch (error) {
    return {
      target,
      installed: binPath !== null,
      binPath,
      states: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** 并发读多个 agent 的现状。 */
export function inspectAll(targets: readonly AgentTarget[]): Promise<AgentSnapshot[]> {
  return Promise.all(targets.map((t) => inspect(t)));
}

/** 执行一个计划：逐个文件备份 + 原子写。 */
export function applyPlan(plan: SwitchPlan): ApplyResult[] {
  return plan.edits.map((edit) => {
    try {
      const { backup, changed } = writeWithBackup(edit.path, edit.next);
      if (!changed) return { path: edit.path, note: edit.note, status: "skipped" as const };
      return {
        path: edit.path,
        note: edit.note,
        status: "written" as const,
        ...(backup === null ? {} : { backup }),
      };
    } catch (error) {
      return {
        path: edit.path,
        note: edit.note,
        status: "failed" as const,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });
}

/** 一个待执行的变更（TUI 里暂存、CLI 里直接构造）。 */
export interface PendingChange {
  target: AgentTarget;
  switchId: SwitchId;
  on: boolean;
}

/** 计算并执行一批变更；返回逐条结果。dryRun 时只计算不落盘。 */
export async function applyChanges(
  changes: readonly PendingChange[],
  dryRun: boolean,
): Promise<{ change: PendingChange; plan: SwitchPlan; results: ApplyResult[] }[]> {
  const out: { change: PendingChange; plan: SwitchPlan; results: ApplyResult[] }[] = [];
  for (const change of changes) {
    const plan = await change.target.plan(change.switchId, change.on);
    const results = dryRun ? [] : applyPlan(plan);
    out.push({ change, plan, results });
  }
  return out;
}
