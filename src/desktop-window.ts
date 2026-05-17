import { z } from '@swarmai/shared';
import { register } from '@swarmai/tools';
import { runNative } from './native/runner.js';
import { IS_ANDROID } from './_android.js';

/**
 * Android — window management is not a concept exposed to userspace.
 * Apps are OS-managed (the framework owns z-order, focus, and
 * visibility), so list/focus/close/move are all no-ops. The agent
 * should fall back to `app_open` / `shizuku_run` when it wants to
 * launch or interact with an app on Android.
 */
const ANDROID_WINDOW_ERROR =
  'window management is not applicable on Android — apps are OS-managed; use app_open to launch one';

/**
 * Window management — `window_list`, `window_focus`, `window_close`,
 * `window_move`.
 *
 * Per-platform backends:
 *   - macOS:    AppleScript via `osascript`. Very reliable; built-in.
 *   - Linux:    `wmctrl` (best) → `xdotool` (fallback). One must be installed.
 *   - Windows:  PowerShell with Get-Process + WPF/Win32 P/Invoke.
 *
 * `window_list` returns objects shaped like:
 *   { id, app, title, pid, bounds: { x, y, width, height }, focused }
 *
 * Some backends can't fill every field (e.g. Linux without wmctrl
 * doesn't surface bounds). Fields are optional rather than wrong.
 */

interface WindowRecord {
  id?: string;
  app: string;
  title: string;
  pid?: number;
  bounds?: { x: number; y: number; width: number; height: number };
  focused?: boolean;
}

const listSchema = z.object({
  filterApp: z.string().optional(),
  filterTitle: z.string().optional(),
});

register({
  name: 'window_list',
  toolset: 'desktop',
  emoji: '🪟',
  policy: 'pair-gated',
  description: 'List visible windows (app, title, pid, bounds when available). Optional filters: filterApp, filterTitle.',
  schema: listSchema,
  handler: async (args) => {
    if (IS_ANDROID) return { ok: false, error: ANDROID_WINDOW_ERROR };
    const all = await listWindows();
    let filtered = all;
    if (args.filterApp) {
      filtered = filtered.filter((w) => w.app.toLowerCase().includes(args.filterApp!.toLowerCase()));
    }
    if (args.filterTitle) {
      filtered = filtered.filter((w) => w.title.toLowerCase().includes(args.filterTitle!.toLowerCase()));
    }
    return { ok: true, count: filtered.length, windows: filtered };
  },
});

const focusSchema = z.object({
  /** Either windowId (from window_list) or app name + title substring. */
  windowId: z.string().optional(),
  app: z.string().optional(),
  titleContains: z.string().optional(),
});

register({
  name: 'window_focus',
  toolset: 'desktop',
  emoji: '🎯',
  policy: 'pair-gated',
  description: 'Bring a window to the front. Identify by windowId or by (app + titleContains).',
  schema: focusSchema,
  handler: async (args) => {
    if (IS_ANDROID) return { ok: false, error: ANDROID_WINDOW_ERROR };
    if (!args.windowId && !args.app) return { ok: false, error: 'pass windowId or app' };
    return await focusWindow(args);
  },
});

const closeSchema = z.object({
  windowId: z.string().optional(),
  app: z.string().optional(),
  titleContains: z.string().optional(),
});

register({
  name: 'window_close',
  toolset: 'desktop',
  emoji: '✖️',
  policy: 'master',
  description: 'Close a window. Master-only — closing the wrong window can lose unsaved work.',
  schema: closeSchema,
  handler: async (args) => {
    if (IS_ANDROID) return { ok: false, error: ANDROID_WINDOW_ERROR };
    if (!args.windowId && !args.app) return { ok: false, error: 'pass windowId or app' };
    return await closeWindow(args);
  },
});

const moveSchema = z.object({
  windowId: z.string().optional(),
  app: z.string().optional(),
  titleContains: z.string().optional(),
  x: z.number().int(),
  y: z.number().int(),
  width: z.number().int().min(50).optional(),
  height: z.number().int().min(50).optional(),
});

register({
  name: 'window_move',
  toolset: 'desktop',
  emoji: '↔️',
  policy: 'pair-gated',
  description: 'Move/resize a window. (x, y) sets origin; (width, height) optional.',
  schema: moveSchema,
  handler: async (args) => {
    if (IS_ANDROID) return { ok: false, error: ANDROID_WINDOW_ERROR };
    return moveWindow(args);
  },
});

// --- platform impls -------------------------------------------------------

async function listWindows(): Promise<WindowRecord[]> {
  if (process.platform === 'darwin') return listMac();
  if (process.platform === 'linux') return listLinux();
  if (process.platform === 'win32') return listWin();
  return [];
}

async function listMac(): Promise<WindowRecord[]> {
  // Returns one TSV record per window: app \t title \t pid
  const script = `
    tell application "System Events"
      set out to ""
      repeat with proc in (every application process whose visible is true)
        set procName to name of proc
        set procPid to unix id of proc
        repeat with w in (every window of proc)
          try
            set wTitle to name of w
            set out to out & procName & tab & wTitle & tab & procPid & linefeed
          end try
        end repeat
      end repeat
      return out
    end tell`;
  const r = await runNative('osascript', ['-e', script], { timeoutMs: 10_000 });
  if (!r.ok) return [];
  return r.stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [app, title, pid] = line.split('\t');
      return { app: app ?? '', title: title ?? '', pid: pid ? Number(pid) : undefined };
    });
}

async function listLinux(): Promise<WindowRecord[]> {
  // wmctrl prints: <id> <desktop> <pid> <host> <title>
  const r = await runNative('wmctrl', ['-l', '-p'], { timeoutMs: 5_000 });
  if (r.ok) {
    const out: WindowRecord[] = [];
    for (const line of r.stdout.split('\n').filter(Boolean)) {
      const m = line.match(/^(\S+)\s+\S+\s+(\d+)\s+\S+\s+(.+)$/);
      if (!m) continue;
      out.push({ id: m[1]!, app: '', pid: Number(m[2]), title: m[3]! });
    }
    return out;
  }
  // Fallback: xdotool — fewer fields.
  const x = await runNative('xdotool', ['search', '--onlyvisible', '--name', '.+'], { timeoutMs: 5_000 });
  if (!x.ok) return [];
  const ids = x.stdout.split('\n').filter(Boolean);
  const out: WindowRecord[] = [];
  for (const id of ids.slice(0, 50)) {
    const t = await runNative('xdotool', ['getwindowname', id], { timeoutMs: 2_000 });
    out.push({ id, app: '', title: t.ok ? t.stdout.trim() : '' });
  }
  return out;
}

async function listWin(): Promise<WindowRecord[]> {
  const ps =
    `Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -ne '' } ` +
    `| Select-Object Id, ProcessName, MainWindowTitle, MainWindowHandle ` +
    `| ConvertTo-Json -Compress`;
  const r = await runNative('powershell.exe', ['-NoProfile', '-Command', ps], { timeoutMs: 10_000 });
  if (!r.ok) return [];
  try {
    const raw = r.stdout.trim();
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    const items = Array.isArray(parsed) ? parsed : [parsed];
    return items.map((p) => {
      const o = p as { Id: number; ProcessName: string; MainWindowTitle: string; MainWindowHandle: number };
      return { id: String(o.MainWindowHandle), app: o.ProcessName, title: o.MainWindowTitle, pid: o.Id };
    });
  } catch {
    return [];
  }
}

async function focusWindow(args: { windowId?: string; app?: string; titleContains?: string }): Promise<{ ok: boolean; error?: string }> {
  if (process.platform === 'darwin') {
    const target = args.app ?? '';
    if (!target) return { ok: false, error: 'macOS focus requires `app`' };
    const script = args.titleContains
      ? `tell application "${esc(target)}" to activate
         tell application "System Events" to tell process "${esc(target)}"
           perform action "AXRaise" of (first window whose name contains "${esc(args.titleContains)}")
         end tell`
      : `tell application "${esc(target)}" to activate`;
    const r = await runNative('osascript', ['-e', script], { timeoutMs: 5_000 });
    return r.ok ? { ok: true } : { ok: false, error: r.stderr };
  }
  if (process.platform === 'linux') {
    if (args.windowId) {
      const r = await runNative('wmctrl', ['-i', '-a', args.windowId], { timeoutMs: 5_000 });
      return r.ok ? { ok: true } : { ok: false, error: r.stderr };
    }
    if (args.app) {
      const r = await runNative('wmctrl', ['-a', args.app], { timeoutMs: 5_000 });
      return r.ok ? { ok: true } : { ok: false, error: r.stderr };
    }
  }
  if (process.platform === 'win32') {
    const ps =
      args.windowId
        ? `Add-Type @" using System; using System.Runtime.InteropServices; public class N { [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h); } "@; [N]::SetForegroundWindow([IntPtr]::new(${args.windowId})) | Out-Null`
        : `(Get-Process -Name '${esc(args.app ?? '')}' -ErrorAction SilentlyContinue) | ForEach-Object { (New-Object -ComObject WScript.Shell).AppActivate($_.Id) } | Out-Null`;
    const r = await runNative('powershell.exe', ['-NoProfile', '-Command', ps], { timeoutMs: 5_000 });
    return r.ok ? { ok: true } : { ok: false, error: r.stderr };
  }
  return { ok: false, error: `unsupported platform ${process.platform}` };
}

async function closeWindow(args: { windowId?: string; app?: string; titleContains?: string }): Promise<{ ok: boolean; error?: string }> {
  if (process.platform === 'darwin') {
    if (!args.app) return { ok: false, error: 'macOS close requires `app`' };
    const script = args.titleContains
      ? `tell application "System Events" to tell process "${esc(args.app)}" to click button 1 of (first window whose name contains "${esc(args.titleContains)}")`
      : `tell application "${esc(args.app)}" to quit`;
    const r = await runNative('osascript', ['-e', script], { timeoutMs: 5_000 });
    return r.ok ? { ok: true } : { ok: false, error: r.stderr };
  }
  if (process.platform === 'linux') {
    if (args.windowId) {
      const r = await runNative('wmctrl', ['-i', '-c', args.windowId], { timeoutMs: 5_000 });
      return r.ok ? { ok: true } : { ok: false, error: r.stderr };
    }
    if (args.app) {
      const r = await runNative('wmctrl', ['-c', args.app], { timeoutMs: 5_000 });
      return r.ok ? { ok: true } : { ok: false, error: r.stderr };
    }
  }
  if (process.platform === 'win32') {
    const ps = args.windowId
      ? `Add-Type @"using System; using System.Runtime.InteropServices; public class N { [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l); } "@; [N]::PostMessage([IntPtr]::new(${args.windowId}), 0x0010, 0, 0) | Out-Null`
      : `Get-Process -Name '${esc(args.app ?? '')}' -ErrorAction SilentlyContinue | ForEach-Object { $_.CloseMainWindow() | Out-Null }`;
    const r = await runNative('powershell.exe', ['-NoProfile', '-Command', ps], { timeoutMs: 5_000 });
    return r.ok ? { ok: true } : { ok: false, error: r.stderr };
  }
  return { ok: false, error: `unsupported platform ${process.platform}` };
}

async function moveWindow(args: {
  windowId?: string; app?: string; titleContains?: string;
  x: number; y: number; width?: number; height?: number;
}): Promise<{ ok: boolean; error?: string }> {
  if (process.platform === 'linux' && args.windowId) {
    const w = args.width ?? -1;
    const h = args.height ?? -1;
    const r = await runNative('wmctrl', ['-i', '-r', args.windowId, '-e', `0,${args.x},${args.y},${w},${h}`], { timeoutMs: 5_000 });
    return r.ok ? { ok: true } : { ok: false, error: r.stderr };
  }
  if (process.platform === 'darwin' && args.app) {
    const setSize = args.width && args.height ? `, set size to {${args.width}, ${args.height}}` : '';
    const target = args.titleContains
      ? `(first window whose name contains "${esc(args.titleContains)}")`
      : `(first window)`;
    const script =
      `tell application "System Events" to tell process "${esc(args.app)}" to ` +
      `(set position of ${target} to {${args.x}, ${args.y}}${setSize})`;
    const r = await runNative('osascript', ['-e', script], { timeoutMs: 5_000 });
    return r.ok ? { ok: true } : { ok: false, error: r.stderr };
  }
  if (process.platform === 'win32' && args.windowId) {
    const w = args.width ?? 0;
    const h = args.height ?? 0;
    const flag = !args.width || !args.height ? '0x0001' : '0';
    const ps =
      `Add-Type @"using System; using System.Runtime.InteropServices; public class N { [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr a, int x, int y, int cx, int cy, uint flags); } "@; ` +
      `[N]::SetWindowPos([IntPtr]::new(${args.windowId}), [IntPtr]::Zero, ${args.x}, ${args.y}, ${w}, ${h}, ${flag}) | Out-Null`;
    const r = await runNative('powershell.exe', ['-NoProfile', '-Command', ps], { timeoutMs: 5_000 });
    return r.ok ? { ok: true } : { ok: false, error: r.stderr };
  }
  return { ok: false, error: 'window_move requires windowId on Linux/Windows or app on macOS' };
}

function esc(s: string): string {
  return s.replace(/"/g, '\\"').replace(/'/g, "''");
}
