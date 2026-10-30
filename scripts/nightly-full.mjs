// The nightly full GPU run: `npm run check:merge:full` (every GPU step, no narrowing) under the GPU lock, then the
// pinned proofs (`npm run proofs`, every claim against its claim commit, timed rounds included), with a dated log in
// test-results/nightly/<YYYY-MM-DD>T<HHMM>.log (output of each run, then a one-line result). Exit code = the first
// failing run's. The pinned proofs run here, on a quiet machine, and not in every landing: about 40 of them time the
// claim's speed-up in interleaved rounds, several with a margin near 5 % (loaders, bvh, creative), which a busy
// landing machine can erase. Only --current ran in any check before, so nine pinned proofs failed for days unnoticed
// (bug 6). It registers nothing with the OS; schedule it with whatever runs jobs on this PC:
//   node scripts/nightly-full.mjs
// Overall deadline: MARGO_NIGHTLY_DEADLINE_MIN minutes (default 240) for the whole run; past it the running step's process
// tree is killed, the result is TIMEOUT (exit 124) and the alert is raised. Every run writes test-results/nightly/last-status.json
// (pass, fail or timeout, and the step), ALERT.txt on a failure, and ends its log with a "nightly RESULT" line.
// Run it from a checkout at the commit to test (the main checkout, after `git pull --ff-only`). Takes the GPU lock exclusively (it
// includes timed steps) for the whole run (the steps inside nest under it), so landing runs wait their turn.
// The steps come from the machine profile (MARGO_MACHINE_PROFILE, scripts/support/machine-profiles.json, item 57.1a): the
// workstation runs the full check and the pinned proofs; a thermally limited machine runs only the GPU package tests,
// with its own heat watch and exclusions, and a heat stop it could not resume from ends the night as PAUSED-FOR-HEAT
// (exit 75), never as a failure. The log names the profile and every step it leaves out, with the reason.
import { spawn, spawnSync } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { margoError } from '../packages/shared/errors.js';
import { describeProfile, machineProfile } from './support/machine-profile.mjs';

const root = resolve(import.meta.dirname, '..');

/** `2026-10-25T0300`, local time: sorts as a date, and two runs on one day keep separate logs. */
export const stamp = (date = new Date()) => {
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}T${p(date.getHours())}${p(date.getMinutes())}`;
};

/** The command that runs the full check under the GPU lock. */
export const nightlyCommand = () => [
  process.execPath,
  [
    'scripts/gpu-lock.mjs',
    'run',
    '--owner=nightly-full',
    '--exclusive',
    '--max=240',
    '--',
    'npm',
    'run',
    'check:merge:full',
  ],
];

/** The command that runs the pinned proofs after it, holding the GPU lock exclusively so the timed rounds run quiet. */
export const pinnedProofsCommand = () => [
  process.execPath,
  ['scripts/gpu-lock.mjs', 'run', '--owner=nightly-proofs', '--exclusive', '--max=60', '--', 'npm', 'run', 'proofs'],
];

/**
 * Every nightly step a profile can name, by label. 'gpu package tests' runs scripts/gpu-package-tests.mjs on its own
 * (no outer lock), so its heat pauses release the GPU lock while the machine cools.
 */
export const NIGHTLY_STEPS = {
  'full check:merge': nightlyCommand,
  'pinned proofs': pinnedProofsCommand,
  'gpu package tests': () => [process.execPath, ['scripts/gpu-package-tests.mjs']],
};

/**
 * The nightly steps `profile` runs, as {label, command}, and the ones it leaves out, as {label, reason}. A label that
 * NIGHTLY_STEPS does not know throws NIGHTLY_STEP_UNKNOWN.
 */
export function nightlySteps(profile) {
  for (const label of profile.nightly)
    if (!NIGHTLY_STEPS[label])
      throw margoError(
        'NIGHTLY_STEP_UNKNOWN',
        `machine profile ${profile.name} names nightly step "${label}"; use one of ${Object.keys(NIGHTLY_STEPS).join(', ')} in scripts/support/machine-profiles.json`,
      );
  return {
    steps: profile.nightly.map((label) => ({ label, command: NIGHTLY_STEPS[label]() })),
    left: Object.keys(NIGHTLY_STEPS)
      .filter((label) => !profile.nightly.includes(label))
      .map((label) => ({ label, reason: `not in machine profile ${profile.name}'s nightly plan` })),
  };
}

/** Exit code of a step that stopped for heat and could not resume (scripts/gpu-package-tests.mjs, the heat guard). */
export const HEAT_EXIT = 75;

/** Hard limit for the whole nightly run, in minutes. Override with MARGO_NIGHTLY_DEADLINE_MIN (a positive number). */
export const defaultDeadlineMin = 240;
export const deadlineMs = (env = process.env) => {
  const minutes = Number(env.MARGO_NIGHTLY_DEADLINE_MIN ?? defaultDeadlineMin);
  return (Number.isFinite(minutes) && minutes > 0 ? minutes : defaultDeadlineMin) * 60_000;
};

/** Ends a process and everything it started (Windows: taskkill /T /F; elsewhere the process group). */
export function killTree(pid) {
  if (!pid) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
  else
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {}
    }
}

const desktopMarker = () => join(homedir(), 'Desktop', 'MARGO-NIGHTLY-FAILED.txt');

/**
 * Best-effort alert that needs no Claude tokens and no network: ALERT.txt beside the logs, a marker file on the
 * Desktop and a Windows toast. The toast can fail in a scheduled task with no signed-in desktop session, so
 * last-status.json and the final "nightly RESULT" log line are the reliable record; the rest is a bonus.
 * MARGO_NIGHTLY_NO_ALERT=1 turns the Desktop file and the toast off (tests).
 */
export function alert(dir, text, env = process.env) {
  try {
    writeFileSync(join(dir, 'ALERT.txt'), `${text}\n`);
  } catch {}
  if (env.MARGO_NIGHTLY_NO_ALERT === '1' || process.platform !== 'win32') return;
  try {
    if (existsSync(join(homedir(), 'Desktop'))) writeFileSync(desktopMarker(), `${text}\n`);
  } catch {}
  try {
    const message = text.replace(/'/g, "''").slice(0, 200);
    const script =
      "$ErrorActionPreference='Stop';[void][Windows.UI.Notifications.ToastNotificationManager,Windows.UI.Notifications,ContentType=WindowsRuntime];" +
      "$x=[Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent('ToastText02');" +
      "$t=$x.GetElementsByTagName('text');$t.Item(0).AppendChild($x.CreateTextNode('Margo nightly check'))|Out-Null;" +
      `$t.Item(1).AppendChild($x.CreateTextNode('${message}'))|Out-Null;` +
      "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('Margo nightly').Show([Windows.UI.Notifications.ToastNotification]::new($x))";
    spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      stdio: 'ignore',
      timeout: 15_000,
    });
  } catch {}
}

/** Clears the markers of an earlier failure once a run passes. */
function clearAlert(dir, env) {
  const files = [join(dir, 'ALERT.txt')];
  if (env.MARGO_NIGHTLY_NO_ALERT !== '1') files.push(desktopMarker());
  for (const file of files) {
    try {
      rmSync(file, { force: true });
    } catch {}
  }
}

/**
 * Runs the steps in order under one overall deadline. Each step is {label, command: [program, args]}. `header` lines
 * open the log (the profile and the steps it leaves out). A step that exits 75 (HEAT_EXIT) is 'paused-for-heat': the
 * night's result is PAUSED-FOR-HEAT unless a step failed, never FAIL. When the
 * deadline passes, the running step's whole process tree is killed (the GPU lock `run` wrapper is in that tree, and a
 * lock whose holder is dead is reclaimed by the next waiter), the remaining steps are skipped and the result is
 * `timeout`. Writes the dated log and `last-status.json` ({result: pass|fail|timeout, step, ...}) in `dir`, raises
 * the alert on fail or timeout, and returns the exit code (0 pass, 124 timeout, or the failing step's code).
 */
export async function runNightly({
  steps,
  dir,
  cwd = root,
  env = process.env,
  deadline = deadlineMs(env),
  quiet = false,
  header = [],
}) {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${stamp()}.log`),
    log = createWriteStream(file, { flags: 'a' }),
    began = Date.now(),
    results = [];
  for (const line of header) log.write(`${line}\n`);
  let code = 0,
    result = 'pass',
    failedStep = null;
  for (const { label, command } of steps) {
    const left = deadline - (Date.now() - began),
      started = Date.now();
    log.write(
      `nightly ${label}, started ${new Date(started).toISOString()}, cwd ${cwd}, ${Math.max(0, Math.round(left / 1000))} s left of the deadline\n`,
    );
    if (left <= 0) {
      results.push({ step: label, result: 'timeout', seconds: 0 });
      result = 'timeout';
      failedStep = label;
      code = 124;
      break;
    }
    const child = spawn(command[0], command[1], {
      cwd,
      // MARGO_NIGHTLY: tests with a nightly depth (the biomes rank envelopes of 2,499 simulations) run it.
      env: { ...env, MARGO_FULL: '1', MARGO_NIGHTLY: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });
    for (const stream of [child.stdout, child.stderr]) {
      stream.on('data', (chunk) => {
        log.write(chunk);
        if (!quiet) process.stdout.write(chunk);
      });
    }
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid);
    }, left);
    const status = await new Promise((done) => {
      child.once('error', () => done(1));
      child.once('close', (value) => done(value ?? 1));
    });
    clearTimeout(timer);
    const seconds = Math.round((Date.now() - started) / 1000);
    if (timedOut) {
      log.write(
        `\nnightly ${label} TIMED OUT after ${seconds} s (overall deadline ${Math.round(deadline / 60_000)} min), process tree killed\n`,
      );
      results.push({ step: label, result: 'timeout', seconds });
      result = 'timeout';
      failedStep = label;
      code = 124;
      break;
    }
    const heat = status === HEAT_EXIT,
      outcome = status === 0 ? 'pass' : heat ? 'paused-for-heat' : 'fail';
    log.write(
      `\nnightly ${label} ${status === 0 ? 'PASSED' : heat ? 'PAUSED FOR HEAT, NOT RESUMED (exit 75, not a failure; its summary names the steps)' : `FAILED (exit ${status})`} in ${seconds} s\n`,
    );
    results.push({ step: label, result: outcome, exit: status, seconds });
    // A failure outranks a heat stop; the first of each kind is the one named.
    if (outcome !== 'pass' && (result === 'pass' || (result === 'paused-for-heat' && outcome === 'fail'))) {
      result = outcome;
      failedStep = label;
      code = status;
    }
  }
  const total = Math.round((Date.now() - began) / 1000),
    summary = `nightly RESULT ${result.toUpperCase()}${failedStep ? ` at step "${failedStep}"` : ''}, ${total} s, log ${file}`;
  log.write(`${summary}\n`);
  await new Promise((done) => log.end(done));
  const record = {
    result,
    step: failedStep,
    exitCode: code,
    finished: new Date().toISOString(),
    seconds: total,
    deadlineMin: deadline / 60_000,
    log: file,
    steps: results,
  };
  writeFileSync(join(dir, 'last-status.json'), `${JSON.stringify(record, null, 2)}\n`);
  if (result === 'pass') clearAlert(dir, env);
  else alert(dir, summary, env);
  if (!quiet) console.log(summary);
  return code;
}

async function main() {
  const profile = machineProfile(),
    { steps, left } = nightlySteps(profile);
  process.exitCode = await runNightly({
    steps,
    dir: join(root, 'test-results/nightly'),
    header: [
      `nightly plan: ${describeProfile(profile)}`,
      ...left.map(({ label, reason }) => `nightly ${label}: LEFT OUT (${reason})`),
    ],
  });
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) await main();
