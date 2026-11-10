/**
 * 行级 diff：给 TUI 预览用，只报真正的增删，不做「按位置对齐」。
 *
 * 为什么不能按位置比：插入一行会让后面所有行下标错位，逐位比较就会把
 * 整段文件都报成「改了」。用户看到 `- name = "custom"` / `+ [model_providers.custom]`
 * 这种假改动，根本判断不出实际改了什么。
 *
 * 做法：先剥掉公共前缀/后缀（「往文件末尾追加一个键」这类改动几乎全被剥掉），
 * 再对剩下的中间段做 LCS。中间段通常极小，所以这个朴素 DP 足够快；
 * 万一遇到巨大的中间段，就用兜底表示，绝不卡死界面。
 */

/** 一行在 diff 里的角色。 */
export type DiffKind = "same" | "add" | "del";

export interface DiffLine {
  kind: DiffKind;
  text: string;
  /** 原文件 / 新文件里的行号（1 起）；新增行没有旧行号，删除行没有新行号 */
  oldNo?: number;
  newNo?: number;
}

export interface DiffResult {
  lines: DiffLine[];
  /** 因 maxLines 被截断的剩余行数 */
  truncated: number;
  /** 增删总数（截断前） */
  added: number;
  removed: number;
}

/** LCS DP 的规模上限：超过就走兜底，避免大文件把界面算死。 */
const LCS_CELL_CAP = 4_000_000;

/**
 * 计算两段文本的行级 diff。
 * @param before 原文本
 * @param after 新文本
 * @param context 每处改动上下保留的上下文行数（默认 2，够看懂位置）
 */
export function diffLines(before: string, after: string, context = 2): DiffResult {
  const a = before.split("\n");
  const b = after.split("\n");

  // 1) 剥公共前缀
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;

  // 2) 剥公共后缀（不与前缀重叠）
  let suffix = 0;
  while (
    suffix < a.length - prefix &&
    suffix < b.length - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  ) {
    suffix++;
  }

  const aMid = a.slice(prefix, a.length - suffix);
  const bMid = b.slice(prefix, b.length - suffix);

  // 3) 中间段做 LCS
  const mid = lcsOps(aMid, bMid);

  // 4) 拼成完整行序列，并记行号
  const all: DiffLine[] = [];
  const push = (kind: DiffKind, text: string, oldNo?: number, newNo?: number) =>
    all.push({ kind, text, ...(oldNo === undefined ? {} : { oldNo }), ...(newNo === undefined ? {} : { newNo }) });

  for (let i = 0; i < prefix; i++) push("same", a[i] as string, i + 1, i + 1);
  let oldCursor = prefix;
  let newCursor = prefix;
  for (const op of mid) {
    if (op.kind === "same") {
      push("same", op.text, ++oldCursor, ++newCursor);
    } else if (op.kind === "del") {
      push("del", op.text, ++oldCursor, undefined);
    } else {
      push("add", op.text, undefined, ++newCursor);
    }
  }
  for (let i = 0; i < suffix; i++) {
    const oldNo = a.length - suffix + i + 1;
    const newNo = b.length - suffix + i + 1;
    push("same", a[a.length - suffix + i] as string, oldNo, newNo);
  }

  const added = all.filter((l) => l.kind === "add").length;
  const removed = all.filter((l) => l.kind === "del").length;

  return { lines: all, truncated: 0, added, removed };
}

/**
 * 只保留改动附近 context 行上下文，中间的连续未变段折叠成省略标记。
 * 这是给界面用的视图，不是完整 diff。
 */
export function compactDiff(result: DiffResult, context = 2): DiffLine[] {
  const keep = new Array<boolean>(result.lines.length).fill(false);
  result.lines.forEach((line, i) => {
    if (line.kind === "same") return;
    for (let j = Math.max(0, i - context); j <= Math.min(result.lines.length - 1, i + context); j++) {
      keep[j] = true;
    }
  });

  const out: DiffLine[] = [];
  let skipping = 0;
  for (let i = 0; i < result.lines.length; i++) {
    if (keep[i] === true) {
      if (skipping > 0) {
        out.push({ kind: "same", text: `… 省略 ${skipping} 行未改动 …` });
        skipping = 0;
      }
      out.push(result.lines[i] as DiffLine);
    } else {
      skipping++;
    }
  }
  if (skipping > 0) out.push({ kind: "same", text: `… 省略 ${skipping} 行未改动 …` });
  return out;
}

interface Op {
  kind: DiffKind;
  text: string;
}

/** 对中间段求 LCS 编辑脚本；规模过大时退化为「整段替换」。 */
function lcsOps(a: string[], b: string[]): Op[] {
  if (a.length === 0 && b.length === 0) return [];
  if (a.length === 0) return b.map((text) => ({ kind: "add" as const, text }));
  if (b.length === 0) return a.map((text) => ({ kind: "del" as const, text }));

  if (a.length * b.length > LCS_CELL_CAP) {
    // 兜底：不假装知道对应关系，如实报「这些删了、这些加了」
    return [...a.map((text) => ({ kind: "del" as const, text })), ...b.map((text) => ({ kind: "add" as const, text }))];
  }

  const n = a.length;
  const m = b.length;
  // dp[i][j] = a[i..] 与 b[j..] 的 LCS 长度
  const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    const row = dp[i] as Uint32Array;
    const next = dp[i + 1] as Uint32Array;
    for (let j = m - 1; j >= 0; j--) {
      row[j] = a[i] === b[j] ? (next[j + 1] as number) + 1 : Math.max(next[j] as number, row[j + 1] as number);
    }
  }

  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ kind: "same", text: a[i] as string });
      i++;
      j++;
    } else if ((dp[i + 1] as Uint32Array)[j]! >= (dp[i] as Uint32Array)[j + 1]!) {
      ops.push({ kind: "del", text: a[i] as string });
      i++;
    } else {
      ops.push({ kind: "add", text: b[j] as string });
      j++;
    }
  }
  while (i < n) ops.push({ kind: "del", text: a[i++] as string });
  while (j < m) ops.push({ kind: "add", text: b[j++] as string });
  return ops;
}
