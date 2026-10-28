// The nightly full GPU run: `npm run check:merge:full` (every GPU step, no narrowing) under the GPU lock, then the
// pinned proofs (`npm run proofs`, every claim against its claim commit, timed rounds included), with a dated log in
// test-results/nightly/<YYYY-MM-DD>T<HHMM>.log (output of each run, then a one-line result). Exit code = the first
// failing run's. The pinned proofs run here, on a quiet machine, and not in every landing: about 40 of them time the
// claim's speed-up in interleaved rounds, several with a margin near 5 % (loaders, bvh, creative), which a busy
// landing machine can erase. Only --current ran in any check before, so nine pinned proofs failed for days unnoticed
// (bug 6). It registers nothing with the OS; schedule it with whatever runs jobs on this PC:
//   node scripts/nightly-full.mjs
// Run it from a checkout at the commit to test (the main checkout, after `git pull --ff-only`). Takes the GPU lock exclusively (it
// includes timed steps) for the whole run (the steps inside nest under it), so landing runs wait their turn.
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

async function main() {
  const dir = join(root, 'test-results/nightly');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${stamp()}.log`),
    log = createWriteStream(file);
  let code = 0;
  for (const [label, [command, args]] of [
    ['full check:merge', nightlyCommand()],
    ['pinned proofs', pinnedProofsCommand()],
  ]) {
    const started = Date.now();
    log.write(`nightly ${label}, started ${new Date(started).toISOString()}, cwd ${root}\n`);
    const child = spawn(command, args, {
      cwd: root,
      // MARGO_NIGHTLY: tests with a nightly depth (the biomes rank envelopes of 2,499 simulations) run it.
      env: { ...process.env, MARGO_FULL: '1', MARGO_NIGHTLY: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    for (const stream of [child.stdout, child.stderr]) {
      stream.on('data', (chunk) => {
        log.write(chunk);
        process.stdout.write(chunk);
      });
    }
    const status = await new Promise((done) => child.on('close', (value) => done(value ?? 1)));
    log.write(
      `\nnightly ${label} ${status === 0 ? 'PASSED' : `FAILED (exit ${status})`} in ${Math.round((Date.now() - started) / 1000)} s\n`,
    );
    code ||= status;
  }
  await new Promise((done) => log.end(done));
  console.log(`log: ${file}`);
  process.exitCode = code;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) await main();
