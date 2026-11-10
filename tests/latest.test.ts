import { describe, expect, test } from "bun:test";
import {
  fetchLatestVersion,
  fetchVersion,
  parseBrewOutdated,
  parseRegistryLatest,
  registryLatestUrl,
  registryTagUrl,
} from "../pkg/channels/latest";

describe("registryLatestUrl", () => {
  test("scoped 包只编码斜杠，保留 @", () => {
    expect(registryLatestUrl("@openai/codex")).toBe("https://registry.npmjs.org/@openai%2Fcodex/latest");
  });

  test("普通包名原样拼接", () => {
    expect(registryLatestUrl("codex")).toBe("https://registry.npmjs.org/codex/latest");
  });
});

describe("parseRegistryLatest", () => {
  test("读取 dist-tag 响应里的 version", () => {
    expect(parseRegistryLatest({ version: "1.2.3" })).toBe("1.2.3");
  });

  test("缺字段或类型不对返回 null", () => {
    expect(parseRegistryLatest({})).toBeNull();
    expect(parseRegistryLatest(null)).toBeNull();
    expect(parseRegistryLatest({ version: 123 })).toBeNull();
  });
});

describe("fetchLatestVersion", () => {
  test("查询 npm registry 并返回版本号", async () => {
    let requested = "";
    const fetcher = (async (input: string | URL | Request) => {
      requested = String(input);
      return new Response(JSON.stringify({ version: "2.0.0" }), { status: 200 });
    }) as typeof fetch;

    await expect(fetchLatestVersion("@openai/codex", fetcher)).resolves.toBe("2.0.0");
    expect(requested).toBe("https://registry.npmjs.org/@openai%2Fcodex/latest");
  });

  test("HTTP 失败或网络异常时返回 null，不抛出", async () => {
    const notFound = (async () => new Response("nope", { status: 404 })) as unknown as typeof fetch;
    await expect(fetchLatestVersion("codex", notFound)).resolves.toBeNull();

    const broken = (async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    await expect(fetchLatestVersion("codex", broken)).resolves.toBeNull();
  });
});

describe("registryTagUrl", () => {
  test("命名标签拼到包名后面", () => {
    expect(registryTagUrl("@deepseek-ai/dsh", "next")).toBe(
      "https://registry.npmjs.org/@deepseek-ai%2Fdsh/next",
    );
  });
});

describe("fetchVersion", () => {
  test("可以查询 latest 之外的 dist-tag", async () => {
    let requested = "";
    const fetcher = (async (input: string | URL | Request) => {
      requested = String(input);
      return new Response(JSON.stringify({ version: "0.2.2-rc.1" }), { status: 200 });
    }) as typeof fetch;

    await expect(fetchVersion("@deepseek-ai/dsh", "next", fetcher)).resolves.toBe("0.2.2-rc.1");
    expect(requested).toBe("https://registry.npmjs.org/@deepseek-ai%2Fdsh/next");
  });
});

describe("parseBrewOutdated", () => {
  test("同时解析 formula 与 cask 的当前/最新版本", () => {
    const out = parseBrewOutdated({
      formulae: [
        {
          name: "codex",
          installed_versions: ["0.160.0"],
          current_version: "0.163.0",
        },
      ],
      casks: [
        {
          name: "claude-code",
          installed_versions: ["2.1.300"],
          current_version: "2.1.303",
        },
      ],
    });

    expect(out.get("codex")).toEqual({ current: "0.160.0", latest: "0.163.0", kind: "formula" });
    expect(out.get("claude-code")).toEqual({ current: "2.1.300", latest: "2.1.303", kind: "cask" });
  });

  test("空输入返回空表", () => {
    expect(parseBrewOutdated({}).size).toBe(0);
    expect(parseBrewOutdated(null).size).toBe(0);
  });
});
