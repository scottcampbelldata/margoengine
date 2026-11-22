// `npm run test:shot` (WebGPU): the shot tool on a small scene (tools/shot/test/scene.js).
// 1. Two renders give identical frames, the frames move, and the manifest, probes and contact sheet are written; the
//    shot's CSS applies from the start (the canvas fills the window) with no page error; each probe records the
//    view-projection core drew it with (the look checks' horizon), the matrix a core Camera makes from the
//    cutscene's camera at the probe's time and the canvas's aspect.
// 2. The page runs on the shot's clock: Math.random is the seeded stream, performance.now() and Date.now() read the
//    shot's time, warm-up frames do not move the clock, every GPU readback lands before the next frame, and the
//    camera is where the cutscene's camera track puts it.
// 3. A page with a source the shot does not control (crypto.getRandomValues) fails the determinism check, naming
//    the first frame that differs and writing its second copy, so the check is not vacuous.
// 4. Masks (AOVs): geometry and depth from the page's SceneTargets, sky and water worked out from the geometry and
//    the camera; written beside each frame, copied for the probes, the same on both renders, and sky, water and
//    geometry split every pixel exactly once. A mask that differs while the frames match fails the check too.
// 5. Capture (P2): MSAA forced to one sample over the high tier's four, 2x supersampling (the canvas twice the shot's
//    size, frames at the shot's size), and four sub-frames a kept frame on their own clock times over a 180 degree
//    shutter; two renders identical. The default shot draws the tier's four samples at the 1.5x default.
// 6. Production renders: one full render, and a second that captures only the probe frames and stops after the last
//    of them, drawing every frame before it; the probes identical, and a page the shot does not control still fails,
//    naming a probe frame.
// 7. Sky coverage (KB-HEARTH-CLIP1): a shot with no sky mask on a page with a Sky gets `sky-coverage` on its probes,
//    the pixels the sky drew: the exact complement of the page's geometry mask, the same on both renders, and the
//    mask skyClip measures inside, which look.md names. A page without a sky gets none.
// Needs `npm run build:packages` first.
import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Camera } from '@margoengine/core';
import { Cutscene } from '@margoengine/cutscene';
import { parseShot, renderSize } from '../shot-file.mjs';
import { CLOCK_EPOCH, CLOCK_START, openShotPage, renderOnce, shoot } from '../render.mjs';
import { lookShot } from '../look.mjs';
import { decodePNG } from '@margoengine/headless/compare';

const root = resolve(import.meta.dirname, '../../..');
process.chdir(root);
const FPS = 60,
  FRAMES = 30,
  WARMUP = 4,
  SEED = 4242;
const shotFile = (id, query = {}, extra = {}) =>
  parseShot({
    format: 'margo-cutscene',
    version: 1,
    duration: 1,
    tracks: [
      {
        type: 'camera',
        id: 'orbit',
        keys: [
          { time: 0, position: [0, 6, 14], target: [0, 1, 0], fov: 50 },
          { time: 1, position: [10, 4, 9], target: [0, 1, 0], fov: 40, ease: 'smoothstep' },
        ],
      },
    ],
    shot: {
      format: 'margo-shot',
      version: 1,
      id,
      seed: SEED,
      size: [270, 480],
      fps: FPS,
      seconds: FRAMES / FPS,
      warmup: WARMUP,
      probes: { start: 0, late: 0.4 },
      page: {
        path: 'tools/shot/test/scene.html',
        query,
        // Applied before the page's code runs, as the document is created: without it the canvas is 240 x 160.
        css: '#viewport{position:fixed;inset:0;width:100%!important;height:100%!important}',
        engine: 'shotScene.engine',
        canvas: '#viewport',
        ...(extra.aovs ? { aovs: 'shotScene.aovs' } : {}),
      },
      ...extra,
    },
  });

// The reference stream: mulberry32, as tools/shot/driver.js seeds Math.random.
function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const quiet = () => {};
const outDir = (id) => join(root, 'test-results', 'shots', id);

// 1. Two identical renders.
{
  const file = shotFile('test-scene'),
    out = outDir('test-scene');
  rmSync(out, { recursive: true, force: true });
  const manifest = await shoot(file, { out, log: quiet });
  assert.equal(manifest.determinism.identical, true, 'two renders of the test scene differ');
  assert.equal(manifest.frames, FRAMES);
  assert.deepEqual(manifest.size, [270, 480]);
  for (const record of manifest.files) assert.ok(existsSync(join(out, record.file)), `missing ${record.file}`);
  assert.equal(manifest.files[0].file, 'frames/frame_0000.png');
  const distinct = new Set(manifest.files.map((record) => record.sha256)).size;
  assert.ok(distinct > FRAMES * 0.8, `the frames hardly move: ${distinct} distinct of ${FRAMES}`);
  assert.deepEqual(Object.keys(manifest.probes), ['start', 'late']);
  assert.equal(manifest.probes.late.frame, 24);
  assert.deepEqual(readFileSync(join(out, 'probes/late.png')), readFileSync(join(out, 'frames/frame_0024.png')));
  assert.ok(existsSync(join(out, 'contact.png')), 'no contact sheet');
  assert.ok(!existsSync(join(out, 'progress-a.json')), 'a finished render left its progress file');
  // The late probe's camera as core drew it: frame 24's cutscene camera at the canvas's aspect (WebGPU depth).
  const late = new Cutscene(file).evaluate(24 / FPS).camera,
    [width, height] = renderSize(file.shot),
    camera = new Camera({ fov: late.fov, position: late.position, target: late.target });
  camera.up = late.up;
  camera.update(width / height, true);
  assert.deepEqual(manifest.probes.late.viewProjection, Array.from(camera.matrix), "the late probe's view-projection");
  assert.equal(manifest.probes.start.viewProjection.length, 16);
  assert.ok(!('viewProjection' in manifest.files[1]), 'a frame that is not a probe carries a view-projection');
  // Read from the canvas texture on the GPU, not the composited canvas: over SSH on Windows the composited copy is
  // black while the GPU draws (1 distinct frame of 30 on the dev PC before the fix).
  assert.equal(manifest.capture, 'gpu', 'the WebGPU canvas was not read from its texture');
  console.log(`ok 1: two renders identical, ${distinct} distinct frames of ${FRAMES}`);
}

// 2. The shot's clock, seed, GPU settling and camera.
{
  const file = shotFile('test-scene-clock');
  let browser;
  try {
    browser = await openShotPage(file);
    await renderOnce(browser, file, { out: outDir('test-scene-clock'), label: 'a', write: false });
    const { record, camera } = await browser.page.evaluate(() => ({
      record: globalThis.shotScene.record,
      camera: {
        position: [...globalThis.shotScene.engine.camera.position],
        fov: globalThis.shotScene.engine.camera.fov,
      },
    }));
    const random = mulberry32(SEED);
    assert.deepEqual(record.random, [random(), random(), random()], 'Math.random is not the seeded stream');
    const drawn = WARMUP + FRAMES;
    assert.equal(record.clock.length, drawn, 'frames drawn');
    const expected = [
      ...Array(WARMUP).fill(CLOCK_START),
      ...Array.from({ length: FRAMES }, (_, i) => CLOCK_START + (i * 1000) / FPS),
    ];
    assert.deepEqual(record.clock, expected, 'performance.now() is not the shot clock');
    assert.deepEqual(
      record.date,
      expected.map((ms) => CLOCK_EPOCH + ms),
      'Date.now() is not the shot clock',
    );
    assert.ok(
      record.deltas.slice(0, WARMUP + 1).every((d) => d === 0),
      'warm-up frames moved the clock',
    );
    for (const delta of record.deltas.slice(WARMUP + 1)) assert.ok(Math.abs(delta - 1 / FPS) < 1e-9, `delta ${delta}`);
    assert.equal(record.reads, drawn, 'a GPU readback landed after the next frame');
    assert.equal(record.samples, 4, 'the high tier draws four MSAA samples when the shot leaves msaa unset');
    assert.deepEqual(record.canvas.at(-1), [405, 720], 'the 1.5x supersampling default');
    const last = new Cutscene(file).evaluate((FRAMES - 1) / FPS).camera;
    camera.position.forEach((value, i) => assert.ok(Math.abs(value - last.position[i]) < 1e-5, 'camera position'));
    assert.ok(Math.abs(camera.fov - last.fov) < 1e-5, 'camera fov');
    console.log('ok 2: seeded random, shot clock, readbacks before the next frame, camera from the cutscene');
  } finally {
    await browser?.close();
  }
}

// 3. An uncontrolled source fails the check.
{
  const file = shotFile('test-scene-leak', { leak: 1 }),
    out = outDir('test-scene-leak');
  rmSync(out, { recursive: true, force: true });
  await assert.rejects(shoot(file, { out, log: quiet }), (error) => {
    assert.match(
      error.message,
      /determinism check failed: \d+ of 30 frames differ between the two renders, first frame \d+/,
    );
    const difference = error.manifest.determinism.difference;
    assert.ok(
      existsSync(join(out, `mismatch/frame_${String(difference.frame).padStart(4, '0')}.b.png`)),
      'no mismatch copy',
    );
    return true;
  });
  console.log('ok 3: a page reading crypto.getRandomValues fails the determinism check');
}
// 4. Masks.
{
  const names = ['geometry', 'depth', 'sky', 'water'],
    // At the shot's own size, so every mask pixel is all in or all out (supersampled masks are checked in 5).
    file = shotFile('test-scene-aovs', { aov: 1 }, { aovs: names, horizon: { y: 0 }, supersample: 1 }),
    out = outDir('test-scene-aovs');
  rmSync(out, { recursive: true, force: true });
  const manifest = await shoot(file, { out, log: quiet });
  assert.equal(manifest.determinism.identical, true, 'two renders of the masks differ');
  assert.deepEqual(manifest.aovs, names);
  for (const record of manifest.files) {
    assert.deepEqual(Object.keys(record.aovs), names, `frame ${record.index} masks`);
    for (const name of names)
      assert.ok(existsSync(join(out, record.aovs[name].file)), `missing ${record.aovs[name].file}`);
    const { geometry, sky, water, depth } = record.aovs;
    // Each of sky, water and geometry is 0 or 255 per pixel and they never overlap, so the means add up to 1.
    assert.ok(
      Math.abs(geometry.mean + sky.mean + water.mean - 1) < 1e-9,
      `frame ${record.index}: sky, water and geometry do not split the frame`,
    );
    for (const [name, mask] of Object.entries({ geometry, sky, water, depth }))
      assert.ok(mask.mean > 0.01 && mask.mean < 0.99, `frame ${record.index}: the ${name} mask is ${mask.mean} full`);
    assert.ok(depth.mean < geometry.mean, 'depth is nearness, below 1 on every surface');
  }
  assert.deepEqual(manifest.probes.late.aovs.water, 'probes/late.water.png');
  assert.deepEqual(
    readFileSync(join(out, 'probes/late.water.png')),
    readFileSync(join(out, 'aovs/water/frame_0024.png')),
  );
  const first = manifest.files[0].aovs,
    last = manifest.files.at(-1).aovs;
  assert.notEqual(first.water.sha256, last.water.sha256, 'the water mask does not follow the camera');
  console.log(
    `ok 4: masks written and identical, frame 0 sky ${first.sky.mean.toFixed(3)} water ${first.water.mean.toFixed(3)} geometry ${first.geometry.mean.toFixed(3)}`,
  );

  const leaky = shotFile('test-scene-aov-leak', { aov: 'leak' }, { aovs: ['geometry', 'noise'] }),
    leakOut = outDir('test-scene-aov-leak');
  rmSync(leakOut, { recursive: true, force: true });
  await assert.rejects(shoot(leaky, { out: leakOut, log: quiet }), (error) => {
    assert.match(
      error.message,
      /determinism check failed: the noise mask differs in 30 of 30 frames between the two renders, first frame 0/,
    );
    assert.equal(error.manifest.determinism.difference.reason, 'aovs');
    return true;
  });
  console.log('ok 4b: a mask that differs between renders fails the determinism check');
}
// 5. Capture: forced MSAA, supersampling and sub-frames.
{
  const SUBS = 4,
    names = ['geometry', 'depth', 'sky', 'water'],
    file = shotFile(
      'test-scene-capture',
      { aov: 1 },
      { msaa: 1, supersample: 2, subframes: SUBS, shutter: 180, aovs: names, horizon: { y: 0 } },
    ),
    out = outDir('test-scene-capture');
  rmSync(out, { recursive: true, force: true });
  const manifest = await shoot(file, { out, log: quiet });
  assert.equal(manifest.determinism.identical, true, 'two renders of the accumulated frames differ');
  assert.deepEqual(manifest.size, [270, 480]);
  assert.deepEqual(manifest.render.size, [540, 960], 'the canvas is the shot size times 2');
  assert.equal(manifest.render.samples, 1, 'the shot forced one MSAA sample');
  assert.equal(manifest.render.subframes, SUBS);
  const png = readFileSync(join(out, manifest.files[0].file));
  assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20)], [270, 480], 'frames are written at the shot size');
  const distinct = new Set(manifest.files.map((record) => record.sha256)).size;
  assert.ok(distinct > FRAMES * 0.8, `the accumulated frames hardly move: ${distinct} distinct of ${FRAMES}`);
  // Masks are made at the canvas size and taken down by coverage: written at the shot size, and sky, water and
  // geometry still split each pixel, to the rounding of each mask's own 8 bits.
  const mask = readFileSync(join(out, manifest.files[0].aovs.water.file));
  assert.deepEqual([mask.readUInt32BE(16), mask.readUInt32BE(20)], [270, 480], 'masks are written at the shot size');
  for (const { aovs, index } of manifest.files) {
    const total = aovs.geometry.mean + aovs.sky.mean + aovs.water.mean;
    assert.ok(Math.abs(total - 1) <= 1.5 / 255, `frame ${index}: sky, water and geometry add to ${total}`);
  }
  let browser;
  try {
    browser = await openShotPage(file);
    await renderOnce(browser, file, { out: outDir('test-scene-capture-clock'), label: 'a', write: false });
    const record = await browser.page.evaluate(() => globalThis.shotScene.record);
    assert.equal(record.samples, 1, "the page's own sceneSamples() reads one sample after applyQualityTier chose high");
    assert.deepEqual(record.canvas.at(-1), [540, 960]);
    const expected = [...Array(WARMUP).fill(CLOCK_START)];
    for (let i = 0; i < FRAMES; i++)
      for (let k = 0; k < SUBS; k++)
        expected.push(CLOCK_START + (i * 1000) / FPS + ((k + 0.5) / SUBS) * (0.5 / FPS) * 1000);
    assert.equal(record.clock.length, expected.length, 'sub-frames drawn');
    record.clock.forEach((ms, i) =>
      assert.ok(Math.abs(ms - expected[i]) < 1e-9, `clock ${i}: ${ms}, want ${expected[i]}`),
    );
  } finally {
    await browser?.close();
  }
  console.log(
    `ok 5: one MSAA sample forced, 2x supersampled, ${SUBS} sub-frames over the shutter, two renders identical`,
  );
}
// 6. Production: the probes checked on a second render that stops after the last of them.
{
  const file = shotFile('test-scene-production'),
    out = outDir('test-scene-production');
  rmSync(out, { recursive: true, force: true });
  const manifest = await shoot(file, { out, check: 'probes', log: quiet });
  assert.deepEqual(manifest.determinism, { runs: 2, check: 'probes', checked: [0, 24], identical: true });
  assert.equal(manifest.files.length, FRAMES, 'the first render keeps every frame');

  // The second render draws every frame up to the last probe (frame 24), each with its sub-frames, and no further.
  let browser;
  try {
    browser = await openShotPage(file);
    const b = await renderOnce(browser, file, {
      out: outDir('test-scene-production-b'),
      label: 'b',
      write: false,
      only: new Set([0, 24]),
    });
    assert.deepEqual(
      b.frames.map((frame) => frame.index),
      [0, 24],
    );
    assert.deepEqual(
      b.frames.map((frame) => frame.sha256),
      [manifest.files[0].sha256, manifest.files[24].sha256],
    );
    const record = await browser.page.evaluate(() => globalThis.shotScene.record);
    assert.equal(record.clock.length, WARMUP + 25, 'frames drawn: the warm-up and frames 0 to 24');
  } finally {
    await browser?.close();
  }

  const leak = shotFile('test-scene-production-leak', { leak: 1 }),
    leakOut = outDir('test-scene-production-leak');
  rmSync(leakOut, { recursive: true, force: true });
  await assert.rejects(shoot(leak, { out: leakOut, check: 'probes', log: quiet }), (error) => {
    assert.match(
      error.message,
      /determinism check failed: [12] of 2 frames differ between the two renders, first frame (0|24)/,
    );
    assert.equal(error.manifest.determinism.check, 'probes');
    return true;
  });
  console.log('ok 6: production render, probes 0 and 24 identical on a second render that stops at frame 24');
}
// 7. Sky coverage.
{
  const file = shotFile(
      'test-scene-sky-coverage',
      { aov: 1, sky: 1 },
      { aovs: ['geometry'], msaa: 1, supersample: 1, lookBounds: { skyClip: 0.5 } },
    ),
    out = outDir('test-scene-sky-coverage');
  rmSync(out, { recursive: true, force: true });
  const manifest = await shoot(file, { out, log: quiet });
  assert.equal(manifest.determinism.identical, true, 'two renders of the sky coverage differ');
  assert.equal(manifest.skyCoverage, true);
  assert.deepEqual(manifest.aovs, ['geometry'], "the shot's own masks are listed as before");
  for (const [name, probe] of Object.entries(manifest.probes)) {
    assert.equal(probe.aovs['sky-coverage'], `probes/${name}.sky-coverage.png`);
    const sky = await decodePNG(readFileSync(join(out, probe.aovs['sky-coverage']))),
      geometry = await decodePNG(readFileSync(join(out, probe.aovs.geometry)));
    let open = 0,
      wrong = 0;
    for (let i = 0; i < sky.data.length; i += 4) {
      if (sky.data[i]) open++;
      if (sky.data[i] !== 255 - geometry.data[i]) wrong++;
    }
    assert.equal(wrong, 0, `${name}: ${wrong} pixels where the sky coverage is not the complement of the geometry`);
    assert.ok(
      open > 0.05 * sky.width * sky.height && open < 0.95 * sky.width * sky.height,
      `${name}: sky share ${open}`,
    );
  }
  // Only the probes carry it, and they match between the two renders through the determinism check above.
  assert.ok(
    manifest.files.filter((record) => record.aovs?.['sky-coverage']).length === Object.keys(manifest.probes).length,
  );
  const report = await lookShot(out, manifest);
  for (const probe of report.json.probes)
    assert.equal(probe.results.find((row) => row.check === 'skyClip').mask, 'sky-coverage');
  assert.match(readFileSync(join(out, 'look.md'), 'utf8'), /- skyClip inside `sky-coverage`.*: start, late/);

  const bare = shotFile('test-scene-no-sky', {}, { lookBounds: { skyClip: 0.5 } }),
    bareOut = outDir('test-scene-no-sky');
  rmSync(bareOut, { recursive: true, force: true });
  const plain = await shoot(bare, { out: bareOut, runs: 1, log: quiet });
  assert.equal(plain.skyCoverage, false);
  assert.ok(
    Object.values(plain.probes).every((probe) => !probe.aovs),
    'a page without a sky gets no mask',
  );
  console.log('ok 7: sky coverage on the probes, the complement of the geometry, named by look.md; none without a sky');
}
console.log('shot tool determinism check passed');
