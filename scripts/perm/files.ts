/**
 * 配置文件读写：原子写 + 时间戳备份 + YAML/JSON 最小文本手术。
 *
 * 为什么不用 YAML 库整篇重写：这些文件里可能有注释、锚点、手写格式，
 * 而且有的被 agent 自己热加载甚至回写。整篇 stringify 会毁掉它们，
 * 所以这里只做「找到那一行、换掉那个值」的最小改动。
 */

import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

/** 备份根目录：所有被本工具改过的文件都在这儿留一份带时间戳的副本。 */
export const BACKUP_ROOT = join(homedir(), ".blanket", "backups");

/** 读文本；文件不存在返回 null。 */
export function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/** 读 JSON；不存在或解析失败返回 null。 */
export function readJson<T = unknown>(path: string): T | null {
  const text = readText(path);
  if (text === null) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

/**
 * 原子写：同目录临时文件 → fsync → rename。
 * 保留原文件权限位；新文件用 0600（配置里常有 token）。
 */
export function writeAtomic(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  let mode = 0o600;
  try {
    mode = statSync(path).mode & 0o777;
  } catch {
    /* 新文件 */
  }
  const tmp = join(dirname(path), `.${basename(path)}.blanket-${process.pid}-${Date.now()}`);
  const fd = openSync(tmp, "w", mode);
  try {
    writeFileSync(fd, content);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    chmodSync(tmp, mode);
  } catch {
    /* 尽力而为 */
  }
  try {
    renameSync(tmp, path);
  } catch (error) {
    try {
      unlinkSync(tmp);
    } catch {
      /* 忽略 */
    }
    throw error;
  }
}

/** 时间戳，形如 20261010-120000，用于备份目录名。 */
function stamp(now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}` +
    `-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`
  );
}

/**
 * 把文件备份到 ~/.blanket/backups/<时间戳>/<扁平化路径>。
 * 文件不存在时返回 null（没什么可备份的）。
 */
export function backup(path: string, now = new Date()): string | null {
  if (!existsSync(path)) return null;
  const flat = path.replace(/^[/\\]+/, "").replace(/[/\\]+/g, "__");
  const dir = join(BACKUP_ROOT, stamp(now));
  mkdirSync(dir, { recursive: true });
  const dest = join(dir, flat);
  copyFileSync(path, dest);
  return dest;
}

/** 写文件：先备份再原子写。内容与现状相同则跳过（幂等，不产生无意义备份）。 */
export function writeWithBackup(path: string, content: string): { backup: string | null; changed: boolean } {
  const current = readText(path);
  if (current === content) return { backup: null, changed: false };
  const saved = backup(path);
  writeAtomic(path, content);
  return { backup: saved, changed: true };
}

/** 转义正则元字符。 */
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 定位顶层 YAML 段落，返回 [起始行, 结束行)；找不到返回 null。 */
function findSection(lines: string[], section: string): [number, number] | null {
  const head = new RegExp(`^${escapeRe(section)}\\s*:\\s*(#.*)?$`);
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (head.test(lines[i] as string)) {
      start = i;
      break;
    }
  }
  if (start < 0) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i] as string;
    if (line.trim() === "") continue;
    if (/^\s/.test(line)) continue; // 缩进行属于本段
    end = i;
    break;
  }
  return [start, end];
}

/** 保留原文件的末尾换行习惯：原文没有换行就不加。 */
function keepEol(rendered: string, original: string): string {
  return original.endsWith("\n") || original.length === 0 ? rendered : rendered.replace(/\n$/, "");
}

/**
 * 设置顶层 YAML 段落里的一个标量：`section.key: value`。
 * 已有 key 只换那一行（连同行尾注释一起换成我们写的），否则在段内追加，
 * 段不存在则在文末追加。段落之外的内容一个字节都不动。
 */
export function setYamlScalar(text: string, section: string, key: string, value: string): string {
  const lines = text.split("\n");
  const found = findSection(lines, section);
  if (found === null) {
    const head = text.length === 0 || text.endsWith("\n") ? text : `${text}\n`;
    return keepEol(`${head}${section}:\n  ${key}: ${value}\n`, text);
  }
  const [start, end] = found;
  const keyRe = new RegExp(`^(\\s+)${escapeRe(key)}\\s*:`);
  for (let i = start + 1; i < end; i++) {
    const line = lines[i] as string;
    if (!keyRe.test(line)) continue;
    const indent = /^(\s+)/.exec(line)?.[1] ?? "  ";
    lines[i] = `${indent}${key}: ${value}`;
    return keepEol(lines.join("\n"), text);
  }
  lines.splice(end, 0, `  ${key}: ${value}`);
  return keepEol(lines.join("\n"), text);
}

/** 读顶层 YAML 段落里的一个标量（粗糙但够用：只认 `key: value` 一行）。 */
export function getYamlScalar(text: string, section: string, key: string): string | null {
  const lines = text.split("\n");
  const found = findSection(lines, section);
  if (found === null) return null;
  const [start, end] = found;
  const keyRe = new RegExp(`^\\s+${escapeRe(key)}\\s*:\\s*(.*?)\\s*$`);
  for (let i = start + 1; i < end; i++) {
    const m = keyRe.exec(lines[i] as string);
    if (m) return (m[1] as string).replace(/\s+#.*$/, "") || null;
  }
  return null;
}

/** 删除顶层 YAML 段落里的一个标量行；段内因此变空则连同段头一起删掉。 */
export function unsetYamlScalar(text: string, section: string, key: string): string {
  const lines = text.split("\n");
  const found = findSection(lines, section);
  if (found === null) return text;
  const [start, end] = found;
  const keyRe = new RegExp(`^\\s+${escapeRe(key)}\\s*:`);
  for (let i = start + 1; i < end; i++) {
    if (!keyRe.test(lines[i] as string)) continue;
    lines.splice(i, 1);
    const rest = lines.slice(start + 1, end - 1).filter((l) => l.trim() !== "");
    if (rest.length === 0) lines.splice(start, 1);
    return keepEol(lines.join("\n"), text);
  }
  return text;
}

/**
 * 按原文件的换行习惯渲染：原文件末尾没有换行就不加，
 * 这样「改一个键再改回来」能字节级还原，也不会产生无意义的 diff。
 */
function renderJson(base: Record<string, unknown>, original: string | null): string {
  const body = JSON.stringify(base, null, 2);
  return original !== null && !original.endsWith("\n") ? body : `${body}\n`;
}

/**
 * 在 JSON 文本里按路径设置值，保留其它所有键。
 * 解析失败时返回 null（调用方据此报错，绝不覆盖一个读不懂的文件）。
 */
export function setJsonPath(text: string | null, path: string[], value: unknown): string | null {
  const base = text === null || text.trim() === "" ? {} : safeParse(text);
  if (base === null) return null;
  let node: Record<string, unknown> = base;
  for (const key of path.slice(0, -1)) {
    const child = node[key];
    if (typeof child !== "object" || child === null || Array.isArray(child)) node[key] = {};
    node = node[key] as Record<string, unknown>;
  }
  node[path[path.length - 1] as string] = value;
  return renderJson(base, text);
}

/** 在 JSON 文本里按路径删除键，返回新文本；路径不存在时原样返回。 */
export function unsetJsonPath(text: string | null, path: string[]): string | null {
  if (text === null || text.trim() === "") return text;
  const base = safeParse(text);
  if (base === null) return null;
  const parents: Record<string, unknown>[] = [base];
  let node: Record<string, unknown> = base;
  for (const key of path.slice(0, -1)) {
    const child = node[key];
    if (typeof child !== "object" || child === null || Array.isArray(child)) return text;
    node = child as Record<string, unknown>;
    parents.push(node);
  }
  const leaf = path[path.length - 1] as string;
  if (!(leaf in node)) return text;
  delete node[leaf];
  // 逐层回收空对象（只回收我们自己造出来的空壳，不动原本就有内容的段）
  for (let i = parents.length - 1; i > 0; i--) {
    const parent = parents[i] as Record<string, unknown>;
    if (Object.keys(parent).length > 0) break;
    const key = path[i - 1] as string;
    delete (parents[i - 1] as Record<string, unknown>)[key];
  }
  return renderJson(base, text);
}

function safeParse(text: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(text) as unknown;
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
    return value as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** 读 JSON 里某个路径的值。 */
export function getJsonPath(text: string | null, path: string[]): unknown {
  if (text === null) return undefined;
  const base = safeParse(text);
  if (base === null) return undefined;
  let node: unknown = base;
  for (const key of path) {
    if (typeof node !== "object" || node === null) return undefined;
    node = (node as Record<string, unknown>)[key];
  }
  return node;
}
