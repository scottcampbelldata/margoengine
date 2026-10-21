// Real-GPU check for Reflector, Refractor, CubeCamera (@margoengine/environment) and render layers
// (@margoengine/cameras/layers). Run under the GPU lock:
//   node scripts/gpu-lock.mjs run --owner=env-mirror -- node scripts/env-mirror-gpu-check.js
// Expectations are independent renders, not copies of the feature's shader: a perfect mirror in z = 0 must show the
// scene reflected in z = 0 (geometry and light) drawn by core without any mirror; a clear glass must show the scene
// drawn without the glass; cube faces must hold the ambient-only box colours in the standard WebGPU face layout.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { openBrowser } from './browser.js';
import { acquire } from './gpu-lock.mjs';
import { encodePNG } from '../packages/exporters/dist/capture.js';

const release = await acquire({ owner: 'env-mirror-gpu-check' });
const W = 320,
  H = 240,
  out = 'test-results/env-mirror';
let browser;
try {
  await mkdir(out, { recursive: true });
  browser = await openBrowser({ startPath: '/tests/env-mirror.html', port: 5303 });
  const page = browser.page,
    pageErrors = [],
    checks = [],
    failures = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.waitForFunction(() => window.mirrorFixture);
  assert.equal(browser.hardware.webgpu?.fallback, false, 'Physical WebGPU adapter required');
  let samples = 4;
  const render = (state) => page.evaluate((state) => window.mirrorFixture.render(state), state);
  const capture = (which, state) =>
    page.evaluate(({ which, state }) => window.mirrorFixture.capture(which, state), { which, state });
  const save = async (name, image) =>
    writeFile(
      `${out}/${samples}x-${name}.png`,
      await encodePNG({ data: new Uint8Array(image.pixels), width: W, height: H }),
    );
  const record = (name, value, ok) => {
    checks.push({ samples, name, ...value });
    if (!ok) failures.push(`${samples}x ${name}: ${JSON.stringify(value)}`);
  };
  // Pixels whose RGB differs between two 8-bit images.
  const differs = (a, b) => {
    const mask = new Uint8Array(W * H);
    for (let i = 0; i < W * H; i++)
      for (let c = 0; c < 3; c++) if (a.pixels[i * 4 + c] !== b.pixels[i * 4 + c]) mask[i] = 1;
    return mask;
  };
  // Shrinks a mask by `r` pixels, so edge pixels (MSAA coverage, rasterisation ties) stay out.
  const erode = (mask, r) => {
    const outMask = new Uint8Array(W * H);
    for (let y = r; y < H - r; y++)
      for (let x = r; x < W - r; x++) {
        let keep = 1;
        for (let dy = -r; keep && dy <= r; dy++)
          for (let dx = -r; keep && dx <= r; dx++) keep = mask[(y + dy) * W + x + dx];
        outMask[y * W + x] = keep;
      }
    return outMask;
  };
  const and = (a, b) => a.map((v, i) => v & b[i]),
    not = (a) => a.map((v) => 1 - v),
    count = (mask) => mask.reduce((sum, v) => sum + v, 0);
  // Channel differences over a mask, in 8-bit steps.
  const compare = (a, b, mask) => {
    const deltas = [];
    for (let i = 0; i < W * H; i++)
      if (mask[i]) for (let c = 0; c < 3; c++) deltas.push(Math.abs(a.pixels[i * 4 + c] - b.pixels[i * 4 + c]));
    deltas.sort((x, y) => x - y);
    const sum = deltas.reduce((s, v) => s + v, 0);
    return {
      pixels: deltas.length / 3,
      max: deltas.at(-1) ?? 0,
      mean: deltas.length ? sum / deltas.length : 0,
      p99: deltas[Math.floor(deltas.length * 0.99)] ?? 0,
    };
  };
  const matches = (name, a, b, mask, { mean = 0.6, p99 = 4, minimum = 2000 } = {}) => {
    const value = compare(a, b, mask);
    record(name, value, value.pixels >= minimum && value.mean <= mean && value.p99 <= p99);
  };
  const exact = (name, a, b, mask) => {
    const value = compare(a, b, mask ?? new Uint8Array(W * H).fill(1));
    record(name, value, value.max === 0);
  };
  const texelDifference = (a, b) => {
    let max = 0;
    for (let i = 0; i < a.data.length; i++) max = Math.max(max, Math.abs(a.data[i] - b.data[i]));
    return max;
  };
  // Total variation inside a mask: lower means smoother.
  const variation = (image, mask) => {
    let sum = 0;
    for (let y = 0; y < H; y++)
      for (let x = 0; x + 1 < W; x++)
        if (mask[y * W + x] && mask[y * W + x + 1])
          for (let c = 0; c < 3; c++)
            sum += Math.abs(image.pixels[(y * W + x + 1) * 4 + c] - image.pixels[(y * W + x) * 4 + c]);
    return sum;
  };

  for (samples of [4, 1]) {
    if (samples === 1) {
      await page.goto('http://127.0.0.1:5303/tests/env-mirror.html?samples=1');
      await page.waitForFunction(() => window.mirrorFixture);
    }
    // Feature off: attaching a Reflector and a Refractor whose nodes are hidden leaves every pixel unchanged.
    const pristine = await render({ scene: 'baseline', pristine: true }),
      attached = await render({ scene: 'baseline' });
    record('scene raster sample count', { actual: attached.sampleCount }, attached.sampleCount === samples);
    exact('hidden Reflector and Refractor leave the frame unchanged', attached, pristine);
    await save('baseline', attached);

    // Mirror against the reflected scene.
    const mirror = await render({ scene: 'mirror' }),
      dark = await render({ scene: 'mirror', tint: [0, 0, 0] }),
      reference = await render({ scene: 'reference' }),
      region = erode(differs(mirror, dark), 2);
    await save('mirror', mirror);
    await save('mirror-reference', reference);
    record('mirror captured', { captured: mirror.captured }, mirror.captured === 1);
    matches('mirror pixels equal the scene reflected in the mirror plane', mirror, reference, region);

    // Nothing behind the mirror (the green box) reaches the capture; a clip plane moved behind it lets it through.
    const withBox = await capture('mirror', { scene: 'mirror', green: true }),
      withoutBox = await capture('mirror', { scene: 'mirror', green: false }),
      leakBox = await capture('mirror', { scene: 'mirror', green: true, clipBias: -1 }),
      leakFree = await capture('mirror', { scene: 'mirror', green: false, clipBias: -1 });
    const leak = texelDifference(withBox, withoutBox),
      control = texelDifference(leakBox, leakFree);
    record('box behind the mirror is absent from its capture', { maxTexelDifference: leak }, leak === 0);
    record('control: clipBias -1 lets that box into the capture', { maxTexelDifference: control }, control > 0.05);

    // Orthographic main camera.
    const ortho = await render({ scene: 'mirror', ortho: true }),
      orthoDark = await render({ scene: 'mirror', ortho: true, tint: [0, 0, 0] }),
      orthoReference = await render({ scene: 'reference', ortho: true });
    await save('mirror-ortho', ortho);
    matches(
      'orthographic mirror equals the reflected scene',
      ortho,
      orthoReference,
      erode(differs(ortho, orthoDark), 2),
    );

    // TAA: captures leave TAA's history alone. The converged mirror matches the converged reflected scene except at
    // edges inside the reflection (TAA supersamples real geometry; the mirror samples one unjittered capture), and a
    // box moved under accumulated history converges to the same image as a fresh history (no trail).
    const taa = await render({ scene: 'mirror', taa: true, frames: 16 }),
      taaDark = await render({ scene: 'mirror', taa: true, frames: 16, tint: [0, 0, 0] }),
      taaReference = await render({ scene: 'reference', taa: true, frames: 16 });
    await save('mirror-taa', taa);
    const taaRegion = erode(differs(taa, taaDark), 3);
    matches('TAA mirror equals the TAA reflected scene (edges excepted)', taa, taaReference, taaRegion, {
      mean: 1.5,
      p99: 32,
    });
    await render({ scene: 'mirror', taa: true, frames: 16 });
    const moved = await render({ scene: 'mirror', taa: true, frames: 16, redX: -0.1, keepHistory: true }),
      movedDark = await render({ scene: 'mirror', taa: true, frames: 16, redX: -0.1, tint: [0, 0, 0] }),
      movedFresh = await render({ scene: 'mirror', taa: true, frames: 16, redX: -0.1 });
    await save('mirror-taa-moved', moved);
    matches(
      'TAA mirror after a move under history equals a fresh history (no ghost)',
      moved,
      movedFresh,
      erode(differs(moved, movedDark), 3),
      { mean: 0.5, p99: 4 },
    );

    // Roughness blurs the reflection, a normal map distorts it.
    const rough = await render({ scene: 'mirror', roughness: 0.5 }),
      wavy = await render({ scene: 'mirror', normal: true });
    const sharpVariation = variation(mirror, region),
      roughVariation = variation(rough, region);
    record(
      'roughness 0.5 smooths the reflection',
      { sharpVariation, roughVariation, changed: compare(rough, mirror, region).mean },
      roughVariation < sharpVariation * 0.8,
    );
    const distortion = compare(wavy, mirror, region);
    record('a normal map distorts the reflection', distortion, distortion.mean > 1);

    // Glass against the scene drawn without the glass; nothing in front of the glass reaches its capture.
    const glassImage = await render({ scene: 'glass' }),
      glassDark = await render({ scene: 'glass', tint: [0, 0, 0] }),
      glassReference = await render({ scene: 'glass-reference' });
    await save('glass', glassImage);
    record('glass captured', { captured: glassImage.captured }, glassImage.captured === 1);
    matches(
      'glass pixels equal the scene behind it',
      glassImage,
      glassReference,
      erode(differs(glassImage, glassDark), 2),
    );
    const front = await capture('glass', { scene: 'glass', yellow: true }),
      noFront = await capture('glass', { scene: 'glass', yellow: false }),
      frontLeak = await capture('glass', { scene: 'glass', yellow: true, clipBias: -2 }),
      frontFree = await capture('glass', { scene: 'glass', yellow: false, clipBias: -2 });
    const glassLeak = texelDifference(front, noFront),
      glassControl = texelDifference(frontLeak, frontFree);
    record(
      'box between the eye and the glass is absent from its capture',
      { maxTexelDifference: glassLeak },
      glassLeak === 0,
    );
    record(
      'control: clipBias -2 lets that box into the capture',
      { maxTexelDifference: glassControl },
      glassControl > 0.05,
    );

    // Layers: the main camera (CameraLayers, mask 1) hides the red box moved to layer 1 while the mirror (every
    // layer) still reflects it; a mirror with mask 1 drops the reflection too.
    const noRed = await render({ scene: 'mirror', redHidden: true }),
      noRedDark = await render({ scene: 'mirror', redHidden: true, tint: [0, 0, 0] }),
      realRed = differs(dark, noRedDark),
      reflectedRed = and(and(differs(mirror, noRed), region), not(realRed)),
      ownRed = and(realRed, not(differs(mirror, noRed).map((v, i) => v & region[i]))),
      main = await render({ scene: 'mirror', layers: 'main' }),
      both = await render({ scene: 'mirror', layers: 'both' });
    await save('layers-main', main);
    record(
      'layer fixture has real and reflected red pixels',
      { real: count(realRed), reflected: count(reflectedRed) },
      count(realRed) > 200 && count(reflectedRed) > 200,
    );
    exact('main camera mask 1 hides the layer-1 box', main, noRed, ownRed);
    exact('mirror with every layer still reflects it', main, mirror, reflectedRed);
    exact('mirror with mask 1 drops the reflection', both, noRed, reflectedRed);
    record('visibility restored after the frames', { visible: main.visibility }, main.visibility[0] === true);
    // Cube camera: faces culled per face, standard layout, usable as image-based lighting.
    const cube = await page.evaluate(() => window.mirrorFixture.cube());
    record('main camera culls every cube-scene box', { visible: cube.mainVisible }, cube.mainVisible === 0);
    record(
      'six faces drawn, full mip chain',
      { drawn: cube.drawn, mips: cube.mipLevels },
      cube.drawn === 6 && cube.mipLevels === 7,
    );
    const colors = [
        [0.8, 0.1, 0.1],
        [0.1, 0.8, 0.1],
        [0.1, 0.1, 0.8],
        [0.8, 0.8, 0.1],
        [0.1, 0.8, 0.8],
        [0.8, 0.1, 0.8],
      ],
      texel = (face, x, y) => [0, 1, 2].map((c) => face[(y * cube.size + x) * 4 + c]),
      near = (a, b, eps) => a.every((v, i) => Math.abs(v - b[i]) <= eps);
    for (let f = 0; f < 6; f++) {
      const centre = texel(cube.faces[f], 32, 32);
      record(
        `cube face ${f} centre holds its box colour`,
        { centre, expected: colors[f] },
        near(centre, colors[f], 0.01),
      );
    }
    // Direction (3, 1, -1) on +X: u = (1/3 + 1) / 2, v = (-1/3 + 1) / 2 in the standard layout.
    const marker = texel(cube.faces[0], 42, 21),
      mirrored = texel(cube.faces[0], 21, 21);
    record(
      '+X face marker sits up and toward -Z (standard orientation)',
      { marker, mirrored },
      near(marker, [1, 1, 1], 0.02) && !near(mirrored, [1, 1, 1], 0.2),
    );
    const dominant = (rgb) => rgb.indexOf(Math.max(...rgb));
    record(
      'Environment from the CubeCamera: irradiance follows the box colours',
      { plusX: cube.before[0], minusX: cube.before[1], plusY: cube.before[2] },
      dominant(cube.before[0]) === 0 && dominant(cube.before[1]) === 1 && dominant(cube.before[2]) === 2,
    );
    const refreshed = texel(cube.refreshedFace, 32, 32);
    record(
      'refresh() reprocesses the updated cube in place',
      { after: cube.after, versionKept: cube.versionKept, face: refreshed },
      dominant(cube.after) === 2 && cube.versionKept && near(refreshed, [0.1, 0.1, 0.9], 0.01),
    );
  }

  const fixtureErrors = await page.evaluate(() => window.mirrorFixture.errors);
  record(
    'no WebGPU validation or engine errors',
    { errors: fixtureErrors, pageErrors },
    !fixtureErrors.length && !pageErrors.length,
  );
  await writeFile(`${out}/gpu.json`, JSON.stringify({ hardware: browser.hardware, checks, failures }, null, 2) + '\n');
  console.log(
    JSON.stringify(
      { hardware: browser.hardware.webgpu, checks: checks.length, failures, report: `${out}/gpu.json` },
      null,
      2,
    ),
  );
  assert.deepEqual(failures, [], 'Reflector / Refractor / CubeCamera / layers GPU checks failed');
} finally {
  await browser?.page.evaluate(() => window.mirrorFixture?.dispose()).catch(() => {});
  await browser?.close();
  release();
}
