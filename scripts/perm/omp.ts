/**
 * omp（oh-my-pi）适配器。
 *
 * 机制（对着安装的 18.8.7 src 源码 + `omp config get` 实测）：
 *   - 完全访问：`~/.omp/agent/config.yml` 的 `tools.approvalMode`，取值
 *     `always-ask | write | yolo`。schema 默认**本来就是 yolo**（实测
 *     `omp config get tools.approvalMode` 输出 yolo），所以显式写进去只是把
 *     「当前默认」钉成「明确意图」，防止上游改默认值后我们被动变严。
 *   - 项目信任：omp **没有**任何项目信任门（源码里 isProjectTrusted 硬编码返回 true），
 *     所以 trust-all 不适用。
 *
 * 注意：omp 用严格 schema 校验，未知键会**报错**而不是忽略；写入必须用
 * `omp config set` 或只写已知键。这里只写已知键，并且用最小文本手术保住注释 ——
 * 因为 omp 自己回写 config.yml 时会丢掉注释（它用整篇 stringify）。
 */

import { join } from "node:path";
import { homedir } from "node:os";
import { getYamlScalar, readText, setYamlScalar } from "./files";
import type { AgentTarget, SwitchPlan, SwitchState } from "./types";

const MODE_YOLO = "yolo";
/** 关闭时回到「写操作自动批准、其它询问」这一档，比 always-ask 更接近用户原本的默认。 */
const MODE_WRITE = "write";

/** omp 的 agent 目录：$OMP_AGENT_DIR 优先，否则 ~/.omp/agent。 */
function agentDir(): string {
  const env = process.env.OMP_AGENT_DIR;
  if (env !== undefined && env.trim().length > 0) return env;
  return join(homedir(), ".omp", "agent");
}

function configPath(): string {
  return join(agentDir(), "config.yml");
}

export const ompTarget: AgentTarget = {
  id: "omp",
  name: "omp",
  bin: "omp",

  inspect(): SwitchState[] {
    const path = configPath();
    const text = readText(path);
    const mode = text === null ? null : getYamlScalar(text, "tools", "approvalMode");
    const enabled = mode === MODE_YOLO || mode === null; // 未设置 = schema 默认 yolo

    let evidence: string;
    if (text === null) evidence = `${path} 不存在（schema 默认就是 yolo）`;
    else if (mode === null) evidence = `${path}: 未显式设置 tools.approvalMode，走 schema 默认 yolo`;
    else evidence = `${path}: tools.approvalMode = ${mode}`;

    return [
      { id: "full-access", supported: true, enabled, evidence },
      {
        id: "trust-all",
        supported: false,
        enabled,
        evidence: "omp 没有项目信任门（源码里 isProjectTrusted 恒为 true）",
        unsupportedReason: "omp 本来就不会为项目信任弹窗，无需这个开关",
      },
    ];
  },

  plan(switchId, on): SwitchPlan {
    if (switchId !== "full-access") {
      return { switchId, on, edits: [], note: "omp 不支持这个开关" };
    }
    const path = configPath();
    const text = readText(path) ?? "";
    const current = getYamlScalar(text, "tools", "approvalMode");

    if (on) {
      if (current === MODE_YOLO) return { switchId, on, edits: [], note: "已经是 yolo，无需改动" };
      return {
        switchId,
        on,
        edits: [
          {
            path,
            next: setYamlScalar(text, "tools", "approvalMode", MODE_YOLO),
            note: `tools.approvalMode → ${MODE_YOLO}（所有层级工具调用都免确认）`,
          },
        ],
      };
    }

    // 未显式设置时本来就走 yolo 默认，关闭必须显式降档，否则「关」是假的。
    if (current !== null && current !== MODE_YOLO) {
      return { switchId, on, edits: [], note: `当前是 ${current}，不属于本开关管的范围` };
    }
    return {
      switchId,
      on,
      edits: [
        {
          path,
          next: setYamlScalar(text, "tools", "approvalMode", MODE_WRITE),
          note: `tools.approvalMode → ${MODE_WRITE}（写操作自动批准，其它仍会询问）`,
        },
      ],
    };
  },
};
