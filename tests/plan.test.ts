import { describe, expect, test } from "bun:test";
import type { AgentSpec } from "../pkg/agents";
import { buildUpgradeCommand, decideUpgrade, evaluateUpgradeResult } from "../pkg/channels/plan";

const codex: AgentSpec = {
  name: "Codex",
  bin: "codex",
  miseTools: ["npm:@openai/codex"],
  npmPackage: "@openai/codex",
  brewCask: null,
  nativeUpdate: ["codex", "update"],
  nativeDirs: ["/Users/u/.local/bin"],
};

const claude: AgentSpec = {
  name: "Claude Code",
  bin: "claude",
  miseTools: ["npm:@anthropic-ai/claude-code"],
  npmPackage: "@anthropic-ai/claude-code",
  brewCask: "claude-code",
  nativeUpdate: ["claude", "install", "latest"],
  nativeDirs: ["/Users/u/.local/bin"],
};

const dsh: AgentSpec = {
  name: "DeepSeek Harness",
  bin: "dsh",
  miseTools: ["npm:@deepseek-ai/dsh"],
  npmPackage: "@deepseek-ai/dsh",
  brewCask: null,
  nativeUpdate: null,
  nativeDirs: [],
};

const options = { bump: true, minimumReleaseAge: "0" };

const miseInstall = { channel: "mise" as const, identity: "npm:@openai/codex", current: "0.162.1" };

describe("buildUpgradeCommand", () => {
  test("mise：带 bump 与发布冷静期参数", () => {
    expect(buildUpgradeCommand(codex, miseInstall, options)).toEqual([
      "mise",
      "upgrade",
      "npm:@openai/codex",
      "--bump",
      "--minimum-release-age",
      "0",
    ]);
  });

  test("mise：--no-bump 与 --age 缺省时不带参数", () => {
    expect(
      buildUpgradeCommand(codex, miseInstall, { bump: false, minimumReleaseAge: null }),
    ).toEqual(["mise", "upgrade", "npm:@openai/codex"]);
  });

  test("预览命令不带 --dry-run（dry-run 只影响是否执行）", () => {
    expect(buildUpgradeCommand(codex, miseInstall, options)).not.toContain("--dry-run");
  });

  test("mise：命名标签用 install --force 刷新，保留标签语义", () => {
    const tagged = {
      ...miseInstall,
      identity: "npm:@deepseek-ai/dsh",
      current: "0.2.1-rc.2",
      miseRequested: "next",
    };
    expect(buildUpgradeCommand(codex, tagged, options)).toEqual([
      "mise",
      "install",
      "npm:@deepseek-ai/dsh@next",
      "--force",
      "--minimum-release-age",
      "0",
    ]);
  });

  test("mise：latest 或普通 semver 仍走 upgrade", () => {
    const latest = { ...miseInstall, miseRequested: "latest" };
    expect(buildUpgradeCommand(codex, latest, options)?.[1]).toBe("upgrade");
  });

  test("npm / bun / pnpm 用各自的全局安装命令", () => {
    const npm = { channel: "npm" as const, identity: "@openai/codex", current: "0.160.0" };
    const bun = { channel: "bun" as const, identity: "@openai/codex", current: "0.160.0" };
    const pnpm = { channel: "pnpm" as const, identity: "@openai/codex", current: "0.160.0" };
    expect(buildUpgradeCommand(codex, npm, options)).toEqual(["npm", "install", "-g", "@openai/codex@latest"]);
    expect(buildUpgradeCommand(codex, bun, options)).toEqual(["bun", "add", "-g", "@openai/codex@latest"]);
    expect(buildUpgradeCommand(codex, pnpm, options)).toEqual(["pnpm", "add", "-g", "@openai/codex@latest"]);
  });

  test("brew formula 与 cask 用不同参数", () => {
    const formula = { channel: "brew" as const, identity: "codex", current: "1.0.0", brewKind: "formula" as const };
    const cask = { channel: "brew" as const, identity: "claude-code", current: "1.0.0", brewKind: "cask" as const };
    expect(buildUpgradeCommand(codex, formula, options)).toEqual(["brew", "upgrade", "codex"]);
    expect(buildUpgradeCommand(claude, cask, options)).toEqual(["brew", "upgrade", "--cask", "claude-code"]);
  });

  test("native 用 agent 自带更新命令", () => {
    const native = { channel: "native" as const, identity: "codex", current: "0.160.0" };
    expect(buildUpgradeCommand(codex, native, options)).toEqual(["codex", "update"]);
    expect(buildUpgradeCommand(dsh, { channel: "native", identity: "dsh", current: "1.0.0" }, options)).toBeNull();
  });

  test("unknown 渠道没有升级命令", () => {
    const unknown = { channel: "unknown" as const, identity: "?", current: "1.0.0" };
    expect(buildUpgradeCommand(codex, unknown, options)).toBeNull();
  });
});

describe("decideUpgrade", () => {
  const command = ["npm", "install", "-g", "@openai/codex@latest"];

  test("最新版与当前一致 → up-to-date", () => {
    const decision = decideUpgrade({ ...miseInstall, current: "0.163.0" }, "0.163.0", { command });
    expect(decision.status).toBe("up-to-date");
    expect(decision.target).toBe("0.163.0");
    expect(decision.note).toBeNull();
  });

  test("有新版本 → outdated，目标为最新版", () => {
    const decision = decideUpgrade(miseInstall, "0.163.0", { command });
    expect(decision.status).toBe("outdated");
    expect(decision.current).toBe("0.162.1");
    expect(decision.target).toBe("0.163.0");
    expect(decision.command).toEqual(command);
  });

  test("本地版本高于最新版 → ahead，绝不降级", () => {
    const decision = decideUpgrade({ ...miseInstall, current: "0.170.0" }, "0.163.0", { command });
    expect(decision.status).toBe("ahead");
    expect(decision.note).toContain("不降级");
  });

  test("最新版未知 → skipped，不执行任何升级", () => {
    const decision = decideUpgrade(miseInstall, null, { command });
    expect(decision.status).toBe("skipped");
    expect(decision.command).toBeNull();
    expect(decision.note).toContain("最新版");
  });

  test("当前版本未知 → skipped", () => {
    const decision = decideUpgrade({ ...miseInstall, current: null }, "0.163.0", { command });
    expect(decision.status).toBe("skipped");
    expect(decision.command).toBeNull();
  });

  test("mise 已安装但未激活 → skipped，并提示接管命令", () => {
    const decision = decideUpgrade(miseInstall, "0.163.0", { command, miseInactive: true });
    expect(decision.status).toBe("skipped");
    expect(decision.note).toContain("mise use -g npm:@openai/codex@latest");
    expect(decision.command).toBeNull();
  });

  test("渠道工具不可用 → skipped", () => {
    const decision = decideUpgrade(miseInstall, "0.163.0", { command, channelAvailable: false });
    expect(decision.status).toBe("skipped");
    expect(decision.note).toContain("不可用");
    expect(decision.command).toBeNull();
  });

  test("未知渠道 → skipped，不猜测", () => {
    const decision = decideUpgrade({ channel: "unknown", identity: "?", current: "1.0.0" }, "2.0.0", {
      command: null,
    });
    expect(decision.status).toBe("skipped");
    expect(decision.note).toContain("渠道");
  });
});

describe("evaluateUpgradeResult", () => {
  test("版本变高 → updated", () => {
    expect(evaluateUpgradeResult("0.162.1", "0.163.0", "0.163.0")).toEqual({
      status: "updated",
      note: null,
    });
  });

  test("升级了但没达到目标版本 → updated 加注", () => {
    const result = evaluateUpgradeResult("0.162.1", "0.162.5", "0.163.0");
    expect(result.status).toBe("updated");
    expect(result.note).toContain("未达到目标版本");
  });

  test("命令成功但版本没变 → up-to-date 加注，不算失败", () => {
    const result = evaluateUpgradeResult("0.163.0", "0.163.0", "0.163.0");
    expect(result.status).toBe("up-to-date");
    expect(result.note).toContain("版本未变化");
  });

  test("升级后版本反而变低 → failed", () => {
    const result = evaluateUpgradeResult("0.163.0", "0.160.0", "0.163.0");
    expect(result.status).toBe("failed");
    expect(result.note).toContain("反而变低");
  });

  test("读不到升级后版本 → failed", () => {
    const result = evaluateUpgradeResult("0.163.0", null, "0.164.0");
    expect(result.status).toBe("failed");
    expect(result.note).toContain("无法读取");
  });
});
