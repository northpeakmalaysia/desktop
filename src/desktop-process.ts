import { z } from '@swarmai/shared';
import { register } from '@swarmai/tools';
import { runNative } from './native/runner.js';

/**
 * Process management — `process_list`, `process_info`, `process_kill`.
 *
 * Backends:
 *   - POSIX (macOS/Linux): `ps -axo pid,ppid,user,pcpu,pmem,etime,comm,args`
 *   - Windows: PowerShell `Get-Process` + `Get-CimInstance Win32_Process`
 *     (the latter has Owner + CommandLine, which Get-Process lacks)
 *
 * `process_kill` is master-policy. Killing the wrong PID can corrupt
 * data or crash the host. The agent is *not* allowed to kill PID 1
 * or its own PID (suicide guards).
 */

interface ProcessRecord {
  pid: number;
  ppid?: number;
  user?: string;
  cpu?: number;
  memMB?: number;
  uptime?: string;
  command: string;
  argv?: string;
}

const listSchema = z.object({
  filterName: z.string().optional(),
  filterUser: z.string().optional(),
  topByCpu: z.number().int().min(1).max(200).optional(),
  topByMem: z.number().int().min(1).max(200).optional(),
  limit: z.number().int().min(1).max(2000).default(200),
});

register({
  name: 'process_list',
  toolset: 'desktop',
  emoji: '⚙️',
  policy: 'pair-gated',
  description:
    'List running processes with PID/CPU/MEM/command. Optional filters: filterName, filterUser, topByCpu, topByMem.',
  schema: listSchema,
  handler: async (args) => {
    let processes = await listProcesses();
    if (args.filterName) {
      const needle = args.filterName.toLowerCase();
      processes = processes.filter((p) => p.command.toLowerCase().includes(needle));
    }
    if (args.filterUser) {
      processes = processes.filter((p) => p.user === args.filterUser);
    }
    if (args.topByCpu) {
      processes = [...processes].sort((a, b) => (b.cpu ?? 0) - (a.cpu ?? 0)).slice(0, args.topByCpu);
    } else if (args.topByMem) {
      processes = [...processes].sort((a, b) => (b.memMB ?? 0) - (a.memMB ?? 0)).slice(0, args.topByMem);
    } else {
      processes = processes.slice(0, args.limit);
    }
    return { ok: true, count: processes.length, processes };
  },
});

const infoSchema = z.object({ pid: z.number().int().positive() });
register({
  name: 'process_info',
  toolset: 'desktop',
  emoji: '🔍',
  policy: 'pair-gated',
  description: 'Get detailed info for a single PID.',
  schema: infoSchema,
  handler: async (args) => {
    const all = await listProcesses();
    const p = all.find((x) => x.pid === args.pid);
    if (!p) return { ok: false, error: `pid ${args.pid} not found` };
    return { ok: true, process: p };
  },
});

const killSchema = z.object({
  pid: z.number().int().positive().optional(),
  name: z.string().optional(),
  signal: z.enum(['TERM', 'KILL', 'INT', 'HUP']).default('TERM'),
});

register({
  name: 'process_kill',
  toolset: 'desktop',
  emoji: '☠️',
  policy: 'master',
  description:
    "Kill a process by pid or name. Default signal: TERM (graceful). Use KILL for force. " +
    "Master-only — refuses to kill PID 1 or the agent's own PID.",
  schema: killSchema,
  handler: async (args) => {
    if (!args.pid && !args.name) return { ok: false, error: 'pass pid or name' };
    if (args.pid !== undefined) {
      if (args.pid === 1) return { ok: false, error: 'refusing to kill PID 1' };
      if (args.pid === process.pid) return { ok: false, error: "refusing to kill the agent's own process" };
      return await killByPid(args.pid, args.signal);
    }
    return await killByName(args.name!, args.signal);
  },
});

// --- impls ----------------------------------------------------------------

async function listProcesses(): Promise<ProcessRecord[]> {
  if (process.platform === 'win32') return listWin();
  return listPosix();
}

async function listPosix(): Promise<ProcessRecord[]> {
  const r = await runNative(
    'ps',
    ['-axo', 'pid,ppid,user,pcpu,pmem,etime,comm,args'],
    { timeoutMs: 10_000, maxStdoutBytes: 8 * 1024 * 1024 },
  );
  if (!r.ok) return [];
  const lines = r.stdout.split('\n');
  if (lines.length < 2) return [];
  const out: ProcessRecord[] = [];
  for (const line of lines.slice(1)) {
    if (!line.trim()) continue;
    // Whitespace-separated columns; the last column (args) can contain
    // spaces, so we slice after the 7th whitespace-bounded column.
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(.*)$/);
    if (!m) continue;
    out.push({
      pid: Number(m[1]),
      ppid: Number(m[2]),
      user: m[3],
      cpu: Number(m[4]),
      memMB: undefined, // pmem is %, not MB; convert via /proc on Linux if needed
      uptime: m[6],
      command: m[7]!,
      argv: m[8],
    });
  }
  return out;
}

async function listWin(): Promise<ProcessRecord[]> {
  const ps =
    `Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, ` +
    `@{N='User'; E={$_.GetOwner().User}}, ` +
    `@{N='CpuPct'; E={(Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue).CPU}}, ` +
    `@{N='MemMB'; E={[math]::Round($_.WorkingSetSize / 1MB, 1)}}, ` +
    `Name, CommandLine | ConvertTo-Json -Compress -Depth 3`;
  const r = await runNative('powershell.exe', ['-NoProfile', '-Command', ps], {
    timeoutMs: 30_000,
    maxStdoutBytes: 16 * 1024 * 1024,
  });
  if (!r.ok || !r.stdout.trim()) return [];
  try {
    const parsed = JSON.parse(r.stdout) as unknown;
    const items = Array.isArray(parsed) ? parsed : [parsed];
    return items.map((p) => {
      const o = p as {
        ProcessId: number; ParentProcessId: number; User?: string;
        CpuPct?: number; MemMB?: number; Name: string; CommandLine?: string;
      };
      return {
        pid: o.ProcessId,
        ppid: o.ParentProcessId,
        user: o.User,
        cpu: o.CpuPct ?? undefined,
        memMB: o.MemMB,
        command: o.Name,
        argv: o.CommandLine ?? undefined,
      };
    });
  } catch {
    return [];
  }
}

async function killByPid(pid: number, signal: string) {
  if (process.platform === 'win32') {
    const r = await runNative(
      'powershell.exe',
      ['-NoProfile', '-Command', `Stop-Process -Id ${pid} ${signal === 'KILL' ? '-Force' : ''}`],
      { timeoutMs: 10_000 },
    );
    return r.ok ? { ok: true, pid, signal } : { ok: false, error: r.stderr };
  }
  try {
    process.kill(pid, signal as NodeJS.Signals);
    return { ok: true, pid, signal };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function killByName(name: string, signal: string) {
  if (process.platform === 'win32') {
    const force = signal === 'KILL' ? ' -Force' : '';
    const r = await runNative(
      'powershell.exe',
      ['-NoProfile', '-Command', `Stop-Process -Name '${name.replace(/'/g, "''")}' -ErrorAction SilentlyContinue${force}`],
      { timeoutMs: 10_000 },
    );
    return r.ok ? { ok: true, name, signal } : { ok: false, error: r.stderr };
  }
  // POSIX: pkill with the requested signal name
  const r = await runNative('pkill', [`-${signal}`, '-f', name], { timeoutMs: 10_000 });
  return r.ok ? { ok: true, name, signal } : { ok: false, error: r.stderr || r.error };
}
