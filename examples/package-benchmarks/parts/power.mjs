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
