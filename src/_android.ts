import { runNative, type NativeRunResult } from './native/runner.js';

/**
 * Android (Termux + Shizuku) support helpers — used by every desktop-*
 * tool that branches on `process.platform`. Doc 15 calls Android out
 * as a first-class device target.
 *
 * Two backends are stitched together:
 *
 *   - Termux (https://termux.dev) — userspace Linux on Android. Provides
 *     bash + a Debian-like package manager plus the `termux-*` CLI family
 *     (Termux:API addon) bridging Android system services to the shell:
 *     `termux-clipboard-get/set`, `termux-notification`, `termux-battery-status`,
 *     `termux-volume`, `termux-location`, `termux-vibrate`, etc.
 *
 *   - Shizuku (https://shizuku.rikka.app/) — service that grants ADB-level
 *     (system) permissions without root. Its CLI is `rish`. `rish -c "<cmd>"`
 *     runs as the `shell` user, which can execute Android-restricted ops
 *     like `screencap` (real screenshot), `am start` (any app launch),
 *     `settings put system screen_brightness <n>`, `pm grant <perm>`.
 *
 * Both helpers surface a clean "install X" hint when the underlying
 * binary is absent — operators may not have all prereqs and the agent
 * needs an actionable error rather than a raw ENOENT to recover from.
 */

/**
 * True on real Android. Detects two cases:
 *   1. Node was built for Android — `process.platform === 'android'`.
 *      Termux ships such a Node binary in `pkg install nodejs`.
 *   2. Some Node builds (esp. cross-compiled) report `linux` even when
 *      running inside Termux. Termux always sets `$PREFIX` to its
 *      package prefix (`/data/data/com.termux/files/usr`), which is a
 *      Termux-defined constant — not operator-specific — so it's safe
 *      to use as a fallback signal.
 */
export const IS_ANDROID =
  process.platform === 'android' || process.env.PREFIX === '/data/data/com.termux/files/usr';

/**
 * Try a `termux-*` helper. Returns the raw `NativeRunResult` on success
 * (or any non-ENOENT failure — stderr / exit code stays available to
 * the caller). When the binary is missing, returns a clean
 * `{ ok: false, error: 'Termux:API not installed...' }` so the calling
 * tool can surface an actionable message rather than a generic
 * "spawn ENOENT".
 *
 * `Termux:API` is two pieces: the companion APK (must be sideloaded
 * separately) and the `pkg install termux-api` CLI bridge. We can't
 * distinguish which is missing from the shell — the hint covers both.
 */
export async function tryTermux(
  bin: string,
  argv: string[],
  opts: { timeoutMs?: number; stdin?: string } = {},
): Promise<NativeRunResult | { ok: false; error: string }> {
  const r = await runNative(bin, argv, {
    timeoutMs: opts.timeoutMs ?? 5_000,
    stdin: opts.stdin,
  });
  if (!r.ok && /ENOENT|not found/i.test(r.error ?? '')) {
    return {
      ok: false as const,
      error:
        'Termux:API not installed. Run: pkg install termux-api ' +
        '(and install the Termux:API companion APK)',
    };
  }
  return r;
}

/**
 * Run an elevated shell command via Shizuku's `rish` CLI. The command
 * executes as the `shell` user (uid 2000), which can do things plain
 * Termux can't — screenshots, app launches, system settings writes,
 * permission grants.
 *
 * Master-gated callers ONLY. Anything that gets here can install apps,
 * grant runtime permissions, factory-reset a device — there is no
 * reasonable pair-gated use.
 *
 * Returns `{ ok: false, error: 'Shizuku not paired...' }` when `rish`
 * is absent — operators may not have Shizuku set up yet.
 */
export async function shizukuExec(
  command: string,
  opts: { timeoutMs?: number } = {},
): Promise<NativeRunResult | { ok: false; error: string }> {
  const r = await runNative('rish', ['-c', command], {
    timeoutMs: opts.timeoutMs ?? 10_000,
  });
  if (!r.ok && /ENOENT|not found/i.test(r.error ?? '')) {
    return {
      ok: false as const,
      error:
        'Shizuku not paired / rish not on PATH. Install Shizuku APK + ' +
        'pair via wireless ADB or root (see https://shizuku.rikka.app/). ' +
        'Then `pkg install rish` inside Termux.',
    };
  }
  return r;
}
