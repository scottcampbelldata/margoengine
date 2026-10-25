// The nightly full GPU run: `npm run check:merge:full` (every GPU step, no narrowing) under the GPU lock, with a dated
// log in test-results/nightly/<YYYY-MM-DD>T<HHMM>.log (output of the run, then a one-line result). Exit code = the
// run's. It registers nothing with the OS; schedule it with whatever runs jobs on this PC:
//   node scripts/nightly-full.mjs
// Run it from a checkout at the commit to test (the main checkout, after `git pull --ff-only`). Takes the GPU lock for
// the whole run (the steps inside nest under it), so landing runs wait their turn.
import { spawn } from 'node:child_process';
import { createWriteStream, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve(import.meta.dirname, '..');

/** `2026-10-25T0300`, local time: sorts as a date, and two runs on one day keep separate logs. */
export const stamp = (date = new Date()) => {
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}T${p(date.getHours())}${p(date.getMinutes())}`;
};

/** The command that runs the full check under the GPU lock. */
export const nightlyCommand = () => [
  process.execPath,
  ['scripts/gpu-lock.mjs', 'run', '--owner=nightly-full', '--', 'npm', 'run', 'check:merge:full'],
];

async function main() {
  const dir = join(root, 'test-results/nightly');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${stamp()}.log`),
    log = createWriteStream(file),
    started = Date.now(),
    [command, args] = nightlyCommand();
  log.write(`nightly full check:merge, started ${new Date(started).toISOString()}, cwd ${root}\n`);
  const child = spawn(command, args, {
    cwd: root,
    env: { ...process.env, MARGO_FULL: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  for (const stream of [child.stdout, child.stderr]) {
    stream.on('data', (chunk) => {
      log.write(chunk);
      process.stdout.write(chunk);
    });
  }
  const code = await new Promise((done) => child.on('close', (status) => done(status ?? 1)));
  log.write(
    `\nnightly full check:merge ${code === 0 ? 'PASSED' : `FAILED (exit ${code})`} in ${Math.round((Date.now() - started) / 1000)} s\n`,
  );
  await new Promise((done) => log.end(done));
  console.log(`log: ${file}`);
  process.exitCode = code;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) await main();
