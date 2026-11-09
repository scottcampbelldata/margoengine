import test from 'node:test';
import assert from 'node:assert/strict';
import { VFX } from '../dist/index.js';
import { VFX as Base } from '../dist/base.js';
import { MAX_PARTICLE_LIGHTS } from '../dist/shadows.js';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';

const attach = (options, features) => {
  const h = optionalGPU();
  h.engine.stats = { drawCalls: 0 };
  const effect = features ? new Base(options, features) : new VFX(options);
  h.engine.use(effect);
  return { h, effect };
};

const codeOf = (pipeline) => (pipeline.compute ?? pipeline.vertex).module.code;

test('shadows packs lights in slot order and draws sphere impostors, without patching the simulation', async () => {
  assert.equal(MAX_PARTICLE_LIGHTS, 64);
  let source;
  let added;
  let removed = false;
  const cast = {
    add(next, options) {
      source = next;
      added = options;
      return () => {
        removed = true;
      };
    },
  };
  const seen = [];
  const into = {
    setLights(lights) {
      seen.push(lights);
    },
  };
  const options = { capacity: 4, shadows: { cast, into, count: 2, range: 5, intensity: 3 } };
  const { h, effect } = attach(options);
  assert.equal(added.static, false);
  assert.equal(typeof source.drawShadow, 'function');
  assert.equal(effect.options.shadows.buffer.size, (1 + 64 * 2) * 16);
  h.frame();
  const params = h.resources.find((r) => r.size === 16 && new Uint32Array(r.data)[0] === 4);
  assert.deepEqual([...new Uint32Array(params.data).subarray(0, 2)], [4, 2]);
  assert.deepEqual([...new Float32Array(params.data).subarray(2, 4)], [5, 3]);
  effect.options.shadows.count = 1;
  effect.options.shadows.range = 6;
  h.frame();
  assert.deepEqual([...new Uint32Array(params.data).subarray(0, 2)], [4, 1]);
  assert.equal(new Float32Array(params.data)[2], 6);
  const codes = h.pipelines.map(codeOf);
  const simulation = codes.find((code) => code.includes('fn update('));
  assert.equal(simulation.includes('particleShadows'), false);
  assert.ok(codes.some((code) => code.includes('fn pack(') && code.includes('fn prefix(')));
  assert.ok(codes.some((code) => code.includes('@builtin(frag_depth)') && code.includes('sqrt(max(0.0,1.0-d))')));
  let drawn = 0;
  source.drawShadow({
    cascade: 0,
    matrix: new Float32Array(16),
    pass: {
      setPipeline() {},
      setBindGroup() {},
      draw(vertices, instances) {
        drawn += 1;
        assert.equal(vertices, 6);
        assert.equal(instances, 4);
      },
    },
  });
  assert.equal(drawn, 1);
  assert.equal(h.engine.stats.drawCalls > 0, true);
  await new Promise((resolve) => setTimeout(resolve, 0));
  h.frame();
  await new Promise((resolve) => setTimeout(resolve, 0));
  h.frame();
  assert.deepEqual(seen.at(-1), []);
  effect.options.shadows = { count: 1 };
  assert.throws(() => h.frame(), /fixed at attach/);
  effect.dispose();
  assert.equal(removed, true);
  assert.equal(source.disposed, true);
});

test('shadows rejects a missing feature and a bad count, range, intensity or target', () => {
  assert.throws(() => new Base({ shadows: {} }, {}), /needs shadows from @margoengine\/vfx\/shadows/);
  assert.throws(() => new VFX({ shadows: null }), TypeError);
  assert.throws(() => new VFX({ shadows: { count: 2.5 } }), RangeError);
  assert.throws(() => new VFX({ shadows: { count: 65 } }), RangeError);
  assert.throws(() => new VFX({ shadows: { count: -1 } }), RangeError);
  assert.throws(() => new VFX({ shadows: { range: 0 } }), RangeError);
  assert.throws(() => new VFX({ shadows: { intensity: -0.1 } }), RangeError);
  assert.throws(() => new VFX({ shadows: { cast: {} } }), TypeError);
  assert.throws(() => new VFX({ shadows: { into: {} } }), TypeError);
  const { h, effect } = attach({ capacity: 2 });
  h.frame();
  assert.equal(
    h.pipelines.map(codeOf).some((code) => code.includes('particleShadows')),
    false,
  );
  effect.dispose();
});
