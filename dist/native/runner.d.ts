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
export declare function runNative(bin: string, argv: string[], opts?: NativeRunOptions): Promise<NativeRunResult>;
