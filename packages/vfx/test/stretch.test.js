import test from 'node:test';
import assert from 'node:assert/strict';
import { VFX } from '../dist/index.js';
import { VFX as Base } from '../dist/base.js';
import { stretch } from '../dist/stretch.js';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';

const attach = (options, features) => {
  const h = optionalGPU();
  h.engine.stats = { drawCalls: 0 };
  const effect = features ? new Base(options, features) : new VFX(options);
  h.engine.use(effect);
  return { h, effect };
};

test('stretch writes its factor every frame, 0 once removed, and patches the billboard and the cull sphere', () => {
  const { h, effect } = attach({ capacity: 8, initialCount: 8, stretch: { factor: 0.2 } }, { stretch });
  h.frame();
  const uniform = h.resources.find((r) => r.size === 16 && new Float32Array(r.data)[0] !== 0 && !r.destroyed);
  assert.ok(uniform, 'the stretch uniform');
  assert.equal(+new Float32Array(uniform.data)[0].toFixed(6), 0.2);
  effect.options.stretch.factor = 1;
  h.frame();
  assert.equal(new Float32Array(uniform.data)[0], 1);
  delete effect.options.stretch;
  h.frame();
  assert.equal(new Float32Array(uniform.data)[0], 0, 'removed: no stretch');
  const code = h.pipelines.map((p) => (p.compute ?? p.vertex).module.code).join('\n');
  assert.ok(
    code.includes('var<uniform> stretch:Stretch') && code.includes('stretch.shape.x*length(p.velocitySize.xyz)'),
  );
  assert.ok(code.includes('let r=(p.velocitySize.w+stretch.shape.x*length(p.velocitySize.xyz))*1.01;'), 'cull sphere');
  effect.dispose();
  assert.ok(h.resources.every((r) => r.destroyed));
});

test('stretch is validated; effects without it compile no stretch code', () => {
  assert.throws(() => new Base({ stretch: {} }, {}), /needs stretch from @margoengine\/vfx\/stretch/);
  assert.throws(() => new VFX({ stretch: null }), TypeError);
  assert.throws(() => new VFX({ stretch: { factor: -1 } }), RangeError);
  assert.throws(() => new VFX({ stretch: { factor: 11 } }), RangeError);
  const { h, effect } = attach({ capacity: 8, initialCount: 8 });
  h.frame();
  assert.ok(!h.pipelines.some((p) => (p.compute ?? p.vertex).module.code.includes('stretch')));
  effect.dispose();
});
