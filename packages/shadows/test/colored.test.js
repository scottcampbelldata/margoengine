// Coloured shadows: options, the off path's shader text, the tint draws. The pixels are colored-browser.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Shadows } from '../dist/index.js';
import { shadowSampling } from '../src/shader.ts';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';

test('colored off keeps the sampling text; on adds the tint bindings and multiplies', () => {
  for (const filter of ['soft', 'pcf', 'hard']) {
    const off = shadowSampling(1, filter),
      on = shadowSampling(1, filter, false, true);
    assert.equal(off, shadowSampling(1, filter, false, false));
    assert.ok(!off.includes('shadowTint'), 'no trace of the tint map when off');
    for (const binding of [27, 28, 29]) assert.ok(on.includes(`@group(1) @binding(${binding})`));
    assert.ok(on.includes('shadowVisibility(position,normal)*shadowTint(position,normal)'));
  }
});

test('a tint needs colored maps and a valid colour, and a drawShadow source cannot tint', () => {
  const h = optionalGPU(),
    engine = h.engine;
  engine.gpu.limits.maxTextureDimension2D = 8192;
  engine.gpu.limits.maxTextureArrayLayers = 256;
  engine.lighting = { direction: new Float32Array([1, 2, 3, 3]) };
  const plain = new Shadows({ resolution: 64 }),
    source = { shadowPrimitives: [] };
  assert.throws(() => plain.add(source, { tint: [1, 0, 0] }), /colored: true/);
  const colored = new Shadows({ resolution: 64, colored: true });
  for (const tint of [[1, 0], [2, 0, 0], [0, -1, 0], [Number.NaN, 0, 0], 'red'])
    assert.throws(() => colored.add(source, { tint }), RangeError);
  assert.throws(() => colored.add({ drawShadow() {} }, { tint: [1, 0, 0] }), /cannot tint/);
  colored.options.colored = false;
  assert.throws(() => colored.setup(engine), /fixed at construction/);
});
