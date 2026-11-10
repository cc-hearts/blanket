import { describe, expect, test } from "bun:test";
import { run } from "../pkg/channels/run";

describe("run", () => {
  test("收集 stdout / stderr / 退出码", async () => {
    const result = await run(["sh", "-c", "printf out; printf err >&2; exit 3"]);
    expect(result.code).toBe(3);
    expect(result.stdout).toBe("out");
    expect(result.stderr).toBe("err");
  });

  test("命令不存在时返回非 0 而不是抛出", async () => {
    const result = await run(["definitely-not-a-real-command-blanket"]);
    expect(result.code).not.toBe(0);
  });
});
