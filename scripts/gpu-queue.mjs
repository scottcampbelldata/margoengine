// Detached GPU gate jobs keep their place while the submitting agent does CPU work.
// Holder and waiting entries use gpu-lock's existing format, including for older clients.
import { spawn } from 'node:child_process';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { runLimited } from './support/run-limited.mjs';
import { endTree, waitSignaled } from './support/shutdown.mjs';

/** Status revisions are immutable: Windows readers may keep the previous name open. */
export function readGpuQueueRecord(file) {
  const stem = basename(file, '.json');
  const revisions = readdirSync(dirname(file))
    .filter((name) => name.startsWith(`${stem}.`) && /^\d{8}\.json$/.test(name.slice(stem.length + 1)))
    .sort();
  const record = JSON.parse(readFileSync(revisions.length ? join(dirname(file), revisions.at(-1)) : file, 'utf8'));
  return { ...record, revision: record.revision ?? 0 };
}

export function createGpuQueue({
  acquire,
  defaultMaxMinutes,
  lockDir,
  measuresSpeed,
  resolveMode,
  validateRequest,
  validateGpuCommand,
  windowsCommandLine,
  launch = spawn,
  settleOwner = process.platform === 'win32' ? waitSignaled : undefined,
}) {
  const MIN = 60_000;
  const jobsDir = `${lockDir}-jobs`;
  const pause = (ms) => new Promise((done) => setTimeout(done, ms));
  const fileFor = (ticket) => {
    if (!/^\d{15}-\d+-[a-z0-9]+$/.test(ticket ?? ''))
      throw Object.assign(new TypeError('ERR_GPU_QUEUE_TICKET: invalid GPU queue ticket'), {
        code: 'ERR_GPU_QUEUE_TICKET',
      });
    return join(jobsDir, `${ticket}.json`);
  };
  const read = (ticket) => readGpuQueueRecord(fileFor(ticket));
  function write(ticket, record) {
    const revision = (record.revision ?? -1) + 1;
    const base = fileFor(ticket);
    const file = revision === 0 ? base : `${base.slice(0, -5)}.${String(revision).padStart(8, '0')}.json`,
      temp = `${file}.${process.pid}.tmp`;
    const published = { ...record, revision };
    writeFileSync(temp, JSON.stringify(published));
    renameSync(temp, file);
    return published;
  }
  const positive = (raw, fallback, name) => {
    const n = raw === undefined ? fallback : Number(raw);
    if (!Number.isFinite(n) || n <= 0) throw new RangeError(`${name} must be finite and positive`);
    return n;
  };

  /** Queue a bounded command; return only once its detached owner has queued or been admitted. */
  async function enqueue(command, options) {
    validateRequest({
      ...options,
      maxMinutes: options.max ?? defaultMaxMinutes(),
      command: command.join(' '),
      auditTiming: false,
    });
    validateGpuCommand(command, options);
    const queuedAt = Date.now();
    const ticket = `${String(queuedAt).padStart(15, '0')}-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
    const log = resolve('test-results', 'gpu-queue', `${ticket}.log`);
    const ownerLog = `${log}.owner.log`;
    mkdirSync(resolve('test-results', 'gpu-queue'), { recursive: true });
    mkdirSync(jobsDir, { recursive: true });
    write(ticket, { ticket, queuedAt, cwd: process.cwd(), command, options, log, ownerLog, state: 'starting' });
    const env = { ...process.env };
    delete env.MARGO_GPU_LOCK_NESTED;
    delete env.MARGO_GPU_LOCK_NESTED_MODE;
    // A file survives detachment and catches failures even before queue-run can read its ticket.
    // Keeping this separate from the command log avoids its runLimited writer truncating startup evidence.
    const output = openSync(ownerLog, 'a');
    let child;
    try {
      child = launch(process.execPath, [resolve(import.meta.dirname, 'gpu-lock.mjs'), 'queue-run', ticket], {
        env,
        detached: true,
        windowsHide: true,
        stdio: ['ignore', output, output],
      });
    } finally {
      closeSync(output);
    }
    let failed;
    child.once('error', (error) => {
      failed = error;
    });
    child.unref();
    for (const deadline = Date.now() + 30_000; ; ) {
      // Snapshot the exit flag before reading the last status published before that exit.
      const exited = child.exitCode !== null || child.signalCode !== null;
      const record = read(ticket);
      if (failed) {
        write(ticket, { ...record, state: 'failed', error: failed.message, code: failed.code });
        throw failed;
      }
      if (record.state !== 'starting') {
        if (record.state === 'failed' && record.error)
          throw Object.assign(new Error(record.error), { code: record.code });
        return { ticket, state: record.state, pid: record.pid, log };
      }
      if (Date.now() > deadline || exited) {
        if (!exited) await endTree(child.pid);
        const code = exited ? 'ERR_GPU_QUEUE_OWNER_EXIT' : 'ERR_GPU_QUEUE_START_TIMEOUT';
        const evidence = readFileSync(ownerLog, 'utf8').trim();
        const error = exited
          ? `${code}: detached owner exited before publishing queue admission (exit ${child.exitCode}, signal ${child.signalCode}); ${ownerLog}${evidence ? `\n${evidence}` : ''}`
          : `${code}: detached owner did not queue within 30 seconds`;
        write(ticket, { ...read(ticket), state: 'failed', error, code });
        throw Object.assign(new Error(error), { code });
      }
      await pause(25);
    }
  }

  async function runQueued(ticket) {
    let record;
    const update = (change) => {
      record = write(ticket, { ...record, ...change });
    };
    let release;
    try {
      record = { ...read(ticket), pid: process.pid };
      const { command, options } = record;
      release = await acquire({
        ...options,
        worktree: record.cwd,
        command: command.join(' '),
        queuedAt: record.queuedAt,
        onQueued: () => update({ state: 'waiting' }),
        log: () => {},
      });
      update({ state: 'running', admittedAt: Date.now(), mode: release.mode });
      const env = {
        ...process.env,
        MARGO_GPU_LOCK_NESTED: join(lockDir, 'nested'),
        MARGO_GPU_LOCK_NESTED_MODE: release.mode,
      };
      if (basename(lockDir) !== 'gpu.lock') env.MARGO_GPU_LOCK = join(dirname(lockDir), 'gpu.lock');
      // The command keeps the submitter's cwd. Its output belongs to that worktree, not the main checkout.
      const line =
        process.platform === 'win32'
          ? windowsCommandLine(command)
          : command.map((word) => `'${word.replaceAll("'", "'\\''")}'`).join(' ');
      const result = await runLimited(line, {
        cwd: record.cwd,
        env,
        limitMs: (options.max ?? defaultMaxMinutes(release.mode)) * MIN,
        logFile: record.log,
      });
      release();
      release = undefined;
      update({ state: result.ok ? 'passed' : 'failed', result, finishedAt: Date.now() });
    } catch (error) {
      // A failed initial read has no valid revision to update. Preserve the original exception
      // on the detached owner's stderr rather than overwriting a ticket or masking its cause.
      if (!record) throw error;
      update({ state: 'failed', error: error.message, code: error.code, finishedAt: Date.now() });
      process.exitCode = 2;
    } finally {
      release?.();
    }
  }

  /** Observe a queued job without replacing or surrendering its request. A timed-out observer can resume later. */
  async function waitForTicket(ticket, minutes) {
    const initial = read(ticket);
    const bound = positive(minutes, (initial.options.waitMax ?? 60) + (initial.options.max ?? 20) + 1, 'wait-max');
    for (const deadline = Date.now() + bound * MIN; ; ) {
      const record = read(ticket);
      if (record.state === 'passed' || record.state === 'failed') {
        // Terminal status is written just before owner exit. Windows keeps its cwd open
        // until process handles close; a completed gate must be safe to clean up.
        if (record.pid && record.pid !== process.pid && settleOwner) {
          const survivors = await settleOwner([record.pid], 30_000, record.finishedAt ?? Date.now());
          if (survivors.length)
            throw Object.assign(
              new Error(`ERR_GPU_QUEUE_OWNER_DRAIN: completed owner ${record.pid} did not close within 30 seconds`),
              { code: 'ERR_GPU_QUEUE_OWNER_DRAIN' },
            );
        }
        return record;
      }
      if (Date.now() > deadline)
        throw new Error(
          `ERR_GPU_QUEUE_WAIT_TIMEOUT: ${ticket} is ${record.state}; its place is retained, run wait ${ticket} again`,
        );
      if (record.pid) {
        let live = true;
        try {
          process.kill(record.pid, 0);
        } catch (error) {
          if (error.code !== 'EPERM') live = false;
        }
        if (!live)
          throw new Error(`ERR_GPU_QUEUE_OWNER_GONE: detached owner ${record.pid} exited before completing ${ticket}`);
      }
      await pause(100);
    }
  }

  async function queueCli(verb, words) {
    if (verb === 'queue-run') return runQueued(words[0]);
    const flag = (name) => words.find((word) => word.startsWith(`--${name}=`))?.slice(name.length + 3);
    if (verb === 'wait') {
      const record = await waitForTicket(words[0], flag('wait-max'));
      if (existsSync(record.log)) process.stdout.write(readFileSync(record.log));
      console.log(
        JSON.stringify({
          ticket: record.ticket,
          state: record.state,
          queuedMs: record.admittedAt - record.queuedAt,
          result: record.result,
          error: record.error,
        }),
      );
      process.exitCode = record.state === 'passed' ? 0 : 1;
      return;
    }
    const split = words.indexOf('--');
    if (split < 0 || split === words.length - 1)
      throw new TypeError('usage: gpu-lock.mjs enqueue --owner=<id> [--wait-max=<min>] [--max=<min>] -- <command...>');
    const flags = words.slice(0, split);
    const ownFlag = (name) => flags.find((word) => word.startsWith(`--${name}=`))?.slice(name.length + 3);
    if (!ownFlag('owner')) throw new TypeError('gpu-lock enqueue requires --owner=<id> before --');
    const command = words.slice(split + 1);
    const mode = resolveMode(
      flags.includes('--exclusive') || ownFlag('timing') !== undefined || measuresSpeed(command)
        ? 'exclusive'
        : undefined,
    );
    const options = {
      owner: ownFlag('owner'),
      mode,
      timing: ownFlag('timing'),
      gpu: ownFlag('gpu'),
      waitMax: positive(
        ownFlag('wait-max'),
        positive(process.env.MARGO_GPU_WAIT_MAX_MIN, 60, 'MARGO_GPU_WAIT_MAX_MIN'),
        'wait-max',
      ),
      max: positive(ownFlag('max'), defaultMaxMinutes(mode), 'max'),
    };
    console.log(JSON.stringify(await enqueue(command, options)));
  }
  return { enqueue, waitForTicket, queueCli };
}
