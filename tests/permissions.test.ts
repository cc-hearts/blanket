#!/usr/bin/env bun
/**
 * 权限开关的单元测试：跑 `bun run test`。
 *
 * 只测纯逻辑（文本手术 + 各适配器的 plan 幂等/可逆），不碰真实配置 ——
 * 每个用例都把 HOME 指到一个临时目录，避免误改用户文件。
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  getJsonPath,
  getYamlScalar,
  setJsonPath,
  setYamlScalar,
  unsetJsonPath,
  unsetYamlScalar,
  writeWithBackup,
} from "../scripts/perm/files";

let sandbox: string;
let realHome: string | undefined;

beforeEach(() => {
  sandbox = join("/tmp", `blanket-test-${process.pid}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(sandbox, { recursive: true });
  realHome = process.env.HOME;
  // 注意：os.homedir() 不跟随 HOME（Bun/Node 会缓存真实家目录），
  // 所以不能用 HOME 来隔离。改用各适配器自己尊重的覆盖变量。
  process.env.DSH_HOME = join(sandbox, ".dsh");
  process.env.CODEX_HOME = join(sandbox, ".codex");
  process.env.XDG_CONFIG_HOME = join(sandbox, ".config");
  process.env.PI_AGENT_DIR = join(sandbox, ".pi", "agent");
  process.env.OMP_AGENT_DIR = join(sandbox, ".omp", "agent");
  process.env.CLAUDE_CONFIG_DIR = join(sandbox, "claude-config");
});

afterEach(() => {
  if (realHome !== undefined) process.env.HOME = realHome;
  delete process.env.DSH_HOME;
  delete process.env.CODEX_HOME;
  delete process.env.XDG_CONFIG_HOME;
  delete process.env.PI_AGENT_DIR;
  delete process.env.OMP_AGENT_DIR;
  delete process.env.CLAUDE_CONFIG_DIR;
  rmSync(sandbox, { recursive: true, force: true });
});

/** 建一个文件并返回路径。 */
function makeFile(rel: string, content: string): string {
  const path = join(sandbox, rel);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
  return path;
}

describe("YAML 文本手术", () => {
  test("新增段落不破坏原有内容", async () => {
    const before = "a:\n  x: 1\nb:\n  y: 2\n";
    const after = setYamlScalar(before, "permission", "defaultPreset", "danger-full-access");
    expect(after).toContain("a:\n  x: 1");
    expect(after).toContain("b:\n  y: 2");
    expect(getYamlScalar(after, "permission", "defaultPreset")).toBe("danger-full-access");
  });

  test("已有键只替换值，保留同级其它键", async () => {
    const before = "permission:\n  defaultPreset: workspace-write\n  other: keep\n";
    const after = setYamlScalar(before, "permission", "defaultPreset", "danger-full-access");
    expect(after).toContain("other: keep");
    expect(after).toContain("defaultPreset: danger-full-access");
    expect(after).not.toContain("workspace-write");
  });

  test("幂等：重复设置同一值结果不变", async () => {
    const once = setYamlScalar("a: 1\n", "permission", "defaultPreset", "danger-full-access");
    const twice = setYamlScalar(once, "permission", "defaultPreset", "danger-full-access");
    expect(twice).toBe(once);
  });

  test("删除后段落为空则连段头一起删，且字节还原", async () => {
    const before = "a:\n  x: 1\n";
    const added = setYamlScalar(before, "permission", "defaultPreset", "danger-full-access");
    const removed = unsetYamlScalar(added, "permission", "defaultPreset");
    expect(removed).toBe(before);
  });

  test("保留原有段落里的其它键，只删目标键", async () => {
    const before = "permission:\n  defaultPreset: danger-full-access\n  keep: yes\n";
    const after = unsetYamlScalar(before, "permission", "defaultPreset");
    expect(after).toContain("keep: yes");
    expect(after).not.toContain("defaultPreset");
    expect(after).toContain("permission:");
  });

  test("原文末尾无换行时不擅自加换行", async () => {
    const before = "a: 1";
    const after = setYamlScalar(before, "permission", "defaultPreset", "x");
    expect(after.endsWith("\n")).toBe(false);
  });
});

describe("JSON 文本手术", () => {
  test("设置深层键保留其它键与顺序", async () => {
    const before = `${JSON.stringify({ env: { A: "1" }, model: "m" }, null, 2)}\n`;
    const after = setJsonPath(before, ["permissions", "defaultMode"], "bypassPermissions");
    expect(after).not.toBeNull();
    expect(getJsonPath(after, ["permissions", "defaultMode"])).toBe("bypassPermissions");
    expect(getJsonPath(after, ["model"])).toBe("m");
    expect(getJsonPath(after, ["env", "A"])).toBe("1");
  });

  test("幂等", async () => {
    const before = "{}\n";
    const once = setJsonPath(before, ["permissions", "defaultMode"], "x");
    const twice = setJsonPath(once, ["permissions", "defaultMode"], "x");
    expect(twice).toBe(once);
  });

  test("设置后删除可字节还原", async () => {
    const before = `${JSON.stringify({ a: 1, b: { c: 2 } }, null, 2)}\n`;
    const added = setJsonPath(before, ["permissions", "defaultMode"], "bypassPermissions");
    const removed = unsetJsonPath(added, ["permissions", "defaultMode"]);
    expect(removed).toBe(before);
  });

  test("删除会回收变空的父对象", async () => {
    const before = "{}\n";
    const added = setJsonPath(before, ["projects", "/x", "trusted"], true);
    const removed = unsetJsonPath(added, ["projects", "/x", "trusted"]);
    expect(removed).toBe(before);
  });

  test("非法 JSON 拒绝改写（返回 null）", async () => {
    expect(setJsonPath("{not json", ["a"], 1)).toBeNull();
    expect(unsetJsonPath("{not json", ["a"])).toBeNull();
  });

  test("文件不存在时能新建", async () => {
    const after = setJsonPath(null, ["permission"], "allow");
    expect(getJsonPath(after, ["permission"])).toBe("allow");
  });

  test("原文末尾无换行时不擅自加换行", async () => {
    const after = setJsonPath('{"a":1}', ["b"], 2);
    expect(after?.endsWith("\n")).toBe(false);
  });
});

describe("备份与原子写", () => {
  test("内容不变时不写、不备份", async () => {
    const path = makeFile("x.json", "{}\n");
    const result = writeWithBackup(path, "{}\n");
    expect(result.changed).toBe(false);
    expect(result.backup).toBeNull();
  });

  test("内容变化时先备份再写", async () => {
    const path = makeFile("x.json", '{"a":1}\n');
    const result = writeWithBackup(path, '{"a":2}\n');
    expect(result.changed).toBe(true);
    expect(result.backup).not.toBeNull();
    expect(readFileSync(result.backup as string, "utf8")).toBe('{"a":1}\n');
    expect(readFileSync(path, "utf8")).toBe('{"a":2}\n');
  });
});

describe("各 agent 适配器", () => {
  test("DSH：开→关字节还原，且关闭只回退自己写的值", async () => {
    const { dshTarget } = await import("../scripts/perm/dsh");
    const path = makeFile(".dsh/settings.yaml", "ui-theme:\n  preference: system\n");
    const original = readFileSync(path, "utf8");

    const on = await dshTarget.plan("full-access", true);
    expect(on.edits).toHaveLength(1);
    writeFileSync(path, (on.edits[0] as { next: string }).next);
    expect((await dshTarget.inspect())[0]?.enabled).toBe(true);

    const off = await dshTarget.plan("full-access", false);
    writeFileSync(path, (off.edits[0] as { next: string }).next);
    expect(readFileSync(path, "utf8")).toBe(original);
  });

  test("DSH：已经开启时 plan 为空（幂等）", async () => {
    const { dshTarget } = await import("../scripts/perm/dsh");
    makeFile(".dsh/settings.yaml", "permission:\n  defaultPreset: danger-full-access\n");
    expect((await dshTarget.plan("full-access", true)).edits).toHaveLength(0);
  });

  test("DSH：不覆盖用户自己设的其它预设", async () => {
    const { dshTarget } = await import("../scripts/perm/dsh");
    makeFile(".dsh/settings.yaml", "permission:\n  defaultPreset: read-only\n");
    const off = await dshTarget.plan("full-access", false);
    expect(off.edits).toHaveLength(0);
    expect(off.note).toContain("read-only");
  });

  test("Claude Code：完全访问写两个文件，关闭后各自还原", async () => {
    const { claudeTarget } = await import("../scripts/perm/claude");
    const settings = makeFile("claude-config/settings.json", '{\n  "model": "m"\n}\n');
    const proj = makeFile("claude-config/.claude.json", '{\n  "projects": {}\n}\n');
    const origSettings = readFileSync(settings, "utf8");
    const origProj = readFileSync(proj, "utf8");

    const on = await claudeTarget.plan("full-access", true);
    expect(on.edits).toHaveLength(2);
    for (const e of on.edits) writeFileSync(e.path, e.next);
    expect((await claudeTarget.inspect())[0]?.enabled).toBe(true);

    const off = await claudeTarget.plan("full-access", false);
    for (const e of off.edits) writeFileSync(e.path, e.next);
    expect(readFileSync(settings, "utf8")).toBe(origSettings);
    expect(readFileSync(proj, "utf8")).toBe(origProj);
  });

  test("Codex：写 never + danger-full-access，关闭后还原", async () => {
    const { codexTarget } = await import("../scripts/perm/codex");
    const path = makeFile(".codex/config.toml", 'model = "m"\n\n[projects."/x"]\ntrust_level = "trusted"\n');
    const original = readFileSync(path, "utf8");

    const on = await codexTarget.plan("full-access", true);
    writeFileSync(path, (on.edits[0] as { next: string }).next);
    const text = readFileSync(path, "utf8");
    expect(text).toContain('approval_policy = "never"');
    expect(text).toContain('sandbox_mode = "danger-full-access"');
    // 原有段落必须还在
    expect(text).toContain('[projects."/x"]');
    expect((await codexTarget.inspect())[0]?.enabled).toBe(true);

    const off = await codexTarget.plan("full-access", false);
    writeFileSync(path, (off.edits[0] as { next: string }).next);
    expect(readFileSync(path, "utf8")).toBe(original);
  });

  test("Codex：信任当前目录可逆", async () => {
    const { codexTarget } = await import("../scripts/perm/codex");
    const path = makeFile(".codex/config.toml", 'model = "m"\n');
    const original = readFileSync(path, "utf8");

    const on = await codexTarget.plan("trust-all", true);
    writeFileSync(path, (on.edits[0] as { next: string }).next);
    expect((await codexTarget.inspect())[1]?.enabled).toBe(true);

    const off = await codexTarget.plan("trust-all", false);
    writeFileSync(path, (off.edits[0] as { next: string }).next);
    expect(readFileSync(path, "utf8")).toBe(original);
  });

  test("OpenCode：permission=allow 可逆，且保留 provider", async () => {
    const { opencodeTarget } = await import("../scripts/perm/opencode");
    const path = makeFile(".config/opencode/opencode.json", `${JSON.stringify({ provider: { p: 1 } }, null, 2)}\n`);
    const original = readFileSync(path, "utf8");

    const on = await opencodeTarget.plan("full-access", true);
    writeFileSync(path, (on.edits[0] as { next: string }).next);
    expect((await opencodeTarget.inspect())[0]?.enabled).toBe(true);
    expect(readFileSync(path, "utf8")).toContain('"provider"');

    const off = await opencodeTarget.plan("full-access", false);
    writeFileSync(path, (off.edits[0] as { next: string }).next);
    expect(readFileSync(path, "utf8")).toBe(original);
  });

  test("pi：defaultProjectTrust=always 可逆，保留其它设置", async () => {
    const { piTarget } = await import("../scripts/perm/pi");
    const path = makeFile(".pi/agent/settings.json", `${JSON.stringify({ defaultModel: "m" }, null, 2)}\n`);
    const original = readFileSync(path, "utf8");

    const on = await piTarget.plan("trust-all", true);
    writeFileSync(path, (on.edits[0] as { next: string }).next);
    expect((await piTarget.inspect())[1]?.enabled).toBe(true);
    expect(readFileSync(path, "utf8")).toContain('"defaultModel"');

    const off = await piTarget.plan("trust-all", false);
    writeFileSync(path, (off.edits[0] as { next: string }).next);
    expect(readFileSync(path, "utf8")).toBe(original);
  });

  test("pi：完全访问如实报「不支持」，不编造可写项", async () => {
    const { piTarget } = await import("../scripts/perm/pi");
    makeFile(".pi/agent/settings.json", "{}\n");
    const state = (await piTarget.inspect())[0];
    expect(state?.supported).toBe(false);
    expect((await piTarget.plan("full-access", true)).edits).toHaveLength(0);
  });

  test("omp：关闭时显式降档（因为默认就是 yolo，删键等于没关）", async () => {
    const { ompTarget } = await import("../scripts/perm/omp");
    const path = makeFile(".omp/agent/config.yml", "symbolPreset: unicode\n");

    const off = await ompTarget.plan("full-access", false);
    expect(off.edits).toHaveLength(1);
    writeFileSync(path, (off.edits[0] as { next: string }).next);
    expect(readFileSync(path, "utf8")).toContain("approvalMode: write");
    expect((await ompTarget.inspect())[0]?.enabled).toBe(false);

    const on = await ompTarget.plan("full-access", true);
    writeFileSync(path, (on.edits[0] as { next: string }).next);
    expect((await ompTarget.inspect())[0]?.enabled).toBe(true);
    // 其它键没被碰
    expect(readFileSync(path, "utf8")).toContain("symbolPreset: unicode");
  });

  test("所有适配器：未知开关不会产生任何写入", async () => {
    const mods = await Promise.all([
      import("../scripts/perm/dsh"),
      import("../scripts/perm/claude"),
      import("../scripts/perm/codex"),
      import("../scripts/perm/opencode"),
      import("../scripts/perm/pi"),
      import("../scripts/perm/omp"),
    ]);
    const targets = [mods[0].dshTarget, mods[1].claudeTarget, mods[2].codexTarget, mods[3].opencodeTarget, mods[4].piTarget, mods[5].ompTarget];
    for (const t of targets) {
      // trust-all 对不支持的 agent、full-access 对 pi，都不应产出写入
      const plan = await t.plan("trust-all", true);
      const states = await t.inspect();
      const trust = states.find((s) => s.id === "trust-all");
      if (trust?.supported === false) expect(plan.edits).toHaveLength(0);
    }
  });
});

describe("diff 预览", () => {
  test("插入一行不会把后面所有行报成改动", async () => {
    const { diffLines } = await import("../scripts/perm/diff");
    const before = "a\nb\nc\nd\n";
    const after = "a\nb\nNEW\nc\nd\n";
    const r = diffLines(before, after);
    // 真正的改动只有 1 行新增
    expect(r.added).toBe(1);
    expect(r.removed).toBe(0);
  });

  test("JSON 里追加一个键：报真实的增删，不是整段错位", async () => {
    const { diffLines } = await import("../scripts/perm/diff");
    const before = '{\n  "env": {\n    "A": "1"\n  },\n  "model": "m"\n}\n';
    const after = '{\n  "env": {\n    "A": "1"\n  },\n  "model": "m",\n  "permissions": {\n    "defaultMode": "bypassPermissions"\n  }\n}\n';
    const r = diffLines(before, after);
    // 改的是 model 行加了逗号 + 新增 3 行
    expect(r.added).toBe(4);
    expect(r.removed).toBe(1);
  });

  test("TOML 顶层插两行：只报 2 行新增", async () => {
    const { diffLines } = await import("../scripts/perm/diff");
    const before = 'model = "m"\n\n[model_providers.custom]\nname = "custom"\nwire_api = "responses"\n';
    const after = 'model = "m"\n\napproval_policy = "never"\nsandbox_mode = "danger-full-access"\n[model_providers.custom]\nname = "custom"\nwire_api = "responses"\n';
    const r = diffLines(before, after);
    expect(r.added).toBe(2);
    expect(r.removed).toBe(0);
  });

  test("大文件的中间段不参与 LCS，直接兜底不卡死", async () => {
    const { diffLines } = await import("../scripts/perm/diff");
    const a = Array.from({ length: 3000 }, (_, i) => `line-${i}`).join("\n");
    const b = Array.from({ length: 3000 }, (_, i) => `other-${i}`).join("\n");
    const t0 = Date.now();
    const r = diffLines(a, b);
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(r.added).toBe(3000);
    expect(r.removed).toBe(3000);
  });

  test("compactDiff 折叠远处未改动行并保留改动上下文", async () => {
    const { compactDiff, diffLines } = await import("../scripts/perm/diff");
    const before = Array.from({ length: 200 }, (_, i) => `l${i}`).join("\n");
    const after = before.replace("l100", "CHANGED");
    const lines = compactDiff(diffLines(before, after), 2);
    expect(lines.some((l) => l.kind === "del" && l.text === "l100")).toBe(true);
    expect(lines.some((l) => l.kind === "add" && l.text === "CHANGED")).toBe(true);
    // 200 行输入应该被折叠成很少的几行
    expect(lines.length).toBeLessThan(15);
    expect(lines.some((l) => l.text.startsWith("… 省略"))).toBe(true);
  });

  test("完全相同的文本没有增删", async () => {
    const { diffLines } = await import("../scripts/perm/diff");
    const r = diffLines("a\nb\n", "a\nb\n");
    expect(r.added).toBe(0);
    expect(r.removed).toBe(0);
  });
});
