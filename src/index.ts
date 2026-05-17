/**
 * @swarmai/desktop — plugin entry.
 *
 * Cross-platform desktop control toolkit. Carved out of the SwarmAI
 * monorepo's `packages/tools/src/builtin/desktop-*.ts` set (doc 15 §4)
 * so operators can install / update the desktop tool family independently
 * of the host runtime.
 *
 * 27+ tools grouped by category:
 *   - clipboard   — clipboard_read, clipboard_write
 *   - notify      — notify
 *   - capture     — screenshot (full/window/region)
 *   - app         — app_open, url_open
 *   - power       — volume_set, brightness_set, caffeinate
 *   - process     — process_list, process_info, process_kill
 *   - shell       — powershell, cmd_exe, applescript
 *   - system      — system_info, disk_usage, network_interfaces, battery
 *   - window      — window_list, window_focus, window_close, window_move
 *   - android     — shizuku_run, termux_notification, termux_vibrate,
 *                   termux_location, wifi_toggle, bluetooth_toggle,
 *                   screen_lock, call_phone, send_sms  (gated by IS_ANDROID)
 *
 * ## Registration model — side-effect import
 *
 * Each desktop-*.ts module calls `register({...})` from `@swarmai/tools`
 * at evaluation time (the same pattern as the monorepo's builtin tools).
 * Side-effect importing the modules from this entry registers every
 * tool into the host's existing tool registry.
 *
 * **Peer-dep contract**: `@swarmai/tools` is a peerDependency so the
 * plugin shares the host's exact registry instance. Do NOT add it to
 * `dependencies` — that would create a duplicate registry and the
 * registered tools would land somewhere the host never dispatches from.
 */

import type { PluginAPI } from '@swarmai/plugin-sdk';

// Side-effect imports. Each module calls register({...}) from @swarmai/tools
// at evaluation time, registering its tools into the host's tool registry.
// Order doesn't matter — registrations are independent.
import './desktop.js';
import './desktop-app.js';
import './desktop-capture.js';
import './desktop-power.js';
import './desktop-process.js';
import './desktop-shell.js';
import './desktop-system.js';
import './desktop-window.js';
import './desktop-android.js'; // gated by IS_ANDROID — no-op on other platforms

/**
 * Plugin entry the loader at `@swarmai/plugin-loader` invokes. The
 * heavy lifting is done at module-evaluation time by the side-effect
 * imports above — this function exists primarily to satisfy the loader
 * contract and emit a single "loaded" line so operators can confirm
 * the plugin landed.
 */
export function register(api: PluginAPI): void {
  // No-op — tool registrations happened at module-eval above. The
  // presence of this export satisfies the loader contract (plugin-loader
  // expects a default export with a `register` function).
  //
  // The host can read its own tool registry to confirm the desktop
  // tools landed (look for `toolset: 'desktop'`).
  const apiWithLogger = api as PluginAPI & {
    logger?: { info?: (msg: string) => void };
  };
  if (apiWithLogger.logger && typeof apiWithLogger.logger.info === 'function') {
    apiWithLogger.logger.info(
      '[@swarmai/desktop] desktop tools registered (clipboard, screenshot, window, app, system, power, android — platform-gated)',
    );
  }
}

export default { register };
