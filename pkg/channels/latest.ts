/**
 * 最新版查询：npm registry 与 Homebrew 的可升级列表。
 *
 * 查询失败一律返回 null —— 调用方会把它当作“无法确定最新版”，
 * 只报告、不升级，绝不在信息不足时动手。
 */

const NPM_REGISTRY = "https://registry.npmjs.org";

/** scoped 包只编码斜杠：@openai/codex → @openai%2Fcodex */
export function registryTagUrl(pkg: string, tag: string): string {
  return `${NPM_REGISTRY}/${pkg.replace("/", "%2F")}/${tag}`;
}

export function registryLatestUrl(pkg: string): string {
  return registryTagUrl(pkg, "latest");
}

export function parseRegistryLatest(json: unknown): string | null {
  if (json === null || typeof json !== "object") return null;
  const version = (json as { version?: unknown }).version;
  return typeof version === "string" ? version : null;
}

/** 查询指定 dist-tag 的具体版本；失败返回 null */
export async function fetchVersion(
  pkg: string,
  tag: string = "latest",
  fetcher: typeof fetch = fetch,
): Promise<string | null> {
  try {
    const response = await fetcher(registryTagUrl(pkg, tag));
    if (!response.ok) return null;
    return parseRegistryLatest(await response.json());
  } catch {
    return null;
  }
}

export async function fetchLatestVersion(pkg: string, fetcher: typeof fetch = fetch): Promise<string | null> {
  return fetchVersion(pkg, "latest", fetcher);
}

export interface BrewOutdatedEntry {
  current: string | null;
  latest: string | null;
  kind: "formula" | "cask";
}

function readBrewList(list: unknown, kind: BrewOutdatedEntry["kind"], out: Map<string, BrewOutdatedEntry>): void {
  if (!Array.isArray(list)) return;
  for (const item of list) {
    if (item === null || typeof item !== "object") continue;
    const record = item as { name?: unknown; installed_versions?: unknown; current_version?: unknown };
    if (typeof record.name !== "string") continue;
    const installed = Array.isArray(record.installed_versions)
      ? record.installed_versions.filter((v): v is string => typeof v === "string")
      : [];
    out.set(record.name, {
      current: installed.at(-1) ?? null,
      latest: typeof record.current_version === "string" ? record.current_version : null,
      kind,
    });
  }
}

/** 解析 `brew outdated --json=v2`：名字 → 当前/最新版与 formula/cask 类型 */
export function parseBrewOutdated(json: unknown): Map<string, BrewOutdatedEntry> {
  const out = new Map<string, BrewOutdatedEntry>();
  if (json === null || typeof json !== "object") return out;
  const data = json as { formulae?: unknown; casks?: unknown };
  readBrewList(data.formulae, "formula", out);
  readBrewList(data.casks, "cask", out);
  return out;
}
