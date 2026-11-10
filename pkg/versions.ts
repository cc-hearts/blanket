/**
 * 版本号解析与比较。
 *
 * agent 的 `--version` 输出格式五花八门（"2.1.303 (Claude Code)"、
 * "codex-cli 0.163.0"、"omp/18.12.3"），这里只做一件事：提取并比较
 * semver 风格的版本号。比较结果用于“是否值得升级”，因此永远不降级。
 */

const VERSION_PATTERN = /\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?/;

/** 提取文本里的第一个版本号；没有则返回 null */
export function parseVersion(text: string): string | null {
  return text.match(VERSION_PATTERN)?.[0] ?? null;
}

function splitVersion(version: string): { core: number[]; prerelease: string[] } {
  const withoutBuild = version.split("+")[0] ?? version;
  const dash = withoutBuild.indexOf("-");
  const coreText = dash >= 0 ? withoutBuild.slice(0, dash) : withoutBuild;
  const preText = dash >= 0 ? withoutBuild.slice(dash + 1) : "";
  return {
    core: coreText.split(".").map((part) => Number.parseInt(part, 10) || 0),
    prerelease: preText.length > 0 ? preText.split(".") : [],
  };
}

function comparePrerelease(a: string[], b: string[]): number {
  if (a.length === 0 && b.length === 0) return 0;
  // 正式版高于同号预发布版
  if (a.length === 0) return 1;
  if (b.length === 0) return -1;

  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i++) {
    const left = a[i];
    const right = b[i];
    // 标识符更少的一方更小（1.0.0-rc < 1.0.0-rc.1）
    if (left === undefined) return -1;
    if (right === undefined) return 1;

    const leftNumeric = /^\d+$/.test(left);
    const rightNumeric = /^\d+$/.test(right);
    if (leftNumeric && rightNumeric) {
      const diff = Number(left) - Number(right);
      if (diff !== 0) return diff < 0 ? -1 : 1;
      continue;
    }
    // 数字标识符小于非数字标识符
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    if (left !== right) return left < right ? -1 : 1;
  }
  return 0;
}

/** 返回 -1 / 0 / 1；忽略 build 元数据 */
export function compareVersions(a: string, b: string): number {
  const left = splitVersion(a);
  const right = splitVersion(b);

  const length = Math.max(left.core.length, right.core.length);
  for (let i = 0; i < length; i++) {
    const diff = (left.core[i] ?? 0) - (right.core[i] ?? 0);
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }
  return comparePrerelease(left.prerelease, right.prerelease);
}
