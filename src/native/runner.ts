import { spawn } from 'node:child_process';

/**
 * Tiny shared helper for native media tools that wrap system CLIs.
 *
 * Each tool checks if its CLI exists (by trying to spawn it with `--version`
 * or similar) and surfaces a clear "install X" error rather than a generic
 * ENOENT. Argv-only — never `shell: true`.
 */

export interface NativeRunResult {
  ok: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
  stdoutBuf?: Buffer;
  timedOut?: boolean;
  error?: string;
}

export interface NativeRunOptions {
  timeoutMs?: number;
  cwd?: string;
  env?: Record<string, string>;
  stdin?: string | Buffer;
  /** When true, capture stdout as a Buffer (for binary outputs like audio). */
  binaryStdout?: boolean;
  /** Override stdout cap. Default 32 KiB for text, unlimited for binary. */
  maxStdoutBytes?: number;
}

export function runNative(
  bin: string,
  argv: string[],
  opts: NativeRunOptions = {},
): Promise<NativeRunResult> {
  return new Promise((resolve) => {
    const child = spawn(bin, argv, {
      cwd: opts.cwd,
      env: opts.env ? { ...process.env, ...opts.env } : process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
    });
    const chunks: Buffer[] = [];
    let stderr = '';
    let timedOut = false;
    const cap = opts.maxStdoutBytes ?? (opts.binaryStdout ? 32 * 1024 * 1024 : 32_000);
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 1000).unref();
    }, opts.timeoutMs ?? 60_000);

    let stdoutBytes = 0;
    child.stdout.on('data', (c: Buffer) => {
      stdoutBytes += c.byteLength;
      if (stdoutBytes <= cap) chunks.push(c);
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (c: string) => { if (stderr.length < 32_000) stderr += c; });
    child.on('error', (err) => {
      clearTimeout(timer);
      const stdoutBuf = Buffer.concat(chunks);
      resolve({
        ok: false,
        exitCode: -1,
        stdout: opts.binaryStdout ? '' : stdoutBuf.toString('utf8'),
        stdoutBuf: opts.binaryStdout ? stdoutBuf : undefined,
        stderr,
        error:
          (err as { code?: string }).code === 'ENOENT'
            ? `${bin} not found on PATH (install it, or set the *_BIN env to its absolute path)`
            : err.message,
      });
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      const stdoutBuf = Buffer.concat(chunks);
      resolve({
        ok: code === 0 && !timedOut,
        exitCode: code ?? -1,
        stdout: opts.binaryStdout ? '' : stdoutBuf.toString('utf8'),
        stdoutBuf: opts.binaryStdout ? stdoutBuf : undefined,
        stderr,
        timedOut: timedOut || undefined,
      });
    });

    if (opts.stdin !== undefined) {
      child.stdin.write(opts.stdin);
    }
    child.stdin.end();
  });
}
