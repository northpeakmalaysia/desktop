import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { z } from '@swarmai/shared';
import { register } from '@swarmai/tools';
import { runNative } from './native/runner.js';
import { IS_ANDROID, shizukuExec, tryTermux } from './_android.js';

/**
 * Doc 15 §4 — desktop power/AV controls:
 *   - `volume_set`     — set system audio output volume (0-100)
 *   - `brightness_set` — set primary display brightness (0-100)
 *   - `caffeinate`     — prevent system sleep for N seconds (or until released)
 *
 * All three are `pair-gated` (medium risk — they perturb the host but
 * don't destroy data). Each handler is per-platform with a clean
 * `unsupported platform` fallback so the agent can recover.
 *
 * Subprocess invariants: argv-only via `runNative` (never `shell: true`),
 * except for `caffeinate`'s background hold which keeps a `ChildProcess`
 * handle in `caffeinateHolds` so a follow-up `{ release: true, token }`
 * call can SIGTERM it. The background spawn is still argv-only and
 * `shell: false`.
 */

// --- volume_set -----------------------------------------------------------

const volumeSchema = z.object({
  percent: z.number().int().min(0).max(100),
});

register({
  name: 'volume_set',
  toolset: 'desktop',
  emoji: '🔊',
  policy: 'pair-gated',
  description:
    'Set system audio output volume (0–100). Returns { ok, percent } on success. ' +
    'On Android the 0–100 percent is scaled into the OS stream range (0–15 for the music stream) via Termux:API.',
  schema: volumeSchema,
  handler: async (args) => setVolume(args.percent),
});

async function setVolume(percent: number): Promise<{ ok: boolean; percent?: number; error?: string }> {
  if (IS_ANDROID) {
    // Android's audio framework exposes per-stream integer levels
    // (0–15 for `music`); termux-volume passes them straight through
    // to AudioManager. Scale the caller's 0–100 percent into that
    // smaller range, rounded to the nearest step.
    const step = Math.max(0, Math.min(15, Math.round((percent / 100) * 15)));
    const r = await tryTermux('termux-volume', ['music', String(step)]);
    if (!r.ok) return { ok: false, error: r.error ?? ('stderr' in r ? r.stderr : undefined) };
    return { ok: true, percent };
  }
  if (process.platform === 'darwin') {
    const r = await runNative('osascript', ['-e', `set volume output volume ${percent}`], { timeoutMs: 5_000 });
    return r.ok ? { ok: true, percent } : { ok: false, error: r.stderr || r.error };
  }
  if (process.platform === 'linux') {
    const a = await runNative('amixer', ['-D', 'pulse', 'sset', 'Master', `${percent}%`], { timeoutMs: 5_000 });
    if (a.ok) return { ok: true, percent };
    // Fallback to pactl if amixer is absent or pulse isn't there.
    const p = await runNative('pactl', ['set-sink-volume', '@DEFAULT_SINK@', `${percent}%`], { timeoutMs: 5_000 });
    return p.ok
      ? { ok: true, percent }
      : { ok: false, error: a.error ?? p.error ?? p.stderr ?? a.stderr ?? 'amixer/pactl both failed' };
  }
  if (process.platform === 'win32') {
    const scalar = (percent / 100).toFixed(4);
    // Canonical P/Invoke to IAudioEndpointVolume. The Add-Type block
    // is single-quoted here-string in PowerShell so $ inside doesn't
    // get interpolated; the only template hole is <scalar>.
    const ps = `try { Add-Type @'
using System.Runtime.InteropServices;
[Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioEndpointVolume {
  int f(); int g(); int h(); int i();
  int SetMasterVolumeLevelScalar(float fLevel, System.Guid pguidEventContext);
  int j();
  int GetMasterVolumeLevelScalar(out float pfLevel);
}
[Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDevice { int Activate(ref System.Guid id, int clsCtx, int activationParams, out IAudioEndpointVolume aev); }
[Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceEnumerator { int f(); int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice endpoint); }
[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class MMDeviceEnumeratorComObject {}
public class Audio {
  static IAudioEndpointVolume Vol() {
    var enumerator = (IMMDeviceEnumerator)(new MMDeviceEnumeratorComObject());
    IMMDevice dev = null; enumerator.GetDefaultAudioEndpoint(0, 1, out dev);
    IAudioEndpointVolume epv = null; var epvid = typeof(IAudioEndpointVolume).GUID; dev.Activate(ref epvid, 23, 0, out epv); return epv;
  }
  public static float Get() { float v = 0; Vol().GetMasterVolumeLevelScalar(out v); return v; }
  public static void Set(float v) { Vol().SetMasterVolumeLevelScalar(v, System.Guid.Empty); }
}
'@; [Audio]::Set(${scalar}); 'ok' } catch { Write-Error $_.Exception.Message; exit 1 }`;
    const r = await runNative('powershell.exe', ['-NoProfile', '-Command', ps], { timeoutMs: 10_000 });
    return r.ok
      ? { ok: true, percent }
      : { ok: false, error: 'volume not supported on this Windows variant: ' + (r.stderr || r.error || '') };
  }
  return { ok: false, error: `unsupported platform ${process.platform}` };
}

// --- brightness_set -------------------------------------------------------

const brightnessSchema = z.object({
  percent: z.number().int().min(0).max(100),
});

register({
  name: 'brightness_set',
  toolset: 'desktop',
  emoji: '☀️',
  policy: 'pair-gated',
  description: 'Set primary display brightness (0–100). May require admin on Linux (sysfs write).',
  schema: brightnessSchema,
  handler: async (args) => setBrightness(args.percent),
});

async function setBrightness(percent: number): Promise<{ ok: boolean; percent?: number; error?: string; hint?: string }> {
  if (IS_ANDROID) {
    // Android's `screen_brightness` settings key is 0–255, not 0–100.
    // Writing it requires the WRITE_SETTINGS permission which a plain
    // Termux process doesn't have — go through Shizuku's `shell` user
    // so the `settings put` succeeds without requiring manual permission
    // grants from the Owner.
    const raw = Math.max(0, Math.min(255, Math.round((percent / 100) * 255)));
    const r = await shizukuExec(`settings put system screen_brightness ${raw}`, { timeoutMs: 5_000 });
    if (!r.ok) {
      return {
        ok: false,
        error: r.error ?? ('stderr' in r ? r.stderr : undefined),
        hint: 'brightness on Android requires Shizuku (rish on PATH) so the `shell` uid can write SYSTEM settings',
      };
    }
    return { ok: true, percent };
  }
  if (process.platform === 'darwin') {
    const r = await runNative('brightness', [(percent / 100).toFixed(3)], { timeoutMs: 5_000 });
    if (r.ok) return { ok: true, percent };
    if (r.error && /not found on PATH/i.test(r.error)) {
      return { ok: false, error: r.error, hint: 'install via `brew install brightness`' };
    }
    return { ok: false, error: r.stderr || r.error };
  }
  if (process.platform === 'linux') {
    // Direct sysfs write — no shell, no subprocess. Picks the first
    // backlight device under /sys/class/backlight and scales the
    // requested percent against its `max_brightness`.
    try {
      const root = '/sys/class/backlight';
      const devices = await fs.readdir(root).catch(() => [] as string[]);
      if (devices.length === 0) {
        return { ok: false, error: 'no backlight devices under /sys/class/backlight (headless / desktop?)' };
      }
      const dev = devices[0]!;
      const maxRaw = await fs.readFile(`${root}/${dev}/max_brightness`, 'utf8');
      const max = Number(maxRaw.trim());
      if (!Number.isFinite(max) || max <= 0) {
        return { ok: false, error: `unreadable max_brightness for ${dev}` };
      }
      const value = Math.round((percent / 100) * max);
      await fs.writeFile(`${root}/${dev}/brightness`, String(value), 'utf8');
      return { ok: true, percent };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const hint = /EACCES|EPERM/i.test(msg)
        ? 'sysfs brightness write usually needs root or a udev rule granting group-write on /sys/class/backlight/*/brightness'
        : undefined;
      return hint ? { ok: false, error: msg, hint } : { ok: false, error: msg };
    }
  }
  if (process.platform === 'win32') {
    const ps = `(Get-WmiObject -Namespace root\\wmi -Class WmiMonitorBrightnessMethods).WmiSetBrightness(1, ${percent}) | Out-Null; 'ok'`;
    const r = await runNative('powershell.exe', ['-NoProfile', '-Command', ps], { timeoutMs: 10_000 });
    return r.ok
      ? { ok: true, percent }
      : { ok: false, error: 'brightness not supported on this display: ' + (r.stderr || r.error || '') };
  }
  return { ok: false, error: `unsupported platform ${process.platform}` };
}

// --- caffeinate -----------------------------------------------------------

/**
 * Live background-hold handles keyed by token. The token is returned
 * to the caller on the start branch; a follow-up call with
 * `{ release: true, token }` SIGTERMs the child and drops the entry.
 *
 * Module-level (process-lifetime). On gateway shutdown all holds die
 * with the parent — fine, since the OS releases the sleep inhibitor
 * once the holder process exits.
 */
const caffeinateHolds = new Map<string, ChildProcess>();

const caffeinateSchema = z.object({
  /** Hold duration in seconds. Required unless `release` is true. */
  seconds: z.number().int().min(1).max(86_400).optional(),
  /** When true, release a previously-started hold identified by `token`. */
  release: z.boolean().optional(),
  /** Token returned by a prior start call. Required when `release: true`. */
  token: z.string().optional(),
});

register({
  name: 'caffeinate',
  toolset: 'desktop',
  emoji: '☕',
  policy: 'pair-gated',
  description:
    'Prevent system sleep for N seconds. Start: { seconds } → returns { token }. ' +
    'Release early: { release: true, token }.',
  schema: caffeinateSchema,
  handler: async (args) => {
    if (args.release) {
      if (!args.token) return { ok: false, error: 'release requires `token`' };
      return releaseCaffeinate(args.token);
    }
    if (!args.seconds) return { ok: false, error: 'pass `seconds` (to start) or `release: true` + `token` (to stop)' };
    return startCaffeinate(args.seconds);
  },
});

function startCaffeinate(seconds: number): { ok: boolean; token?: string; pid?: number; seconds?: number; error?: string } {
  const spawned = spawnHold(seconds);
  if (!spawned) return { ok: false, error: `unsupported platform ${process.platform}` };
  if ('error' in spawned) return { ok: false, error: spawned.error };
  const child = spawned.child;
  const token = randomUUID();
  caffeinateHolds.set(token, child);
  // Auto-clean the map entry when the child exits on its own (natural
  // timer expiry). Caller's release call after this just no-ops.
  child.once('exit', () => {
    if (caffeinateHolds.get(token) === child) caffeinateHolds.delete(token);
  });
  return { ok: true, token, pid: child.pid, seconds };
}

function releaseCaffeinate(token: string): { ok: boolean; released?: boolean; error?: string } {
  const child = caffeinateHolds.get(token);
  if (!child) return { ok: true, released: false }; // already gone — idempotent
  try {
    child.kill('SIGTERM');
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  caffeinateHolds.delete(token);
  return { ok: true, released: true };
}

type SpawnHoldResult = { child: ChildProcess } | { error: string };

function spawnHold(seconds: number): SpawnHoldResult | null {
  // Argv-only, shell:false, detached:false so the child dies with the
  // gateway on hard shutdown. stdio ignored so handles don't keep the
  // event loop alive past the agent's needs.
  const opts = { shell: false as const, detached: false, stdio: 'ignore' as const };
  try {
    if (process.platform === 'darwin') {
      const child = spawn('caffeinate', ['-i', '-t', String(seconds)], opts);
      return wireHold(child);
    }
    if (process.platform === 'linux') {
      const child = spawn(
        'systemd-inhibit',
        ['--what=idle', '--who=swarmai', '--why=agent-requested', 'sleep', String(seconds)],
        opts,
      );
      return wireHold(child);
    }
    if (IS_ANDROID) {
      // Termux:API exposes wake-lock acquire/release as two separate
      // CLIs (termux-wake-lock / termux-wake-unlock). Wrap them in a
      // `sh` child whose trap fires on SIGTERM so the wake-lock is
      // always released — both on natural timer expiry and on early
      // release via the caller's `{ release: true, token }` path.
      // The shell built-in `sleep` runs in the same process so trap
      // catches signals during the wait.
      const script =
        `trap 'termux-wake-unlock >/dev/null 2>&1; exit 0' TERM INT; ` +
        `termux-wake-lock; ` +
        `sleep ${seconds} & wait $!; ` +
        `termux-wake-unlock >/dev/null 2>&1`;
      const child = spawn('sh', ['-c', script], opts);
      return wireHold(child);
    }
    if (process.platform === 'win32') {
      // Keep a hidden PowerShell alive that calls SetThreadExecutionState
      // with ES_CONTINUOUS | ES_SYSTEM_REQUIRED | ES_DISPLAY_REQUIRED,
      // then sleeps for the requested duration, then clears the flag.
      // When the parent SIGTERMs us (release branch) the flag is dropped
      // automatically by Windows as the thread exits.
      const ps = `Add-Type @'
using System;
using System.Runtime.InteropServices;
public class Power {
  [DllImport("kernel32.dll")]
  public static extern uint SetThreadExecutionState(uint esFlags);
}
'@
$ES_CONTINUOUS = 0x80000000
$ES_SYSTEM_REQUIRED = 0x00000001
$ES_DISPLAY_REQUIRED = 0x00000002
[Power]::SetThreadExecutionState($ES_CONTINUOUS -bor $ES_SYSTEM_REQUIRED -bor $ES_DISPLAY_REQUIRED) | Out-Null
Start-Sleep -Seconds ${seconds}
[Power]::SetThreadExecutionState($ES_CONTINUOUS) | Out-Null`;
      const child = spawn(
        'powershell.exe',
        ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', ps],
        opts,
      );
      return wireHold(child);
    }
    return null;
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

function wireHold(child: ChildProcess): SpawnHoldResult {
  // Surface immediate spawn-failures (ENOENT for caffeinate / systemd-inhibit
  // on a minimal box) as a clean error rather than leaving a ghost entry.
  let earlyError: string | null = null;
  child.once('error', (err: NodeJS.ErrnoException) => {
    earlyError =
      err.code === 'ENOENT'
        ? `${child.spawnfile} not found on PATH`
        : err.message;
  });
  // Give the kernel a tick to report ENOENT synchronously-ish. If the
  // pid never materialised, treat as failure.
  if (earlyError) return { error: earlyError };
  if (!child.pid && earlyError !== null) return { error: earlyError };
  return { child };
}
