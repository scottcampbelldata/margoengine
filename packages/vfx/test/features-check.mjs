// Real-GPU checks of the features added after the first seven (run from the repository root after building packages,
// one GPU job at a time):
//   node scripts/gpu-lock.mjs run --owner=<id> -- node packages/vfx/test/features-check.mjs
// Ribbons: a particle flying at a known speed leaves a ribbon whose alpha along its centre row matches the head-to-tail
// and width fades computed here, at 1x and 4x MSAA, recording every frame or every second frame; a particle that dies
// and is born again starts a new ribbon that never reaches back into its old life.
// Mesh particles: a cube lit head-on shows its front face in the lit particle colour, exactly as wide as the face's
// projection, and hides a cube behind it (depth written), at 1x and 4x MSAA; a cube turned by its birth angle about its
// hashed axis shows the shade of the face the test finds turned to the camera; a long box follows its velocity.
// Events: a particle that dies, or hits the ground faster than `speed`, gives `count` children in the next frame at
// its death or impact point, with the event's life, size, colour and generation, read back from the particle buffer;
// fewer free slots give fewer children; children never give children; the same frames give the same bytes.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { openBrowser } from '../../../scripts/browser.js';
const context = await openBrowser({ startPath: '/packages/vfx/test/features-check.html', port: 5287 }),
  { page, hardware } = context,
  pageErrors = [],
  report = { hardware, results: {} };
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') pageErrors.push(m.text());
});
const clean = (r, name) => {
  assert.equal(r.error, null, name);
  assert.deepEqual(r.errors, [], name);
};
try {
  console.log('adapter', JSON.stringify(hardware.webgpu));
  await page.waitForFunction(() => window.ready, null, { timeout: 60000 });
  for (const options of [
    { samples: 1, interval: 0 },
    { samples: 4, interval: 0 },
    { samples: 1, interval: 0.2 },
    { samples: 1, interval: 0, reborn: true },
    { samples: 4, interval: 0, heads: true },
  ]) {
    const name = `ribbons ${JSON.stringify(options)}`,
      r = await page.evaluate((o) => window.checkRibbons(o), options);
    report.results[name] = r;
    clean(r, name);
    // A ribbon 1.8 (0.9 reborn) world units long at about 0.028 units a pixel: most of its pixels are compared.
    assert.ok(r.checked >= (options.reborn ? 25 : 55), `${name}: ${r.checked} pixels compared`);
    if (!options.heads) {
      assert.deepEqual(r.mismatches, [], name);
      assert.equal(r.beyond, 0, `${name}: nothing is drawn past the head`);
    }
    console.log(
      `ok ${name}: ${r.checked} pixels, largest difference ${r.largest.toFixed(2)}/255, tail ${r.tail.toFixed(2)}`,
    );
  }
  for (const options of [
    { kind: 'front', samples: 1 },
    { kind: 'front', samples: 4 },
    { kind: 'random', samples: 1 },
    { kind: 'velocity', samples: 1 },
  ]) {
    const name = `mesh ${JSON.stringify(options)}`,
      r = await page.evaluate((o) => window.checkMesh(o), options);
    report.results[name] = r;
    clean(r, name);
    assert.deepEqual(r.mismatches, [], name);
    console.log(`ok ${name}`);
  }
  for (const options of [
    { on: 'death' },
    { on: 'death', capacity: 3 },
    { on: 'death', short: true },
    { on: 'collision' },
    { on: 'collision', speed: 6 },
  ]) {
    const name = `events ${JSON.stringify(options)}`,
      r = await page.evaluate((o) => window.checkEvents(o), options);
    const { bytes, ...kept } = r;
    report.results[name] = kept;
    clean(r, name);
    assert.deepEqual(r.mismatches, [], name);
    if (options.on === 'death' && !options.short) {
      assert.equal(r.children, Math.min(4, options.capacity ?? 16), `${name}: children born`);
      // The same frames again give the same particle buffer, byte for byte (slot order, no atomics).
      const again = await page.evaluate((o) => window.checkEvents(o), options);
      assert.deepEqual(again.bytes, bytes, `${name}: same frames, same particles`);
    }
    if (options.on === 'collision') assert.equal(r.children, options.speed ? 0 : 4, `${name}: children born`);
    console.log(`ok ${name}: ${r.children} children`);
  }
  assert.deepEqual(pageErrors, []);
  await mkdir('test-results', { recursive: true });
  await writeFile('test-results/vfx-features-check.json', JSON.stringify(report, null, 1));
  console.log('vfx features check passed');
} finally {
  await context.close();
}
