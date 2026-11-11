import test from 'node:test';
import assert from 'node:assert/strict';
import { Camera } from '@margoengine/core';
import { fillFrame } from '../src/frame.ts';

// Off-axis crop of a whole-view clip matrix to one tile, as a tiled capture draws it: x and y rows scaled to the tile
// and offset by the w row.
function crop(m, fullWidth, fullHeight, x, y, width, height) {
  const out = Float32Array.from(m),
    sx = fullWidth / width,
    sy = fullHeight / height,
    tx = (fullWidth - 2 * x - width) / width,
    ty = (2 * y + height - fullHeight) / height;
  for (let c = 0; c < 4; c++) {
    out[c * 4] = sx * m[c * 4] + tx * m[c * 4 + 3];
    out[c * 4 + 1] = sy * m[c * 4 + 1] + ty * m[c * 4 + 3];
  }
  return out;
}

test('perspective pixels per world unit follow a cropped tile projection, not the full-view fov', () => {
  for (const [fov, up, position] of [
    [60, [0, 1, 0], [0, 0, 8]],
    [35, [0, 0, 1], [3, -5, 2]],
    [90, [0.3, 1, 0.2], [-4, 6, 9]],
  ]) {
    const camera = new Camera({ position, target: [0.5, -0.25, 0.75], up, fov });
    camera.update(1600 / 900, true);
    const full = new Float32Array(36),
      view = new Float32Array(16);
    fillFrame(full, view, camera, 1600, 900, 'rgba8unorm');
    assert.ok(Math.abs(full[18] / (450 / Math.tan((fov * Math.PI) / 360)) - 1) < 1e-6, 'whole view keeps fov scale');
    // Short tiles in every row of a 1600 x 900 capture with 256-pixel tiles: the last row is 132 pixels tall.
    for (const [x, y, w, h] of [
      [0, 0, 256, 256],
      [512, 256, 256, 256],
      [1536, 768, 64, 132],
    ]) {
      camera.matrix.set(crop(camera.matrix, 1600, 900, x, y, w, h));
      const tile = new Float32Array(36);
      fillFrame(tile, view, camera, w, h, 'rgba8unorm');
      // A world-size splat covers the same pixels in a tile as in the whole image.
      assert.ok(Math.abs(tile[18] / full[18] - 1) < 1e-5, `tile ${x},${y} ${w}x${h}: ${tile[18]} vs ${full[18]}`);
      camera.update(1600 / 900, true);
    }
  }
});
