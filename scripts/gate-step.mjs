// Runs one gate step with a hard time limit that does not count time spent queued for the GPU.
//
// CLI: node scripts/gate-step.mjs --limit=<s> [--wait-max=<s>] -- <command...>
//
// A plain `timeout <s> <command>` around a step that takes the GPU lock counts the queue as the step's own run time:
// with every slot busy, `check:readme-run` used up a 1,500 s limit waiting and never ran a README (sweep L6b,
// 2026-11-11). Here the step's clock stops while any gpu-lock request started by the step is still waiting for a slot
// (scripts/gpu-lock.mjs leaves a marker file per waiting request in MARGO_GPU_WAIT_MARKERS), so `--limit` is the step's
// own run time. The wait has its own limit, `--wait-max` (default 3600 s), handed to every gpu-lock request in the step
// as MARGO_GPU_WAIT_MAX_MIN, and the whole step still ends at `--limit` plus `--wait-max` plus a minute however its time
// was split. Past either limit the step's whole process tree is ended and this exits 124 saying which limit it was.
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { killTree, windowsCommandLine } from './gpu-lock.mjs';

const GRACE_S = 60;

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
};

/** Whether a request in `folder` is still waiting: a marker whose process is alive (a killed waiter leaves its file). */
export function waiting(folder) {
  let names;
  try {
    names = readdirSync(folder);
  } catch {
    return false;
  }
  return names.some((name) => {
    try {
      return alive(Number(readFileSync(join(folder, name), 'utf8')));
    } catch {
      return false;
    }
  });
}

/**
 * Runs `command` ([program, ...args]) and resolves to {code, reason}. `limitMs` counts only time when no gpu-lock
 * request of the command is waiting; `waitMaxMs` bounds the waiting; `limitMs + waitMaxMs + graceMs` bounds the whole.
 */
export function runStep(command, { limitMs, waitMaxMs = 3_600_000, graceMs = GRACE_S * 1000, poll = 200 } = {}) {
  const windows = process.platform === 'win32',
    markers = mkdtempSync(join(tmpdir(), 'gate-step-wait-')),
    env = { ...process.env, MARGO_GPU_WAIT_MARKERS: markers, MARGO_GPU_WAIT_MAX_MIN: String(waitMaxMs / 60_000) },
    child = windows
      ? spawn(windowsCommandLine(command), { env, stdio: 'inherit', shell: true })
      : spawn(command[0], command.slice(1), { env, stdio: 'inherit', detached: true });
  const started = Date.now();
  let last = started,
    ran = 0,
    queued = 0,
    reason;
  const timer = setInterval(() => {
    const now = Date.now();
    if (waiting(markers)) queued += now - last;
    else ran += now - last;
    last = now;
    if (ran > limitMs) reason = `ran ${Math.round(ran / 1000)} s, past its own limit of ${limitMs / 1000} s`;
    else if (queued > waitMaxMs + graceMs)
      reason = `waited ${Math.round(queued / 1000)} s for the GPU, past the wait limit of ${waitMaxMs / 1000} s`;
    else if (now - started > limitMs + waitMaxMs + graceMs)
      reason = `took ${Math.round((now - started) / 1000)} s in all, past the overall limit of ${(limitMs + waitMaxMs + graceMs) / 1000} s`;
    if (reason) {
      clearInterval(timer);
      killTree(child.pid);
    }
  }, poll);
  return new Promise((done) => {
    const finish = (code) => {
      clearInterval(timer);
      rmSync(markers, { recursive: true, force: true });
      done({ code: reason ? 124 : (code ?? 1), reason, ran, queued });
    };
    child.once('error', () => finish(1));
    child.once('close', finish);
  });
}

async function main(argv) {
  const split = argv.indexOf('--'),
    flags = argv.slice(0, split < 0 ? argv.length : split),
    command = split < 0 ? [] : argv.slice(split + 1),
    seconds = (name) => {
      const raw = flags.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
      return raw === undefined ? undefined : Number(raw);
    },
    limit = seconds('limit'),
    waitMax = seconds('wait-max') ?? 3600;
  if (!command.length || !(limit > 0) || !(waitMax > 0)) {
    console.error('usage: node scripts/gate-step.mjs --limit=<s> [--wait-max=<s>] -- <command...>');
    process.exit(2);
  }
  const { code, reason } = await runStep(command, { limitMs: limit * 1000, waitMaxMs: waitMax * 1000 });
  if (reason) console.error(`TIMEOUT: ${command.join(' ')} ${reason}`);
  process.exit(code);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main(process.argv.slice(2));
