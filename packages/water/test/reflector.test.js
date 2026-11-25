import test from 'node:test';
import assert from 'node:assert/strict';
import { Water } from '../dist/index.js';
import { WaterReflection } from '../dist/reflector.js';

test('planar water validates optics, requires a source and disposes idempotently', () => {
  const surface = new Water(),
    reflector = { texture: undefined, textureMatrix: undefined };
  assert.throws(() => new WaterReflection({ surface }), /reflector/);
  for (const settings of [
    { strength: 2 },
    { roughness: -1 },
    { distortion: NaN },
    { color: [1, 1] },
    { color: [1, -1, 1] },
  ])
    assert.throws(() => new WaterReflection({ surface, reflector, ...settings }));
  const effect = new WaterReflection({ surface, reflector });
  effect.dispose();
  effect.dispose();
  assert.throws(() => effect.setup({}), { code: 'disposed' });
  surface.dispose();
});

test('contactHardening is a boolean fixed at construction', () => {
  const surface = new Water(),
    reflector = { texture: undefined, textureMatrix: undefined };
  for (const contactHardening of [1, 'yes', null])
    assert.throws(() => new WaterReflection({ surface, reflector, contactHardening }), /contactHardening/);
  new WaterReflection({ surface, reflector, contactHardening: true }).dispose();
  new WaterReflection({ surface, reflector, contactHardening: false }).dispose();
  surface.dispose();
});
