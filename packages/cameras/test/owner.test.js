// A disposed CameraProjection leaves the scene it was attached to (integration J1, docs/integration-fixtures.md).
import assert from 'node:assert/strict';
import test from 'node:test';
import { Engine, TransformStore } from '../../core/dist/extension.js';
import { CameraProjection } from '../dist/index.js';
import { mockGPU } from '../../../examples/package-benchmarks/proofs/gpu-recorder.js';

const engine = async () =>
  new Engine({ width: 64, height: 64 }, await TransformStore.create(64), {
    backend: 'webgpu',
    gpu: mockGPU().device,
    add() {},
    remove() {},
    render() {},
    dispose() {},
  });

test('dispose() detaches the projection from its scene, so a new one attaches under the same name', async () => {
  const e = await engine();
  try {
    const scene = e.createScene('cameras');
    let others = 0;
    e.use({ name: 'cameras', setup() {}, dispose: () => others++ });
    const projection = new CameraProjection({ mode: 'orthographic', height: 10 });
    scene.use(projection);
    assert.equal(typeof e.camera.project, 'function');
    projection.dispose();
    assert.equal(e.camera.project, undefined, 'the camera has its own projection back');
    assert.equal(scene.plugins.has('cameras'), false, 'a disposed projection must leave its scene');
    assert.equal(others, 0, 'the same name in the default scene stays attached');
    const next = new CameraProjection({ mode: 'perspective' });
    scene.use(next);
    assert.equal(scene.plugins.get('cameras'), next);
    scene.removePlugin('cameras');
    assert.equal(e.camera.project, undefined);
    projection.dispose();
  } finally {
    e.dispose();
  }
});

test('a projection attached to a bare camera disposes without an engine', () => {
  const projection = new CameraProjection({ mode: 'orthographic', height: 4 });
  const camera = { up: [0, 1, 0], fov: 60, position: [0, 0, 5], target: [0, 0, 0] };
  projection.attach(camera);
  assert.equal(typeof camera.project, 'function');
  projection.dispose();
  assert.equal(camera.project, undefined);
});
