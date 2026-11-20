// GAP-FILM-LATE and GAP-FILM-READY: the sun's colour and strength follow the air between it and the camera, so the
// light of a frame takes that frame's camera altitude. It read the altitude the sky passes had stored in the frame
// before (and sea level on the first frame), so a film lit each frame with the camera of the one before.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Sky, sunlight } from '../dist/index.js';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';

test('the sky light of every frame, the first included, takes that frame camera altitude', () => {
  const h = optionalGPU();
  h.engine.lighting = { direction: new Float32Array(4), radiance: new Float32Array([1, 1, 1, 0.15]) };
  const sky = new Sky({ hours: 7.5, timeScale: 0, lighting: { intensity: 6 } });
  h.engine.use(sky);
  const expected = (metres) => {
    const s = sunlight(sky.sun[1], Math.max(0.001, metres / 1000), 2);
    return Math.fround(6 * Math.max(...s));
  };
  try {
    // The first frame of a fresh sky, then each altitude change: never the altitude of the frame before.
    for (const metres of [2400, 1, 900, 900, 30]) {
      for (const camera of new Set([h.context.camera, h.engine.camera])) camera.position = [0, metres, 4];
      h.frame();
      assert.equal(sky.lights[0].direction[3], expected(metres), `sun strength at ${metres} m`);
      assert.equal(h.engine.lighting.direction[3], expected(metres), `engine light at ${metres} m`);
    }
  } finally {
    sky.dispose();
  }
});
