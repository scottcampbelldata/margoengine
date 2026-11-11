// An async attach belongs to the scene that was active when it was called, and a blend leaves its scene on dispose.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Environment } from '../dist/index.js';
import { EnvironmentBlend } from '../dist/blend.js';
import { Engine, TransformStore } from '../../core/dist/extension.js';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';

const image = () => ({ width: 16, height: 8, data: new Float32Array(16 * 8 * 4).fill(0.5) });
async function setup(t) {
  const gpu = optionalGPU();
  globalThis.GPUShaderStage ??= { VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 };
  const pass = new Proxy({}, { get: () => () => {} });
  Object.assign(gpu.engine.gpu, {
    pushErrorScope() {},
    popErrorScope: async () => null,
    createCommandEncoder: () => new Proxy({ finish: () => ({}) }, { get: (o, k) => o[k] ?? (() => pass) }),
  });
  const engine = new Engine(
    { width: 8, height: 8, clientWidth: 8, clientHeight: 8 },
    await TransformStore.create(16),
    { backend: 'webgpu', gpu: gpu.engine.gpu, add() {}, remove() {}, render() {}, dispose() {} },
    undefined,
    null,
  );
  t.after(() => { engine.dispose(); gpu.cleanup(); });
  return engine;
}

test('Environment.attach installs into the scene active at the call, not the one active when it finishes', async (t) => {
  const engine = await setup(t), other = engine.createScene('other'), first = engine.scene;
  let pending;
  other.use({ name: 'probe', setup() { pending = Environment.attach(engine, image(), { size: 16 }); } });
  const environment = await pending;
  assert.equal(engine.sceneOf(environment), other);
  assert.equal(first.plugins.has(environment.name), false);
  environment.dispose();
  assert.equal(other.plugins.has(environment.name), false);
});

test('EnvironmentBlend.attach installs into the scene active at the call, and dispose leaves that scene', async (t) => {
  const engine = await setup(t), other = engine.createScene('other'),
    from = await Environment.create(engine, image(), { size: 16 }), to = await Environment.create(engine, image(), { size: 16 });
  let pending;
  other.use({ name: 'probe', setup() { pending = EnvironmentBlend.attach(engine, from, to); } });
  const blend = await pending;
  assert.equal(engine.sceneOf(blend), other);
  blend.dispose();
  assert.equal(other.plugins.has(blend.name), false);
  from.dispose();
  to.dispose();
});
