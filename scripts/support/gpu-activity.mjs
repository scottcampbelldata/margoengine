import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/** An idle window may cover a measured compile, but cannot outlive the command's hard hold limit. */
export function gpuIdleWindow(maxMinutes, idleMinutes = 3) {
  if (!Number.isFinite(maxMinutes) || maxMinutes <= 0)
    throw new RangeError('GPU hold minutes must be finite and positive');
  if (!Number.isFinite(idleMinutes) || idleMinutes <= 0)
    throw new RangeError('MARGO_GPU_IDLE_MIN must be finite and positive');
  return Math.min(maxMinutes, idleMinutes) * 60_000;
}

/** Windows WDDM cumulative per-engine work; query errors and missing providers are unknown, never zero. */
function runProbe(
  script,
  args,
  { launch = spawn, platform = process.platform, timeoutMs = 45_000, killTimeoutMs = 5_000 } = {},
) {
  if (platform !== 'win32')
    return Promise.resolve({ ok: false, error: 'per-PID GPU Engine telemetry requires Windows WDDM' });
  return new Promise((done) => {
    let child;
    try {
      child = launch(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-File', fileURLToPath(new URL(script, import.meta.url)), ...args],
        {
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
    } catch (error) {
      done({ ok: false, error: error.message });
      return;
    }
    let output = '',
      errorText = '',
      failure,
      killer,
      killTimer,
      timer,
      finished = false;
    const finish = (result) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      done(result);
    };
    timer = setTimeout(() => {
      failure = 'GPU telemetry operation exceeded its hard time limit';
      // Bound the terminator too; query cancellation must never stall lease heartbeats.
      killTimer = setTimeout(() => {
        killer?.kill();
        child.kill();
        finish({ ok: false, error: failure });
      }, killTimeoutMs);
      try {
        killer = launch('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        killer.once('error', () => child.kill());
        killer.once('close', () => finish({ ok: false, error: failure }));
      } catch {
        child.kill();
      }
    }, timeoutMs);
    child.stdout.on('data', (chunk) => {
      output += chunk;
    });
    child.stderr.on('data', (chunk) => {
      errorText += chunk;
    });
    child.once('error', (error) => finish({ ok: false, error: error.message }));
    child.once('close', (code) => {
      if (failure) return; // The bounded terminator owns completion after a query timeout.
      if (code !== 0) return finish({ ok: false, error: `GPU telemetry exited ${code}: ${errorText.trim()}` });
      try {
        finish(JSON.parse(output));
      } catch (error) {
        finish({ ok: false, error: `invalid GPU counter snapshot: ${error.message}` });
      }
    });
  });
}

export function queryGpuActivity(options) {
  return runProbe('./gpu-activity.ps1', [], options);
}

/** Native handles pin each process identity through the tree kill and bounded exit wait. */
export async function terminateGpuTree(tracked, options) {
  const result = await runProbe(
    './gpu-terminate.ps1',
    ['-IdentitiesBase64', Buffer.from(JSON.stringify(tracked)).toString('base64')],
    options,
  );
  if (!result.ok) throw Object.assign(new Error(`ERR_GPU_IDLE_KILL: ${result.error}`), { code: 'ERR_GPU_IDLE_KILL' });
}

export class GpuActivity {
  constructor({ idleMs = 180_000, maxGapMs = 90_000, bornBefore = Date.now() } = {}) {
    this.idleLimitMs = idleMs;
    this.maxGapMs = maxGapMs;
    this.bornBefore = (BigInt(Math.ceil(bornBefore)) + 11644473600000n) * 10000n;
    this.previous = null;
    this.rootBirth = null;
    this.tracked = new Map();
    this.idleSince = null;
  }
  observe(sample, rootPid, now) {
    const unknown = (reason, rootChanged = false) => {
      this.previous = null;
      this.idleSince = null;
      return { state: 'unknown', reason, sampledAt: now, idleMs: 0, reclaim: false, rootChanged };
    };
    if (!sample?.ok) return unknown(sample?.error ?? 'GPU telemetry unavailable');
    if (!Number.isFinite(now)) throw new TypeError('activity time must be finite');
    if (!Array.isArray(sample.processes) || !Array.isArray(sample.engines)) return unknown('incomplete GPU snapshot');
    const processes = new Map(sample.processes.map((p) => [p.pid, p]));
    const root = processes.get(rootPid);
    if (!root?.birth || !/^\d+$/.test(root.birth)) return unknown('holder process identity unavailable');
    if (BigInt(root.birth) > this.bornBefore || (this.rootBirth !== null && this.rootBirth !== root.birth))
      return unknown('holder PID belongs to a replacement process', true);
    this.rootBirth = root.birth;
    const tree = new Map([[rootPid, root.birth]]);
    // Retain surviving children even when intermediate launchers have exited.
    for (const [pid, birth] of this.tracked) if (processes.get(pid)?.birth === birth) tree.set(pid, birth);
    let added;
    do {
      added = false;
      for (const p of processes.values()) {
        const parent = processes.get(p.parent);
        if (
          !tree.has(p.pid) &&
          tree.has(p.parent) &&
          tree.get(p.parent) === parent?.birth &&
          /^\d+$/.test(p.birth) &&
          BigInt(p.birth) >= BigInt(parent.birth)
        ) {
          tree.set(p.pid, p.birth);
          added = true;
        }
      }
    } while (added);
    this.tracked = tree;
    if (!sample.engineCount || sample.engineCount !== sample.engines.length)
      return unknown('GPU Engine provider returned no complete instances');
    const counters = new Map();
    for (const engine of sample.engines) {
      if (!/^\d+$/.test(engine.running) || !/^\d+$/.test(engine.timestamp)) return unknown('invalid raw GPU counter');
      if (tree.has(engine.pid))
        counters.set(`${engine.name}:${tree.get(engine.pid)}`, {
          running: BigInt(engine.running),
          timestamp: BigInt(engine.timestamp),
        });
    }
    const previous = this.previous;
    this.previous = { at: now, tree, counters };
    const baseline = (reason) => {
      this.idleSince = now;
      return { state: 'unknown', reason, sampledAt: now, idleMs: 0, reclaim: false };
    };
    if (!previous) return baseline('collecting first complete sample');
    if (now <= previous.at || now - previous.at > this.maxGapMs) return baseline('sample gap or clock discontinuity');
    if (tree.size !== previous.tree.size || [...tree].some(([pid, birth]) => previous.tree.get(pid) !== birth))
      return baseline('process tree changed');
    if (
      counters.size !== previous.counters.size ||
      [...counters].some(
        ([key, value]) =>
          !previous.counters.has(key) ||
          value.running < previous.counters.get(key).running ||
          value.timestamp <= previous.counters.get(key).timestamp,
      )
    )
      return baseline('engine counters changed, reset or stopped');
    const busy = [...counters].some(([key, value]) => value.running > previous.counters.get(key).running);
    if (busy) this.idleSince = now;
    this.idleSince ??= previous.at;
    const idleMs = busy ? 0 : now - this.idleSince;
    return {
      state: busy ? 'busy' : 'idle',
      sampledAt: now,
      idleMs,
      reclaim: !busy && idleMs >= this.idleLimitMs,
      rootBirth: this.rootBirth,
      tracked: [...tree].map(([pid, birth]) => ({ pid, birth })),
    };
  }
}

/** One monitor observation. Injected callbacks prove reclamation without touching the real lock or GPU. */
export async function monitorGpuLease({
  activity,
  pid,
  token,
  readEntry,
  query = queryGpuActivity,
  now = () => performance.now(),
  publish,
  terminate,
  release,
  report,
}) {
  const sample = await query();
  if (readEntry()?.token !== token) return;
  const observe = (snapshot) => {
    const result = activity.observe(snapshot, pid, now());
    publish({ ...result, observedAt: Date.now() });
    return result;
  };
  const result = observe(sample);
  if (result.reclaim) {
    // Re-sample identities immediately before termination; never kill a reused PID.
    const confirmation = await query();
    if (readEntry()?.token !== token) return;
    const current = observe(confirmation);
    if (!current.reclaim) return;
    await terminate(current.tracked);
    report(current);
    release();
  }
}
