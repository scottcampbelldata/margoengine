// GPU check of @margoengine/voxel-pathtracer/sequence on WebGPU and the WebGL2 compatibility layer.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { openBrowser } from '../../../scripts/browser.js';
import { legDevice } from '../../../scripts/support/compat-shim.js';

const rows = [];
for (const compat of [false, true]) {
  const context = await openBrowser({
    startPath: '/packages/voxel-pathtracer/tests/sequence.html',
    port: 'free',
    ...(compat && process.platform === 'win32' ? { args: ['--use-angle=vulkan'] } : {}),
  });
  const errors = [];
  context.page.on('pageerror', (e) => errors.push(e.message));
  try {
    await context.page.waitForFunction(() => window.ready, null, { timeout: 120000 });
    const r = await context.page.evaluate((compat) => window.run(compat), compat);
    const device = legDevice(compat, context.hardware);
    console.log(JSON.stringify({ compat, device, r }));
    assert.deepEqual(errors, []);
    assert.deepEqual(r.errors, []);
    assert.equal(r.fixedEqual, true, "noise 'fixed' traces a still scene bit for bit the same each frame");
    assert.equal(r.perFrameDiffer, true, "noise 'per-frame' draws new samples each frame");
    // Frame 0 has no previous pose, so it is sharp with or without a shutter.
    assert.equal(r.blur0.support, r.still0.support, 'the first frame is still');
    // Frame 1: the bar moved shiftPx in the image; shutter 0.5 smears it over the last half of that move.
    const smear = r.shiftPx * 0.5;
    assert.ok(
      Math.abs(r.blur.support - r.still.support - smear) <= 1,
      `smear ${r.blur.support - r.still.support} px, expected ${smear} +-1`,
    );
    // Energy: the bar's 1-voxel depth shows its side face off centre, so its image width grows with the pan; the blur
    // integrates the shutter (from 0.5 to 1 of the move), so its sum equals the still sum at mid-shutter (0.75 of the move,
    // the width growing linearly between frame 0 and frame 1) within 1%.
    const midShutter = r.still0.sum + 0.75 * (r.still.sum - r.still0.sum);
    assert.ok(Math.abs(r.blur.sum - midShutter) <= 0.01 * midShutter, `energy kept: ${r.blur.sum} vs ${midShutter}`);
    // The camera pans +x, so the bar moves -x in the image and the smear trails toward its previous place (+x).
    assert.ok(
      Math.abs(r.blur.centroid - r.still.centroid - smear / 2) <= 0.5,
      `centroid ${r.blur.centroid - r.still.centroid}`,
    );
    assert.equal(r.parity, 0, 'pixels() equals the capture PNG of the same render');
    assert.equal(r.linearMax, 255, 'emission 1 maps to white under linear tone mapping');
    assert.deepEqual(r.restored, { shutter: 0, previousCamera: null }, 'the tracer options are restored');
    rows.push({ compat, device, hardware: context.hardware, r });
  } finally {
    await context.close();
  }
}
await mkdir('test-results', { recursive: true });
await writeFile('test-results/voxel-pathtracer-sequence.json', JSON.stringify(rows, null, 2));
console.log('voxel-pathtracer sequence: native and compat passed');
