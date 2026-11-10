import { describe, expect, test } from "bun:test";
import { compareVersions, parseVersion } from "../pkg/versions";

describe("parseVersion", () => {
  test("从各 agent 的 --version 输出里提取版本号", () => {
    expect(parseVersion("2.1.303 (Claude Code)")).toBe("2.1.303");
    expect(parseVersion("codex-cli 0.163.0")).toBe("0.163.0");
    expect(parseVersion("opencode v2.0.32")).toBe("2.0.32");
    expect(parseVersion("1.4.0")).toBe("1.4.0");
    expect(parseVersion("omp/18.12.3")).toBe("18.12.3");
    expect(parseVersion("0.2.1-rc.2")).toBe("0.2.1-rc.2");
  });

  test("没有版本号时返回 null", () => {
    expect(parseVersion("no version here")).toBeNull();
    expect(parseVersion("")).toBeNull();
  });
});

describe("compareVersions", () => {
  test("按数字比较主次修订号，不是字典序", () => {
    expect(compareVersions("1.2.3", "1.2.3")).toBe(0);
    expect(compareVersions("1.2.4", "1.2.3")).toBe(1);
    expect(compareVersions("1.2.3", "1.2.4")).toBe(-1);
    expect(compareVersions("1.10.0", "1.9.9")).toBe(1);
    expect(compareVersions("2.0.0", "1.99.99")).toBe(1);
  });

  test("正式版高于同号预发布版", () => {
    expect(compareVersions("1.2.3", "1.2.3-rc.2")).toBe(1);
    expect(compareVersions("1.2.3-rc.2", "1.2.3")).toBe(-1);
  });

  test("预发布标识符按 semver 规则比较", () => {
    expect(compareVersions("1.2.3-rc.2", "1.2.3-rc.10")).toBe(-1);
    expect(compareVersions("1.2.3-rc.10", "1.2.3-rc.2")).toBe(1);
    expect(compareVersions("1.2.3-beta", "1.2.3-rc")).toBe(-1);
  });

  test("build 元数据不参与比较", () => {
    expect(compareVersions("1.2.3+build.5", "1.2.3")).toBe(0);
  });
});
