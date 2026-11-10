import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentSpec } from "../pkg/agents";
import {
  classifyPath,
  selectInstallations,
  whichAll,
  type ClassifyContext,
  type PathInstall,
} from "../pkg/channels/detect";

const codex: AgentSpec = {
  name: "Codex",
  bin: "codex",
  miseTools: ["npm:@openai/codex"],
  npmPackage: "@openai/codex",
  brewCask: null,
  nativeUpdate: ["codex", "update"],
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

const facts: ClassifyContext = {
  facts: {
    miseDataDir: "/Users/u/.local/share/mise",
    miseShimDir: "/Users/u/.local/share/mise/shims",
    miseInstallPaths: ["/Users/u/.local/share/mise/installs/npm-openai-codex/0.163.0"],
    npmRoots: ["/Users/u/.local/share/mise/installs/node/24/lib/node_modules"],
    bunRoots: ["/Users/u/.bun/install/global/node_modules"],
    pnpmRoots: ["/Users/u/Library/pnpm/global/v11"],
    brewPrefixes: ["/opt/homebrew"],
  },
  realpath: (path) => path,
  nativeBinaryCheck: () => true,
};

function classify(raw: string, agent: AgentSpec = codex, real = raw): PathInstall {
  return classifyPath(raw, agent, { ...facts, realpath: () => real });
}

describe("classifyPath", () => {
  test("mise 的 node 目录下的 npm 全局安装判为 npm，不是 mise", () => {
    const install = classify(
      "/Users/u/.local/share/mise/installs/node/24/bin/codex",
      codex,
      "/Users/u/.local/share/mise/installs/node/24/lib/node_modules/@openai/codex/bin/codex.js",
    );
    expect(install.channel).toBe("npm");
  });

  test("mise installs 下、属于选中 tool 的真实安装判为 mise", () => {
    const install = classify(
      "/Users/u/.local/share/mise/installs/npm-openai-codex/0.163.0/node_modules/.bin/codex",
      codex,
      "/Users/u/.local/share/mise/installs/npm-openai-codex/0.163.0/node_modules/@openai/codex/bin/codex.js",
    );
    expect(install.channel).toBe("mise");
  });

  test("mise installs 下但不属于该 tool 的路径不判 mise", () => {
    const install = classify(
      "/Users/u/.local/share/mise/installs/npm-other-agent/1.0.0/bin/codex",
      codex,
      "/Users/u/.local/share/mise/installs/npm-other-agent/1.0.0/bin/codex",
    );
    expect(install.channel).toBe("unknown");
  });

  test("npm root 缺失时，mise node 目录下的路径判 unknown 而不是 mise", () => {
    const withoutNpmRoots: ClassifyContext = {
      ...facts,
      facts: { ...facts.facts, npmRoots: [] },
    };
    const install = classifyPath(
      "/Users/u/.local/share/mise/installs/node/24/bin/codex",
      codex,
      {
        ...withoutNpmRoots,
        realpath: () =>
          "/Users/u/.local/share/mise/installs/node/24/lib/node_modules/@openai/codex/bin/codex.js",
      },
    );
    expect(install.channel).toBe("unknown");
  });

  test("mise shim 判为 mise（不被 shim 指向的 mise 二进制带偏）", () => {
    const install = classify("/Users/u/.local/share/mise/shims/codex", codex, "/Users/u/.local/bin/mise");
    expect(install.channel).toBe("mise");
  });

  test("bun 全局安装判为 bun", () => {
    const install = classify(
      "/Users/u/.bun/bin/codex",
      codex,
      "/Users/u/.bun/install/global/node_modules/@openai/codex/bin/codex.js",
    );
    expect(install.channel).toBe("bun");
  });

  test("pnpm 全局安装判为 pnpm", () => {
    const install = classify(
      "/Users/u/Library/pnpm/bin/codex",
      codex,
      "/Users/u/Library/pnpm/global/v11/10/node_modules/@openai/codex/bin/codex.js",
    );
    expect(install.channel).toBe("pnpm");
  });

  test("brew prefix 下的安装判为 brew", () => {
    const install = classify(
      "/opt/homebrew/bin/codex",
      codex,
      "/opt/homebrew/Cellar/codex/1.2.3/bin/codex",
    );
    expect(install.channel).toBe("brew");
  });

  test("原生目录里的真实二进制判为 native", () => {
    const install = classify("/Users/u/.local/bin/codex", codex);
    expect(install.channel).toBe("native");
  });

  test("原生目录里的脚本 wrapper 判为 unknown", () => {
    const install = classifyPath("/Users/u/.local/bin/codex", codex, {
      ...facts,
      nativeBinaryCheck: () => false,
    });
    expect(install.channel).toBe("unknown");
  });

  test("原生目录之外的路径即使有 nativeUpdate 也判 unknown", () => {
    const install = classify("/Users/u/.seedmux/shims/codex", codex);
    expect(install.channel).toBe("unknown");
  });

  test("没有原生更新能力的 agent 路径判为 unknown", () => {
    const install = classify("/Users/u/.local/bin/dsh", dsh);
    expect(install.channel).toBe("unknown");
  });

  test("同一渠道的多个路径生成相同的去重键", () => {
    const a = classify("/Users/u/.local/share/mise/shims/codex", codex, "/Users/u/.local/bin/mise");
    const b = classify(
      "/Users/u/.local/share/mise/installs/npm-openai-codex/0.163.0/node_modules/.bin/codex",
      codex,
      "/Users/u/.local/share/mise/installs/npm-openai-codex/0.163.0/node_modules/@openai/codex/bin/codex.js",
    );
    expect(a.key).toBe(b.key);
  });
});

describe("selectInstallations", () => {
  const mise = classify("/Users/u/.local/share/mise/shims/codex", codex, "/Users/u/.local/bin/mise");
  const npm = classify(
    "/Users/u/.local/share/mise/installs/node/24/bin/codex",
    codex,
    "/Users/u/.local/share/mise/installs/node/24/lib/node_modules/@openai/codex/bin/codex.js",
  );
  const brew = classify("/opt/homebrew/bin/codex", codex, "/opt/homebrew/Cellar/codex/1.2.3/bin/codex");

  test("PATH 第一项是生效安装，其余去重后进入 shadowed", () => {
    const result = selectInstallations([npm, brew, mise]);
    expect(result.effective?.channel).toBe("npm");
    expect(result.shadowed.map((i) => i.channel)).toEqual(["brew", "mise"]);
  });

  test("同一渠道的重复路径只保留第一条", () => {
    const shim = classify("/Users/u/.local/share/mise/shims/codex", codex, "/Users/u/.local/bin/mise");
    const result = selectInstallations([mise, shim]);
    expect(result.effective?.channel).toBe("mise");
    expect(result.shadowed).toHaveLength(0);
  });

  test("PATH 第一项是未知 wrapper 时保持生效，不跳到后面的 mise", () => {
    const wrapper = classify("/Users/u/.seedmux/shims/codex", codex);
    const result = selectInstallations([wrapper, mise]);
    expect(result.effective?.channel).toBe("unknown");
    expect(result.shadowed.map((i) => i.channel)).toEqual(["mise"]);
  });

  test("空候选返回 null", () => {
    const result = selectInstallations([]);
    expect(result.effective).toBeNull();
    expect(result.shadowed).toHaveLength(0);
  });
});

describe("whichAll", () => {
  let sandbox: string;

  beforeEach(() => {
    sandbox = join("/tmp", `blanket-which-${process.pid}-${Math.random().toString(36).slice(2, 8)}`);
    mkdirSync(join(sandbox, "a"), { recursive: true });
    mkdirSync(join(sandbox, "b"), { recursive: true });
  });

  afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });

  test("按 PATH 顺序列出所有命中，并跳过不可执行文件", () => {
    const first = join(sandbox, "b", "codex");
    const second = join(sandbox, "a", "codex");
    writeFileSync(first, "#!/bin/sh\n");
    writeFileSync(second, "#!/bin/sh\n");
    chmodSync(first, 0o755);
    chmodSync(second, 0o644); // 不可执行

    expect(whichAll("codex", `${join(sandbox, "b")}:${join(sandbox, "a")}`)).toEqual([first]);
  });

  test("同一个文件出现两次时去重", () => {
    const bin = join(sandbox, "a", "codex");
    writeFileSync(bin, "#!/bin/sh\n");
    chmodSync(bin, 0o755);
    const dir = join(sandbox, "a");
    expect(whichAll("codex", `${dir}:${dir}`)).toEqual([bin]);
  });
});
