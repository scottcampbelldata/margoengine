// Timings on a laptop are only valid on AC power (battery throttles CPU and GPU). Windows only; elsewhere returns null.
import { execFileSync } from 'node:child_process';
export function acPower() {
  if (process.platform !== 'win32') return null;
  try {
    const status = execFileSync(
      'powershell',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        'Add-Type -AssemblyName System.Windows.Forms -ErrorAction Stop; ([System.Windows.Forms.SystemInformation]::PowerStatus).PowerLineStatus',
      ],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim();
    return status === 'Online' ? true : status === 'Offline' ? false : null;
  } catch {
    return null;
  }
}
/** Throws on battery unless BENCH_ALLOW_BATTERY=1; returns the recorded state. */
export function requireAC() {
  const power = acPower();
  if (power === false && process.env.BENCH_ALLOW_BATTERY !== '1')
    throw new Error('On battery: timings would be throttled. Plug in, or set BENCH_ALLOW_BATTERY=1 to record anyway.');
  return power;
}
/** The power state as the text the benchmark reports record: 'True' on mains (also a desktop with no battery), 'False' on battery, 'Unknown' when it cannot be read. */
export function powerOnlineText() {
  const power = acPower();
  return power === true ? 'True' : power === false ? 'False' : 'Unknown';
}

const ps = (script) =>
  execFileSync('powershell', ['-NoProfile', '-Command', script], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
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
