import test from 'node:test';
import assert from 'node:assert/strict';
import { engine } from '../../../tests/support/review56-engine.js';
import { TAA } from '../dist/index.js';
import { TAAUpscaleVelocity } from '../dist/upscale-velocity.js';
import { TAAUpscale } from '../dist/upscale.js';

for (const Type of [TAA, TAAUpscale, TAAUpscaleVelocity])
  test(`${Type.name} disposal detaches its owner and preserves another scene's same-name effect`, async (t) => {
    const e = await engine(t);
    e.gpu.createComputePipeline = () => ({ getBindGroupLayout: () => ({}) });
    const owner = e.createScene('temporal-owner');
    const primary = new Type();
    const secondary = new Type();
    e.use(primary);
    owner.use(secondary);
    secondary.dispose();
    secondary.dispose();
    assert.equal(e.sceneOf(secondary) === undefined, true);
    assert.equal(owner.plugins.has(secondary.name), false);
    assert.equal(e.scene.plugins.get(primary.name), primary);
    const replacement = new Type();
    owner.use(replacement);
    replacement.dispose();
  });
