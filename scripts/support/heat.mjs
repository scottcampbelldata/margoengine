// Temperature reading, the in-step heat watch and the bounded cooldown wait for scripts/gpu-package-tests.mjs (item
// 57.1a). A thermally limited machine (the fanless Linux server with a 10 W cap) used to have heavy runs killed by its
// machine-level heat guard, and the kill read like a failure or a silent skip. The runner now watches the same sensor
// itself, a little below the guard's own stop: at the profile's stop temperature it ends the step's process tree, waits
// (bounded) for the resume temperature and runs that step again; the guard stays as the safety net above it.
//
// The sensor is the one the machine's heat guard reads (the hottest of /sys/class/thermal/thermal_zone*/temp, in
// millidegrees; zones that cannot be read are left out), so both agree on what "hot" means. MARGO_THERMAL_FILE points
// at a file to read instead: a fake source for tests, or the latest line of a temperature logger on a machine with no
// sysfs (Windows). A reading older than its source's freshness limit counts as no reading.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** Where Linux exposes its thermal zones. */
export const SYSFS_THERMAL = '/sys/class/thermal';

/** A file reading older than this many seconds is stale and counts as no reading (a logger that stopped). */
export const DEFAULT_MAX_AGE_S = 60;

/**
 * Degrees Celsius from one sensor value: millidegrees (the sysfs format, any value above 1000) or degrees. Returns null
 * for anything that is not a finite number.
 */
export function toCelsius(text) {
  const value = Number(
    String(text)
      .trim()
      .split(/[\s,;]+/)[0],
  );
  if (!Number.isFinite(value)) return null;
  return Math.abs(value) > 1000 ? value / 1000 : value;
}

/**
 * The hottest readable zone under `dir` (default /sys/class/thermal), in degrees C, or null when there is none. Zones
 * that cannot be read (a Wi-Fi zone that answers "No data available") are left out, as the heat guard does.
 */
export function hottestZone(dir = SYSFS_THERMAL) {
  let names;
  try {
    names = readdirSync(dir).filter((name) => name.startsWith('thermal_zone'));
  } catch {
    return null;
  }
  let hottest = null;
  for (const name of names) {
    let value = null;
    try {
      value = toCelsius(readFileSync(join(dir, name, 'temp'), 'utf8'));
    } catch {}
    if (value !== null && (hottest === null || value > hottest)) hottest = value;
  }
  return hottest;
}

/**
 * The temperature from a file: the first number on its last non-empty line (degrees or millidegrees). Null when the
 * file is missing, holds no number, or was last written more than `maxAgeS` seconds before `now`.
 */
export function fileTemperature(file, { maxAgeS = DEFAULT_MAX_AGE_S, now = Date.now() } = {}) {
  try {
    if ((now - statSync(file).mtimeMs) / 1000 > maxAgeS) return null;
    const lines = readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .filter((line) => line.trim());
    return lines.length ? toCelsius(lines.at(-1)) : null;
  } catch {
    return null;
  }
}

/**
 * The thermal source for this machine: `{ name, read() }`, where `read()` returns degrees C or null. MARGO_THERMAL_FILE
 * (with MARGO_THERMAL_MAX_AGE_S, default 60) wins; otherwise the sysfs zones.
 */
export function thermalSource(env = process.env) {
  if (env.MARGO_THERMAL_FILE) {
    const file = env.MARGO_THERMAL_FILE,
      maxAgeS = Number(env.MARGO_THERMAL_MAX_AGE_S ?? DEFAULT_MAX_AGE_S);
    return { name: `file ${file}`, read: () => fileTemperature(file, { maxAgeS }) };
  }
  return { name: `hottest zone in ${SYSFS_THERMAL}`, read: () => hottestZone() };
}

const round = (value) => (value === null ? null : Math.round(value * 10) / 10);
const sleep = (ms, signal) =>
  new Promise((done) => {
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', () => (clearTimeout(timer), done()), { once: true });
  });

/**
 * Watches the temperature while a step runs. Every `pollMs` it reads `read()`; at or above `stopC`, or when no reading
 * can be had, it records why and calls `onStop()` once (the runner then ends the step's process tree). `stop()` ends
 * the watch and returns `{ peakC, stoppedAtC, reason }` (`reason` null when it never fired).
 */
export function watchHeat({ read, stopC, pollMs = 5000, onStop }) {
  let peakC = null,
    stoppedAtC = null,
    reason = null,
    timer = null;
  const sample = () => {
    const t = read();
    if (t !== null && (peakC === null || t > peakC)) peakC = t;
    if (reason) return;
    if (t === null) reason = 'no temperature reading (the sensor stopped answering); treated as too hot';
    else if (t >= stopC) {
      stoppedAtC = t;
      reason = `${round(t)} C reached the stop temperature ${stopC} C`;
    }
    if (reason) onStop();
  };
  sample();
  if (!reason) timer = setInterval(sample, pollMs);
  return {
    stop() {
      clearInterval(timer);
      return { peakC: round(peakC), stoppedAtC: round(stoppedAtC), reason };
    },
  };
}

/**
 * Waits until `read()` is below `resumeC`, for at most `maxWaitMs`. Never raises a limit and never waits past
 * `maxWaitMs`. Resolves `{ resumed, waitedS, lastC, lowestC }`: `resumed` false when the wait ran out (or `signal`
 * aborted it), with the last and lowest readings so the report can say how close it came.
 */
export async function coolDown({ read, resumeC, maxWaitMs, pollMs = 10_000, signal, now = () => performance.now() }) {
  const began = now();
  let lastC = null,
    lowestC = null;
  for (;;) {
    lastC = read();
    if (lastC !== null && (lowestC === null || lastC < lowestC)) lowestC = lastC;
    const waited = now() - began;
    if (lastC !== null && lastC < resumeC)
      return { resumed: true, waitedS: Math.round(waited / 1000), lastC: round(lastC), lowestC: round(lowestC) };
    if (waited >= maxWaitMs || signal?.aborted)
      return { resumed: false, waitedS: Math.round(waited / 1000), lastC: round(lastC), lowestC: round(lowestC) };
    await sleep(Math.min(pollMs, Math.max(1, maxWaitMs - waited)), signal);
  }
}
