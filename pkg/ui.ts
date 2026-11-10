/**
 * 终端输出小工具：颜色、ANSI 安全的等宽对齐表格。
 * 只在 TTY 且未设置 NO_COLOR 时上色，方便管道/日志使用。
 */

const colorEnabled = (process.stdout.isTTY ?? false) && !process.env.NO_COLOR;
const ANSI_PATTERN = /\x1b\[[0-9;]*m/g;

const paint = (code: string, s: string): string => (colorEnabled ? `\x1b[${code}m${s}\x1b[0m` : s);

export const c = {
  dim: (s: string) => paint("2", s),
  bold: (s: string) => paint("1", s),
  red: (s: string) => paint("31", s),
  green: (s: string) => paint("32", s),
  yellow: (s: string) => paint("33", s),
  blue: (s: string) => paint("34", s),
  cyan: (s: string) => paint("36", s),
  gray: (s: string) => paint("90", s),
};

export function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, "");
}

/** 东亚全角字符按 2 列计宽，自动忽略 ANSI 颜色码，保证表格对齐 */
export function displayWidth(text: string): number {
  let width = 0;
  for (const ch of stripAnsi(text)) {
    const code = ch.codePointAt(0) ?? 0;
    const wide =
      (code >= 0x1100 && code <= 0x115f) ||
      (code >= 0x2e80 && code <= 0xa4cf) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe30 && code <= 0xfe6f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6) ||
      (code >= 0x1f300 && code <= 0x1f64f) ||
      (code >= 0x1f900 && code <= 0x1f9ff);
    width += wide ? 2 : 1;
  }
  return width;
}

export function pad(text: string, width: number): string {
  return text + " ".repeat(Math.max(0, width - displayWidth(text)));
}

export function padLeft(text: string, width: number): string {
  return " ".repeat(Math.max(0, width - displayWidth(text))) + text;
}

export interface Column {
  title: string;
  /** 列宽下限 */
  min?: number;
  align?: "left" | "right";
}

/** 按内容自动定宽的表格；列宽同时考虑表头和所有单元格 */
export function renderTable(columns: Column[], rows: string[][]): string {
  const widths = columns.map((col, i) =>
    Math.max(...[col.title, ...rows.map((r) => r[i] ?? "")].map(displayWidth), col.min ?? 0),
  );
  const renderRow = (cells: string[]) =>
    columns
      .map((col, i) => {
        const cell = cells[i] ?? "";
        return col.align === "right" ? padLeft(cell, widths[i] ?? 0) : pad(cell, widths[i] ?? 0);
      })
      .join("  ")
      .trimEnd();

  const header = renderRow(columns.map((col) => col.title));
  const divider = columns.map((_, i) => "─".repeat(widths[i] ?? 0)).join("──");
  const out = [header, divider];
  for (const row of rows) out.push(renderRow(row));
  return out.join("\n");
}
