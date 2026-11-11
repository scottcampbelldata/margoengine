// How long does Windows take to finish with an ended Chromium process while the GPU is busy?
// Starts N browsers at once (Edge by default), each running a back-to-back GPU compute loop (load.html), waits for the GPU work to run,
// ends each browser's main process with TerminateProcess (Node's child.kill()) and measures, per browser:
//   exitMs      from kill() to Node's 'exit' event (the kernel signalling the process object, i.e. the end of the kernel's teardown of it)
//   closeMs     from kill() to Node's 'close' event (exit plus the stdio pipes closing)
//   stragglers  processes of that run (matched by its profile folder) still listed 5 s after the kill
//
//   node teardown-latency.mjs [--browser=C:/path/to/msedge.exe] [--parallel=4] [--cycles=10] [--work-ms=3000]
//
// No dependencies beyond Node 20+. Windows only (uses PowerShell for the process list). Prints one JSON object.
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const arg = (name, fallback) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const exe = arg('browser', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe');
const parallel = Number(arg('parallel', 4)), cycles = Number(arg('cycles', 10)), workMs = Number(arg('work-ms', 3000));
const page = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), 'load.html')).href;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const listed = (marker) => {
  const command = `(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like ('*' + '${marker.slice(0, 5)}' + '${marker.slice(5)}' + '*') } | Measure-Object).Count`;
  return Number(spawnSync('powershell', ['-NoProfile', '-Command', command], { encoding: 'utf8' }).stdout.trim() || 0);
};

async function one() {
  const dir = mkdtempSync(join(tmpdir(), 'teardown-'));
  const child = spawn(exe, ['--headless=new', '--enable-unsafe-webgpu', `--user-data-dir=${dir}`, '--no-first-run', page], { stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.resume();
  child.stderr.resume();
  const ended = {};
  let t0;
  child.once('exit', () => (ended.exit = performance.now() - t0));
  child.once('close', () => (ended.close = performance.now() - t0));
  await sleep(workMs);
  t0 = performance.now();
  child.kill();
  const deadline = performance.now() + 60000;
  while (ended.close === undefined && performance.now() < deadline) await sleep(5);
  await sleep(5000);
  const stragglers = listed(basename(dir));
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
  return { exitMs: Math.round(ended.exit ?? -1), closeMs: Math.round(ended.close ?? -1), stragglers };
}

const rows = [];
for (let c = 0; c < cycles; c++) rows.push(...(await Promise.all(Array.from({ length: parallel }, one))));
const exits = rows.map((r) => r.exitMs).sort((a, b) => a - b);
console.log(JSON.stringify({
  exe, parallel, cycles, workMs, runs: rows.length, medianExitMs: exits[exits.length >> 1], maxExitMs: exits.at(-1),
  slowOver1s: exits.filter((v) => v > 1000).length, timeouts: rows.filter((r) => r.exitMs < 0).length,
  stragglers: rows.reduce((n, r) => n + r.stragglers, 0), rows,
}, null, 1));
