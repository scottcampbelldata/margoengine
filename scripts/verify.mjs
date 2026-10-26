// `npm run verify`: the checks that every change must pass, in two stages.
//   1. In order: the hygiene gate (seconds, fails first), then one build of every package.
//   2. Side by side, all reading that build: the API reports, the quality gate, the two sandbox builds each followed by
//      its tests, the unit tests, the size measurement and the proofs. None of them writes a file another one reads, so
//      the wall time is the longest of them instead of their sum. The first failure stops the rest and prints its output.
//   node scripts/verify.mjs --serial    one step at a time, in the order the steps are listed (to read one step's output)
// MARGOENGINE_PLANT_STALE=1 (set by check:merge) puts a stale file in two dist folders before the build; the tarball
// test later asserts that no pack contains it, which proves the build cleans dist.
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve(import.meta.dirname, '..');

/** Stage 1: in order. */
export const SERIAL = ['node scripts/hygiene.js --verify', 'npm run build:packages'];

/** Half the machine's threads for the unit tests (the no-burn rule), at least the 4 they always had and at most 8. */
export const TEST_CONCURRENCY = Math.min(8, Math.max(4, availableParallelism() >> 1));

/** Stage 2: each entry is a chain of commands run one after another; the chains run side by side. */
export const PARALLEL = [
  ['npm run api:check'],
  ['npm run quality'],
  ['npm run check:parity'],
  ['npm run build --workspace examples/gameplay-sandbox', 'npm run test --workspace examples/gameplay-sandbox'],
  ['npm run build --workspace examples/voxel-sandbox', 'npm run test --workspace examples/voxel-sandbox'],
  [
    `node --experimental-test-module-mocks --test --test-concurrency=${TEST_CONCURRENCY} tests/*.test.js packages/*/tests/*.test.js packages/*/test/*.test.js`,
  ],
  ['npm run measure:size'],
  ['npm run proofs -- --current'],
];

const rounded = (since) => Math.round((performance.now() - since) / 100) / 10;

/** Ends a command and everything it started (a shell command is a tree of processes). */
function kill(child) {
  if (child.exitCode !== null || child.pid === undefined) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  else child.kill('SIGKILL');
}

async function main() {
  const serial = process.argv.includes('--serial'),
    started = performance.now(),
    times = [];
  const run = (command) =>
    new Promise((done) => {
      const since = performance.now(),
        chunks = [],
        child = spawn(command, { cwd: root, shell: true, stdio: ['ignore', 'pipe', 'pipe'] });
      const finish = (code) => {
        const output = Buffer.concat(chunks).toString();
        done({ command, code, output, seconds: rounded(since), child });
      };
      for (const stream of [child.stdout, child.stderr])
        stream.on('data', (chunk) => {
          chunks.push(chunk);
          if (stage === 1) process.stdout.write(chunk);
        });
      child.on('error', () => finish(-1));
      child.on('close', (code) => finish(code ?? 1));
      running.add(child);
    });
  const running = new Set();
  let stage = 1,
    failed;
  for (const command of SERIAL) {
    if (command === 'npm run build:packages' && process.env.MARGOENGINE_PLANT_STALE === '1')
      for (const name of ['core', 'react']) {
        mkdirSync(join(root, `packages/${name}/dist`), { recursive: true });
        writeFileSync(
          join(root, `packages/${name}/dist/__stale-package-test.js`),
          'throw new Error("Stale build artifact");',
        );
      }
    console.log(`\n=== ${command}`);
    const result = await run(command);
    times.push([command, result.seconds]);
    if (result.code !== 0) {
      console.log(`\nverify FAILED at ${command} (${rounded(started)} s)`);
      process.exitCode = 1;
      return;
    }
  }
  stage = 2;
  const chains = serial ? [PARALLEL.flat()] : PARALLEL;
  console.log(`\n=== ${serial ? 'one at a time' : `${chains.length} chains side by side`}`);
  await Promise.all(
    chains.map(async (chain) => {
      for (const command of chain) {
        if (failed) return;
        console.log(`  start: ${command}`);
        const result = await run(command),
          { code, output, seconds } = result;
        running.delete(result.child);
        times.push([command, seconds]);
        if (failed) return;
        console.log(`\n--- ${code === 0 ? 'passed' : 'FAILED'}: ${command} (${seconds} s)\n${output.trimEnd()}`);
        if (code !== 0) {
          failed = command;
          for (const child of running) kill(child);
          return;
        }
      }
    }),
  );
  console.log(
    `\nverify ${failed ? `FAILED at ${failed}` : 'PASSED'} in ${rounded(started)} s\n${times.map(([c, s]) => `  ${String(s).padStart(6)} s  ${c}`).join('\n')}`,
  );
  if (failed) process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) await main();
