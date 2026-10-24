// What every result records about where it ran: host, GPU and driver, OS, Node, engine commit (browser details are
// added by the browser runner once a page has reported its WebGPU adapter and user agent).
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { cpus, platform, release, totalmem, version } from 'node:os';
import { resolve } from 'node:path';

export const root = resolve(import.meta.dirname, '../..');
/** The main checkout (worktrees live under it in .claude/worktrees/<name>). */
export const mainRoot = root.replace(/[\\/]\.claude[\\/]worktrees[\\/][^\\/]+$/, '');

const run = (file, args) => {
  try {
    return execFileSync(file, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 20_000 }).trim();
  } catch {
    return '';
  }
};
export const git = (...args) => run('git', ['-C', root, ...args]);

/** Name, driver and (NVIDIA only) utilisation of the machine's GPUs, from nvidia-smi or the OS. */
export function gpus() {
  const smi = run('nvidia-smi', ['--query-gpu=name,driver_version,utilization.gpu', '--format=csv,noheader,nounits']);
  if (smi)
    return smi.split('\n').map((line) => {
      const [name, driver, utilization] = line.split(',').map((s) => s.trim());
      return { name, driver, utilizationPercent: Number(utilization), source: 'nvidia-smi' };
    });
  if (platform() === 'win32') {
    const json = run('powershell', [
      '-NoProfile',
      '-Command',
      'Get-CimInstance Win32_VideoController | Select-Object Name,DriverVersion | ConvertTo-Json -Compress',
    ]);
    try {
      return [JSON.parse(json || '[]')].flat().map((g) => ({ name: g.Name, driver: g.DriverVersion, source: 'wmi' }));
    } catch {}
  }
  if (platform() === 'darwin') {
    const name = run('sysctl', ['-n', 'machdep.cpu.brand_string']);
    return name ? [{ name: `${name} (integrated)`, driver: null, source: 'sysctl' }] : [];
  }
  return [];
}

/** Host, OS, GPU and engine commit for a result. */
export function environment() {
  const cpu = cpus(),
    gpu = gpus(),
    core = JSON.parse(readFileSync(resolve(root, 'packages/core/package.json'), 'utf8'));
  const host = {
    cpu: cpu[0]?.model.trim(),
    cores: cpu.length,
    memoryGB: Math.round(totalmem() / 2 ** 30),
    os: platform(),
    osRelease: release(),
    osVersion: version(),
    node: process.version,
  };
  return {
    host,
    gpu,
    machine: createHash('sha256')
      .update(`${host.cpu}|${host.cores}|${host.memoryGB}|${gpu.map((g) => g.name).join('+')}|${host.os}`)
      .digest('hex')
      .slice(0, 10),
    engine: {
      name: 'margo',
      version: core.version,
      commit: git('rev-parse', '--short', 'HEAD'),
      commitFull: git('rev-parse', 'HEAD'),
      branch: git('rev-parse', '--abbrev-ref', 'HEAD'),
      dirty: git('status', '--porcelain', '--', 'packages', 'bench') !== '',
    },
  };
}
