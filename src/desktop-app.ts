import { z } from '@swarmai/shared';
import { register } from '@swarmai/tools';
import { runNative } from './native/runner.js';
import { IS_ANDROID, shizukuExec, tryTermux } from './_android.js';

/**
 * App + URL launching — `app_open`, `url_open`.
 *
 * - `app_open`: launch an installed application by name. Cross-platform
 *   wrapper around `open` (macOS), `xdg-open` (Linux), `start` (Windows).
 * - `url_open`: open a URL in the OS default browser.
 *
 * Both are pair-gated. Master sessions still call them; non-main
 * subagents can't open browser tabs (which can hit auth flows etc).
 */

const appOpenSchema = z.object({
  name: z
    .string()
    .describe(
      'App name (macOS) / executable name (Linux/Windows) / .desktop entry. ' +
        'On Android: the application package id, optionally suffixed with `/<.Activity>` ' +
        '(e.g. `com.android.settings/.Settings`). There is no fuzzy app-name lookup on Android — ' +
        'the operator must supply the exact package id.',
    ),
  /** Optional file/URL to pass to the app on launch. */
  withArg: z.string().optional(),
  /** When true, return as soon as the app launches (don't wait for exit). */
  detached: z.boolean().default(true),
});

register({
  name: 'app_open',
  toolset: 'desktop',
  emoji: '🚀',
  policy: 'pair-gated',
  description:
    'Launch an installed application. Cross-platform. ' +
    'On Android `name` must be the package id (Shizuku-only; non-rooted Android forbids `am start` from a plain shell uid).',
  schema: appOpenSchema,
  handler: async (args) => {
    if (IS_ANDROID) {
      // `am start -n <package>/<Activity>` is the canonical Android
      // launch path. When the caller gives just a package id, fall back
      // to the friendlier `-a android.intent.action.MAIN -c LAUNCHER`
      // form which lets Android resolve the default activity.
      const target = args.name.includes('/')
        ? `am start -n ${args.name}`
        : `am start -a android.intent.action.MAIN -c android.intent.category.LAUNCHER -n ${args.name}`;
      const cmd = args.withArg ? `${target} -d ${JSON.stringify(args.withArg)}` : target;
      const r = await shizukuExec(cmd, { timeoutMs: 10_000 });
      if (!r.ok) return { ok: false, error: r.error ?? ('stderr' in r ? r.stderr : undefined) };
      return { ok: true, app: args.name };
    }
    if (process.platform === 'darwin') {
      const argv = ['-a', args.name];
      if (args.withArg) argv.push(args.withArg);
      const r = await runNative('open', argv, { timeoutMs: 10_000 });
      return r.ok ? { ok: true, app: args.name } : { ok: false, error: r.stderr };
    }
    if (process.platform === 'linux') {
      // Prefer xdg-open with a desktop file if `name` ends in .desktop;
      // otherwise spawn the binary directly.
      if (args.name.endsWith('.desktop')) {
        const r = await runNative('gtk-launch', [args.name.replace(/\.desktop$/, '')], { timeoutMs: 10_000 });
        return r.ok ? { ok: true, app: args.name } : { ok: false, error: r.stderr };
      }
      // Best effort: nohup the binary so it survives our process exit.
      const r = await runNative(args.name, args.withArg ? [args.withArg] : [], {
        timeoutMs: args.detached ? 2_000 : 60_000,
      });
      // If detached, we expect the process to keep running (timeout is OK).
      if (args.detached) return { ok: true, app: args.name };
      return r.ok ? { ok: true, app: args.name } : { ok: false, error: r.stderr };
    }
    if (process.platform === 'win32') {
      // `Start-Process` returns immediately when -PassThru not set.
      const argList = args.withArg ? `, '${args.withArg.replace(/'/g, "''")}'` : '';
      const ps = `Start-Process -FilePath '${args.name.replace(/'/g, "''")}'${argList ? ` -ArgumentList '${args.withArg!.replace(/'/g, "''")}'` : ''}`;
      const r = await runNative('powershell.exe', ['-NoProfile', '-Command', ps], { timeoutMs: 10_000 });
      return r.ok ? { ok: true, app: args.name } : { ok: false, error: r.stderr };
    }
    return { ok: false, error: `unsupported platform ${process.platform}` };
  },
});

const urlOpenSchema = z.object({
  url: z.string().url(),
  /** Optional browser hint (macOS: 'Safari', 'Google Chrome'; otherwise default). */
  browser: z.string().optional(),
});

register({
  name: 'url_open',
  toolset: 'desktop',
  emoji: '🔗',
  policy: 'pair-gated',
  description:
    'Open a URL in the OS default browser (or specific browser on macOS). ' +
    'On Android uses Termux:API termux-open-url (no Shizuku required).',
  schema: urlOpenSchema,
  handler: async (args) => {
    if (IS_ANDROID) {
      const r = await tryTermux('termux-open-url', [args.url]);
      if (!r.ok) return { ok: false, error: r.error ?? ('stderr' in r ? r.stderr : undefined) };
      return { ok: true, url: args.url };
    }
    if (process.platform === 'darwin') {
      const argv = args.browser ? ['-a', args.browser, args.url] : [args.url];
      const r = await runNative('open', argv, { timeoutMs: 5_000 });
      return r.ok ? { ok: true, url: args.url } : { ok: false, error: r.stderr };
    }
    if (process.platform === 'linux') {
      const r = await runNative('xdg-open', [args.url], { timeoutMs: 5_000 });
      return r.ok ? { ok: true, url: args.url } : { ok: false, error: r.stderr };
    }
    if (process.platform === 'win32') {
      const r = await runNative('powershell.exe', ['-NoProfile', '-Command', `Start-Process '${args.url.replace(/'/g, "''")}'`], { timeoutMs: 5_000 });
      return r.ok ? { ok: true, url: args.url } : { ok: false, error: r.stderr };
    }
    return { ok: false, error: `unsupported platform ${process.platform}` };
  },
});
