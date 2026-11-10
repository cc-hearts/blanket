/**
 * Codex CLI 适配器。
 *
 * 机制（在隔离的 CODEX_HOME 里用 `codex doctor --json` 实测过）：
 *   - 完全访问：`~/.codex/config.toml` 里 `approval_policy = "never"` +
 *     `sandbox_mode = "danger-full-access"`。**这个组合本身是合法的** ——
 *     我在 /tmp 的干净 CODEX_HOME 里验证过 doctor 报 `config loaded`（status ok）。
 *     网上流传的「never + danger-full-access 会被 requirements 拒绝」只在本机存在
 *     托管 requirements 文件时成立；本机没有那个文件。
 *   - 项目信任：`[projects."<绝对路径>"]` 下 `trust_level = "trusted"`。
 *     Codex 没有全局 trust-all 开关，所以按目录写。
 *
 * 用 -c key=value 覆盖也能生效（doctor 实测），但写进配置文件才是持久的。
 */

import { join } from "node:path";
import { homedir } from "node:os";
import { readText } from "./files";
import type { AgentTarget, SwitchPlan, SwitchState } from "./types";

const POLICY_NEVER = "never";
const SANDBOX_FULL = "danger-full-access";

/** 解析 Codex home：$CODEX_HOME 优先，否则 ~/.codex。 */
function codexHome(): string {
  const env = process.env.CODEX_HOME;
  if (env !== undefined && env.trim().length > 0) return env;
  return join(homedir(), ".codex");
}

function configPath(): string {
  return join(codexHome(), "config.toml");
}

function projectDir(): string {
  return process.cwd();
}

/** TOML 字符串值：本项目路径不会含引号，做最小转义即可。 */
function tomlString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** 保留原文件的末尾换行习惯。 */
function keepEol(rendered: string, original: string): string {
  return original.endsWith("\n") || original.length === 0 ? rendered : rendered.replace(/\n$/, "");
}

/**
 * 把 `[projects."<dir>"]` 段里的 trust_level 设为 trusted。
 * 段不存在时在文末追加一个完整段落（前面留一个空行分隔，符合 TOML 习惯）。
 */
function setProjectTrust(text: string, dir: string, level: string | null): string {
  const header = `[projects.${tomlString(dir)}]`;
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l.trim() === header);

  if (start < 0) {
    if (level === null) return text;
    // 保证前面恰好一个空行分隔，且不产生连续空行
    const trimmed = text.replace(/\n*$/, "");
    const head = trimmed.length === 0 ? "" : `${trimmed}\n\n`;
    return keepEol(`${head}${header}\ntrust_level = ${tomlString(level)}\n`, text);
  }

  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i] as string;
    if (line.trim() === "") continue;
    if (line.trimStart().startsWith("[")) {
      end = i;
      break;
    }
  }

  const keyRe = /^\s*trust_level\s*=/;
  const keyAt = (() => {
    for (let i = start + 1; i < end; i++) if (keyRe.test(lines[i] as string)) return i;
    return -1;
  })();

  if (level === null) {
    if (keyAt < 0) return text;
    lines.splice(keyAt, 1);
    // 段落里只剩表头就整段删掉。删完用 filter 一次性清掉因此产生的连续空行，
    // 不要用「边删边看下标」的循环 —— splice 会让下标指向变化，容易死循环。
    const rest = lines.slice(start + 1, end - 1).filter((l) => l.trim() !== "");
    if (rest.length === 0) {
      lines.splice(start, 1);
      const collapsed: string[] = [];
      for (const line of lines) {
        // 只在文件中间折叠连续空行，保留首尾
        if (line.trim() === "" && collapsed.length > 0 && (collapsed[collapsed.length - 1] as string).trim() === "") continue;
        collapsed.push(line);
      }
      return keepEol(collapsed.join("\n").replace(/\n{3,}/g, "\n\n"), text);
    }
    return keepEol(lines.join("\n"), text);
  }

  if (keyAt >= 0) lines[keyAt] = `trust_level = ${tomlString(level)}`;
  else lines.splice(end, 0, `trust_level = ${tomlString(level)}`);
  return keepEol(lines.join("\n"), text);
}

/** 读某目录的 trust_level。 */
function getProjectTrust(text: string, dir: string): string | null {
  const header = `[projects.${tomlString(dir)}]`;
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l.trim() === header);
  if (start < 0) return null;
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i] as string;
    if (line.trim() === "") continue;
    if (line.trimStart().startsWith("[")) break;
    const m = /^\s*trust_level\s*=\s*"?([^"#\s]+)"?/.exec(line);
    if (m) return m[1] as string;
  }
  return null;
}

export const codexTarget: AgentTarget = {
  id: "codex",
  name: "Codex",
  bin: "codex",

  inspect(): SwitchState[] {
    const path = configPath();
    const text = readText(path);
    // approval_policy / sandbox_mode 是顶层标量（不在任何段落里），用专门的顶层读取
    const policyValue = text === null ? null : topScalar(text, "approval_policy");
    const sandboxValue = text === null ? null : topScalar(text, "sandbox_mode");

    const enabled = policyValue === POLICY_NEVER && sandboxValue === SANDBOX_FULL;
    let evidence: string;
    if (text === null) {
      evidence = `${path} 不存在`;
    } else {
      evidence = `${path}: approval_policy = ${policyValue ?? "未设置"}, sandbox_mode = ${sandboxValue ?? "未设置"}`;
      if (policyValue === POLICY_NEVER && sandboxValue !== SANDBOX_FULL) {
        evidence += "（只有 never 没有 danger-full-access，仍会被沙箱限制）";
      }
    }

    const dir = projectDir();
    const trust = text === null ? null : getProjectTrust(text, dir);
    const trustEnabled = trust === "trusted";
    const trustEvidence =
      text === null
        ? `${path} 不存在`
        : trustEnabled
          ? `${path}: [projects."${dir}"] trust_level = trusted`
          : `${path}: 未信任当前目录（${dir}）`;

    return [
      { id: "full-access", supported: true, enabled, evidence },
      {
        id: "trust-all",
        supported: true,
        enabled: trustEnabled,
        evidence: trustEvidence,
        unsupportedReason: `Codex 没有全局信任开关，只能按目录写；本开关处理当前目录 ${dir}`,
      },
    ];
  },

  plan(switchId, on): SwitchPlan {
    const path = configPath();
    const text = readText(path) ?? "";

    if (switchId === "full-access") {
      const policy = topScalar(text, "approval_policy");
      const sandbox = topScalar(text, "sandbox_mode");

      if (on) {
        if (policy === POLICY_NEVER && sandbox === SANDBOX_FULL) {
          return { switchId, on, edits: [], note: "已经是 never + danger-full-access，无需改动" };
        }
        let next = setTopScalar(text, "approval_policy", `"${POLICY_NEVER}"`);
        next = setTopScalar(next, "sandbox_mode", `"${SANDBOX_FULL}"`);
        return {
          switchId,
          on,
          edits: [
            {
              path,
              next,
              note: `approval_policy → never，sandbox_mode → ${SANDBOX_FULL}（不弹审批、不受沙箱限制）`,
            },
          ],
        };
      }

      if (policy !== POLICY_NEVER && sandbox !== SANDBOX_FULL) {
        return { switchId, on, edits: [], note: "本来就没开启完全访问" };
      }
      // 只回退「本开关写进去的那两个值」，不动其它
      let next = text;
      if (policy === POLICY_NEVER) next = unsetTopScalar(next, "approval_policy");
      if (sandbox === SANDBOX_FULL) next = unsetTopScalar(next, "sandbox_mode");
      return { switchId, on, edits: [{ path, next, note: "移除 approval_policy / sandbox_mode，回到 Codex 默认" }] };
    }

    const dir = projectDir();
    const current = getProjectTrust(text, dir);
    if (on) {
      if (current === "trusted") return { switchId, on, edits: [], note: `${dir} 已信任` };
      return {
        switchId,
        on,
        edits: [{ path, next: setProjectTrust(text, dir, "trusted"), note: `信任 ${dir}（trust_level = trusted）` }],
      };
    }
    if (current !== "trusted") return { switchId, on, edits: [], note: `${dir} 本来就没被标记信任` };
    return { switchId, on, edits: [{ path, next: setProjectTrust(text, dir, null), note: `取消信任 ${dir}` }] };
  },
};

/** 读 TOML 顶层标量（段落之外的 key = value）。 */
export function topScalar(text: string, key: string): string | null {
  const re = new RegExp(`^\\s*${key}\\s*=\\s*(.*?)\\s*(?:#.*)?$`);
  for (const line of text.split("\n")) {
    if (line.trimStart().startsWith("[")) break; // 到了第一个段落，顶层结束
    const m = re.exec(line);
    if (m) return (m[1] as string).replace(/^"(.*)"$/, "$1").trim();
  }
  return null;
}

/** 设置 TOML 顶层标量：已有就替换，否则插到第一个段落之前。 */
export function setTopScalar(text: string, key: string, value: string): string {
  const lines = text.split("\n");
  const re = new RegExp(`^\\s*${key}\\s*=`);
  let firstSection = lines.length;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    if (line.trimStart().startsWith("[")) {
      firstSection = i;
      break;
    }
    if (re.test(line)) {
      lines[i] = `${key} = ${value}`;
      return keepEol(lines.join("\n"), text);
    }
  }
  lines.splice(firstSection, 0, `${key} = ${value}`);
  return keepEol(lines.join("\n"), text);
}

/** 删除 TOML 顶层标量。 */
export function unsetTopScalar(text: string, key: string): string {
  const lines = text.split("\n");
  const re = new RegExp(`^\\s*${key}\\s*=`);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    if (line.trimStart().startsWith("[")) break;
    if (re.test(line)) {
      lines.splice(i, 1);
      return keepEol(lines.join("\n"), text);
    }
  }
  return text;
}
