// Runs check jobs side by side (scripts/gpu-package-tests.mjs for GPU suites, scripts/check-merge.mjs for its steps), so
// a check uses the machine fully and does exactly the work a serial run does. Scott: "Use the hardware fully.
// Correctness tests can share a big GPU; only timing benchmarks need it exclusively."
//   - Longest first: the suites that bound the run start while slots are free.
//   - A job names its `resources` (a fixed port, a shared output path); two jobs with one in common never run at once.
//   - A job with `exclusive` runs after every other job, with nothing beside it.
//   - The first failure stops the run: running jobs are aborted (their trees killed by the caller's runner), jobs not
//     started are reported `not-run`, and the failing job is named. Time limits are the runner's (runLimited).
//   - Keep going (--keep-going or MARGO_CHECK_KEEP_GOING=1): a failure stops nothing beside it; only a job that needs the
//     failed one (`after`) is `not-run`, and every failure is reported, so one run finds every bug it can reach.
import { readFileSync } from 'node:fs';
import { margoError } from '../../packages/shared/errors.js';

/** Off until one real check compares clean (scripts/compare-check-runs.mjs); then flip this one line. */
export const PARALLEL_DEFAULT = false;

/**
 * Whether a check runs side by side. `--serial` or MARGO_CHECK_SERIAL=1 always selects the serial path, and so does a
 * profile with a heat watch or split steps (small machines stay one at a time). Otherwise `--parallel` or
 * MARGO_CHECK_PARALLEL=1 turns it on, else PARALLEL_DEFAULT.
 */
export function parallelMode({ argv = [], env = {}, profile = {} } = {}) {
  if (argv.includes('--serial') || env.MARGO_CHECK_SERIAL === '1' || profile.heat || profile.split) return false;
  return argv.includes('--parallel') || env.MARGO_CHECK_PARALLEL === '1' || PARALLEL_DEFAULT;
}

/** Whether a failed step or suite leaves the others running: `--keep-going` or MARGO_CHECK_KEEP_GOING=1. */
export const keepGoingMode = ({ argv = [], env = {} } = {}) =>
  argv.includes('--keep-going') || env.MARGO_CHECK_KEEP_GOING === '1';

/** Shared jobs longest first (ties keep their order), then exclusive jobs in their order. */
export function longestFirst(jobs) {
  const shared = jobs.filter((j) => !j.exclusive).sort((a, b) => (b.estimate ?? 0) - (a.estimate ?? 0));
  return [...shared, ...jobs.filter((j) => j.exclusive)];
}

/** The last `lines` lines of a log file, or a note that it cannot be read. */
export function tailOf(file, lines = 40) {
  try {
    return readFileSync(file, 'utf8').split(/\r?\n/).slice(-lines).join('\n');
  } catch (error) {
    return `(cannot read ${file}: ${error.code ?? error.message})`;
  }
}

const seconds = (ms) => Math.round(ms / 100) / 10;

/**
 * Runs `jobs` and resolves one result per job, in the order given: the job plus what `run` returned, `outcome` ('pass',
 * 'fail', or 'not-run' with `reason`), `ok`, `hold` ('shared' or 'exclusive'), `startedAt`, `endedAt` and
 * `slotWaitSeconds`. A job is `{ id, label, estimate?, resources?, after?: [id], exclusive? }`. `run(job, signal)`
 * resolves `{ ok, aborted? }` and must end the job's process tree when `signal` aborts. `take(mode, job)` resolves the
 * release of that job's own hold; it is given back before the job's resources. `limit` caps jobs running at once. A
 * plan that can never finish (an `after` cycle or an unknown id) throws PARALLEL_PLAN_STUCK. With `keepGoing` a failure
 * aborts nothing; a job whose `after` holds a job that did not pass is 'not-run', naming it, and the rest still run.
 */
export function runJobs(
  jobs,
  { limit, run, take = async () => () => {}, now = Date.now, log = () => {}, keepGoing = false },
) {
  if (!(limit >= 1)) throw new RangeError(`runJobs: limit must be 1 or more, got ${limit}; use MARGO_GPU_SLOTS=3`);
  const pending = longestFirst(jobs),
    running = new Map(),
    busy = new Set(),
    passed = new Set(),
    blocked = new Set(),
    results = new Map();
  let stoppedBy = null;
  return new Promise((resolve, reject) => {
    const startable = (job) =>
      running.size < limit &&
      (job.after ?? []).every((id) => passed.has(id)) &&
      !(job.resources ?? []).some((r) => busy.has(r)) &&
      (job.exclusive
        ? running.size === 0 && !pending.some((p) => !p.exclusive)
        : ![...running.keys()].some((r) => r.exclusive));
    const start = async (job) => {
      const controller = new AbortController(),
        hold = job.exclusive ? 'exclusive' : 'shared',
        asked = now();
      running.set(job, controller);
      for (const r of job.resources ?? []) busy.add(r);
      let release = () => {},
        result;
      try {
        // A stop must not wait for a slot: a hold that arrives after it is given straight back.
        const taking = Promise.resolve(take(hold, job));
        const stopped = new Promise((done) =>
          controller.signal.addEventListener('abort', () => done(null), { once: true }),
        );
        const got = await Promise.race([taking, stopped]);
        if (got === null) {
          taking.then(
            (late) => late(),
            () => {},
          );
          result = { outcome: 'not-run', ok: false, reason: `the run stopped at ${stoppedBy?.label}` };
        } else {
          release = got;
          const startedAt = now(),
            r = await run(job, controller.signal),
            outcome = r.ok ? 'pass' : r.aborted && stoppedBy ? 'not-run' : 'fail';
          result = {
            ...r,
            outcome,
            ok: Boolean(r.ok),
            startedAt,
            endedAt: now(),
            slotWaitSeconds: seconds(startedAt - asked),
            ...(outcome === 'not-run' && { reason: `ended when the run stopped at ${stoppedBy?.label}` }),
          };
        }
      } catch (error) {
        result = { outcome: 'fail', ok: false, message: error?.message ?? String(error) };
      }
      release();
      running.delete(job);
      for (const r of job.resources ?? []) busy.delete(r);
      results.set(job, { ...job, ...result, hold });
      if (result.ok) passed.add(job.id);
      if (result.outcome === 'fail' && keepGoing) {
        blocked.add(job.id);
        log(`FAILED: ${job.label}; the rest go on`);
      } else if (result.outcome === 'fail' && !stoppedBy) {
        stoppedBy = job;
        log(`STOPPING: ${job.label} failed; ending what runs beside it`);
        for (const c of running.values()) c.abort();
      }
      tick();
    };
    const tick = () => {
      // A job that needs a failed one cannot run, and neither can what needs that job.
      for (let moved = keepGoing; moved; ) {
        moved = false;
        for (const job of [...pending]) {
          const needs = (job.after ?? []).find((id) => blocked.has(id));
          if (!needs) continue;
          pending.splice(pending.indexOf(job), 1);
          blocked.add(job.id);
          results.set(job, { ...job, outcome: 'not-run', ok: false, reason: `it needs ${needs}, which did not pass` });
          moved = true;
        }
      }
      if (stoppedBy)
        for (const job of pending.splice(0))
          results.set(job, {
            ...job,
            outcome: 'not-run',
            ok: false,
            reason: `the run stopped at ${stoppedBy.label}`,
          });
      for (let i = 0; i < pending.length; ) {
        if (startable(pending[i])) start(pending.splice(i, 1)[0]);
        else i++;
      }
      if (running.size) return;
      if (pending.length)
        return reject(
          margoError(
            'PARALLEL_PLAN_STUCK',
            `no job can start: ${pending.map((j) => `${j.label} (after ${(j.after ?? []).join(', ')})`).join('; ')}; fix the "after" list so every id exists and none waits on itself`,
          ),
        );
      resolve(jobs.map((job) => results.get(job)));
    };
    tick();
  });
}
