import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../packages/core/dist/engine.js';
import { TransformStore } from '../packages/core/dist/kernel.js';
import { FrameGraph } from '../packages/core/dist/extension.js';
import { box } from '../packages/core/dist/geometry.js';

// docs/conventions.md, Errors: core and the stage throw MargoError with a stable code (or TypeError / RangeError),
// and every message links to its entry on margoengine.com/errors (tests/errors-page.test.js checks the links).
const coded =
  (code, prefix, anchor = code) =>
  (error) =>
    error.name === 'MargoError' &&
    error.code === code &&
    error.message === `${prefix}; see https://margoengine.com/errors#${anchor}`;

async function engine(backend = 'webgpu') {
  const renderer = { backend, add() {}, remove() {}, dispose() {}, render() {}, pick: async () => -1 };
  const canvas = { width: 8, height: 8, clientWidth: 8, clientHeight: 8 };
  return new Engine(canvas, await TransformStore.create(4), renderer, undefined, null);
}

test('pick and rebootDevice on the WebGL2 fallback reject with code unsupported', async () => {
  const e = await engine('webgl2');
  try {
    await assert.rejects(e.pick(1, 1), coded('unsupported', 'WebGPU required', 'webgpu'));
    await assert.rejects(e.rebootDevice(), coded('unsupported', 'WebGPU required', 'webgpu'));
  } finally {
    e.dispose();
  }
});

test('disposed engines, meshes and transforms throw code disposed', async () => {
  const e = await engine(),
    mesh = e.createMesh().setGeometry(box());
  mesh.dispose();
  assert.throws(() => mesh.setPosition([0, 0, 0]), coded('disposed', 'Mesh disposed'));
  e.dispose();
  assert.throws(() => e.createMesh(), coded('disposed', 'Engine disposed'));
  await assert.rejects(e.rebootDevice(), coded('disposed', 'Engine disposed'));
  await assert.rejects(e.pick(1, 1), coded('disposed', 'Engine disposed'));
  const store = await TransformStore.create(1);
  store.dispose();
  assert.throws(() => store.tick(), coded('disposed', 'Transforms disposed'));
});

test('re-entrant frame graph calls throw code state', () => {
  const graph = new FrameGraph(),
    errors = [];
  graph.add({
    name: 'outer',
    order: 0,
    execute(context) {
      for (const call of [() => graph.add({ name: 'late', order: 1, execute() {} }), () => graph.execute(context)])
        try {
          call();
        } catch (error) {
          errors.push(error);
        }
    },
  });
  graph.execute({ draw() {} });
  assert.ok(coded('state', 'Graph executing', 'reentrancy')(errors[0]), String(errors[0]));
  assert.ok(coded('state', 'Graph recursion', 'reentrancy')(errors[1]), String(errors[1]));
});
