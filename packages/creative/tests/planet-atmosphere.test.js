import test from 'node:test';
import assert from 'node:assert/strict';
import { OrbitAtmosphere } from '../dist/planet-atmosphere.js';
import { tracedGPU } from '../../../tests/support/gpu-trace.js';

test('orbit atmosphere validates frame, attachment and disposal', () => {
  for (const o of [
    { radius: 0 },
    { radius: Infinity },
    { sun: [0, 0, 0] },
    { center: [NaN, 0, 0] },
    { center: [1, 2] },
  ])
    assert.throws(() => new OrbitAtmosphere(o), RangeError);
  const effect = new OrbitAtmosphere();
  assert.throws(
    () => effect.setup({}),
    (e) => e.code === 'unsupported',
  );
  effect.dispose();
  effect.dispose();
  assert.throws(
    () => effect.setup({}),
    (e) => e.code === 'disposed',
  );
});
test('orbit planet uses shared physical tables, updates sun without redoing the medium, restores and detaches', () => {
  globalThis.GPUShaderStage = { VERTEX: 1, FRAGMENT: 2 };
  const h = tracedGPU(),
    engine = h.engine;
  engine.gpu.createPipelineLayout = (d) => d;
  engine.sceneOf = () => ({ removePlugin() {} });
  const effect = new OrbitAtmosphere({ radius: 2, center: [1, 0, 0] });
  effect.setup(engine);
  assert.throws(
    () => effect.setup(engine),
    (e) => e.code === 'attached',
  );
  const passes = [];
  effect.registerPasses({ add: (p) => passes.push(p) });
  const c = h.context;
  c.camera = { matrix: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]), position: [1, 0, 3] };
  c.descriptor = { depthStencil: { format: 'depth32float' }, multisample: { count: 1 } };
  passes[0].execute(c);
  const compute = h.commands().filter((x) => x.startsWith('dispatch')).length;
  effect.options.sun = [0, 1, 0];
  passes[0].execute(c);
  assert.equal(h.commands().filter((x) => x.startsWith('dispatch')).length, compute);
  assert.ok(compute > 0);
  effect.enabled = false;
  const count = h.commands().length;
  passes[0].execute(c);
  assert.equal(h.commands().length, count);
  effect.enabled = true;
  effect.options.radius = -1;
  assert.throws(() => passes[0].execute(c), RangeError);
  effect.options.radius = 2;
  effect.onDeviceRestored(engine);
  passes[0].execute(c);
  effect.dispose();
  assert.throws(
    () => passes[0].execute(c),
    (e) => e.code === 'disposed',
  );
});
