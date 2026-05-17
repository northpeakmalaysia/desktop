import {
  hostname,
  platform,
  arch,
  release,
  totalmem,
  freemem,
  cpus,
  loadavg,
  networkInterfaces,
  userInfo,
  homedir,
  tmpdir,
  uptime,
} from 'node:os';

type IfaceInfo = {
  address: string;
  netmask: string;
  family: 'IPv4' | 'IPv6' | number;
  mac: string;
  internal: boolean;
  cidr: string | null;
  scopeid?: number;
};
import { statfsSync } from 'node:fs';
import { z } from '@swarmai/shared';
import { register } from '@swarmai/tools';
import { runNative } from './native/runner.js';
import { IS_ANDROID, tryTermux } from './_android.js';

/**
 * System info, disk, network, battery — read-only observability.
 *
 * Most of this comes from `node:os` which is built-in; no subprocess
 * needed. Disk usage uses the new (Node ≥ 19.6) `statfsSync`. Battery
 * needs platform CLIs.
 */

const sysInfoSchema = z.object({});
register({
  name: 'system_info',
  toolset: 'desktop',
  emoji: '🖥️',
  policy: 'open',
  description: 'Host info: OS, arch, hostname, uptime, CPU count, total/free memory, current user.',
  schema: sysInfoSchema,
  handler: async () => {
    return {
      ok: true,
      hostname: hostname(),
      platform: platform(),
      arch: arch(),
      release: release(),
      uptimeSec: Math.floor(uptime()),
      cpuCount: cpus().length,
      cpuModel: cpus()[0]?.model,
      loadAvg: loadavg(),
      totalMemMB: Math.round(totalmem() / 1024 / 1024),
      freeMemMB: Math.round(freemem() / 1024 / 1024),
      user: userInfo({ encoding: 'utf8' }).username,
      homeDir: homedir(),
      tmpDir: tmpdir(),
      nodeVersion: process.version,
      pid: process.pid,
    };
  },
});

const diskSchema = z.object({
  paths: z.array(z.string()).default([process.cwd()]),
});
register({
  name: 'disk_usage',
  toolset: 'desktop',
  emoji: '💾',
  policy: 'open',
  description: 'Disk free/total per path. Default: cwd. Multiple paths supported (one per volume).',
  schema: diskSchema,
  handler: async (args) => {
    const out: Array<{ path: string; totalGB: number; freeGB: number; usedPct: number } | { path: string; error: string }> = [];
    for (const p of args.paths) {
      try {
        const s = statfsSync(p);
        const total = Number(s.bsize) * Number(s.blocks);
        const free = Number(s.bsize) * Number(s.bavail);
        out.push({
          path: p,
          totalGB: round(total / 1024 ** 3, 2),
          freeGB: round(free / 1024 ** 3, 2),
          usedPct: round(100 * (1 - free / total), 1),
        });
      } catch (err) {
        out.push({ path: p, error: err instanceof Error ? err.message : String(err) });
      }
    }
    return { ok: true, volumes: out };
  },
});

const netSchema = z.object({});
register({
  name: 'network_interfaces',
  toolset: 'desktop',
  emoji: '🌐',
  policy: 'pair-gated',
  description: 'List network interfaces with IP/MAC/family/scope. Mildly sensitive (MAC addresses).',
  schema: netSchema,
  handler: async () => {
    const ifaces = networkInterfaces();
    const out: Array<{
      name: string; address: string; family: string; mac: string; internal: boolean; cidr: string | null;
    }> = [];
    for (const name of Object.keys(ifaces)) {
      const addrs = ifaces[name] as IfaceInfo[] | undefined;
      if (!addrs) continue;
      for (const a of addrs) {
        out.push({
          name,
          address: a.address,
          family: typeof a.family === 'number' ? `IPv${a.family}` : String(a.family),
          mac: a.mac,
          internal: a.internal,
          cidr: a.cidr ?? null,
        });
      }
    }
    return { ok: true, interfaces: out };
  },
});

const batterySchema = z.object({});
register({
  name: 'battery',
  toolset: 'desktop',
  emoji: '🔋',
  policy: 'open',
  description: "Laptop / phone battery state (charge percent, plugged-in). Reports 'unsupported' on desktops/servers.",
  schema: batterySchema,
  handler: async () => {
    if (IS_ANDROID) {
      // Termux:API ships rich battery info via JSON:
      //   { percentage, status, health, temperature, plugged, ... }
      // Reshape to match the Linux/macOS/Windows record so the agent
      // doesn't have to special-case the consumer side.
      const r = await tryTermux('termux-battery-status', []);
      if (!r.ok) return { ok: true, supported: false, error: r.error };
      try {
        const parsed = JSON.parse(r.stdout) as {
          percentage?: number;
          status?: string;
          health?: string;
          temperature?: number;
          plugged?: string;
        };
        return {
          ok: true,
          supported: true,
          percent: parsed.percentage,
          state: (parsed.status ?? 'unknown').toLowerCase(),
          health: parsed.health,
          temperatureC: parsed.temperature,
          plugged: parsed.plugged !== undefined && parsed.plugged !== 'UNPLUGGED',
        };
      } catch {
        return { ok: true, supported: false, raw: r.stdout.trim() };
      }
    }
    if (process.platform === 'darwin') {
      const r = await runNative('pmset', ['-g', 'batt'], { timeoutMs: 5_000 });
      if (!r.ok) return { ok: false, error: r.stderr };
      const m = r.stdout.match(/(\d+)%[;\s]+(charging|discharged|charged|finishing charge|AC attached|not charging|discharging)/i);
      if (!m) return { ok: true, supported: false, raw: r.stdout.trim() };
      return { ok: true, supported: true, percent: Number(m[1]), state: m[2] };
    }
    if (process.platform === 'linux') {
      const r = await runNative('cat', ['/sys/class/power_supply/BAT0/capacity', '/sys/class/power_supply/BAT0/status'], { timeoutMs: 2_000 });
      if (!r.ok) return { ok: true, supported: false };
      const lines = r.stdout.trim().split('\n');
      return { ok: true, supported: true, percent: Number(lines[0]), state: lines[1]?.toLowerCase() ?? 'unknown' };
    }
    if (process.platform === 'win32') {
      const ps = `(Get-CimInstance Win32_Battery | Select-Object EstimatedChargeRemaining, BatteryStatus | ConvertTo-Json -Compress)`;
      const r = await runNative('powershell.exe', ['-NoProfile', '-Command', ps], { timeoutMs: 5_000 });
      if (!r.ok || !r.stdout.trim()) return { ok: true, supported: false };
      try {
        const parsed = JSON.parse(r.stdout) as { EstimatedChargeRemaining?: number; BatteryStatus?: number };
        return {
          ok: true,
          supported: true,
          percent: parsed.EstimatedChargeRemaining,
          state: parsed.BatteryStatus === 2 ? 'AC' : parsed.BatteryStatus === 1 ? 'discharging' : 'unknown',
        };
      } catch {
        return { ok: true, supported: false };
      }
    }
    return { ok: true, supported: false };
  },
});

function round(n: number, places: number): number {
  const k = 10 ** places;
  return Math.round(n * k) / k;
}
