/**
 * 适配器注册表。
 *
 * 每个 agent 一个模块，导出一个 AgentTarget。新增 agent = 加一个文件 + 这里加一行。
 * 找不到的二进制不影响其它 agent：inspect 会把「未安装」如实报出来。
 */

import type { AgentTarget } from "./types";
import { dshTarget } from "./dsh";
import { claudeTarget } from "./claude";
import { codexTarget } from "./codex";
import { opencodeTarget } from "./opencode";
import { piTarget } from "./pi";
import { ompTarget } from "./omp";

export const AGENT_TARGETS: readonly AgentTarget[] = [
  dshTarget,
  claudeTarget,
  codexTarget,
  opencodeTarget,
  piTarget,
  ompTarget,
] as const;

/**
 * 按查询串挑出 agent：先精确匹配 id / 名字，再退回子串匹配。
 * queries 为 null 时返回全部。
 */
export function findTargets(queries: readonly string[] | null, targets: readonly AgentTarget[]): AgentTarget[] {
  if (queries === null) return [...targets];
  const picked = new Set<AgentTarget>();
  for (const query of queries) {
    const q = query.trim().toLowerCase();
    if (q.length === 0) continue;
    const exact = targets.filter((t) => t.id.toLowerCase() === q || t.name.toLowerCase() === q);
    const pool = exact.length > 0 ? exact : targets.filter((t) => t.id.toLowerCase().includes(q) || t.name.toLowerCase().includes(q));
    for (const t of pool) picked.add(t);
  }
  // 保持注册表顺序，输出稳定
  return targets.filter((t) => picked.has(t));
}
