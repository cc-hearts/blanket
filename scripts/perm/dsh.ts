/**
 * DeepSeek Harness 适配器。
 *
 * 机制（已对着安装的 0.1.5-rc.2 源码核实）：
 *   - 权限由两个旋钮决定：沙箱模式（read-only / workspace-write / danger-full-access）
 *     与审批策略（ask / never）。
 *   - 二者被 `@deepseek-ai/dsh-permission-presets` 打包成具名预设，预设表由
 *     `@deepseek-ai/dsh-base` 的 cordis.patch.yml 定义，包含 danger-full-access
 *     = (danger-full-access, never)。
 *   - **新会话**取 `settings.yaml` 里 `permission.defaultPreset` 作为默认预设
 *     （`pinInitialPermission`：全新会话直接用 defaultPreset 写 preset + 两个旋钮）。
 *     所以把它设成 danger-full-access，就等于以后每个新会话默认完全访问，
 *     不用再逐个项目/会话点同意。
 *   - 已经存在的会话不受影响（预设只在创建时钉住），这是文档明确的设计。
 *
 * DSH 没有「按项目授权」的概念，沙箱模式按会话生效，所以 trust-all 对它不适用。
 */

import { join } from "node:path";
import { homedir } from "node:os";
import { getYamlScalar, readText, setYamlScalar, unsetYamlScalar } from "./files";
import type { AgentTarget, SwitchPlan, SwitchState } from "./types";

const FULL_PRESET = "danger-full-access";
/** 关闭时回到部署默认预设。 */
const DEFAULT_PRESET = "workspace-write";

/** 解析 DSH home：$DSH_HOME（非空）优先，否则 ~/.dsh。 */
function dshHome(): string {
  const env = process.env.DSH_HOME;
  if (env !== undefined && env.trim().length > 0) return env;
  return join(homedir(), ".dsh");
}

function settingsPath(): string {
  return join(dshHome(), "settings.yaml");
}

export const dshTarget: AgentTarget = {
  id: "dsh",
  name: "DeepSeek Harness",
  bin: "dsh",

  inspect(): SwitchState[] {
    const path = settingsPath();
    const text = readText(path);
    const preset = text === null ? null : getYamlScalar(text, "permission", "defaultPreset");
    const enabled = preset === FULL_PRESET;

    let evidence: string;
    if (text === null) {
      evidence = `${path} 不存在（新会话会用部署默认 workspace-write）`;
    } else if (preset === null) {
      evidence = `${path}: 未设置 permission.defaultPreset → 新会话用部署默认 workspace-write`;
    } else {
      evidence = `${path}: permission.defaultPreset = ${preset}`;
    }

    return [
      {
        id: "full-access",
        supported: true,
        enabled,
        evidence,
      },
      {
        id: "trust-all",
        supported: false,
        enabled: enabled,
        evidence: "DSH 的沙箱模式按会话生效，没有按项目授权的开关",
        unsupportedReason:
          "DSH 不存在「逐项目信任」这一步；权限按会话钉住，由「完全访问权限」开关统一覆盖",
      },
    ];
  },

  plan(switchId, on): SwitchPlan {
    if (switchId !== "full-access") {
      return { switchId, on, edits: [], note: "DSH 不支持这个开关" };
    }
    const path = settingsPath();
    const text = readText(path) ?? "";
    const current = getYamlScalar(text, "permission", "defaultPreset");

    if (on) {
      if (current === FULL_PRESET) {
        return { switchId, on, edits: [], note: `已经是 ${FULL_PRESET}，无需改动` };
      }
      return {
        switchId,
        on,
        edits: [
          {
            path,
            next: setYamlScalar(text, "permission", "defaultPreset", FULL_PRESET),
            note: `新会话默认预设 → ${FULL_PRESET}（完全访问，不再弹审批）`,
          },
        ],
      };
    }

    // 关闭：只有「确实是我们设的完全访问」才动手。
    // 删掉这个键让 DSH 回落到部署默认 workspace-write —— 比写死一个我们猜的值更安全，
    // 也保证「开→关」能字节级还原。
    if (current !== FULL_PRESET) {
      const why =
        current === null
          ? "本来就没设置，新会话用部署默认 workspace-write"
          : `当前是显式设置的 ${current}，不属于本开关管的范围，不动它`;
      return { switchId, on, edits: [], note: why };
    }

    return {
      switchId,
      on,
      edits: [
        {
          path,
          next: unsetYamlScalar(text, "permission", "defaultPreset"),
          note: `移除 permission.defaultPreset，回落到部署默认 ${DEFAULT_PRESET}`,
        },
      ],
    };
  },
};
