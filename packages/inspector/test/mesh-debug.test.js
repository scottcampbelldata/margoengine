import assert from 'node:assert/strict';
import test from 'node:test';
import { MeshDebugView } from '../dist/mesh-debug.js';

test('zero configuration shows a wireframe over the picture; data modes replace it unless multiply says otherwise', () => {
  const view = new MeshDebugView();
  const { mode, multiply, meshes, enabled, wireWidth, vertexRadius, uvScale, specularPower } = view.options;
  assert.deepEqual(
    { mode, multiply, meshes, enabled, wireWidth, vertexRadius, uvScale, specularPower },
    {
      mode: 'wireframe',
      multiply: true,
      meshes: null,
      enabled: true,
      wireWidth: 1,
      vertexRadius: 3,
      uvScale: 10,
      specularPower: 32,
    },
  );
  assert.ok(Object.isFrozen(view.options));
  for (const [name, expected] of [
    ['shaded', false],
    ['wireframe', true],
    ['vertices', true],
    ['wireframe-vertices', true],
    ['uv0', false],
    ['uv1', false],
    ['vertex-colors', false],
    ['material-ids', false],
  ])
    assert.equal(view.set({ mode: name }).options.multiply, expected, name);
  view.set({ multiply: true });
  assert.equal(view.set({ mode: 'uv0' }).options.multiply, true, 'a chosen value outlives a mode change');
  assert.equal(view.set({ multiply: undefined }).options.multiply, true, 'undefined keeps it');
  assert.equal(view.set({ multiply: null }).options.multiply, false, 'null gives the mode back its default');
});

test('set keeps omitted values and copies the mesh list', () => {
  const list = [{ id: 1 }];
  const view = new MeshDebugView({ meshes: new Set(list), uvScale: 4 });
  view.set({ wireWidth: 0, vertexRadius: 64, wireColor: [0, 0.5, 1], uvColors: ['#000', '#fff'] });
  assert.equal(view.options.uvScale, 4);
  assert.deepEqual(view.options.meshes, list);
  assert.notEqual(view.options.meshes, list);
  assert.equal(view.set({ meshes: null }).options.meshes, null);
});

test('invalid options throw coded errors with a help link and change nothing', () => {
  const view = new MeshDebugView({ mode: 'uv0' });
  const before = view.options;
  for (const [options, type] of [
    [null, TypeError],
    [{ wires: true }, TypeError],
    [{ mode: 'normals' }, TypeError],
    [{ multiply: 1 }, TypeError],
    [{ enabled: 'yes' }, TypeError],
    [{ meshes: 3 }, TypeError],
    [{ meshes: [null] }, TypeError],
    [{ wireColor: 'red' }, TypeError],
    [{ vertexColor: [0, 0, 2] }, TypeError],
    [{ diffuseColor: [0, 0] }, TypeError],
    [{ specularColor: [0, Number.NaN, 0] }, TypeError],
    [{ uvColors: ['#000'] }, TypeError],
    [{ materialColors: '#000' }, TypeError],
    [{ materialColors: Array(4097).fill('#000') }, TypeError],
    [{ wireWidth: -1 }, RangeError],
    [{ wireWidth: 65 }, RangeError],
    [{ vertexRadius: Number.NaN }, RangeError],
    [{ uvScale: 0 }, RangeError],
    [{ uvScale: 5000 }, RangeError],
    [{ specularPower: 0 }, RangeError],
    // A valid value beside an invalid one: neither applies.
    [{ mode: 'shaded', uvScale: -1 }, RangeError],
  ])
    assert.throws(
      () => view.set(options),
      (error) => error instanceof type && error.message.includes('https://margoengine.com/errors#mesh-debug-view'),
      JSON.stringify(options),
    );
  assert.equal(view.options, before);
});

test('it needs a GPU with vertex-stage storage buffers, and refuses use after disposal', () => {
  const view = new MeshDebugView();
  const code = (expected) => (error) => error.code === expected;
  assert.throws(() => view.setup({ gpu: null }), code('unsupported'));
  assert.throws(() => view.setup({ gpu: { limits: { maxStorageBuffersInVertexStage: 0 } } }), code('unsupported'));
  view.dispose();
  view.dispose();
  assert.throws(() => view.set({ mode: 'uv0' }), code('disposed'));
  assert.throws(() => view.setup({ gpu: { limits: {} } }), code('disposed'));
});
