// `npm run verify`: the checks that every change must pass, in two stages.
//   1. In order: the hygiene gate (seconds, fails first), then one build of every package.
//   2. Side by side, all reading that build: the API reports, the quality gate, the two sandbox builds each followed by
//      its tests, the unit tests, the size measurement and the proofs. None of them writes a file another one reads, so
//      the wall time is the longest of them instead of their sum. The first failure stops the rest and prints its output.
//   node scripts/verify.mjs --serial    one step at a time, in the order the steps are listed (to read one step's output)
// Every step always runs. Shadow mode (scripts/support/result-cache.mjs) records what each one read and reports what a
// result cache would have served; MARGO_RESULT_CACHE=off stops the recording.
// MARGOENGINE_PLANT_STALE=1 (set by check:merge) puts a stale file in two dist folders before the build; the tarball
// test later asserts that no pack contains it, which proves the build cleans dist.
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ResultStore, ShadowRun, servingRequested, shadowEnabled } from './support/result-cache.mjs';
import { reportSpeedPhase } from './support/speed-phase.mjs';

const root = resolve(import.meta.dirname, '..');

/** Puts a stale file in two dist folders; a build that cleans dist removes them, and no pack may contain one. */
export function plantStale(dir = root) {
  for (const name of ['core', 'react']) {
    mkdirSync(join(dir, `packages/${name}/dist`), { recursive: true });
    writeFileSync(
      join(dir, `packages/${name}/dist/__stale-package-test.js`),
      'throw new Error("Stale build artifact");',
    );
  }
}

/** Stage 1: in order. */
export const SERIAL = [
  'node scripts/hygiene.js --verify',
  'node scripts/check-gpu-policy.mjs',
  'node scripts/support/external-test-assets.mjs',
  'npm run build:packages',
];

/** Half the machine's threads for the unit tests (the no-burn rule), at least the 4 they always had and at most 8. */
export const TEST_CONCURRENCY = Math.min(8, Math.max(4, availableParallelism() >> 1));

/**
 * Limit of one unit test. The longest measured was 32 s on 2026-11-06, in a step that takes 166 to 380 s by load, so this
 * leaves room for a machine five times busier and still names a hang well inside a gate's limit for the step. A hang the
 * test's own process cannot report is named by scripts/support/test-watch.mjs.
 */
export const TEST_TIMEOUT_MS = 300_000;

/** Stage 2: each entry is a chain of commands run one after another; the chains run side by side. */
export const PARALLEL = [
  ['npm run api:check'],
  ['npm run quality'],
  ['npm run check:parity'],
  ['npm run check:xr-runs'],
  ['npm run build --workspace examples/gameplay-sandbox', 'npm run test --workspace examples/gameplay-sandbox'],
  ['npm run build --workspace examples/voxel-sandbox', 'npm run test --workspace examples/voxel-sandbox'],
  [
    `node --experimental-test-module-mocks --test --test-concurrency=${TEST_CONCURRENCY} --test-timeout=${TEST_TIMEOUT_MS} --test-reporter=spec --test-reporter-destination=stdout --test-reporter=./scripts/support/test-watch.mjs --test-reporter-destination=stderr tests/*.test.js packages/*/tests/*.test.js packages/*/test/*.test.js`,
  ],
  ['npm run docs:links'],
  ['npm run check:readmes'],
  ['npm run measure:size'],
  ['npm run proofs -- --current'],
];

/**
 * Environment for one verify step. `FORCE_COLOR` is forced off: Node colors `console.log` of a number or a
 * boolean when it is set, and tests read that text. An agent shell sets it, so a step must not inherit it.
 */
export function commandEnv(base = process.env) {
  return { ...base, NO_COLOR: '1', FORCE_COLOR: '0' };
}

/** What a command is to the result cache: the steps with their own keys. The hygiene gate is seconds and stays out. */
export function cacheKind(command) {
  if (command === 'npm run build:packages') return 'builds';
  if (command.includes(' --test ') && command.includes('tests/*.test.js')) return 'tests';
  return PARALLEL.flat().includes(command) ? 'step' : undefined;
}

/** Records one finished step and prints what the store would have done with it. */
function settle(shadow, { command, code, seconds, recordDir }) {
  if (!shadow || !recordDir) return;
  const kind = cacheKind(command),
    rows = shadow.finish(command, recordDir, { kind, code, seconds });
  if (kind !== 'step') {
    const hits = rows.filter((row) => row.cache.wouldHit).length;
    console.log(`  cache: ${command.slice(0, 40)}: ${hits} of ${rows.length} would hit`);
    return;
  }
  const { from } = rows[0].cache;
  if (from) console.log(`  WOULD BE CACHED from ${from.commit} ${from.date}: ${command}`);
}

const rounded = (since) => Math.round((performance.now() - since) / 100) / 10;

/** Ends a command and everything it started (a shell command is a tree of processes). */
function kill(child) {
  if (child.exitCode !== null || child.pid === undefined) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  else child.kill('SIGKILL');
}

async function main() {
  reportSpeedPhase('verify');
  const serial = process.argv.includes('--serial'),
    started = performance.now(),
    times = [];
  const shadow = shadowEnabled() ? new ShadowRun({ root, store: new ResultStore() }) : undefined;
  if (shadow && servingRequested())
    console.log(
      'MARGO_RESULT_CACHE_SERVE=1: serving is not built yet (phase 1 is shadow only); every step still runs.',
    );
  const run = (command) =>
    new Promise((done) => {
      const recorded = shadow && cacheKind(command) ? shadow.stepEnv(cacheKind(command) === 'tests') : undefined,
        since = performance.now(),
        chunks = [],
        child = spawn(command, {
          cwd: root,
          shell: true,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: commandEnv(recorded ? recorded.env : process.env),
        });
      const finish = (code) => {
        const output = Buffer.concat(chunks).toString();
        done({ command, code, output, seconds: rounded(since), child, recordDir: recorded?.dir });
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
    if (command === 'npm run build:packages' && process.env.MARGOENGINE_PLANT_STALE === '1') plantStale();
    console.log(`\n=== ${command}`);
    const result = await run(command);
    times.push([command, result.seconds]);
    settle(shadow, result);
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
        // A step ended by another step's failure has no result to record.
        if (failed) return;
        settle(shadow, result);
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
  if (shadow) {
    const summary = shadow.report();
    console.log(
      `\nresult cache (shadow, nothing skipped): ${summary.wouldHit} of ${summary.steps} would hit, about ${summary.wouldSaveSeconds} s of work; ${summary.uncacheable} uncacheable; ${summary.disagreements} disagreements (test-results/cache/shadow-report.json)`,
    );
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) await main();
