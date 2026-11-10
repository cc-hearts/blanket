/** 极简命令执行：收集 stdout / stderr / 退出码，命令不存在也不抛出。 */

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export async function run(
  argv: string[],
  opts: { cwd?: string; timeoutMs?: number } = {},
): Promise<RunResult> {
  try {
    const proc = Bun.spawn({
      cmd: argv,
      cwd: opts.cwd,
      stdout: "pipe",
      stderr: "pipe",
      env: process.env,
    });
    const timer = setTimeout(() => proc.kill(), opts.timeoutMs ?? 600_000);
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    clearTimeout(timer);
    return { code: code ?? 1, stdout, stderr };
  } catch (error) {
    return { code: 127, stdout: "", stderr: error instanceof Error ? error.message : String(error) };
  }
}
