// Run before any timing benchmark: require AC power, wait until the machine is quiet, and return the conditions
// to record with the results. CLI: `node scripts/quiet-gate.mjs [--max=20] [--hold=20] [--timeout=1800]` prints JSON.
// Whole-machine CPU threshold, not per-process attribution; good enough to wait out other builds.
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { acPower } from '../examples/package-benchmarks/parts/power.mjs';

const ps = (script) =>
  execFileSync('powershell', ['-NoProfile', '-Command', script], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const onAC = () => acPower() !== false;
// The processor-time performance counter, as Task Manager shows it. Win32_Processor.LoadPercentage misreads on some
// machines: 18-97% from one call to the next on an idle 32-thread desktop whose counter read 4-8% (2026-10-19); it
// stays as the fallback where the counter class is missing.
export const cpuLoad = () => {
  const counter = ps(
    '(Get-CimInstance Win32_PerfFormattedData_PerfOS_Processor -Filter "Name=\'_Total\'").PercentProcessorTime',
  );
  return counter !== '' && Number.isFinite(Number(counter))
    ? Number(counter)
    : Number(ps('(Get-CimInstance Win32_Processor | Measure-Object LoadPercentage -Average).Average')) || 0;
};
const topProcesses = () =>
  ps(
    `Get-Process | Sort-Object CPU -Descending | Select-Object -First 8 Name,Id,@{n='cpuSeconds';e={[int]$_.CPU}} | ConvertTo-Json -Compress`,
  );

/** Resolves when CPU load has stayed at or under `max` % for `hold` seconds; throws on battery or after `timeout` s. */
export async function waitForQuiet({ max = 20, hold = 20, timeout = 1800, log = console.error } = {}) {
  if (!onAC()) throw new Error('On battery: plug in before timing runs');
  const start = Date.now(),
    samples = [];
  let quietSince = 0;
  for (;;) {
    const load = cpuLoad(),
      now = Date.now();
    samples.push(load);
    quietSince = load <= max ? quietSince || now : 0;
    if (quietSince && now - quietSince >= hold * 1000) break;
    if (now - start > timeout * 1000) throw new Error(`Machine not quiet after ${timeout} s (last CPU load ${load}%)`);
    if (samples.length % 6 === 1) log(`quiet-gate: CPU ${load}% (need <= ${max}% for ${hold} s)`);
    await sleep(5000);
  }
  if (!onAC()) throw new Error('On battery: plug in before timing runs');
  return {
    ac: true,
    cpuLoadPercent: samples.at(-1),
    waitedSeconds: Math.round((Date.now() - start) / 1000),
    checkedAt: new Date().toISOString(),
    topProcesses: JSON.parse(topProcesses() || '[]'),
  };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const option = (name) => {
    const arg = process.argv.find((a) => a.startsWith(`--${name}=`));
    return arg ? Number(arg.split('=')[1]) : undefined;
  };
  console.log(
    JSON.stringify(
      await waitForQuiet({ max: option('max'), hold: option('hold'), timeout: option('timeout') }),
      null,
      2,
    ),
  );
}
