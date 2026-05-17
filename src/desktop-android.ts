import { z } from '@swarmai/shared';
import { register } from '@swarmai/tools';
import { IS_ANDROID, shizukuExec, tryTermux } from './_android.js';

/**
 * Quote a string for safe interpolation inside a double-quoted shell
 * argument. `shizukuExec` runs `rish -c "<command>"`, so any caller-
 * supplied data interpolated into that command string is one shell
 * level deep. Escape the four metacharacters that survive inside `"..."`
 * in POSIX sh: backslash, double-quote, dollar sign, backtick.
 *
 * Used by `send_sms` (body + number) and any future tool that builds
 * a `rish -c` payload from agent-supplied text. Trivial to misuse —
 * never concatenate untrusted input into a shell string without it.
 */
function shellQuote(s: string): string {
  return s.replace(/(["\\$`])/g, '\\$1');
}

/**
 * Android-only tools — registered conditionally so they only appear in
 * the registry when the host is actually running on Android. On other
 * platforms the agent never sees them (no "not supported" error path
 * to traverse, no schema clutter for the LLM).
 *
 * The fourteen tools registered here intentionally span both backends:
 *
 *   - `shizuku_run`        — elevated shell (master-gated; the only
 *                            escape hatch for arbitrary system commands)
 *   - `termux_notification` — richer notification surface than the
 *                            cross-platform `notify` tool (priority,
 *                            stable replace-by-id)
 *   - `termux_vibrate`      — haptic feedback (pair-gated; harmless)
 *   - `termux_location`     — GPS (master-gated; sensitive)
 *   - `wifi_toggle`         — WiFi radio on/off (master; can sever ADB-over-WiFi)
 *   - `bluetooth_toggle`    — BT radio on/off (master)
 *   - `screen_lock`         — power-key toggle (pair-gated)
 *   - `call_phone`          — DIALS IMMEDIATELY via tel: intent (master)
 *   - `send_sms`            — opens SMS composer pre-filled (master; operator taps Send)
 *   - `device_info`         — manufacturer / model / Android version / build (pair-gated)
 *   - `list_apps`           — installed packages via `pm list packages` (pair-gated)
 *   - `kill_app`            — `am force-stop <pkg>` via Shizuku (master)
 *   - `youtube_search`      — opens YouTube search URL in default browser (pair-gated)
 *   - `whatsapp_send`       — opens WhatsApp composer pre-filled via wa.me (master; operator taps Send)
 *
 * `pkg install termux-api` + the Termux:API companion APK are required
 * for the three `termux_*` tools; Shizuku APK + `rish` on PATH for
 * `shizuku_run` and every tool that calls `shizukuExec`. Each handler
 * surfaces a clean install hint when the prereq is missing so the agent
 * can tell the operator what to do.
 */

if (IS_ANDROID) {
  register({
    name: 'shizuku_run',
    toolset: 'desktop',
    emoji: '🤖',
    // Shell-as-system uid: installs apps, grants runtime permissions,
    // writes Settings.Global. Always master, never pair-gated.
    policy: 'master',
    description:
      'Run a shell command via Shizuku (elevated shell user). Requires Shizuku paired + rish on PATH. ' +
      'Mutating/destructive — master-gated. Use this for `screencap`, `am start`, `pm grant`, `settings put`, etc.',
    schema: z.object({
      command: z.string().min(1).describe('Shell command to execute as the Shizuku shell user'),
      timeoutMs: z.number().int().positive().max(60_000).optional(),
    }),
    handler: async (args) => {
      const r = await shizukuExec(args.command, { timeoutMs: args.timeoutMs });
      if (!r.ok) return { ok: false, error: r.error ?? ('stderr' in r ? r.stderr : undefined) };
      return { ok: true, stdout: r.stdout, stderr: r.stderr, exitCode: r.exitCode };
    },
  });

  register({
    name: 'termux_notification',
    toolset: 'desktop',
    emoji: '📱',
    policy: 'pair-gated',
    description:
      'Post an Android notification via Termux:API. Title + content + optional priority (low | default | high | max). ' +
      'Pass the same `id` on a later call to replace the prior notification rather than stack them.',
    schema: z.object({
      title: z.string(),
      content: z.string(),
      priority: z.enum(['low', 'default', 'high', 'max']).optional(),
      id: z
        .string()
        .optional()
        .describe('Notification id — same id replaces a prior notification'),
    }),
    handler: async (args) => {
      const argv = ['--title', args.title, '--content', args.content];
      if (args.priority) argv.push('--priority', args.priority);
      if (args.id) argv.push('--id', args.id);
      const r = await tryTermux('termux-notification', argv);
      if (!r.ok) return { ok: false, error: r.error ?? ('stderr' in r ? r.stderr : undefined) };
      return { ok: true };
    },
  });

  register({
    name: 'termux_vibrate',
    toolset: 'desktop',
    emoji: '📳',
    policy: 'pair-gated',
    description: 'Vibrate the Android device for N milliseconds via Termux:API.',
    schema: z.object({
      durationMs: z.number().int().min(1).max(10_000).default(500),
    }),
    handler: async (args) => {
      const r = await tryTermux('termux-vibrate', ['-d', String(args.durationMs)]);
      if (!r.ok) return { ok: false, error: r.error ?? ('stderr' in r ? r.stderr : undefined) };
      return { ok: true };
    },
  });

  register({
    name: 'termux_location',
    toolset: 'desktop',
    emoji: '📍',
    // Location reveals where the operator physically is. Master-gated
    // even though Termux:API itself just needs a permission grant.
    policy: 'master',
    description:
      'Get device GPS location via Termux:API. Requires the Location permission granted to the Termux:API APK. ' +
      'Provider: gps (most accurate, slow), network (cell+wifi), passive (cached). ' +
      'Request: once (block until a fresh fix), last (most recent known), updates (subscribe — not recommended from a tool call).',
    schema: z.object({
      provider: z.enum(['gps', 'network', 'passive']).default('gps'),
      request: z.enum(['once', 'last', 'updates']).default('last'),
    }),
    handler: async (args) => {
      const r = await tryTermux('termux-location', ['-p', args.provider, '-r', args.request], {
        timeoutMs: 30_000,
      });
      if (!r.ok) return { ok: false, error: r.error ?? ('stderr' in r ? r.stderr : undefined) };
      try {
        return { ok: true, location: JSON.parse(r.stdout) as unknown };
      } catch {
        return { ok: false, error: 'failed to parse termux-location JSON', raw: r.stdout };
      }
    },
  });

  register({
    name: 'wifi_toggle',
    toolset: 'desktop',
    emoji: '📶',
    // Disabling WiFi on the device hosting the agent can sever the
    // operator's ADB-over-WiFi link to Shizuku — i.e. it can kick the
    // operator out of their own remote shell. Always master.
    policy: 'master',
    description:
      'Enable or disable the device WiFi radio via Shizuku (`svc wifi enable|disable`). ' +
      'Mutating — master-gated. WARNING: disabling WiFi will sever ADB-over-WiFi sessions, ' +
      'including the one Shizuku itself may be using; you can be locked out of your own device.',
    schema: z.object({
      enabled: z.boolean().describe('true → enable WiFi; false → disable'),
    }),
    handler: async (args) => {
      const r = await shizukuExec(`svc wifi ${args.enabled ? 'enable' : 'disable'}`);
      if (!r.ok) return { ok: false, error: r.error ?? ('stderr' in r ? r.stderr : undefined) };
      return { ok: true, enabled: args.enabled, stdout: r.stdout, exitCode: r.exitCode };
    },
  });

  register({
    name: 'bluetooth_toggle',
    toolset: 'desktop',
    emoji: '🔵',
    // Less catastrophic than wifi_toggle (operators rarely run agent
    // sessions over BT), but still touching a radio — keep master.
    policy: 'master',
    description:
      'Enable or disable the device Bluetooth radio via Shizuku (`svc bluetooth enable|disable`). ' +
      'Mutating — master-gated. Disconnects any active BT peripherals.',
    schema: z.object({
      enabled: z.boolean().describe('true → enable Bluetooth; false → disable'),
    }),
    handler: async (args) => {
      const r = await shizukuExec(`svc bluetooth ${args.enabled ? 'enable' : 'disable'}`);
      if (!r.ok) return { ok: false, error: r.error ?? ('stderr' in r ? r.stderr : undefined) };
      return { ok: true, enabled: args.enabled, stdout: r.stdout, exitCode: r.exitCode };
    },
  });

  register({
    name: 'screen_lock',
    toolset: 'desktop',
    emoji: '🔒',
    // KEYCODE_POWER is a toggle, not a one-way action — calling on a
    // sleeping screen wakes it. Low blast radius either way (the lock
    // screen still gates real access), so pair-gated is enough.
    policy: 'pair-gated',
    description:
      'Press the power button via Shizuku (`input keyevent KEYCODE_POWER`). ' +
      'NOTE: this is a TOGGLE — it locks the screen if currently on, wakes it if currently off. ' +
      'There is no portable "definitely lock" intent on Android without a Device Admin app.',
    schema: z.object({}),
    handler: async () => {
      const r = await shizukuExec('input keyevent KEYCODE_POWER');
      if (!r.ok) return { ok: false, error: r.error ?? ('stderr' in r ? r.stderr : undefined) };
      return { ok: true, toggled: true, stdout: r.stdout, exitCode: r.exitCode };
    },
  });

  register({
    name: 'call_phone',
    toolset: 'desktop',
    emoji: '📞',
    // android.intent.action.CALL DIALS IMMEDIATELY — no compose, no
    // confirm. Operators have been billed for this; emergency-number
    // abuse is also a concern. Always master.
    policy: 'master',
    description:
      'Place a phone call IMMEDIATELY via Shizuku (`am start -a android.intent.action.CALL`). ' +
      'There is NO compose / confirm step — the call dials as soon as this tool returns ok. ' +
      'Costs money, can dial emergency numbers, and can be abused — master-gated. ' +
      'The agent should explicitly confirm with the operator before invoking.',
    schema: z.object({
      number: z
        .string()
        .regex(/^[+0-9\s()-]+$/)
        .describe('Phone number — digits, spaces, +, parens, hyphens'),
    }),
    handler: async (args) => {
      // Strip everything except digits and a leading + before handing to
      // `tel:` — Android tolerates more, but extra characters are a
      // shell-injection footgun and a typo magnet.
      const cleaned = args.number.replace(/[^\d+]/g, '');
      if (!cleaned) return { ok: false, error: 'phone number contained no dialable characters' };
      const r = await shizukuExec(
        `am start -a android.intent.action.CALL -d tel:${cleaned}`,
      );
      if (!r.ok) return { ok: false, error: r.error ?? ('stderr' in r ? r.stderr : undefined) };
      return { ok: true, dialed: cleaned, stdout: r.stdout, exitCode: r.exitCode };
    },
  });

  register({
    name: 'send_sms',
    toolset: 'desktop',
    emoji: '💬',
    // Compose-only: opens the SMS composer pre-filled. The OPERATOR
    // must tap Send. SwarmAI deliberately does NOT auto-send SMS on
    // the operator's behalf — that would require SEND_SMS permission
    // granted to a system app and is a phishing/abuse risk we don't
    // want a tool call to be able to take. Still master because even
    // surfacing a pre-filled SMS in front of the user is a social-
    // engineering vector.
    policy: 'master',
    description:
      'Open the Android SMS composer pre-filled with a recipient and body ' +
      '(`am start -a android.intent.action.SENDTO -d sms:<number> --es sms_body "<body>"`). ' +
      'The operator MUST tap Send — SwarmAI does NOT silently send SMS on the operator\'s behalf ' +
      '(auto-send would need SEND_SMS permission and a system app, which is out of scope). ' +
      'Master-gated because surfacing a pre-filled SMS is itself a social-engineering vector.',
    schema: z.object({
      number: z
        .string()
        .regex(/^[+0-9\s()-]+$/)
        .describe('Phone number — digits, spaces, +, parens, hyphens'),
      body: z.string().min(1).max(1600).describe('SMS body (up to 1600 chars)'),
    }),
    handler: async (args) => {
      // Two layers of cleansing:
      //   1. number → strip to digits + leading `+` (regex schema already
      //      bounded the charset, but `tel:`/`sms:` URIs are picky).
      //   2. body → shellQuote because it lands inside a `rish -c "..."`
      //      double-quoted string. Without escaping a body containing `"`
      //      or `$(...)` would break out of the am argument and execute
      //      arbitrary shell. shellQuote handles ", \, $, `.
      const cleanedNumber = args.number.replace(/[^\d+]/g, '');
      if (!cleanedNumber) {
        return { ok: false, error: 'phone number contained no dialable characters' };
      }
      const safeBody = shellQuote(args.body);
      const r = await shizukuExec(
        `am start -a android.intent.action.SENDTO -d sms:${cleanedNumber} --es sms_body "${safeBody}"`,
      );
      if (!r.ok) return { ok: false, error: r.error ?? ('stderr' in r ? r.stderr : undefined) };
      return {
        ok: true,
        opened: true,
        sent: false,
        number: cleanedNumber,
        detail: 'composer opened — user must tap Send',
        stdout: r.stdout,
        exitCode: r.exitCode,
      };
    },
  });

  // ────────── device introspection ──────────

  register({
    name: 'device_info',
    toolset: 'desktop',
    emoji: '📱',
    // Read-only metadata: manufacturer, model, Android version, build
    // fingerprint. `getprop` is readable to Termux's shell user without
    // Shizuku for nearly all `ro.*` props. Pair-gated.
    policy: 'pair-gated',
    description:
      'Android device info: manufacturer, model, Android version, SDK level, build fingerprint, kernel. ' +
      'Reads `ro.*` system properties via `getprop` (no Shizuku required). Missing properties return null.',
    schema: z.object({}),
    handler: async () => {
      // Stable ordered set of `getprop` keys. `ro.build.version.kernel`
      // is missing on some modern Android builds (kernel info lives in
      // `uname -r` instead) — null is the expected outcome there.
      const props: Record<string, string> = {
        manufacturer: 'ro.product.manufacturer',
        brand: 'ro.product.brand',
        model: 'ro.product.model',
        device: 'ro.product.device',
        androidVersion: 'ro.build.version.release',
        sdkLevel: 'ro.build.version.sdk',
        buildId: 'ro.build.id',
        fingerprint: 'ro.build.fingerprint',
        kernel: 'ro.build.version.kernel',
        abi: 'ro.product.cpu.abi',
      };
      const info: Record<string, string | null> = {};
      for (const [key, prop] of Object.entries(props)) {
        const r = await tryTermux('getprop', [prop], { timeoutMs: 3_000 });
        info[key] = r.ok ? r.stdout.trim() || null : null;
      }
      return { ok: true, info };
    },
  });

  // ────────── app inventory & control ──────────

  register({
    name: 'list_apps',
    toolset: 'desktop',
    emoji: '📋',
    // Read-only inventory. `pm list packages` is callable by the Termux
    // shell user without Shizuku. Pair-gated; pair with `app_open` to
    // launch one of the returned package ids.
    policy: 'pair-gated',
    description:
      'List installed Android packages via Termux (`pm list packages`). Returns the package id list; ' +
      'pair with `app_open` to launch one. `includeAppNames` is a best-effort label lookup that runs ' +
      '`pm dump` per package — slow on devices with 200+ apps.',
    schema: z.object({
      filter: z
        .enum(['all', 'system', 'third-party'])
        .default('third-party')
        .describe('all = no flag (lists everything); system = -s; third-party = -3'),
      includeAppNames: z
        .boolean()
        .default(false)
        .describe(
          'Best-effort: when true, also fetch display labels via `pm dump <pkg>` per package (slow with 200+ apps)',
        ),
    }),
    handler: async (args) => {
      const flag = args.filter === 'all' ? '' : args.filter === 'system' ? '-s' : '-3';
      const argv = ['list', 'packages'];
      if (flag) argv.push(flag);
      const r = await tryTermux('pm', argv, { timeoutMs: 10_000 });
      if (!r.ok) return { ok: false, error: r.error ?? ('stderr' in r ? r.stderr : undefined) };
      const packages = r.stdout
        .split('\n')
        .map((l) => l.replace(/^package:/, '').trim())
        .filter(Boolean);

      // Optional label-lookup pass. `pm dump <pkg>` emits multi-line
      // output containing `applicationLabel=<text>` somewhere. We run in
      // parallel (capped) and tolerate per-package failures by mapping
      // to null. Operators get a strong hint in the description that
      // this is slow with large package counts.
      if (args.includeAppNames && packages.length > 0) {
        const labelRe = /applicationLabel=([^\r\n]+)/;
        const results = await Promise.all(
          packages.map(async (pkg) => {
            const d = await tryTermux('pm', ['dump', pkg], { timeoutMs: 5_000 });
            if (!d.ok) return { package: pkg, label: null as string | null };
            const m = d.stdout.match(labelRe);
            return { package: pkg, label: m ? m[1].trim() : null };
          }),
        );
        return { ok: true, count: results.length, packages: results };
      }

      return { ok: true, count: packages.length, packages };
    },
  });

  register({
    name: 'kill_app',
    toolset: 'desktop',
    emoji: '💀',
    // Force-stop is destructive: drops state, kills background workers,
    // can break sync. Requires Shizuku because `am force-stop` needs
    // the system uid. Master-gated.
    policy: 'master',
    description:
      'Force-stop an Android app by package id (`am force-stop <pkg>`). Requires Shizuku — ' +
      '`am force-stop` needs the system uid. Mutating/destructive — master-gated. ' +
      'Drops the app\'s state and kills its background workers.',
    schema: z.object({
      package: z
        .string()
        .min(1)
        .regex(
          /^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)+$/,
          'expected reverse-DNS package id like com.example.app',
        ),
    }),
    handler: async (args) => {
      // shellQuote is defensive — the regex already restricts the input
      // to characters that have no shell meaning, but keeps the pattern
      // consistent with other shizukuExec callers.
      const r = await shizukuExec(`am force-stop ${shellQuote(args.package)}`);
      if (!r.ok) return { ok: false, error: r.error ?? ('stderr' in r ? r.stderr : undefined) };
      return {
        ok: true,
        package: args.package,
        stdout: r.stdout,
        exitCode: r.exitCode,
      };
    },
  });

  // ────────── content shortcuts (browser-mediated) ──────────

  register({
    name: 'youtube_search',
    toolset: 'desktop',
    emoji: '🔎',
    // Browser-open is harmless — no API call, no key, no auto-play.
    // Pair-gated so the agent can hand the operator a result quickly.
    policy: 'pair-gated',
    description:
      'Open YouTube search results in the default browser for a query string. Uses an intent VIEW ' +
      'with the YouTube web search URL (`https://www.youtube.com/results?search_query=...`) — works ' +
      'whether the YouTube app is installed or not.',
    schema: z.object({
      query: z.string().min(1).max(200),
    }),
    handler: async (args) => {
      const encoded = encodeURIComponent(args.query);
      const url = `https://www.youtube.com/results?search_query=${encoded}`;
      const r = await tryTermux('termux-open-url', [url]);
      if (!r.ok) return { ok: false, error: r.error ?? ('stderr' in r ? r.stderr : undefined) };
      return { ok: true, url };
    },
  });

  register({
    name: 'whatsapp_send',
    toolset: 'desktop',
    emoji: '💬',
    // Compose-only: WhatsApp does NOT allow third-party apps to silently
    // send. The operator MUST tap Send. Still master because surfacing a
    // pre-filled message in front of the user is a social-engineering
    // vector (same reasoning as send_sms).
    policy: 'master',
    description:
      'Open WhatsApp pre-filled with a target number + message. Opens the composer via `wa.me` ' +
      '(deep-links into the installed app, falls back to web WhatsApp); the user MUST tap Send. ' +
      'WhatsApp does NOT allow third-party apps to silently send. ' +
      'Master-gated because surfacing a pre-filled message is itself a social-engineering vector.',
    schema: z.object({
      number: z
        .string()
        .regex(/^[+0-9\s()-]+$/)
        .describe('Phone number in international format — digits, spaces, +, parens, hyphens'),
      message: z.string().min(1).max(4096),
    }),
    handler: async (args) => {
      // `wa.me` is stricter than digits-only; it ignores a leading `+`.
      // Strip everything except digits so the URL is canonical.
      const cleanedNumber = args.number.replace(/[^\d+]/g, '').replace(/^\+/, '');
      if (!cleanedNumber) {
        return { ok: false, error: 'phone number contained no dialable characters' };
      }
      const encoded = encodeURIComponent(args.message);
      const url = `https://wa.me/${cleanedNumber}?text=${encoded}`;
      const r = await tryTermux('termux-open-url', [url]);
      if (!r.ok) return { ok: false, error: r.error ?? ('stderr' in r ? r.stderr : undefined) };
      return {
        ok: true,
        opened: true,
        sent: false,
        number: cleanedNumber,
        url,
        detail: 'composer opened — user must tap Send in WhatsApp',
      };
    },
  });
}
