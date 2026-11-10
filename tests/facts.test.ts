import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentSpec } from "../pkg/agents";
import type { MiseTool, MiseToolMap } from "../pkg/mise";
import {
  brewOutdatedMap,
  collectSystemFacts,
  defaultBunRoots,
  findNodePackageDir,
  isNativeBinaryMagic,
  listBrewCasks,
  parseBrewWhichFormula,
  parseMiseDataDir,
  normalizeRoot,
  pickMiseTool,
  probeVersion,
  readNodePackageVersion,
  whichFormula,
} from "../pkg/channels/facts";
import type { RunResult } from "../pkg/channels/run";

const omp: AgentSpec = {
  name: "omp",
  bin: "omp",
  miseTools: ["github:can1357/oh-my-pi", "npm:@oh-my-pi/pi-coding-agent"],
  npmPackage: "@oh-my-pi/pi-coding-agent",
  brewCask: null,
  nativeUpdate: ["omp", "update"],
  nativeDirs: ["/Users/u/.local/bin"],
};

const codex: AgentSpec = {
  name: "Codex",
  bin: "codex",
  miseTools: ["npm:@openai/codex"],
  npmPackage: "@openai/codex",
  brewCask: null,
  nativeUpdate: ["codex", "update"],
  nativeDirs: ["/Users/u/.local/bin"],
};

function entry(version: string, installPath = `/mise/installs/x/${version}`, installed = true): MiseTool {
  return {
    version,
    requested_version: version,
    install_path: installPath,
    source: null,
    installed,
    active: installed,
  };
}

describe("pickMiseTool", () => {
  test("优先选择出现在 active 配置里的 tool", () => {
    const active: MiseToolMap = { "github:can1357/oh-my-pi": [entry("18.12.3", "/mise/installs/omp/18.12.3")] };
    const installed: MiseToolMap = {
      "github:can1357/oh-my-pi": [entry("18.12.3", "/mise/installs/omp/18.12.3")],
      "npm:@oh-my-pi/pi-coding-agent": [entry("18.10.0", "/mise/installs/npm-omp/18.10.0")],
    };
    expect(pickMiseTool(omp, active, installed)).toMatchObject({
      tool: "github:can1357/oh-my-pi",
      active: true,
      version: "18.12.3",
      installPath: "/mise/installs/omp/18.12.3",
    });
  });

  test("PATH 指向旧版本时仍视为 active，版本取配置里的版本", () => {
    const active: MiseToolMap = {
      "npm:@openai/codex": [entry("0.167.0", "/mise/installs/npm-openai-codex/0.167.0")],
    };
    const installed: MiseToolMap = {
      "npm:@openai/codex": [entry("0.163.0", "/mise/installs/npm-openai-codex/0.163.0")],
    };
    expect(
      pickMiseTool(
        codex,
        active,
        installed,
        "/mise/installs/npm-openai-codex/0.163.0/node_modules/@openai/codex/bin/codex.js",
      ),
    ).toMatchObject({
      tool: "npm:@openai/codex",
      active: true,
      version: "0.167.0",
      requestedVersion: "0.167.0",
    });
  });

  test("install_path 命中生效路径时优先于注册表顺序", () => {
    const active: MiseToolMap = {
      "github:can1357/oh-my-pi": [entry("18.12.3", "/mise/installs/omp/18.12.3")],
      "npm:@oh-my-pi/pi-coding-agent": [entry("18.10.0", "/mise/installs/npm-omp/18.10.0")],
    };
    expect(
      pickMiseTool(omp, active, active, "/mise/installs/npm-omp/18.10.0/node_modules/@oh-my-pi/pi/bin.js"),
    ).toMatchObject({ tool: "npm:@oh-my-pi/pi-coding-agent", version: "18.10.0" });
  });

  test("只有 installed、没有配置时返回 inactive 选择", () => {
    const active: MiseToolMap = {};
    const installed: MiseToolMap = { "npm:@oh-my-pi/pi-coding-agent": [entry("18.10.0")] };
    expect(pickMiseTool(omp, active, installed)).toMatchObject({
      tool: "npm:@oh-my-pi/pi-coding-agent",
      active: false,
    });
  });

  test("两处都没有时返回 null", () => {
    expect(pickMiseTool(codex, {}, {})).toBeNull();
  });

  test("同一个 tool 装了多个版本时取最后一条已安装版本", () => {
    const active: MiseToolMap = {
      "npm:@openai/codex": [entry("0.162.1"), entry("0.163.0")],
    };
    expect(pickMiseTool(codex, active, active)?.version).toBe("0.163.0");
  });

  test("保留 requested_version，供标签钉版本判断", () => {
    const record = entry("next", "/mise/installs/dsh/next");
    record.requested_version = "next";
    const active: MiseToolMap = { "npm:@deepseek-ai/dsh": [record] };
    const picked = pickMiseTool(
      { ...codex, name: "DeepSeek Harness", bin: "dsh", miseTools: ["npm:@deepseek-ai/dsh"], nativeUpdate: null },
      active,
      active,
    );
    expect(picked?.requestedVersion).toBe("next");
  });
});

describe("findNodePackageDir", () => {
  test("scoped 包", () => {
    expect(
      findNodePackageDir(
        "/Users/u/.local/share/mise/installs/node/24/lib/node_modules/@openai/codex/bin/codex.js",
        "@openai/codex",
      ),
    ).toBe("/Users/u/.local/share/mise/installs/node/24/lib/node_modules/@openai/codex");
  });

  test("普通包", () => {
    expect(findNodePackageDir("/usr/local/lib/node_modules/codex/bin/codex.js", "codex")).toBe(
      "/usr/local/lib/node_modules/codex",
    );
  });

  test("包名不在路径里返回 null", () => {
    expect(findNodePackageDir("/usr/local/bin/codex", "@openai/codex")).toBeNull();
  });
});

describe("parseBrewWhichFormula", () => {
  test("多行输出取第一个非空行", () => {
    expect(parseBrewWhichFormula("\ncodex\ncodex@beta\n")).toBe("codex");
  });

  test("没有输出返回 null", () => {
    expect(parseBrewWhichFormula("")).toBeNull();
    expect(parseBrewWhichFormula(" \n\t\n")).toBeNull();
  });
});

describe("isNativeBinaryMagic", () => {
  test("识别 Mach-O 与 ELF", () => {
    expect(isNativeBinaryMagic(Uint8Array.from([0xcf, 0xfa, 0xed, 0xfe]))).toBe(true); // Mach-O 64 LE
    expect(isNativeBinaryMagic(Uint8Array.from([0xfe, 0xed, 0xfa, 0xcf]))).toBe(true); // Mach-O 64 BE
    expect(isNativeBinaryMagic(Uint8Array.from([0xca, 0xfe, 0xba, 0xbe]))).toBe(true); // fat binary
    expect(isNativeBinaryMagic(Uint8Array.from([0x7f, 0x45, 0x4c, 0x46]))).toBe(true); // ELF
  });

  test("脚本 wrapper 不算原生二进制", () => {
    expect(isNativeBinaryMagic(new TextEncoder().encode("#!/bin/sh\n"))).toBe(false);
    expect(isNativeBinaryMagic(new TextEncoder().encode("#!/usr/bin/env node\n"))).toBe(false);
  });

  test("字节不足返回 false", () => {
    expect(isNativeBinaryMagic(Uint8Array.from([0xcf, 0xfa]))).toBe(false);
  });
});

describe("normalizeRoot", () => {
  const sandbox = join("/tmp", `blanket-root-${process.pid}-${Math.random().toString(36).slice(2, 8)}`);

  test("解析软链与 /tmp 物理路径", () => {
    mkdirSync(join(sandbox, "real"), { recursive: true });
    symlinkSync(join(sandbox, "real"), join(sandbox, "link"));
    try {
      expect(normalizeRoot(join(sandbox, "link"))).toBe(normalizeRoot(join(sandbox, "real")));
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  test("不存在的路径原样返回", () => {
    expect(normalizeRoot("/definitely/not/here")).toBe("/definitely/not/here");
  });
});

describe("parseMiseDataDir", () => {
  test("从 install_path 反推数据目录", () => {
    expect(parseMiseDataDir("/Users/u/.local/share/mise/installs/npm-codex/1.0.0")).toBe(
      "/Users/u/.local/share/mise",
    );
  });

  test("没有 installs 段返回 null", () => {
    expect(parseMiseDataDir("/Users/u/.local/share/mise")).toBeNull();
  });
});

describe("defaultBunRoots", () => {
  test("尊重 BUN_INSTALL", () => {
    expect(defaultBunRoots({ BUN_INSTALL: "/bun" }, "/Users/u")).toEqual([
      "/bun/install/global/node_modules",
    ]);
  });

  test("默认落在 ~/.bun", () => {
    expect(defaultBunRoots({}, "/Users/u")).toEqual(["/Users/u/.bun/install/global/node_modules"]);
  });
});

describe("collectSystemFacts", () => {
  test("汇总各渠道根目录，并给 mise 安装路径留空", async () => {
    const calls: string[][] = [];
    const fakeRun = async (argv: string[]): Promise<RunResult> => {
      calls.push(argv);
      if (argv[0] === "npm") return { code: 0, stdout: "/n/global\n", stderr: "" };
      if (argv[0] === "pnpm") return { code: 0, stdout: "/p/global\n", stderr: "" };
      return { code: 1, stdout: "", stderr: "" };
    };
    const which = (bin: string) =>
      ({ npm: "/bin/npm", pnpm: "/bin/pnpm", brew: "/opt/homebrew/bin/brew" })[bin] ?? null;

    const facts = await collectSystemFacts({
      run: fakeRun,
      which,
      env: { BUN_INSTALL: "/bun" },
      homedir: "/Users/u",
    });

    expect(facts.npmRoots).toEqual(["/n/global"]);
    expect(facts.pnpmRoots).toEqual(["/p/global"]);
    expect(facts.bunRoots).toEqual(["/bun/install/global/node_modules"]);
    expect(facts.brewPrefixes).toContain("/opt/homebrew");
    expect(facts.miseDataDir).toBe("/Users/u/.local/share/mise");
    expect(facts.miseShimDir).toBe("/Users/u/.local/share/mise/shims");
    expect(facts.miseInstallPaths).toEqual([]);
    expect(calls.some((c) => c[0] === "npm" && c[1] === "root")).toBe(true);
  });
});

describe("readNodePackageVersion", () => {
  let sandbox: string;

  beforeEach(() => {
    sandbox = join("/tmp", `blanket-pkg-${process.pid}-${Math.random().toString(36).slice(2, 8)}`);
  });

  afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });

  test("从 package.json 读取版本", () => {
    const pkgDir = join(sandbox, "node_modules", "@openai", "codex");
    mkdirSync(join(pkgDir, "bin"), { recursive: true });
    writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ version: "0.163.0" }));
    const realPath = join(pkgDir, "bin", "codex.js");
    writeFileSync(realPath, "");

    expect(readNodePackageVersion(realPath, "@openai/codex")).toBe("0.163.0");
  });

  test("文件缺失返回 null", () => {
    expect(readNodePackageVersion(join(sandbox, "nope", "codex.js"), "@openai/codex")).toBeNull();
  });
});

describe("probeVersion", () => {
  test("运行 --version 并解析版本号", async () => {
    const probe = await probeVersion("/bin/codex", async () => ({
      code: 0,
      stdout: "codex-cli 0.163.0\n",
      stderr: "",
    }));
    expect(probe).toBe("0.163.0");
  });

  test("命令失败返回 null", async () => {
    const probe = await probeVersion("/bin/codex", async () => ({
      code: 1,
      stdout: "",
      stderr: "boom",
    }));
    expect(probe).toBeNull();
  });
});

describe("brew 辅助", () => {
  test("brewOutdatedMap 解析 brew outdated --json=v2", async () => {
    const deps = {
      which: () => "/opt/homebrew/bin/brew",
      run: async () => ({
        code: 0,
        stdout: JSON.stringify({
          formulae: [{ name: "codex", installed_versions: ["0.160.0"], current_version: "0.163.0" }],
          casks: [],
        }),
        stderr: "",
      }),
    };
    const map = await brewOutdatedMap(deps);
    expect(map?.get("codex")).toMatchObject({ current: "0.160.0", latest: "0.163.0", kind: "formula" });
  });

  test("brew 不可用或 outdated 失败返回 null", async () => {
    expect(await brewOutdatedMap({ which: () => null })).toBeNull();
    expect(
      await brewOutdatedMap({
        which: () => "/opt/homebrew/bin/brew",
        run: async () => ({ code: 1, stdout: "", stderr: "boom" }),
      }),
    ).toBeNull();
  });

  test("whichFormula 取第一行输出", async () => {
    const deps = {
      which: () => "/opt/homebrew/bin/brew",
      run: async () => ({ code: 0, stdout: "codex\n", stderr: "" }),
    };
    expect(await whichFormula("codex", deps)).toBe("codex");
  });

  test("listBrewCasks 按行拆分", async () => {
    const deps = {
      which: () => "/opt/homebrew/bin/brew",
      run: async () => ({ code: 0, stdout: "claude-code\nother-cask\n", stderr: "" }),
    };
    expect(await listBrewCasks(deps)).toEqual(["claude-code", "other-cask"]);
  });
});
