// A `node --test` reporter that names a hung test. `--test-timeout` ends a test whose promise never settles, but it runs
// inside the test's own process: a blocked event loop, or a process that stays alive after its tests, runs on until the
// whole step is killed, and a step prints nothing until it ends. This reporter sits in the runner's process, so it still
// runs. When a test file gives no event for SILENCE_SECONDS (MARGO_TEST_SILENCE_SECONDS overrides it), it prints the file
// and the test and ends the run, children included. Every event resets the count, so a long file of short tests never
// trips it.
import { spawnSync } from 'node:child_process';
import { writeSync } from 'node:fs';
import { resolve } from 'node:path';

/** Above verify's TEST_TIMEOUT_MS, so a test whose promise never settles gets `--test-timeout`'s error and its stack first. */
export const SILENCE_SECONDS = 360;

/** Tracks what each running test file last said; pure, so its rules test without a real hang. */
export class HangWatch {
  files = new Map();
  constructor(limitSeconds) {
    this.limit = limitSeconds * 1000;
  }
  /** Takes one reporter event. `now` is in milliseconds. */
  see({ type, data }, now) {
    if (type !== 'test:enqueue' && type !== 'test:dequeue' && type !== 'test:complete') return;
    if (!data?.file) return;
    const isFile = resolve(data.name) === resolve(data.file),
      { files } = this;
    if (isFile) {
      if (type === 'test:dequeue') files.set(data.file, { name: data.name, heard: now, queue: [], running: [], done: undefined });
      else if (type === 'test:complete') files.delete(data.file);
      return;
    }
    const file = files.get(data.file);
    if (!file) return;
    file.heard = now;
    if (type === 'test:enqueue') file.queue.push(data.name);
    else if (type === 'test:dequeue') {
      const at = file.queue.indexOf(data.name);
      if (at >= 0) file.queue.splice(at, 1);
      file.running.push(data.name);
    } else {
      const at = file.running.lastIndexOf(data.name);
      if (at >= 0) file.running.splice(at, 1);
      file.done = data.name;
    }
  }
  /** One line for each file silent past the limit. */
  hung(now) {
    const lines = [];
    for (const { name, heard, queue, running, done } of this.files.values()) {
      if (now - heard < this.limit) continue;
      const seconds = Math.round((now - heard) / 1000),
        where = running.length
          ? `in test "${running.join(' > ')}"`
          : queue.length
            ? `in or before test "${queue[0]}"`
            : done !== undefined
              ? `after its last test "${done}" (something keeps the process alive)`
              : 'with no test reported yet (a blocked process reports nothing)';
      lines.push(`HUNG TEST: ${name} ${where}: no event for ${seconds} s`);
    }
    return lines;
  }
}

/** Ends this runner and the test processes it started. */
function endRun() {
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(process.pid), '/T', '/F'], { stdio: 'ignore' });
  else process.kill(process.pid, 'SIGTERM');
}

export default async function* watch(source) {
  const limit = Number(process.env.MARGO_TEST_SILENCE_SECONDS ?? SILENCE_SECONDS);
  if (!(limit > 0)) throw new RangeError('MARGO_TEST_SILENCE_SECONDS must be a number of seconds');
  const hangs = new HangWatch(limit),
    timer = setInterval(() => {
      const lines = hangs.hung(Date.now());
      if (!lines.length) return;
      clearInterval(timer);
      writeSync(2, `\n${lines.join('\n')}\n`);
      endRun();
    }, 1000);
  timer.unref();
  for await (const event of source) hangs.see(event, Date.now());
  clearInterval(timer);
}
