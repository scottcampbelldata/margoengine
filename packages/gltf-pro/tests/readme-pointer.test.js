import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseGLTFAsync, viewGLTFCamera, applyGLTFLights } from '../dist/index.js';
import { Animation } from '../../animation/dist/index.js';
import { pointerChannels } from '../../animation/dist/pointer.js';
import { loadedPBREngine } from '../../../tests/support/loaded-pbr-fixtures.js';

test('README pointer sample includes the animated camera, material and sun it promises', async () => {
  const engine = await loadedPBREngine();
  try {
    const model = await parseGLTFAsync(engine, readFileSync(new URL('./fixtures/pointer-show.glb', import.meta.url)));
    const animation = Animation.attach(model, { pointers: pointerChannels });
    animation.playing = false;
    animation.seek(0.5);
    viewGLTFCamera(model, 0);
    applyGLTFLights(model);
    assert.equal(model.cameras.length, 1);
    assert.equal(model.cameras[0].perspective.yfov, 0.75);
    assert.ok(Math.abs(engine.camera.fov - (0.75 * 180) / Math.PI) < 1e-12);
    assert.equal(model.lights[0].intensity, 2);
    assert.deepEqual(Array.from(model.primitives[0].material.base), [0.5, 0.5, 0, 1]);
    assert.deepEqual(animation.warnings, []);
  } finally {
    engine.dispose();
  }
});
