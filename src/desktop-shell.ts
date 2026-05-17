import { z } from '@swarmai/shared';
import { register } from '@swarmai/tools';
import { runNative } from './native/runner.js';
import { IS_ANDROID } from './_android.js';

/**
 * Platform shells — `powershell`, `cmd_exe`, `applescript`.
 *
 * The existing `bash` tool covers POSIX shells. These three add the
 * platform-specific paths the agent needs on Windows + macOS:
 *
 *   - `powershell`: PowerShell on Windows (and pwsh on Mac/Linux if installed).
 *   - `cmd_exe`: legacy cmd.exe — sometimes still the right answer for
 *     batch files / older tooling.
 *   - `applescript`: osascript on macOS for window/app automation.
 *
 * All three are master-policy. Argv-only (no shell:true). Output is
 * captured + truncated like `bash`.
 */

const powerShellSchema = z.object({
  script: z.string().min(1).max(64_000),
  /** When true, use pwsh (cross-plat) instead of powershell.exe (Windows-only). */
  useCore: z.boolean().default(false),
  timeoutMs: z.number().int().min(100).max(300_000).default(60_000),
});

register({
  name: 'powershell',
  toolset: 'desktop',
  emoji: '🪟',
  policy: 'master',
  description:
    'Run a PowerShell script. Uses powershell.exe (Windows) by default; set useCore: true for `pwsh` (cross-platform). Not available on Android.',
  schema: powerShellSchema,
  handler: async (args) => {
    if (IS_ANDROID) {
      return { ok: false, error: 'powershell is not available on Android' };
    }
    const bin = args.useCore ? 'pwsh' : process.platform === 'win32' ? 'powershell.exe' : 'pwsh';
    const r = await runNative(bin, ['-NoProfile', '-Command', args.script], {
      timeoutMs: args.timeoutMs,
    });
    return {
      ok: r.ok,
      exitCode: r.exitCode,
      stdout: r.stdout,
      stderr: r.stderr,
      error: r.error,
      timedOut: r.timedOut,
    };
  },
});

const cmdSchema = z.object({
  command: z.string().min(1).max(8_000),
  cwd: z.string().optional(),
  timeoutMs: z.number().int().min(100).max(300_000).default(60_000),
});

register({
  name: 'cmd_exe',
  toolset: 'desktop',
  emoji: '⌨️',
  policy: 'master',
  description: 'Run a Windows cmd.exe command. Master-only. Refuses to run on non-Windows.',
  schema: cmdSchema,
  handler: async (args) => {
    if (IS_ANDROID) {
      return { ok: false, error: 'cmd_exe is not available on Android' };
    }
    if (process.platform !== 'win32') {
      return { ok: false, error: `cmd.exe only available on Windows (current: ${process.platform})` };
    }
    const r = await runNative('cmd.exe', ['/c', args.command], {
      cwd: args.cwd,
      timeoutMs: args.timeoutMs,
    });
    return {
      ok: r.ok,
      exitCode: r.exitCode,
      stdout: r.stdout,
      stderr: r.stderr,
      error: r.error,
      timedOut: r.timedOut,
    };
  },
});

const appleScriptSchema = z.object({
  script: z.string().min(1).max(32_000),
  timeoutMs: z.number().int().min(100).max(120_000).default(30_000),
});

register({
  name: 'applescript',
  toolset: 'desktop',
  emoji: '🍎',
  policy: 'master',
  description:
    'Run an AppleScript via osascript (macOS). Useful for app automation, file dialogs, system events. Master-only.',
  schema: appleScriptSchema,
  handler: async (args) => {
    if (IS_ANDROID) {
      return { ok: false, error: 'applescript is not available on Android' };
    }
    if (process.platform !== 'darwin') {
      return { ok: false, error: `AppleScript only available on macOS (current: ${process.platform})` };
    }
    const r = await runNative('osascript', ['-e', args.script], { timeoutMs: args.timeoutMs });
    return {
      ok: r.ok,
      exitCode: r.exitCode,
      stdout: r.stdout,
      stderr: r.stderr,
      error: r.error,
    };
  },
});
