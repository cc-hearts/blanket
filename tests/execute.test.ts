import { describe, expect, test } from "bun:test";
import type { AgentSpec } from "../pkg/agents";
import { executeUpgrade, addStalePathNote } from "../pkg/channels/execute";
import type { AgentInspection } from "../pkg/channels/inspect";

const codex: AgentSpec = {
  name: "Codex",
  bin: "codex",
  miseTools: ["npm:@openai/codex"],
  npmPackage: "@openai/codex",
  brewCask: null,
  nativeUpdate: ["codex", "update"],
  nativeDirs: ["/Users/u/.local/bin"],
};

function inspection(overrides: Partial<AgentInspection> = {}): AgentInspection {
  return {
    agent: codex,
    status: "outdated",
    channel: "mise",
    identity: "npm:@openai/codex",
    miseTool: "npm:@openai/codex",
    path: "/mise/installs/npm-openai-codex/0.162.1/bin/codex",
    current: "0.162.1",
    target: "0.163.0",
    command: ["mise", "upgrade", "npm:@openai/codex", "--bump"],
    note: null,
    shadowed: [],
    install: { channel: "mise", identity: "npm:@openai/codex", current: "0.162.1" },
    ...overrides,
  };
}

const okRunner = async () => ({ code: 0, stdout: "", stderr: "" });

describe("executeUpgrade", () => {
  test("升级成功 → updated，并更新 current", async () => {
    const result = await executeUpgrade(inspection(), {
      run: okRunner,
      probeVersion: async () => "0.163.0",
    });
    expect(result.status).toBe("updated");
    expect(result.current).toBe("0.163.0");
    expect(result.note).toBeNull();
  });

  test("命令失败 → failed，保留错误信息", async () => {
    const result = await executeUpgrade(inspection(), {
      run: async () => ({ code: 1, stdout: "", stderr: "network error\n" }),
      probeVersion: async () => "0.162.1",
    });
    expect(result.status).toBe("failed");
    expect(result.note).toContain("network error");
  });

  test("命令成功但版本没变 → up-to-date 加注", async () => {
    const result = await executeUpgrade(inspection(), {
      run: okRunner,
      probeVersion: async () => "0.162.1",
    });
    expect(result.status).toBe("up-to-date");
    expect(result.note).toContain("版本未变化");
  });

  test("非 outdated 状态不会执行命令", async () => {
    let called = false;
    const result = await executeUpgrade(inspection({ status: "up-to-date", command: null }), {
      run: async () => {
        called = true;
        return { code: 0, stdout: "", stderr: "" };
      },
      probeVersion: async () => "0.163.0",
    });
    expect(called).toBe(false);
    expect(result.status).toBe("up-to-date");
  });
});

describe("addStalePathNote", () => {
  test("mise 升级后提示当前 shell 的 PATH 可能仍指向旧版本", () => {
    const result = addStalePathNote(inspection({ status: "updated", current: "0.167.0" }));
    expect(result.note).toContain("重开 shell");
  });

  test("非 mise 渠道或没有升级时不加提示", () => {
    const npm = inspection({
      status: "updated",
      channel: "npm",
      path: "/node/bin/codex",
      note: null,
    });
    expect(addStalePathNote(npm).note).toBeNull();
    const upToDate = inspection({ status: "up-to-date" });
    expect(addStalePathNote(upToDate).note).toBeNull();
  });
});
