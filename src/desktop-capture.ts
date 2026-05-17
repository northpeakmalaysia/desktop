import { mkdirSync, promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { z } from '@swarmai/shared';
import { register } from '@swarmai/tools';
import { runNative } from './native/runner.js';
import { IS_ANDROID, shizukuExec } from './_android.js';

/**
 * Screen capture tools — `screenshot`.
 *
 * Three modes:
 *   - mode: 'full'    capture the entire primary display
 *   - mode: 'window'  capture a specific window (by title or pid)
 *   - mode: 'region'  capture x/y/w/h pixel rect on primary display
 *
 * Per-platform backends:
 *   - macOS:    `screencapture` (built-in)
 *   - Linux:    `gnome-screenshot` → `scrot` → `import` (ImageMagick)
 *   - Windows:  PowerShell + System.Drawing (built-in)
 *
 * Output: PNG at `outPath`. If `outPath` is omitted we write to a
 * tmpdir and return the path so the agent can attach it / OCR it.
 *
 * Pair-gated: screenshots can include sensitive content (mail, passwords).
 * Master sessions still call them; non-main subagents don't.
 */

const screenshotSchema = z.union([
  z.object({
    mode: z.literal('full').default('full'),
    outPath: z.string().optional(),
    delaySec: z.number().int().min(0).max(60).default(0),
  }),
  z.object({
    mode: z.literal('window'),
    outPath: z.string().optional(),
    windowTitle: z.string().optional(),
    windowPid: z.number().int().optional(),
    delaySec: z.number().int().min(0).max(60).default(0),
  }),
  z.object({
    mode: z.literal('region'),
    outPath: z.string().optional(),
    x: z.number().int().min(0),
    y: z.number().int().min(0),
    width: z.number().int().min(1),
    height: z.number().int().min(1),
    delaySec: z.number().int().min(0).max(60).default(0),
  }),
]);

register({
  name: 'screenshot',
  toolset: 'desktop',
  emoji: '📸',
  policy: 'pair-gated',
  description:
    'Capture the screen, a window, or a region as PNG. Modes: ' +
    '`"full"` (DEFAULT — captures the entire virtual desktop across all monitors at physical pixel resolution; use this for any "screenshot" / "desktop" / "show me the screen" request), ' +
    '`"window"` (foreground window only — title bar + client area; use only when the user explicitly says "the active window" or names an app), ' +
    '`"region"` (rectangle by x/y/width/height). ' +
    'Output path defaults to `<workspaceRoot>/captures/shot-<timestamp>.png` if omitted (path returned so the agent can read or attach). Files persist across the OS temp cleanup so the user can find them later.',
  schema: screenshotSchema,
  handler: async (args) => {
    const out = args.outPath ?? defaultPath();
    const abs = resolve(out);
    if (IS_ANDROID) return await androidCapture(args, abs);
    if (process.platform === 'darwin') return await macCapture(args, abs);
    if (process.platform === 'linux') return await linuxCapture(args, abs);
    if (process.platform === 'win32') return await winCapture(args, abs);
    return { ok: false, error: `screenshot not implemented for platform ${process.platform}` };
  },
});

/**
 * Android — capture the framebuffer via `screencap`. That binary is
 * part of the AOSP toolbox but reading the framebuffer requires
 * system-level access; on a non-rooted device the only sanctioned path
 * is going through Shizuku's elevated `shell` user (via `rish`). Plain
 * Termux can't call it.
 *
 * Output: PNG written to `/sdcard/swarmai-screenshot.png` (the only
 * location both `shell` uid and Termux can read), then base64'd back
 * to the caller and copied to the requested `abs` path under the
 * workspace so subsequent reads work the same as on desktop platforms.
 * Region / window modes are not meaningful on Android (apps are
 * OS-managed full-screen), so both fall through to a full capture.
 */
async function androidCapture(args: CaptureArgs, abs: string) {
  if (args.delaySec) {
    await new Promise((r) => setTimeout(r, args.delaySec * 1000));
  }
  // `/sdcard/` is the shared external-storage symlink — readable by
  // both the shell uid (writer) and the Termux uid (reader).
  const tmp = '/sdcard/swarmai-screenshot.png';
  const cap = await shizukuExec(`screencap -p ${tmp}`, { timeoutMs: 15_000 });
  if (!cap.ok) {
    return {
      ok: false,
      error:
        ('error' in cap ? cap.error : undefined) ??
        'screenshot requires Shizuku (rish) on Android — install Shizuku APK + `pkg install rish`',
    };
  }
  try {
    const buf = await fs.readFile(tmp);
    await fs.writeFile(abs, buf);
    return {
      ok: true,
      path: abs,
      engine: 'shizuku+screencap',
      base64: buf.toString('base64'),
    };
  } catch (err) {
    return {
      ok: false,
      error: `screencap wrote ${tmp} but reading it failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * F-PATH-02 — capture artefacts now land under
 * `<workspaceRoot>/captures/` so they're (a) findable by the user
 * (the workspace is the operator's mental sandbox), (b) attachable by
 * `send_message` once F-CHAN-02 lands, (c) immune to OS temp cleanup.
 *
 * Mirrors the workspace-resolution precedence used by `write-file` and
 * `read` so tests that pin `SWARMAI_WORKSPACE` to a tempdir keep
 * working without changes.
 */
function resolveWorkspaceRoot(): string {
  const explicitName = process.env.SWARMAI_WORKSPACE_NAME;
  const explicitGlobal = process.env.SWARMAI_WORKSPACE;
  if (explicitName && explicitGlobal) {
    return join(explicitGlobal, 'workspaces', explicitName);
  }
  if (explicitGlobal) return explicitGlobal;
  return join(homedir(), '.swarmai', 'workspaces', explicitName ?? 'default');
}

function defaultPath(): string {
  const dir = join(resolveWorkspaceRoot(), 'captures');
  mkdirSync(dir, { recursive: true });
  return join(dir, `shot-${Date.now()}.png`);
}

type CaptureArgs = z.infer<typeof screenshotSchema>;

async function macCapture(args: CaptureArgs, abs: string) {
  const argv: string[] = ['-x']; // -x = no sound
  if (args.delaySec) argv.push('-T', String(args.delaySec));
  if (args.mode === 'window') {
    argv.push('-l');
    if (args.windowPid !== undefined) {
      // Resolve PID → window id via osascript fallback would be heavy.
      // `screencapture -l <windowID>` needs CGWindowID; we can't get
      // that from a pid easily. Fall back to interactive window pick:
      argv.pop();
      argv.push('-W');
    } else {
      argv.pop();
      argv.push('-W');
    }
  } else if (args.mode === 'region') {
    argv.push('-R', `${args.x},${args.y},${args.width},${args.height}`);
  }
  argv.push(abs);
  const r = await runNative('screencapture', argv, { timeoutMs: 30_000 });
  if (!r.ok) return { ok: false, error: r.error ?? r.stderr, exitCode: r.exitCode };
  return { ok: true, path: abs, engine: 'screencapture' };
}

async function linuxCapture(args: CaptureArgs, abs: string) {
  // Try gnome-screenshot first (modern), fall back to scrot, then ImageMagick `import`.
  if (args.mode === 'region') {
    const r = await runNative(
      'import',
      ['-window', 'root', '-crop', `${args.width}x${args.height}+${args.x}+${args.y}`, abs],
      { timeoutMs: 30_000 },
    );
    if (r.ok) return { ok: true, path: abs, engine: 'import' };
    return { ok: false, error: r.error ?? r.stderr };
  }
  if (args.mode === 'window') {
    const r = await runNative('gnome-screenshot', ['-w', '-f', abs], { timeoutMs: 30_000 });
    if (r.ok) return { ok: true, path: abs, engine: 'gnome-screenshot' };
    const s = await runNative('scrot', ['-u', abs], { timeoutMs: 30_000 });
    if (s.ok) return { ok: true, path: abs, engine: 'scrot' };
    return { ok: false, error: 'no window-capture backend (install gnome-screenshot or scrot)' };
  }
  // full
  const g = await runNative('gnome-screenshot', ['-f', abs], { timeoutMs: 30_000 });
  if (g.ok) return { ok: true, path: abs, engine: 'gnome-screenshot' };
  const s = await runNative('scrot', [abs], { timeoutMs: 30_000 });
  if (s.ok) return { ok: true, path: abs, engine: 'scrot' };
  const im = await runNative('import', ['-window', 'root', abs], { timeoutMs: 30_000 });
  if (im.ok) return { ok: true, path: abs, engine: 'import' };
  return { ok: false, error: 'no screenshot backend (install gnome-screenshot, scrot, or imagemagick)' };
}

async function winCapture(args: CaptureArgs, abs: string) {
  // Built-in PowerShell + System.Drawing — no extra installs.
  const escaped = abs.replace(/'/g, "''");
  let snippet: string;
  if (args.mode === 'region') {
    snippet =
      `[System.Drawing.Bitmap]::new(${args.width},${args.height}) ` +
      `| ForEach-Object { ` +
      `  $g = [System.Drawing.Graphics]::FromImage($_); ` +
      `  $g.CopyFromScreen(${args.x}, ${args.y}, 0, 0, [System.Drawing.Size]::new(${args.width},${args.height})); ` +
      `  $_.Save('${escaped}'); ` +
      `  $g.Dispose(); $_.Dispose() }`;
  } else if (args.mode === 'window') {
    // Window-only capture from PowerShell is fiddly (needs P/Invoke).
    // Settle for foreground window via the PrintWindow API.
    snippet =
      `Add-Type @"
using System;
using System.Drawing;
using System.Runtime.InteropServices;
public class W {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdcBlt, uint nFlags);
  public struct RECT { public int Left, Top, Right, Bottom; }
}
"@; ` +
      `$h = [W]::GetForegroundWindow(); $r = New-Object W+RECT; [W]::GetWindowRect($h, [ref]$r) | Out-Null; ` +
      `$w = $r.Right - $r.Left; $hg = $r.Bottom - $r.Top; ` +
      `$bmp = New-Object System.Drawing.Bitmap $w, $hg; ` +
      `$g = [System.Drawing.Graphics]::FromImage($bmp); ` +
      `$hdc = $g.GetHdc(); [W]::PrintWindow($h, $hdc, 2) | Out-Null; $g.ReleaseHdc($hdc); ` +
      `$bmp.Save('${escaped}'); $bmp.Dispose(); $g.Dispose()`;
  } else {
    // F-CAPTURE-01 — full virtual-desktop capture, DPI-aware.
    //
    // Two layers of bug were folded in here:
    //   1. `PrimaryScreen.Bounds` only covered the *primary* monitor;
    //      multi-monitor setups got clipped. Switched to
    //      `SystemInformation.VirtualScreen` which spans all monitors
    //      (virtual coordinates — Y can be negative when a secondary
    //      sits above the primary).
    //   2. PowerShell child processes are NOT per-monitor DPI-aware by
    //      default — under Windows 10/11 with display scaling at
    //      125 %+ , `VirtualScreen` reported logical pixels and the
    //      bottom/right edges were clipped relative to physical
    //      pixels. We now call `SetProcessDpiAwarenessContext` with
    //      `PER_MONITOR_AWARE_V2` (-4) BEFORE reading the screen,
    //      so the captured bitmap matches what the user actually sees.
    //      Falls back silently on Windows < 10.0.15063 (the API
    //      doesn't exist; capture proceeds at logical resolution).
    snippet =
      `Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class DpiAware {
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr value);
}
"@; ` +
      `try { [DpiAware]::SetProcessDpiAwarenessContext([IntPtr](-4)) | Out-Null } catch {}; ` +
      `$vs = [System.Windows.Forms.SystemInformation]::VirtualScreen; ` +
      `$bmp = New-Object System.Drawing.Bitmap $vs.Width, $vs.Height; ` +
      `$g = [System.Drawing.Graphics]::FromImage($bmp); ` +
      `$g.CopyFromScreen($vs.X, $vs.Y, 0, 0, [System.Drawing.Size]::new($vs.Width, $vs.Height)); ` +
      `$bmp.Save('${escaped}'); $bmp.Dispose(); $g.Dispose()`;
  }
  const ps = `Add-Type -AssemblyName System.Windows.Forms,System.Drawing; ${snippet}`;
  if (args.delaySec) {
    // Use the PowerShell sleep — keeps the timing self-contained.
  }
  const argv = ['-NoProfile', '-Command', (args.delaySec ? `Start-Sleep -Seconds ${args.delaySec}; ` : '') + ps];
  const r = await runNative('powershell.exe', argv, { timeoutMs: 60_000 });
  if (!r.ok) return { ok: false, error: r.error ?? r.stderr, exitCode: r.exitCode };
  return { ok: true, path: abs, engine: 'powershell+System.Drawing' };
}
