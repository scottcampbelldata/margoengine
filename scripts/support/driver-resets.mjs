// GPU driver resets as the operating system logged them (bug 25). When a GPU driver resets, every WebGPU device on that
// GPU is lost: the page that was working fails, and the next page to ask for a device can be refused (Dawn's D3D12
// backend then says "create command queue failed with E_OUTOFMEMORY" or DXGI_ERROR_DEVICE_REMOVED). The page cannot
// tell a reset from a bug of its own, but Windows logs each one, so the checks look them up by time:
//   nvlddmkm (NVIDIA), amdkmdag / amdwddmg (AMD), igfx* (Intel)   driver errors in the System log, for example
//                                                                 nvlddmkm event 153 (the NVIDIA driver reset a GPU)
//   Display event 4101                                            "display driver stopped responding and has recovered"
//   Windows Error Reporting LiveKernelEvent 141, 117, 1a8         the Windows watchdog (TDR) reset an engine or the GPU
// Other platforms log no such events in a form we read, so the lookup returns no resets there and nothing is retried.
import { execFileSync } from 'node:child_process';

/** Driver providers in the Windows System log whose Error entries mean the GPU (or one of its engines) was reset. */
export const DRIVER_PROVIDERS = ['nvlddmkm', 'amdkmdag', 'amdwddmg', 'igfx', 'igfxn', 'igfxnd', 'Display'];
/** LiveKernelEvent codes Windows Error Reporting files for a GPU watchdog reset. */
export const WATCHDOG_CODES = ['141', '117', '1a8', '1a1'];

/**
 * The PowerShell that lists driver errors and GPU watchdog reports between two times as JSON lines of
 * `{ at, source, id, detail }`. Times are ISO strings; the script is read only.
 */
export function resetQueryScript(since, until) {
  const providers = DRIVER_PROVIDERS.map((p) => `'${p}'`).join(',');
  return [
    `$s=[DateTime]::Parse('${since}').ToLocalTime(); $u=[DateTime]::Parse('${until}').ToLocalTime()`,
    `$e=@(Get-WinEvent -FilterHashtable @{LogName='System';ProviderName=${providers};Level=1,2,3;StartTime=$s;EndTime=$u} -ErrorAction SilentlyContinue)`,
    `$w=@(Get-WinEvent -FilterHashtable @{LogName='Application';ProviderName='Windows Error Reporting';Id=1001;StartTime=$s;EndTime=$u} -ErrorAction SilentlyContinue | Where-Object { $_.Message -match 'LiveKernelEvent' })`,
    `foreach ($x in $e) { [pscustomobject]@{at=$x.TimeCreated.ToUniversalTime().ToString('o');source=$x.ProviderName;id=$x.Id;detail=(($x.Properties | Select-Object -Skip 1 -First 1 | ForEach-Object { [string]$_.Value }) -join '')} | ConvertTo-Json -Compress }`,
    `foreach ($x in $w) { $m=$x.Message -replace '\\s+',' '; $c=if ($m -match 'P1: (\\S+)') { $Matches[1] } else { '' }; $d=if ($m -match '(\\w+-\\d{8}-\\d{4}(-\\d+)?\\.dmp)') { $Matches[1] } else { '' }; [pscustomobject]@{at=$x.TimeCreated.ToUniversalTime().ToString('o');source='LiveKernelEvent';id=$c;detail=$d} | ConvertTo-Json -Compress }`,
  ].join('; ');
}

/**
 * When a watchdog report's dump was written, from its name (WATCHDOG-20261027-2304.dmp, local time to the minute), or
 * null. Windows Error Reporting files the same dump again at every upload attempt, hours later, so the report's own
 * time is not the reset's.
 */
export function dumpTime(name) {
  const m = /-(\d{4})(\d\d)(\d\d)-(\d\d)(\d\d)(?:-\d+)?\.dmp$/i.exec(String(name));
  return m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) : null;
}

/**
 * Parses the query's JSON lines, keeping only the entries that mean a reset (WER files other LiveKernelEvents too).
 * A watchdog report counts once per dump, at the dump's time, and only when that time is inside `since`..`until`
 * (a minute's slack for the name's precision); a report without a dump name counts at its own time.
 */
export function parseResets(text, { since, until } = {}) {
  const resets = [],
    dumps = new Set(),
    from = since ? Date.parse(new Date(since).toISOString()) - 60_000 : -Infinity,
    to = until ? Date.parse(new Date(until).toISOString()) : Infinity;
  for (const line of String(text).split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    let entry;
    try {
      entry = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const id = String(entry.id ?? '').toLowerCase();
    const detail = String(entry.detail ?? '').trim();
    let at = entry.at;
    if (entry.source === 'LiveKernelEvent') {
      if (!WATCHDOG_CODES.includes(id)) continue;
      const written = dumpTime(detail);
      if (written) {
        if (dumps.has(detail)) continue;
        dumps.add(detail);
        at = written.toISOString();
      }
    }
    if (entry.source === 'Display' && id !== '4101') continue;
    const t = Date.parse(at);
    if (entry.source !== 'lookup' && (t < from || t > to)) continue;
    resets.push({ at, source: entry.source, id, detail });
  }
  return resets.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

/**
 * Driver resets logged between `since` and `until` (Dates or ISO strings), oldest first. Windows only: elsewhere, or
 * when the log cannot be read, it returns []. `run` is the PowerShell runner (tests pass a stand-in).
 */
export function driverResets({ since, until = new Date(), platform = process.platform, run = runPowerShell } = {}) {
  if (platform !== 'win32') return [];
  const iso = (t) => new Date(t).toISOString();
  return parseResets(run(resetQueryScript(iso(since), iso(until))), { since, until });
}

function runPowerShell(script) {
  try {
    return execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8',
      timeout: 30_000,
      windowsHide: true,
    });
  } catch (error) {
    // The lookup only adds detail to a failure that is reported anyway; a log that cannot be read is said so.
    return `{"source":"lookup","id":"failed","at":"${new Date().toISOString()}","detail":${JSON.stringify(String(error.message).split('\n')[0])}}`;
  }
}

/** "nvlddmkm event 153 at 01:21:49" for one reset (local time, as Event Viewer shows it). */
export function describeReset({ at, source, id }) {
  const time = new Date(at).toLocaleTimeString('en-GB', { hour12: false });
  if (source === 'LiveKernelEvent') return `Windows GPU watchdog report LiveKernelEvent ${id} at ${time}`;
  return `${source} event ${id} at ${time}`;
}

/** One line naming the resets, or null when there are none. Lookup failures are named as such, never as resets. */
export function describeResets(resets) {
  const real = resets.filter((r) => r.source !== 'lookup');
  const failed = resets.find((r) => r.source === 'lookup');
  if (!real.length)
    return failed
      ? `the Windows event log could not be read (${failed.detail}), so a GPU reset cannot be confirmed`
      : null;
  return `GPU driver reset${real.length > 1 ? 's' : ''} in the Windows event log: ${real.map(describeReset).join(', ')}`;
}

/** True when `resets` holds at least one real reset (not a failed lookup). */
export const confirmed = (resets) => resets.some((r) => r.source !== 'lookup');

/**
 * Runs a GPU check step with `run()` (resolving `{ ok, ... }`). When it fails and the event log shows a GPU driver reset
 * between its start and a few seconds after its end, the whole step runs once more, and both the reset and the rerun are
 * printed and returned in `driverReset`: a reset is never hidden, and a second failure fails the step. A failure with
 * no logged reset is not retried. `lookup` is driverResets (tests pass a stand-in); `log` prints.
 */
export async function retryAfterDriverReset(
  label,
  run,
  { lookup = driverResets, log = (line) => console.error(line), settleMs = 5000, now = () => new Date() } = {},
) {
  const started = now();
  const first = await run();
  if (first.ok) return first;
  // The driver logs a reset after it recovers, a few seconds after the page saw its device go.
  if (settleMs > 0) await new Promise((resolve) => setTimeout(resolve, settleMs));
  const resets = lookup({ since: new Date(started.getTime() - 10_000), until: now() });
  if (!confirmed(resets)) {
    const why = describeResets(resets);
    if (why) log(`${label}: ${why}`);
    return first;
  }
  log(
    `\nGPU RESET: ${label} failed during a ${describeResets(resets)}. The failure is kept in this log; running the whole step once more (bug 25).`,
  );
  const second = await run();
  log(`GPU RESET: the rerun of ${label} ${second.ok ? 'passed' : 'failed too'}.`);
  return { ...second, driverReset: { resets, firstRun: first, rerunOk: second.ok } };
}
