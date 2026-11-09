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
// Lit: a particle lit by the sun shows, at every pixel of its disc, the wrap-lit ball shading computed here, at any
// birth angle and at 1x and 4x MSAA.
// Depth collide: a particle flying into a depth texture drawn from quads bounces off a wall and a slope with the
// velocity and position the CPU steps, takes its normal from its own surface at an edge, and flies on behind a wall
// (past the thickness) or without the feature.
// Stretch: a fast particle's disc is stretched along its motion on screen to size + factor x speed and keeps its size
// across, horizontally and vertically, at 1x and 4x MSAA; factor 0 is the round disc.
// Fields: particles under two attractors, or in a linear vector field (inside, in the edge band, outside the box),
// move as the CPU steps them; without the feature they stay at rest.
// Skinned: births lie on the posed triangles (placed by the transform), fly along the posed normals and split by
// bind-pose area; with no deformer yet they lie on the bind pose.
// Flipbook: two particles held halfway between atlas frames (including a row wrap) match the CPU mix of the two
// solid cells times the life fade, within 2 of 255. Removing the mix fails this.
// Shadows: the first two live slots of four (a dead slot between them) pack as point lights, and one sphere at the
// origin writes the orthographic sphere depth into a 64 x 64 map. The same numbers on the WebGL2 route are
// shadows-nodes-webgl2.mjs.
// Nodes: one particle with velocity (1, 0, 0), force (0, 2, 0) and drag 0.5 matches four steps of 0.05 s of
// velocity += (force - drag * velocity) * dt, then position += velocity * dt. The same numbers on the WebGL2
// route are shadows-nodes-webgl2.mjs.
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
  for (const options of [
    { samples: 1 },
    { samples: 4 },
    { samples: 1, wrap: 0, angle: 1.1 },
    { samples: 1, wrap: 1, sun: [0, -1, 0.2] },
  ]) {
    const name = `lit ${JSON.stringify(options)}`,
      r = await page.evaluate((o) => window.checkLit(o), options);
    report.results[name] = r;
    clean(r, name);
    // A ball 4 world units across at about 0.028 units a pixel, every third pixel inside 0.95 of its radius.
    assert.ok(r.checked >= 1200, `${name}: ${r.checked} pixels compared`);
    assert.deepEqual(r.mismatches, [], name);
    console.log(`ok ${name}: ${r.checked} pixels, largest difference ${r.largest.toFixed(2)}/255`);
  }
  for (const kind of ['wall', 'slope', 'edge', 'behind', 'off']) {
    const name = `depth collide ${kind}`,
      r = await page.evaluate((o) => window.checkDepthCollide(o), { kind });
    report.results[name] = r;
    clean(r, name);
    assert.deepEqual(r.mismatches, [], name);
    console.log(`ok ${name}: velocity ${r.got.v.map((v) => v.toFixed(3))}`);
  }
  for (const options of [{ samples: 1 }, { samples: 4 }, { samples: 1, vertical: true }, { samples: 1, factor: 0 }]) {
    const name = `stretch ${JSON.stringify(options)}`,
      r = await page.evaluate((o) => window.checkStretch(o), options);
    report.results[name] = r;
    clean(r, name);
    assert.ok(r.checked >= 20, `${name}: ${r.checked} pixels compared`);
    assert.deepEqual(r.mismatches, [], name);
    console.log(
      `ok ${name}: ${r.checked} pixels, largest difference ${r.largest.toFixed(2)}/255, half length ${r.along}`,
    );
  }
  for (const kind of ['attract', 'field', 'off']) {
    const name = `fields ${kind}`,
      r = await page.evaluate((o) => window.checkFields(o), { kind });
    report.results[name] = r;
    clean(r, name);
    assert.deepEqual(r.mismatches, [], name);
    console.log(`ok ${name}: first velocity ${r.got[0].v.map((v) => v.toFixed(4))}`);
  }
  for (const options of [{ kind: 'pose' }, { kind: 'pose', offset: 0 }, { kind: 'rest' }]) {
    const name = `skinned ${JSON.stringify(options)}`,
      r = await page.evaluate((o) => window.checkSkinned(o), options);
    report.results[name] = r;
    clean(r, name);
    assert.deepEqual(r.mismatches, [], name);
    console.log(`ok ${name}: ${r.born} births, ${r.counts.join(' / ')} by triangle`);
  }
  {
    const name = 'flipbook',
      r = await page.evaluate(() => window.checkFlipbook());
    report.results[name] = r;
    clean(r, name);
    assert.deepEqual(r.mismatches, [], name);
    console.log(`ok ${name}: ${r.got.map((p) => p.join(',')).join(' | ')}`);
  }
  {
    const name = 'shadows',
      r = await page.evaluate(() => window.checkShadows());
    report.results[name] = r;
    clean(r, name);
    assert.deepEqual(
      r.header.map((v) => Math.round(v * 1e6) / 1e6),
      [2, 5, 3],
      name,
    );
    assert.deepEqual(r.lights[0].position, [1, 2, 3], name);
    assert.deepEqual(r.lights[0].color, [1, 0, 0], name);
    assert.equal(r.lights[0].range, 5, name);
    assert.equal(r.lights[0].intensity, 3, name);
    assert.deepEqual(r.lights[1].position, [4, 5, 6], name);
    assert.deepEqual(r.lights[1].color, [0, 0, 1], name);
    assert.equal(r.lights[1].range, 5, name);
    assert.equal(r.lights[1].intensity, 3, name);
    assert.notDeepEqual(r.lights[2].position, [7, 8, 9], name);
    assert.equal(r.published?.length, 2, name);
    assert.equal(r.published[0].decay, 2, name);
    assert.deepEqual(r.published[0].position, [1, 2, 3], name);
    assert.deepEqual(r.published[1].position, [4, 5, 6], name);
    assert.deepEqual(r.published[1].color, [0, 0, 1], name);
    for (let i = 0; i < 3; i++)
      assert.ok(
        Math.abs(r.depthGot[i] - r.depthWant[i]) < 1e-4,
        `${name} sample ${i}: got ${r.depthGot[i]} want ${r.depthWant[i]}`,
      );
    console.log(`ok ${name}: lights ${r.header.join(',')} depth ${r.depthGot.map((v) => v.toFixed(5)).join(' ')}`);
  }
  {
    const name = 'nodes',
      r = await page.evaluate(() => window.checkNodes());
    report.results[name] = r;
    clean(r, name);
    assert.deepEqual(r.mismatches, [], name);
    console.log(
      `ok ${name}: at ${r.got.at.map((v) => v.toFixed(5)).join(',')} v ${r.got.v.map((v) => v.toFixed(5)).join(',')}`,
    );
  }
  assert.deepEqual(pageErrors, []);
  await mkdir('test-results', { recursive: true });
  await writeFile('test-results/vfx-features-check.json', JSON.stringify(report, null, 1));
  console.log('vfx features check passed');
} finally {
  await context.close();
}
