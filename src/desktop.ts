import { z } from '@swarmai/shared';
import { register } from '@swarmai/tools';
import { runNative } from './native/runner.js';
import { IS_ANDROID, tryTermux } from './_android.js';

/**
 * Desktop integration — `clipboard_read`, `clipboard_write`, `notify`.
 *
 * Wraps platform-native CLIs:
 *   - macOS: pbpaste/pbcopy/osascript
 *   - Linux: xclip/xsel/notify-send
 *   - Windows: PowerShell Get-Clipboard/Set-Clipboard, BurntToast for
 *     notifications (falls back to msg if absent)
 *   - Android (Termux + Termux:API):
 *       clipboard → termux-clipboard-get / termux-clipboard-set
 *       notify    → termux-notification
 *
 * Pair-gated: clipboard contents are sensitive, and notifications can
 * surprise the operator. Master sessions can still call them.
 */

const clipReadSchema = z.object({});
register({
  name: 'clipboard_read',
  toolset: 'desktop',
  emoji: '📋',
  policy: 'pair-gated',
  description: 'Read the current OS clipboard text. Platform: macOS/Linux/Windows/Android (Termux:API).',
  schema: clipReadSchema,
  handler: async () => {
    if (IS_ANDROID) {
      const r = await tryTermux('termux-clipboard-get', []);
      if (!r.ok) return { ok: false, error: r.error ?? ('stderr' in r ? r.stderr : undefined) };
      return { ok: true, text: r.stdout };
    }
    const { bin, args } = clipboardReadCmd();
    const r = await runNative(bin, args, { timeoutMs: 5_000 });
    if (!r.ok) return { ok: false, error: r.error ?? r.stderr };
    return { ok: true, text: r.stdout };
  },
});

const clipWriteSchema = z.object({ text: z.string() });
register({
  name: 'clipboard_write',
  toolset: 'desktop',
  emoji: '📋',
  policy: 'pair-gated',
  description: 'Write text to the OS clipboard.',
  schema: clipWriteSchema,
  handler: async (args) => {
    if (IS_ANDROID) {
      const r = await tryTermux('termux-clipboard-set', [], { stdin: args.text });
      if (!r.ok) return { ok: false, error: r.error ?? ('stderr' in r ? r.stderr : undefined) };
      return { ok: true, bytes: Buffer.byteLength(args.text, 'utf8') };
    }
    const { bin, argv } = clipboardWriteCmd();
    const r = await runNative(bin, argv, { stdin: args.text, timeoutMs: 5_000 });
    if (!r.ok) return { ok: false, error: r.error ?? r.stderr };
    return { ok: true, bytes: Buffer.byteLength(args.text, 'utf8') };
  },
});

const notifySchema = z.object({
  title: z.string().min(1).max(120),
  body: z.string().max(2000).default(''),
  /** macOS/Linux only — system sound name. */
  sound: z.string().optional(),
});
register({
  name: 'notify',
  toolset: 'desktop',
  emoji: '🔔',
  policy: 'pair-gated',
  description: 'Show an OS notification. Use sparingly — interruptions are expensive.',
  schema: notifySchema,
  handler: async (args) => {
    if (IS_ANDROID) {
      const r = await tryTermux('termux-notification', ['--title', args.title, '--content', args.body]);
      if (!r.ok) return { ok: false, error: r.error ?? ('stderr' in r ? r.stderr : undefined) };
      return { ok: true };
    }
    const cmd = notifyCmd(args.title, args.body, args.sound);
    const r = await runNative(cmd.bin, cmd.argv, { timeoutMs: 10_000 });
    if (!r.ok) return { ok: false, error: r.error ?? r.stderr };
    return { ok: true };
  },
});

function clipboardReadCmd(): { bin: string; args: string[] } {
  if (process.platform === 'darwin') return { bin: 'pbpaste', args: [] };
  if (process.platform === 'win32') {
    return { bin: 'powershell.exe', args: ['-NoProfile', '-Command', 'Get-Clipboard -Raw'] };
  }
  // Linux: try xclip first, xsel as fallback (caller can swap).
  return { bin: 'xclip', args: ['-selection', 'clipboard', '-out'] };
}

function clipboardWriteCmd(): { bin: string; argv: string[] } {
  if (process.platform === 'darwin') return { bin: 'pbcopy', argv: [] };
  if (process.platform === 'win32') {
    return { bin: 'powershell.exe', argv: ['-NoProfile', '-Command', '$input | Set-Clipboard'] };
  }
  return { bin: 'xclip', argv: ['-selection', 'clipboard'] };
}

function notifyCmd(title: string, body: string, sound: string | undefined): { bin: string; argv: string[] } {
  const t = title.replace(/"/g, '\\"');
  const b = body.replace(/"/g, '\\"');
  if (process.platform === 'darwin') {
    const soundLine = sound ? ` sound name "${sound}"` : '';
    return {
      bin: 'osascript',
      argv: ['-e', `display notification "${b}" with title "${t}"${soundLine}`],
    };
  }
  if (process.platform === 'win32') {
    // Use BurntToast if installed; otherwise msg via PowerShell as a low-fi fallback.
    const ps = `if (Get-Module -ListAvailable -Name BurntToast) { Import-Module BurntToast; New-BurntToastNotification -Text '${t}','${b}' } else { [System.Windows.Forms.MessageBox]::Show('${b}','${t}') | Out-Null }`;
    return { bin: 'powershell.exe', argv: ['-NoProfile', '-Command', ps] };
  }
  const argv = ['-a', 'SwarmAI', title, body];
  return { bin: 'notify-send', argv };
}
