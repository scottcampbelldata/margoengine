// The Windows session a process runs in. A process started over SSH (Win32-OpenSSH's sshd is a service) or by a
// scheduled task set to run whether the user is signed in or not runs in session 0, the Services session that Windows
// isolates from the signed-in desktop (Microsoft Learn, "Interactive Services": all services run in session 0). A WDDM
// GPU's display belongs to the console session (Microsoft Learn, "Remote and console terminal differences"); Edge's GPU
// process started in session 0 now and then gives pages no WebGPU adapter (docs/known-bugs.md, 2026-11-14, measured 2 of
// 12 launches on the dev PC). scripts/browser.js names that cause when a probe gets no adapter.
import { spawnSync } from 'node:child_process';

/** Session id and name from one line of `tasklist /FO CSV /NH`, or null when the line is not one. */
export function parseTasklistSession(line) {
  const fields = [...String(line).matchAll(/"((?:[^"]|"")*)"/g)].map((m) => m[1].replaceAll('""', '"'));
  if (fields.length < 4 || !/^\d+$/.test(fields[3])) return null;
  return { id: Number(fields[3]), name: fields[2] };
}

/** The session of process `pid` on Windows, or null elsewhere or when tasklist cannot say. */
export function windowsSession(pid = process.pid, { platform = process.platform, run = spawnSync } = {}) {
  if (platform !== 'win32') return null;
  const out = run('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], {
    encoding: 'utf8',
    timeout: 10_000,
    windowsHide: true,
  });
  if (out.status !== 0 || typeof out.stdout !== 'string') return null;
  return parseTasklistSession(out.stdout.trim().split(/\r?\n/)[0]);
}
