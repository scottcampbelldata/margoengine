#!/usr/bin/env node
// The shot queue: render jobs dropped in a folder, run one at a time by a runner that lives in the render machine's
// signed-in desktop session (on the dev PC a scheduled task, "Margo Shot Runner"; docs/shots.md, Render queue). A
// browser started over SSH on Windows runs in a session with no desktop, where Edge now and then gets no WebGPU adapter;
// the runner's browsers start in the desktop session instead.
//
//   node tools/shot/queue.mjs submit <shot.json> [--seconds s] [--day YYYY-MM-DD] [--once | --production] [--encode] [--host dev] [--remote <dir>]
//   (--remote defaults to MARGO_SHOT_REMOTE_QUEUE, the render checkout's .lane/queue on that machine)
//   node tools/shot/queue.mjs run [--queue <dir>] [--watch]
//
// A job is <queue>/<name>.json. The runner claims it by moving it to running/, runs the shot tool under a hang limit, writes the log to logs/<name>.log and the outcome to
// done/<name>.json or failed/<name>.json.
//
// The runner never runs a job on stale code. It takes a stamp of its own code when it starts (the files of this folder
// and the checkout's commit) and compares it again before it claims each job and at every poll; once the checkout has
// moved it claims nothing more and exits, and the scheduled task starts it again on the new code (docs/shots.md,
// Render queue). Each job's shot tool already starts as a new process from the checkout.
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { SHOT_KINDS } from './shot-file.mjs';
import { killChildTreeSync } from '../../scripts/support/shutdown.mjs';

/** The format name of a job file. */
export const JOB_FORMAT = 'margo-shot-job';
/** The environment variable naming the queue folder on the render machine for `submit`, when `--remote` does not:
 * the render checkout's `.lane/queue`, the runner's default queue there. A machine's folders stay out of the
 * repository. */
export const REMOTE_QUEUE_VARIABLE = 'MARGO_SHOT_REMOTE_QUEUE';
/** The longest a job may run before it counts as hung and is ended with its child processes, in minutes. A shot renders
 * from its first frame to its last in one run; nothing else stops it. */
export const HANG_MINUTES = 720;
/** The longest `seconds` a job may ask for: the longest shot of any kind (a long video's, SHOT_KINDS). */
export const MAX_JOB_SECONDS = Math.max(...Object.values(SHOT_KINDS).map((kind) => kind.maxSeconds));
/** How often the runner looks at the queue in --watch, ms. */
export const POLL_MS = 30_000;
/** What `runQueue` resolves when it stopped because its code changed under it, so a fresh runner takes over. */
export const CODE_CHANGED = 'code changed';
/** What `runQueue` resolves when the process that started it is gone (the scheduled task was ended). */
export const PARENT_GONE = 'parent gone';
/** How often the runner checks that the process that started it still runs, ms. */
export const PARENT_CHECK_MS = 5_000;

/**
 * Whether the process that started this one still runs. On Windows, ending a scheduled task ends only the process the
 * task started (the PowerShell wrapper of runner-task.ps1), not the node runner under it, and nothing tells the
 * runner, so it watches its parent instead. Windows can give a gone process's id to a new one: the check runs every
 * PARENT_CHECK_MS, so that would have to happen within seconds.
 */
export function parentRuns(parent = process.ppid) {
  try {
    process.kill(parent, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM'; // Alive, owned by someone else.
  }
}

/**
 * A check that the process with id `parent` (the runner's parent when it started) still runs and is still its parent.
 * On macOS and Linux an orphan is re-parented to launchd or init, which always run (and answer the probe with EPERM),
 * so the parent id is read again: once it is no longer `parent`, the parent is gone. Windows does not re-parent, so
 * there the probe of `parent` decides.
 */
export const parentWatch =
  (parent = process.ppid, current = () => process.ppid) =>
  () =>
    current() === parent && parentRuns(parent);

/**
 * A stamp of the runner's code: a SHA-256 over the name and bytes of every .mjs and .js file in `dir` (the shot tool's
 * folder, where this module and the shot-file module it loads live) and the commit `git rev-parse HEAD` gives in
 * `repo` (the packages it imports come from that checkout). An unreadable folder, or no git, hashes in as such, so a
 * checkout caught half moved never matches the stamp of the code that was loaded.
 */
export function runnerCodeStamp({ dir = import.meta.dirname, repo = resolve(import.meta.dirname, '../..') } = {}) {
  const hash = createHash('sha256');
  try {
    for (const name of readdirSync(dir)
      .filter((file) => /\.(mjs|js)$/.test(file))
      .sort())
      hash
        .update(`${name}\0`)
        .update(readFileSync(join(dir, name)))
        .update('\0');
  } catch (error) {
    hash.update(`unreadable ${error.code ?? error.message}\0`);
  }
  const head = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: repo,
    encoding: 'utf8',
    timeout: 10_000,
    windowsHide: true,
  });
  hash.update(head.status === 0 ? `commit ${head.stdout.trim()}` : 'no commit');
  return hash.digest('hex');
}

/**
 * Checks a job file. Returns the problems, empty when it runs. A job names a shot file in the repository, the shot
 * tool options to pass (`seconds`, `day`, `once` or `production`, `encode`) A job runs to its end in one go.
 */
export function validateJob(job) {
  const issues = [];
  if (typeof job !== 'object' || job === null || Array.isArray(job)) return ['a job is {format, version, shot, ...}'];
  if (job.format !== JOB_FORMAT) issues.push(`format must be '${JOB_FORMAT}'`);
  if (job.version !== 1) issues.push('version must be 1');
  if (typeof job.shot !== 'string' || !/^[\w][\w./-]*\.json$/.test(job.shot) || job.shot.includes('..'))
    issues.push(
      'shot must be the path of a shot file in the repository, for example tools/shot/shots/orrery-dolly.json',
    );
  if ('seconds' in job && !(typeof job.seconds === 'number' && job.seconds > 0 && job.seconds < MAX_JOB_SECONDS))
    issues.push(`seconds must be above 0 and under ${MAX_JOB_SECONDS}`);
  if ('day' in job && !(typeof job.day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(job.day)))
    issues.push('day must be YYYY-MM-DD');
  if ('once' in job && typeof job.once !== 'boolean') issues.push('once must be true or false');
  if ('production' in job && typeof job.production !== 'boolean') issues.push('production must be true or false');
  if (job.once === true && job.production === true)
    issues.push('once and production: pick one (production renders once and checks its probes)');
  if ('encode' in job && typeof job.encode !== 'boolean') issues.push('encode must be true or false');
  const known = new Set(['format', 'version', 'shot', 'seconds', 'day', 'once', 'production', 'encode', 'submitted']);
  for (const key of Object.keys(job)) if (!known.has(key)) issues.push(`${key} is not a job field`);
  return issues;
}

/** The shot tool's arguments for a valid job. */
export function jobArguments(job) {
  return [
    'tools/shot/cli.mjs',
    job.shot,
    ...(job.seconds !== undefined ? ['--seconds', String(job.seconds)] : []),
    ...(job.day ? ['--day', job.day] : []),
    ...(job.once ? ['--once'] : []),
    ...(job.production ? ['--production'] : []),
    ...(job.encode ? ['--encode'] : []),
  ];
}

/** The hard limit of a job's process, ms: the hang limit. */
export const jobLimitMs = () => HANG_MINUTES * 60_000;

/** Job files waiting in a queue folder, oldest name first. */
export const queuedJobs = (queue) =>
  existsSync(queue)
    ? readdirSync(queue)
        .filter((name) => name.endsWith('.json'))
        .sort()
    : [];

/** Ends a process and everything it started (the browser, the dev server). */
function killTree(child) {
  if (process.platform === 'win32') killChildTreeSync(child);
  else
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      child.kill('SIGKILL');
    }
}

/**
 * Runs one job file of the queue to its end. Resolves its outcome record, also written to done/ or failed/ (or the
 * job moved back to the queue when the shot paused at its hold's limit). An abort of `signal` (the runner was ended)
 * ends the shot and its browser, and the job fails as stopped.
 */
export async function runJob(
  queue,
  name,
  { repo, env = process.env, now = () => new Date(), limitMs = jobLimitMs, signal } = {},
) {
  if (signal?.aborted) return null;
  const dirs = Object.fromEntries(['running', 'done', 'failed', 'logs'].map((dir) => [dir, join(queue, dir)]));
  for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true });
  const claimed = join(dirs.running, name);
  try {
    renameSync(join(queue, name), claimed);
  } catch {
    return null; // Another runner took it, or it was withdrawn.
  }
  const started = now();
  const base = name.replace(/\.json$/, '');
  const finish = (where, record) => {
    writeFileSync(join(dirs[where], `${base}.json`), JSON.stringify(record, null, 2) + '\n');
    rmSync(claimed, { force: true });
    return record;
  };
  let job;
  try {
    job = JSON.parse(readFileSync(claimed, 'utf8'));
  } catch (error) {
    return finish('failed', { name, error: `not JSON: ${error.message}`, started: started.toISOString() });
  }
  const issues = validateJob(job);
  if (issues.length) return finish('failed', { name, job, error: issues.join('; '), started: started.toISOString() });
  const log = join(dirs.logs, `${base}.log`),
    fd = openSync(log, 'a');
  const child = spawn(process.execPath, jobArguments(job), {
    cwd: repo,
    env,
    stdio: ['ignore', fd, fd],
    detached: process.platform !== 'win32',
    windowsHide: true,
  });
  let timedOut = false;
  // wall-clock: the job's hard limit; past it the shot and its browser are ended.
  const timer = setTimeout(() => {
    timedOut = true;
    killTree(child);
  }, limitMs(job));
  let stopped = false;
  const stop = () => {
    stopped = true;
    killTree(child);
  };
  signal?.addEventListener('abort', stop, { once: true });
  if (signal?.aborted) stop(); // Ended between the claim and the start.
  const code = await new Promise((done) => {
    child.on('exit', (exitCode, exitSignal) => done(exitCode ?? (exitSignal ? 1 : 0)));
    child.on('error', () => done(1));
  });
  clearTimeout(timer);
  signal?.removeEventListener('abort', stop);
  closeSync(fd);
  const ended = now(),
    record = {
      name,
      job,
      code,
      timedOut,
      started: started.toISOString(),
      ended: ended.toISOString(),
      minutes: Math.round(((ended - started) / 60_000) * 100) / 100,
      log: `logs/${base}.log`,
      ...(stopped
        ? { stopped: true, error: 'the runner was ended (its scheduled task stopped) while the job ran' }
        : {}),
    };
  return finish(code === 0 && !timedOut && !stopped ? 'done' : 'failed', record);
}

/**
 * Runs every queued job, one at a time, then returns (or, with `watch`, looks again every `pollMs`). One runner per
 * queue: a runner.pid file names the live runner, and a second one exits at once. It takes `codeStamp()` at its start
 * and compares it again before it claims each job and at every poll: once they differ (the checkout moved) it claims
 * nothing more and resolves CODE_CHANGED, so the job is checked and run by a runner on the new code. Every
 * `parentMs` it checks `parentAlive()`: once the process that started it is gone it ends the running job's shot and
 * browser (the job fails as stopped), claims nothing more and resolves PARENT_GONE.
 */
export async function runQueue({
  queue,
  repo,
  watch = false,
  log = console.log,
  env = process.env,
  pollMs = POLL_MS,
  codeStamp = () => runnerCodeStamp({ repo }),
  parentAlive = parentWatch(),
  parentMs = PARENT_CHECK_MS,
} = {}) {
  const loaded = codeStamp();
  mkdirSync(queue, { recursive: true });
  const pidFile = join(queue, 'runner.pid');
  if (existsSync(pidFile)) {
    const pid = Number(readFileSync(pidFile, 'utf8'));
    let alive = false;
    try {
      process.kill(pid, 0);
      alive = pid !== process.pid;
    } catch {
      alive = false;
    }
    if (alive) {
      log(`runner ${pid} already serves ${queue}`);
      return;
    }
  }
  writeFileSync(pidFile, String(process.pid));
  const ended = new AbortController();
  const watcher = setInterval(() => {
    if (!parentAlive()) ended.abort();
  }, parentMs);
  const gone = () => {
    if (!ended.signal.aborted) return false;
    log(`${new Date().toISOString()} the process that started the runner is gone (its task was ended): exiting`);
    return true;
  };
  const moved = () => {
    if (codeStamp() === loaded) return false;
    log(
      `${new Date().toISOString()} the runner's code changed (the checkout moved): exiting for a runner on the new code`,
    );
    return true;
  };
  try {
    for (;;) {
      if (gone()) return PARENT_GONE;
      if (moved()) return CODE_CHANGED;
      for (const name of queuedJobs(queue)) {
        if (gone()) return PARENT_GONE;
        if (moved()) return CODE_CHANGED;
        log(`${new Date().toISOString()} start ${name}`);
        const record = await runJob(queue, name, { repo, env, signal: ended.signal });
        if (record)
          log(
            `${record.ended ?? ''} ${name}: code ${record.code ?? '-'}${record.timedOut ? ' (timed out)' : ''}${record.stopped ? ' (stopped: the runner was ended)' : ''} ${record.minutes ?? ''} min`,
          );
      }
      if (gone()) return PARENT_GONE;
      if (!watch) return;
      await new Promise((r) => {
        const wake = () => {
          clearTimeout(timer);
          r();
        };
        const timer = setTimeout(() => {
          ended.signal.removeEventListener('abort', wake);
          r();
        }, pollMs);
        ended.signal.addEventListener('abort', wake, { once: true });
      });
    }
  } finally {
    clearInterval(watcher);
    rmSync(pidFile, { force: true });
  }
}

/**
 * Writes a job for `shot` and copies it into the render machine's queue over SSH (scp). Resolves the job's name.
 * `remote` is that queue's folder there, default `MARGO_SHOT_REMOTE_QUEUE` from `env`.
 */
export function submit(shot, { seconds, day, once, production, encode, host = 'dev', remote, env = process.env } = {}) {
  remote ??= env[REMOTE_QUEUE_VARIABLE];
  if (typeof remote !== 'string' || !remote)
    throw new TypeError(
      `No queue folder on ${host}: pass --remote <dir> or set ${REMOTE_QUEUE_VARIABLE} (the render checkout's .lane/queue)`,
    );
  const job = {
    format: JOB_FORMAT,
    version: 1,
    shot: shot.replace(/\\/g, '/'),
    ...(seconds !== undefined ? { seconds } : {}),
    ...(day ? { day } : {}),
    ...(once ? { once } : {}),
    ...(production ? { production } : {}),
    ...(encode ? { encode } : {}),
    submitted: new Date().toISOString(),
  };
  const issues = validateJob(job);
  if (issues.length) throw new TypeError(`Invalid job: ${issues.join('; ')}`);
  const stamp = job.submitted.replace(/[-:.]/g, '').replace('T', '-').slice(0, 15),
    name = `${stamp}-${shot.replace(/^.*[\\/]/, '').replace(/\.json$/, '')}.json`,
    local = join(tmpdir(), `margo-${process.pid}-${name}`);
  writeFileSync(local, JSON.stringify(job, null, 2) + '\n');
  try {
    // To a hidden name first, then renamed, so the runner never reads a half-copied job.
    const copy = spawnSync('scp', ['-q', '-o', 'BatchMode=yes', local, `${host}:${remote}/.${name}`], {
      stdio: 'inherit',
      timeout: 120_000,
    });
    if (copy.status !== 0) throw new Error(`scp to ${host}:${remote} failed (exit ${copy.status})`);
    const win = remote.replace(/\//g, '\\');
    const move = spawnSync(
      'ssh',
      ['-o', 'BatchMode=yes', host, `cmd /c move /y "${win}\\.${name}" "${win}\\${name}"`],
      {
        stdio: ['ignore', 'ignore', 'inherit'],
        timeout: 120_000,
      },
    );
    if (move.status !== 0) throw new Error(`renaming the job on ${host} failed (exit ${move.status})`);
  } finally {
    rmSync(local, { force: true });
  }
  return name;
}

// The command line: resolves to 0, 1 for a failure, 2 for bad arguments.
async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      seconds: { type: 'string' },
      day: { type: 'string' },
      once: { type: 'boolean' },
      production: { type: 'boolean' },
      encode: { type: 'boolean' },
      host: { type: 'string' },
      remote: { type: 'string' },
      queue: { type: 'string' },
      // Ignored: a runner task registered before 2026-11-16 still passes it. Re-registering the task drops it.
      lock: { type: 'string' },
      watch: { type: 'boolean' },
    },
  });
  const repo = resolve(import.meta.dirname, '../..');
  try {
    if (command === 'submit' && positionals.length === 1) {
      const name = submit(positionals[0], {
        seconds: values.seconds !== undefined ? Number(values.seconds) : undefined,
        day: values.day,
        once: values.once,
        production: values.production,
        encode: values.encode,
        host: values.host,
        remote: values.remote,
      });
      console.log(`queued ${name} on ${values.host ?? 'dev'}; outcome in done/ or failed/ of the queue, log in logs/`);
    } else if (command === 'run') {
      // Once the task's wrapper is ended, the output it piped to is gone: the runner's last line has nowhere to go.
      process.stdout.on('error', (error) => {
        if (error.code !== 'EPIPE') throw error;
      });
      // Returns CODE_CHANGED once the checkout moved (the scheduled task starts a runner on the new code), PARENT_GONE once the task was ended.
      await runQueue({ queue: resolve(values.queue ?? join(repo, '.lane', 'queue')), repo, watch: values.watch });
    } else {
      console.error(
        'usage: node tools/shot/queue.mjs submit <shot.json> [--seconds s] [--day YYYY-MM-DD] [--once | --production] [--encode] [--host dev] [--remote <dir>]\n       node tools/shot/queue.mjs run [--queue <dir>] [--watch]',
      );
      return 2;
    }
  } catch (error) {
    console.error(error.message);
    return 1;
  }
  return 0;
}

if (import.meta.main) process.exitCode = await main();
