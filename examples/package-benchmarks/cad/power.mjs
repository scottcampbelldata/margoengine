// Timings on a laptop are only valid on AC power (battery throttles CPU and GPU). Windows only; elsewhere returns null.
import {execFileSync} from 'node:child_process';
export function acPower() {
  if (process.platform !== 'win32') return null;
  try {return execFileSync('powershell', ['-NoProfile', '-Command', '(Get-CimInstance -Namespace root/wmi -ClassName BatteryStatus | Select-Object -First 1).PowerOnline'], {encoding: 'utf8'}).trim() === 'True';}
  catch {return null;}
}
/** Throws on battery unless BENCH_ALLOW_BATTERY=1; returns the recorded state. */
export function requireAC() {
  const power = acPower();
  if (power === false && process.env.BENCH_ALLOW_BATTERY !== '1') throw new Error('On battery: timings would be throttled. Plug in, or set BENCH_ALLOW_BATTERY=1 to record anyway.');
  return power;
}
