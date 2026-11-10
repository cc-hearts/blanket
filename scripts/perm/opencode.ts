/**
 * OpenCode 适配器。
 *
 * 机制（对着 v2.0.26 的官方 config schema 核实 —— https://opencode.ai/config.json
 * 的 `$defs.Config` 里确实有顶层 `permission`，并且在隔离的 XDG_CONFIG_HOME 里用
 * `opencode debug config` 实测过它会归一化成通配 allow）：
 *
 *   - 完全访问：顶层 `permission: "allow"`（等价于 `[{action:"*",resource:"*",effect:"allow"}]`）。
 *     实测输出证实：写 `"permission": "allow"` 后 debug config 回显
 *     `"permissions": [{"action":"*","resource":"*","effect":"allow"}]`。
 *     注意：网上有说法用 `session.permissions: "autoaccept"`，**那个是错的** ——
 *     实测它被 schema 直接丢弃，debug config 里根本不出现。
 *   - 项目信任：OpenCode 没有逐项目信任这一层，所以 trust-all 不适用。
 */

import { join } from "node:path";
import { homedir } from "node:os";
import { getJsonPath, readText, setJsonPath, unsetJsonPath } from "./files";
import type { AgentTarget, SwitchPlan, SwitchState } from "./types";

const PERMISSION_ALLOW = "allow";

/** 尊重 XDG_CONFIG_HOME，与 OpenCode 自己的解析保持一致。 */
function configPath(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  const base = xdg !== undefined && xdg.trim().length > 0 ? xdg : join(homedir(), ".config");
  return join(base, "opencode", "opencode.json");
}

export const opencodeTarget: AgentTarget = {
  id: "opencode",
  name: "OpenCode",
  bin: "opencode",

  inspect(): SwitchState[] {
    const path = configPath();
    const text = readText(path);
    const value = getJsonPath(text, ["permission"]);
    // permission 可以是字符串 "allow"，也可以是对象形式；两种都算开启
    const enabled = value === PERMISSION_ALLOW || (typeof value === "object" && value !== null);

    let evidence: string;
    if (text === null) evidence = `${path} 不存在`;
    else if (value === undefined) evidence = `${path}: 未设置 permission（默认每个工具都问）`;
    else evidence = `${path}: permission = ${JSON.stringify(value)}`;

    return [
      { id: "full-access", supported: true, enabled, evidence },
      {
        id: "trust-all",
        supported: false,
        enabled,
        evidence: "OpenCode 没有逐项目信任这一层",
        unsupportedReason: "OpenCode 不存在项目信任弹窗，无需这个开关",
      },
    ];
  },

  plan(switchId, on): SwitchPlan {
    if (switchId !== "full-access") {
      return { switchId, on, edits: [], note: "OpenCode 不支持这个开关" };
    }
    const path = configPath();
    const text = readText(path);
    const current = getJsonPath(text, ["permission"]);

    if (on) {
      if (current === PERMISSION_ALLOW) return { switchId, on, edits: [], note: "已经是 allow，无需改动" };
      const next = setJsonPath(text, ["permission"], PERMISSION_ALLOW);
      if (next === null) return { switchId, on, edits: [], note: `${path} 不是合法 JSON，拒绝改写` };
      return {
        switchId,
        on,
        edits: [{ path, next, note: `permission → "${PERMISSION_ALLOW}"（所有工具免确认）` }],
      };
    }

    if (current !== PERMISSION_ALLOW) {
      return {
        switchId,
        on,
        edits: [],
        note: current === undefined ? "本来就没设置" : `当前是 ${JSON.stringify(current)}，不属于本开关管的范围`,
      };
    }
    const next = unsetJsonPath(text, ["permission"]);
    if (next === null) return { switchId, on, edits: [], note: `${path} 不是合法 JSON，拒绝改写` };
    return { switchId, on, edits: [{ path, next, note: "移除 permission，回到默认询问" }] };
  },
};
