/**
 * pi 适配器。
 *
 * 机制（对着安装的 1.1.0 dist 源码核实）：
 *   - 完全访问：pi **本来就不在每次工具调用前问审批**（docs/security.md 明确写了
 *     "it does not ask for approval before every tool call"），settings schema 里也没有
 *     任何审批开关。所以这个开关对 pi 没有可写的东西 —— 如实报「不支持」，
 *     而不是编一个键写进去。
 *   - 项目信任：`~/.pi/agent/settings.json` 的 `defaultProjectTrust: "always"`。
 *     dist/core/project-trust.js 的逻辑：trustStore 里没有该目录的决定时，
 *     读 defaultProjectTrust，"always" 直接返回 true 不弹窗；"ask" 才弹。
 *     这是真正的全局开关，比逐个目录写 trust.json 好得多。
 *
 * settings.json 会被 SettingsManager.flush() 回写，但只在设置真的变化时；
 * 我们只加一个键，且写入是原子替换 + 备份，冲突窗口很小。
 */

import { join } from "node:path";
import { homedir } from "node:os";
import { getJsonPath, readText, setJsonPath, unsetJsonPath } from "./files";
import type { AgentTarget, SwitchPlan, SwitchState } from "./types";

const TRUST_ALWAYS = "always";

/** pi 的 agent 目录：$PI_AGENT_DIR 优先，否则 ~/.pi/agent。 */
function agentDir(): string {
  const env = process.env.PI_AGENT_DIR;
  if (env !== undefined && env.trim().length > 0) return env;
  return join(homedir(), ".pi", "agent");
}

function settingsPath(): string {
  return join(agentDir(), "settings.json");
}

export const piTarget: AgentTarget = {
  id: "pi",
  name: "pi",
  bin: "pi",

  inspect(): SwitchState[] {
    const path = settingsPath();
    const text = readText(path);
    const trust = getJsonPath(text, ["defaultProjectTrust"]);
    const trustEnabled = trust === TRUST_ALWAYS;

    let trustEvidence: string;
    if (text === null) trustEvidence = `${path} 不存在`;
    else if (typeof trust === "string") trustEvidence = `${path}: defaultProjectTrust = ${trust}`;
    else trustEvidence = `${path}: 未设置 defaultProjectTrust（等价于 ask，会弹信任对话框）`;

    return [
      {
        id: "full-access",
        supported: false,
        enabled: true,
        evidence: "pi 默认就不在每次工具调用前问审批，也没有审批开关",
        unsupportedReason:
          "pi 没有审批/沙箱配置：它默认就以启动者的权限读写执行。无需也无法用配置打开",
      },
      {
        id: "trust-all",
        supported: true,
        enabled: trustEnabled,
        evidence: trustEvidence,
      },
    ];
  },

  plan(switchId, on): SwitchPlan {
    if (switchId !== "trust-all") {
      return { switchId, on, edits: [], note: "pi 没有这个开关（它默认就不问审批）" };
    }
    const path = settingsPath();
    const text = readText(path);
    const current = getJsonPath(text, ["defaultProjectTrust"]);

    if (on) {
      if (current === TRUST_ALWAYS) return { switchId, on, edits: [], note: "已经是 always，无需改动" };
      const next = setJsonPath(text, ["defaultProjectTrust"], TRUST_ALWAYS);
      if (next === null) return { switchId, on, edits: [], note: `${path} 不是合法 JSON，拒绝改写` };
      return {
        switchId,
        on,
        edits: [{ path, next, note: `defaultProjectTrust → ${TRUST_ALWAYS}（所有项目都不再弹信任对话框）` }],
      };
    }

    if (current !== TRUST_ALWAYS) {
      return {
        switchId,
        on,
        edits: [],
        note: current === undefined ? "本来就没设置" : `当前是 ${String(current)}，不属于本开关管的范围`,
      };
    }
    const next = unsetJsonPath(text, ["defaultProjectTrust"]);
    if (next === null) return { switchId, on, edits: [], note: `${path} 不是合法 JSON，拒绝改写` };
    return { switchId, on, edits: [{ path, next, note: "移除 defaultProjectTrust，回到 ask（会弹信任对话框）" }] };
  },
};
