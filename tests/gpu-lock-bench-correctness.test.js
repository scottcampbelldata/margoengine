// KB-L3b-bench: gpu-lock counted every script under a *-benchmarks/ folder as a speed measurement, so the correctness
// checks kept there (post-effects-gpu.mjs, volumetric-gpu.mjs --no-timing) were refused for the whole build phase.
// A script now declares itself a correctness check in its header; timing runs stay exclusive and stay refused while
// scripts/speed-phase.json defers them. Fake lock folders only; the children never touch a GPU.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import test from 'node:test';
import { declaredCorrectness, measuresSpeed } from '../scripts/gpu-lock.mjs';

const bench = 'examples/package-benchmarks';

function fixtures(t) {
  mkdirSync('test-results', { recursive: true });
  const folder = mkdtempSync(resolve('test-results/gpu-lock-bench-'));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const dir = join(folder, 'fake-benchmarks');
  mkdirSync(dir);
  const write = (name, header) => {
    const file = join(dir, name);
    writeFileSync(file, `${header}\r\nconsole.log('child ran ${name}');\r\n`);
    return relative(process.cwd(), file);
  };
  return {
    folder,
    correct: write('correct.mjs', '// A correctness check.\r\n// gpu-lock: correctness'),
    optional: write('optional.mjs', '// Times unless told not to.\r\n// gpu-lock: correctness with --no-timing'),
    timing: write('timing.mjs', '// Measures frame time.'),
    late: write('late.mjs', `${'// filler\r\n'.repeat(40)}// gpu-lock: correctness`),
    inline: write('inline.mjs', 'const note = "// gpu-lock: correctness";'),
  };
}

test('the repository scripts declare what they are', () => {
  assert.equal(declaredCorrectness(`${bench}/post-effects-gpu.mjs`), 'always');
  for (const name of ['volumetric-gpu.mjs', 'ssr-gpu.mjs', 'ssr-models-gpu.mjs'])
    assert.equal(declaredCorrectness(`${bench}/${name}`), 'no-timing', name);
  assert.equal(declaredCorrectness(`${bench}/vfx-gpu.mjs`), undefined);
  assert.equal(declaredCorrectness(`${bench}/no-such-script.mjs`), undefined);
});

test('correctness scripts under a benchmarks folder are not speed work; timing runs still are', (t) => {
  const f = fixtures(t);
  const yes = [
    ['node', `${bench}/vfx-gpu.mjs`],
    ['node', `${bench}/vfx-gpu.mjs`, '--no-timing'],
    ['node', `${bench}/volumetric-gpu.mjs`],
    ['node', `${bench}/ssr-gpu.mjs`, '--rounds=3'],
    ['node', `${bench}/no-such-script.mjs`],
    ['node', f.timing],
    ['node', f.timing, '--no-timing'],
    ['node', f.optional],
    ['node', f.late],
    ['node', f.inline],
    ['npm', 'run', 'bench:render'],
    ['node', 'bench/cli.mjs', 'render', '--no-timing'],
  ];
  const no = [
    ['node', `${bench}/post-effects-gpu.mjs`, '--only=flare'],
    ['node', `${bench}/volumetric-gpu.mjs`, '--no-timing'],
    ['node', `${bench}/ssr-models-gpu.mjs`, '--no-timing'],
    ['node', f.correct],
    ['node', f.optional, '--no-timing'],
  ];
  for (const words of yes) assert.equal(measuresSpeed(words, ''), true, words.join(' '));
  for (const words of no) assert.equal(measuresSpeed(words, ''), false, words.join(' '));
  assert.equal(measuresSpeed(['node', f.correct], 'bench:post'), true, 'run from a bench* npm script');
});

test('in the deferred build phase gpu-lock runs a correctness script and refuses a timing one', {
  timeout: 60_000,
}, (t) => {
  const f = fixtures(t);
  const lock = join(f.folder, 'gpu.lock');
  const env = { ...process.env, MARGO_SPEED_PHASE: 'deferred', MARGO_GPU_LOCK: lock, npm_lifecycle_event: '' };
  for (const key of Object.keys(env)) if (key.startsWith('MARGO_GPU_') && key !== 'MARGO_GPU_LOCK') delete env[key];
  const run = (...command) =>
    spawnSync(
      process.execPath,
      [
        'scripts/gpu-lock.mjs',
        'run',
        '--owner=bench-class-test',
        '--gpu=fake check',
        '--max=1',
        '--',
        process.execPath,
        ...command,
      ],
      { env, encoding: 'utf8', timeout: 30_000, windowsHide: true },
    );
  for (const command of [[f.correct], [f.optional, '--no-timing']]) {
    const result = run(...command);
    assert.equal(result.status, 0, `${command.join(' ')}\n${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /child ran/);
  }
  for (const command of [[f.timing], [f.optional]]) {
    const result = run(...command);
    assert.notEqual(result.status, 0, `${command.join(' ')} measures speed and must be refused`);
    assert.match(result.stderr, /ERR_SPEED_PHASE_DEFERRED/);
    assert.doesNotMatch(result.stdout, /child ran/);
  }
});
