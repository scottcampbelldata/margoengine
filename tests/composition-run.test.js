import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { C2 } from '../scripts/support/composition-contracts.mjs';
import {
  COMPAT_VULKAN_MEMBERS,
  SCENE_LIMIT_MS,
  compatArgs,
  groupRows,
  runScene,
} from '../scripts/support/composition-run.mjs';

const never = () => new Promise(() => {});

// Regression (c2-003, 2026-11-10): a scene whose page never answered held the GPU for 195.7 s until the lease monitor
// reclaimed it, with no row named. It must now fail at its own limit with a coded error naming the scene.
test('a scene that never returns fails with ERR_COMPOSITION_STALL naming it and the page state', async () => {
  await assert.rejects(
    runScene(never, { label: 'c2-003 webgl2-compat 1x', limitMs: 20, probe: () => 'pipelines {"pending":2}' }),
    (error) =>
      error.code === 'ERR_COMPOSITION_STALL' &&
      error.message.includes('c2-003 webgl2-compat 1x') &&
      error.message.includes('pipelines {"pending":2}'),
  );
});

test('a page blocked in a native call still fails: the probe is bounded too', async () => {
  await assert.rejects(
    runScene(never, { label: 'blocked', limitMs: 20, probe: never, probeMs: 20 }),
    (error) => error.code === 'ERR_COMPOSITION_STALL' && error.message.includes('did not answer'),
  );
  await assert.rejects(
    runScene(never, {
      label: 'probe error',
      limitMs: 20,
      probe: () => {
        throw new Error('page closed');
      },
    }),
    (error) => error.code === 'ERR_COMPOSITION_STALL' && error.message.includes('page closed'),
  );
});

test('a scene that settles keeps its own result or error', async () => {
  assert.deepEqual(await runScene(async () => ({ errors: [] }), { label: 'ok', limitMs: 1000 }), { errors: [] });
  await assert.rejects(
    runScene(
      async () => {
        throw new Error('probe 0 channel 1');
      },
      { label: 'fails', limitMs: 1000 },
    ),
    /probe 0 channel 1/,
  );
});

test('the scene limit ends before the GPU lease reclaims an idle run', () => {
  // scripts/gpu-lock.mjs: MARGO_GPU_IDLE_MIN defaults to 3 minutes.
  assert.ok(SCENE_LIMIT_MS < 3 * 60_000);
});

test('compatibility rows with the path tracer use ANGLE Vulkan on Windows only', () => {
  const tracer = ['post', 'toon', 'transitions', 'scenery', 'voxel-pathtracer'];
  assert.deepEqual(compatArgs(tracer, 'win32'), ['--use-angle=vulkan']);
  assert.deepEqual(compatArgs(tracer, 'linux'), []);
  assert.deepEqual(compatArgs(tracer, 'darwin'), []);
  assert.deepEqual(compatArgs(['post', 'toon', 'transitions', 'scenery'], 'win32'), []);
  for (const member of COMPAT_VULKAN_MEMBERS.keys()) assert.ok(C2.includes(member), `${member} is not a C2 member`);
});

test('rows group by their browser arguments in first-seen order', () => {
  const rows = [
    { id: 'a', members: ['post'] },
    { id: 'b', members: ['voxel-pathtracer'] },
    { id: 'c', members: ['toon'] },
  ];
  assert.deepEqual(
    groupRows(rows, (row) => compatArgs(row.members, 'win32')).map((g) => [g.args, g.rows.map((r) => r.id)]),
    [
      [[], ['a', 'c']],
      [['--use-angle=vulkan'], ['b']],
    ],
  );
});

test('the browser runner bounds every scene and picks each row backend', () => {
  const runner = readFileSync(new URL('../scripts/composition-browser-tests.mjs', import.meta.url), 'utf8');
  assert.match(runner, /runScene\(\(\) => page\.evaluate\(/);
  assert.match(runner, /groupRows\(rows, \(row\) => compatArgs\(row\.members\)\)/);
  assert.doesNotMatch(runner, /await browser\.page\.evaluate\(\(samples\) => window\.composition\.run/);
});
