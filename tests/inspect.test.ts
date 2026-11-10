import { describe, expect, test } from "bun:test";
import type { AgentSpec } from "../pkg/agents";
import type { SystemFacts } from "../pkg/channels/detect";
import { inspectAgent, type InspectDeps } from "../pkg/channels/inspect";
import type { MiseTool, MiseToolMap } from "../pkg/mise";

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

const facts: SystemFacts = {
  miseDataDir: "/mise",
  miseShimDir: "/mise/shims",
  miseInstallPaths: [],
  npmRoots: ["/node/lib/node_modules"],
  bunRoots: ["/bun/install/global/node_modules"],
  pnpmRoots: ["/pnpm/global"],
  brewPrefixes: ["/opt/homebrew"],
};

function entry(version: string, installPath: string, requested = version): MiseTool {
  return {
    version,
    requested_version: requested,
    install_path: installPath,
    source: null,
    installed: true,
    active: true,
  };
}

const MISE_PATH = "/mise/installs/npm-openai-codex/0.163.0/node_modules/.bin/codex";
const MISE_REAL = "/mise/installs/npm-openai-codex/0.163.0/node_modules/@openai/codex/bin/codex.js";
const NPM_PATH = "/node/bin/codex";
const NPM_REAL = "/node/lib/node_modules/@openai/codex/bin/codex.js";
const BREW_PATH = "/opt/homebrew/bin/codex";
const BREW_REAL = "/opt/homebrew/Cellar/codex/0.160.0/bin/codex";
const NATIVE_PATH = "/Users/u/.local/bin/codex";
const WRAPPER_PATH = "/Users/u/.seedmux/shims/codex";

const realPathMap: Record<string, string> = {
  [MISE_PATH]: MISE_REAL,
  [NPM_PATH]: NPM_REAL,
  [BREW_PATH]: BREW_REAL,
  [NATIVE_PATH]: NATIVE_PATH,
  [WRAPPER_PATH]: WRAPPER_PATH,
};

function makeDeps(overrides: Partial<InspectDeps> = {}): InspectDeps {
  return {
    facts,
    active: { "npm:@openai/codex": [entry("0.163.0", "/mise/installs/npm-openai-codex/0.163.0")] },
    installed: {},
    brewOutdated: new Map(),
    brewCasks: [],
    channelAvailable: { mise: true, npm: true, bun: true, pnpm: true, brew: true, native: true },
    readNodeVersion: () => "0.160.0",
    probeVersion: async () => "0.163.0",
    fetchLatest: async () => "0.163.0",
    fetchTag: async () => null,
    miseUpgradePlan: async () => ({ targetVersion: null, code: 0 }),
    whichFormula: async () => null,
    realpath: (path) => realPathMap[path] ?? path,
    nativeBinaryCheck: () => true,
    options: { bump: true, minimumReleaseAge: "0" },
    ...overrides,
  };
}

describe("inspectAgent", () => {
  test("mise 已是最新", async () => {
    const result = await inspectAgent(codex, [MISE_PATH], makeDeps());
    expect(result.channel).toBe("mise");
    expect(result.current).toBe("0.163.0");
    expect(result.status).toBe("up-to-date");
    expect(result.shadowed).toHaveLength(0);
  });

  test("mise 有新版本 → outdated，命令指向 mise", async () => {
    const result = await inspectAgent(
      codex,
      [MISE_PATH],
      makeDeps({ miseUpgradePlan: async () => ({ targetVersion: "0.164.0", code: 0 }) }),
    );
    expect(result.status).toBe("outdated");
    expect(result.target).toBe("0.164.0");
    expect(result.command?.slice(0, 2)).toEqual(["mise", "upgrade"]);
  });

  test("installed 里有旧版本残留时，探测仍用裸 tool，不钉到当前版本", async () => {
    let spec = "";
    const result = await inspectAgent(
      codex,
      [MISE_PATH],
      makeDeps({
        installed: {
          "npm:@openai/codex": [entry("0.162.1", "/mise/installs/npm-openai-codex/0.162.1")],
        },
        miseUpgradePlan: async (requested) => {
          spec = requested;
          return { targetVersion: "0.167.0", code: 0 };
        },
      }),
    );
    expect(spec).toBe("npm:@openai/codex");
    expect(result.status).toBe("outdated");
    expect(result.target).toBe("0.167.0");
  });

  test("命名标签只在 npm 后端上查 dist-tag；github 后端拿不到就跳过", async () => {
    let tagCalled = false;
    const omg: AgentSpec = {
      name: "omp",
      bin: "omp",
      miseTools: ["github:can1357/oh-my-pi"],
      npmPackage: "@oh-my-pi/pi-coding-agent",
      brewCask: null,
      nativeUpdate: ["omp", "update"],
      nativeDirs: ["/Users/u/.local/bin"],
    };
    const result = await inspectAgent(
      omg,
      ["/mise/installs/omp/beta/bin/omp"],
      makeDeps({
        active: {
          "github:can1357/oh-my-pi": [
            entry("beta", "/mise/installs/omp/beta", "beta"),
          ],
        },
        probeVersion: async () => "1.0.0",
        fetchTag: async () => {
          tagCalled = true;
          return "2.0.0";
        },
      }),
    );
    expect(tagCalled).toBe(false);
    expect(result.status).toBe("skipped");
    expect(result.note).toContain("最新版");
  });

  test("PATH 仍指向旧版本时：按配置版本报告 up-to-date，并提示重开 shell", async () => {
    const stalePath = "/mise/installs/npm-openai-codex/0.163.0/node_modules/.bin/codex";
    const staleReal = "/mise/installs/npm-openai-codex/0.163.0/node_modules/@openai/codex/bin/codex.js";
    const result = await inspectAgent(
      codex,
      [stalePath],
      makeDeps({
        active: {
          "npm:@openai/codex": [entry("0.167.0", "/mise/installs/npm-openai-codex/0.167.0")],
        },
        installed: {
          "npm:@openai/codex": [entry("0.163.0", "/mise/installs/npm-openai-codex/0.163.0")],
        },
        realpath: (path) => (path === stalePath ? staleReal : path),
      }),
    );
    expect(result.channel).toBe("mise");
    expect(result.current).toBe("0.167.0");
    expect(result.status).toBe("up-to-date");
    expect(result.note).toContain("旧版本");
    expect(result.note).toContain("重开 shell");
  });

  test("npm 生效、mise 被遮蔽：只升 npm，mise 进 shadowed", async () => {
    const result = await inspectAgent(
      codex,
      [NPM_PATH, MISE_PATH],
      makeDeps({ fetchLatest: async () => "0.164.0" }),
    );
    expect(result.channel).toBe("npm");
    expect(result.status).toBe("outdated");
    expect(result.command?.slice(0, 3)).toEqual(["npm", "install", "-g"]);
    expect(result.shadowed.map((i) => i.channel)).toEqual(["mise"]);
  });

  test("mise 已安装但未激活 → skipped + 接管提示", async () => {
    const result = await inspectAgent(
      codex,
      [MISE_PATH],
      makeDeps({
        active: {},
        installed: { "npm:@openai/codex": [entry("0.163.0", "/mise/installs/npm-openai-codex/0.163.0")] },
      }),
    );
    expect(result.channel).toBe("mise");
    expect(result.status).toBe("skipped");
    expect(result.note).toContain("mise use -g");
  });

  test("PATH 第一项是未知 wrapper → skipped，不升级后面的 mise", async () => {
    const result = await inspectAgent(codex, [WRAPPER_PATH, MISE_PATH], makeDeps());
    expect(result.channel).toBe("unknown");
    expect(result.status).toBe("skipped");
    expect(result.note).toContain("渠道");
    expect(result.shadowed.map((i) => i.channel)).toEqual(["mise"]);
  });

  test("未知渠道不执行二进制，连 --version 都不跑", async () => {
    const result = await inspectAgent(
      codex,
      [WRAPPER_PATH],
      makeDeps({
        probeVersion: async () => {
          throw new Error("should not execute unknown binary");
        },
      }),
    );
    expect(result.status).toBe("skipped");
    expect(result.current).toBeNull();
  });

  test("完全没装 → not-installed，不影响退出码", async () => {
    const result = await inspectAgent(codex, [], makeDeps());
    expect(result.status).toBe("not-installed");
    expect(result.channel).toBeNull();
  });

  test("命名标签：当前版本取二进制，最新版取 dist-tag，命令用 install --force", async () => {
    const result = await inspectAgent(
      dsh,
      ["/mise/installs/dsh/next/bin/dsh"],
      makeDeps({
        active: { "npm:@deepseek-ai/dsh": [entry("next", "/mise/installs/dsh/next", "next")] },
        probeVersion: async () => "0.2.1-rc.2",
        fetchTag: async () => "0.2.2-rc.1",
      }),
    );
    expect(result.channel).toBe("mise");
    expect(result.current).toBe("0.2.1-rc.2");
    expect(result.target).toBe("0.2.2-rc.1");
    expect(result.status).toBe("outdated");
    expect(result.command).toContain("install");
    expect(result.command).toContain("npm:@deepseek-ai/dsh@next");
    expect(result.command).toContain("--force");
  });

  test("brew formula：命令为 brew upgrade <formula>", async () => {
    const result = await inspectAgent(
      codex,
      [BREW_PATH],
      makeDeps({
        whichFormula: async () => "codex",
        brewOutdated: new Map([["codex", { current: "0.160.0", latest: "0.163.0", kind: "formula" }]]),
      }),
    );
    expect(result.channel).toBe("brew");
    expect(result.status).toBe("outdated");
    expect(result.command).toEqual(["brew", "upgrade", "codex"]);
  });

  test("brew cask：which-formula 查不到时用注册表里的 cask 名", async () => {
    const result = await inspectAgent(
      claude,
      ["/opt/homebrew/bin/claude"],
      makeDeps({
        active: {},
        brewCasks: ["claude-code"],
        probeVersion: async () => "2.1.300",
        brewOutdated: new Map([
          ["claude-code", { current: "2.1.300", latest: "2.1.303", kind: "cask" }],
        ]),
      }),
    );
    expect(result.channel).toBe("brew");
    expect(result.command).toEqual(["brew", "upgrade", "--cask", "claude-code"]);
  });

  test("brew 安装但认不出 formula/cask → unknown，不猜", async () => {
    const result = await inspectAgent(
      codex,
      [BREW_PATH],
      makeDeps({ whichFormula: async () => null }),
    );
    expect(result.channel).toBe("unknown");
    expect(result.status).toBe("skipped");
  });

  test("brew outdated 不可用 → 最新版未知，skipped", async () => {
    const result = await inspectAgent(
      codex,
      [BREW_PATH],
      makeDeps({ whichFormula: async () => "codex", brewOutdated: null }),
    );
    expect(result.channel).toBe("brew");
    expect(result.status).toBe("skipped");
    expect(result.note).toContain("最新版");
  });

  test("native：用自带更新命令", async () => {
    const result = await inspectAgent(
      codex,
      [NATIVE_PATH],
      makeDeps({ probeVersion: async () => "0.160.0", fetchLatest: async () => "0.163.0" }),
    );
    expect(result.channel).toBe("native");
    expect(result.status).toBe("outdated");
    expect(result.command).toEqual(["codex", "update"]);
  });

  test("最新版查不到 → skipped，不执行", async () => {
    const result = await inspectAgent(codex, [NPM_PATH], makeDeps({ fetchLatest: async () => null }));
    expect(result.status).toBe("skipped");
    expect(result.command).toBeNull();
    expect(result.note).toContain("最新版");
  });
});
