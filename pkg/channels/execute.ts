/** 执行升级并复核结果：命令成功不等于升级成功，必须重新探测版本。 */

import type { AgentInspection } from "./inspect";
import { evaluateUpgradeResult } from "./plan";
import type { RunResult } from "./run";

export interface ExecuteDeps {
  run: (argv: string[]) => Promise<RunResult>;
  probeVersion: (path: string) => Promise<string | null>;
}

function firstMeaningfulLine(text: string): string | null {
  return (
    text
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? null
  );
}

export async function executeUpgrade(
  inspection: AgentInspection,
  deps: ExecuteDeps,
): Promise<AgentInspection> {
  if (inspection.status !== "outdated" || inspection.command === null || inspection.path === null) {
    return inspection;
  }

  const result = await deps.run(inspection.command);
  if (result.code !== 0) {
    return {
      ...inspection,
      status: "failed",
      note: firstMeaningfulLine(result.stderr) ?? `退出码 ${result.code}`,
    };
  }

  const after = await deps.probeVersion(inspection.path);
  const evaluation = evaluateUpgradeResult(inspection.current, after, inspection.target);
  return {
    ...inspection,
    status: evaluation.status,
    current: after ?? inspection.current,
    note: evaluation.note,
  };
}

/**
 * mise 升级后，当前 shell 的 PATH 往往还指着旧版本目录（mise activate 的
 * PATH 不会自动刷新）。只对“PATH 直接指向版本目录”的安装加提示；
 * 走 shim 的安装会自动解析到新版本，不需要。
 */
export function addStalePathNote(inspection: AgentInspection): AgentInspection {
  if (inspection.status !== "updated" || inspection.channel !== "mise") return inspection;
  if (inspection.path === null || !inspection.path.includes("/installs/")) return inspection;
  const note = "当前 shell 的 PATH 可能仍指向旧版本；重开 shell 或重新激活 mise 后生效";
  return {
    ...inspection,
    note: inspection.note === null ? note : `${inspection.note}；${note}`,
  };
}
