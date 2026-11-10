/**
 * Claude Code 适配器。
 *
 * 机制（对着安装的 2.1.296 二进制字符串核实）：
 *   - 完全访问需要**两个**文件配合：
 *     1. `~/.claude/settings.json` 的 `permissions.defaultMode = "bypassPermissions"` ——
 *        二进制里有明确文案承认这条路径（"a settings defaultMode of bypassPermissions"）。
 *     2. `~/.claude.json` 的 `bypassPermissionsModeAccepted = true` —— 二进制里
 *        `Fft()` 把 bypass 的门控建在这个键上（`V5e() || ce().bypassPermissionsModeAccepted`），
 *        且它自己的 eval 沙箱初始化 .claude.json 时正是写这个键。还有一条诊断文案
 *        "[permissions] bypass consent was accepted but user settings do not show it ...
 *        so bypass is not passed on" 说明这个「同意」状态是绕过检查的必要条件。
 *     只写 defaultMode 有可能被降级回 default，所以两个一起写。
 *   - 项目信任：`~/.claude.json` 的 `projects.<绝对路径>.hasTrustDialogAccepted = true`。
 *     Claude Code **没有**「信任所有目录」的全局开关（二进制里搜 trustedDirectories /
 *     skipTrustDialog / trustAllProjects 全无结果），所以 trust-all 只能按目录写。
 *
 * 两个文件都是启动时读一次，不热加载；退出也不回写，所以写入时机不敏感。
 */

import { join } from "node:path";
import { homedir } from "node:os";
import { getJsonPath, readJson, readText, setJsonPath, unsetJsonPath } from "./files";
import type { AgentTarget, SwitchPlan, SwitchState } from "./types";

const MODE_BYPASS = "bypassPermissions";

/**
 * Claude Code 的配置目录覆盖：$CLAUDE_CONFIG_DIR。
 * 二进制里的解析是 `join(CLAUDE_CONFIG_DIR || homedir(), ".claude.json")`，
 * 而 settings.json 在 `join(CLAUDE_CONFIG_DIR || homedir()/.claude, "settings.json")`。
 * 所以两个文件的落点并不总是同一个目录，这里分别照抄它的算法。
 */
function configDirOverride(): string | null {
  const env = process.env.CLAUDE_CONFIG_DIR;
  return env !== undefined && env.trim().length > 0 ? env : null;
}

function settingsPath(): string {
  return join(configDirOverride() ?? join(homedir(), ".claude"), "settings.json");
}

/** 项目信任存放在 .claude.json 的 projects 映射里。 */
function projectsPath(): string {
  return join(configDirOverride() ?? homedir(), ".claude.json");
}

/** 当前工作目录是默认要信任的项目；用真实路径，避免符号链接不一致。 */
function projectDir(): string {
  return process.cwd();
}

export const claudeTarget: AgentTarget = {
  id: "claude",
  name: "Claude Code",
  bin: "claude",

  inspect(): SwitchState[] {
    const settings = settingsPath();
    const settingsText = readText(settings);
    const mode = getJsonPath(settingsText, ["permissions", "defaultMode"]);
    const projPath = projectsPath();
    const projText = readText(projPath);
    const accepted = getJsonPath(projText, ["bypassPermissionsModeAccepted"]) === true;
    const enabled = mode === MODE_BYPASS && accepted;

    let evidence: string;
    if (settingsText === null) {
      evidence = `${settings} 不存在`;
    } else if (mode === MODE_BYPASS && accepted) {
      evidence = `${settings}: permissions.defaultMode = ${MODE_BYPASS} + ${projPath}: bypassPermissionsModeAccepted = true`;
    } else if (mode === MODE_BYPASS) {
      evidence = `${settings}: defaultMode = ${MODE_BYPASS}，但 ${projPath} 的 bypassPermissionsModeAccepted 不是 true（可能被降级回 default）`;
    } else if (typeof mode === "string") {
      evidence = `${settings}: permissions.defaultMode = ${mode}`;
    } else {
      evidence = `${settings}: 未设置 permissions.defaultMode（默认每次询问）`;
    }

    const trusted = getJsonPath(projText, ["projects", projectDir(), "hasTrustDialogAccepted"]);
    const trustEnabled = trusted === true;
    const trustEvidence =
      projText === null
        ? `${projPath} 不存在`
        : trustEnabled
          ? `${projPath}: projects["${projectDir()}"].hasTrustDialogAccepted = true`
          : `${projPath}: 未信任当前目录（${projectDir()}）`;

    return [
      { id: "full-access", supported: true, enabled, evidence },
      {
        id: "trust-all",
        supported: true,
        enabled: trustEnabled,
        evidence: trustEvidence,
        unsupportedReason:
          "Claude Code 没有「信任所有目录」的全局开关，只能按目录写；本开关处理当前目录 " + projectDir(),
      },
    ];
  },

  plan(switchId, on): SwitchPlan {
    if (switchId === "full-access") {
      const path = settingsPath();
      const text = readText(path);
      const current = getJsonPath(text, ["permissions", "defaultMode"]);

      const projPath = projectsPath();
      const projText = readText(projPath);
      const accepted = getJsonPath(projText, ["bypassPermissionsModeAccepted"]) === true;

      if (on) {
        if (current === MODE_BYPASS && accepted) {
          return { switchId, on, edits: [], note: `已经是 ${MODE_BYPASS} 且已接受免责声明，无需改动` };
        }
        const edits: SwitchPlan["edits"] = [];
        if (current !== MODE_BYPASS) {
          const next = setJsonPath(text, ["permissions", "defaultMode"], MODE_BYPASS);
          if (next === null) return { switchId, on, edits: [], note: `${path} 不是合法 JSON，拒绝改写` };
          edits.push({ path, next, note: `permissions.defaultMode → ${MODE_BYPASS}（跳过所有权限检查）` });
        }
        if (!accepted) {
          const nextProj = setJsonPath(projText, ["bypassPermissionsModeAccepted"], true);
          if (nextProj === null) return { switchId, on, edits: [], note: `${projPath} 不是合法 JSON，拒绝改写` };
          edits.push({
            path: projPath,
            next: nextProj,
            note: "bypassPermissionsModeAccepted → true（记下已接受 bypass 免责声明，否则会被降级回 default）",
          });
        }
        return { switchId, on, edits };
      }

      // 关闭：只回退本开关写进去的东西
      if (current !== MODE_BYPASS && !accepted) {
        return { switchId, on, edits: [], note: "本来就没开启完全访问" };
      }
      const edits: SwitchPlan["edits"] = [];
      if (current === MODE_BYPASS) {
        const next = unsetJsonPath(text, ["permissions", "defaultMode"]);
        if (next === null) return { switchId, on, edits: [], note: `${path} 不是合法 JSON，拒绝改写` };
        edits.push({ path, next, note: "移除 permissions.defaultMode，回到默认询问" });
      }
      if (accepted) {
        const nextProj = unsetJsonPath(projText, ["bypassPermissionsModeAccepted"]);
        if (nextProj === null) return { switchId, on, edits: [], note: `${projPath} 不是合法 JSON，拒绝改写` };
        edits.push({ path: projPath, next: nextProj, note: "移除 bypassPermissionsModeAccepted" });
      }
      return { switchId, on, edits };
    }

    // trust-all：按目录写 hasTrustDialogAccepted
    const path = projectsPath();
    const text = readText(path);
    const dir = projectDir();
    const current = getJsonPath(text, ["projects", dir, "hasTrustDialogAccepted"]);

    if (on) {
      if (current === true) return { switchId, on, edits: [], note: `${dir} 已信任` };
      const next = setJsonPath(text, ["projects", dir, "hasTrustDialogAccepted"], true);
      if (next === null) return { switchId, on, edits: [], note: `${path} 不是合法 JSON，拒绝改写` };
      return { switchId, on, edits: [{ path, next, note: `信任 ${dir}（不再弹信任对话框）` }] };
    }

    if (current !== true) return { switchId, on, edits: [], note: `${dir} 本来就没被标记信任` };
    const next = unsetJsonPath(text, ["projects", dir, "hasTrustDialogAccepted"]);
    if (next === null) return { switchId, on, edits: [], note: `${path} 不是合法 JSON，拒绝改写` };
    return { switchId, on, edits: [{ path, next, note: `取消信任 ${dir}` }] };
  },
};
