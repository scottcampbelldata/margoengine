// Real-adapter check of @margoengine/shader/raw and /effects (run from the repository root after building the shader
// package): node scripts/gpu-lock.mjs run --owner=shader-raw -- node scripts/shader-raw-gpu-check.js
// At 4x and 1x MSAA: every WGSL module compiles without errors and no GPU error escapes; a RawMesh with a per-vertex
// and a per-instance attribute matches its analytic colours and is hidden behind / drawn in front of a core box by
// reversed-Z depth; live uniforms and ranged attributes update; device restoration redraws the same pixels; pixelate and
// Sobel (plus posterize, sepia and vignette) match analytic results, and every other preset compiles and changes the
// image. Feature off (plugin detached, nothing visible, stack removed) leaves every pixel unchanged.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { openBrowser } from './browser.js';
import { decodePNG } from '../tests/support/png.js';
import { acquire } from './gpu-lock.mjs';

const W = 320,
  H = 240,
  port = 5302,
  out = 'test-results/shader-raw';
const release = await acquire({ owner: 'shader-raw-gpu-check' });
let browser;
try {
  await mkdir(out, { recursive: true });
  browser = await openBrowser({ startPath: '/tests/shader-raw.html', port });
  const page = browser.page,
    pageErrors = [],
    checks = [],
    failures = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  assert.equal(browser.hardware.webgpu?.fallback, false, 'Physical WebGPU adapter required');
  let samples = 4;
  async function shot(label, action) {
    const state = await action();
    const file = `${out}/${samples}x-${label}.png`;
    const png = await page.locator('canvas').screenshot({ path: file }),
      image = await decodePNG(png);
    assert.equal(image.width, W, label + ' width');
    assert.equal(image.height, H, label + ' height');
    check(label + ': no GPU, compile or material errors', [state.errors, state.compile, state.materials], [[], [], []]);
    return { state, data: image.data, at: (x, y) => [...image.data.slice((y * W + x) * 4, (y * W + x) * 4 + 3)] };
  }
  const show = (label, scene, effect, options) =>
    shot(label, () => page.evaluate((a) => window.rawFixture.show(...a), [scene, effect, options ?? {}]));
  function check(name, actual, expected) {
    checks.push({ name, samples, actual, expected });
    if (JSON.stringify(actual) !== JSON.stringify(expected))
      failures.push(`${samples}x ${name}: ${JSON.stringify(actual)} != ${JSON.stringify(expected)}`);
  }
  /** Compares `image` with `expected(x, y)` (RGB 0-255 or null to skip) over the whole frame. */
  function compare(name, image, expected, tolerance = 0) {
    let max = 0,
      count = 0,
      worst;
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        const e = expected(x, y);
        if (!e) continue;
        count++;
        const a = image.at(x, y);
        for (let c = 0; c < 3; c++) {
          if (e[c] === null) continue;
          const d = Math.abs(a[c] - e[c]);
          if (d > max) {
            max = d;
            worst = { x, y, actual: a, expected: e.map((v) => (v === null ? v : Math.round(v * 10) / 10)) };
          }
        }
      }
    checks.push({ name, samples, pixels: count, max, tolerance, worst });
    if (!count) failures.push(`${samples}x ${name}: no pixels compared`);
    if (max > tolerance)
      failures.push(`${samples}x ${name}: max error ${max} > ${tolerance} at ${JSON.stringify(worst)}`);
  }
  const same = (name, a, b) => compare(name, a, (x, y) => b.at(x, y), 0);
  function differs(name, a, b, minimum = 10) {
    let max = 0;
    for (let i = 0; i < a.data.length; i++) if (i % 4 !== 3) max = Math.max(max, Math.abs(a.data[i] - b.data[i]));
    checks.push({ name, samples, max, minimum });
    if (max < minimum) failures.push(`${samples}x ${name}: changed only ${max}`);
  }
  // Camera at z = 3 looking at the origin, fov 60, aspect 4:3. A pixel centre on the plane at distance d:
  const t30 = Math.tan(Math.PI / 6),
    toWorld = (x, y, d) =>
      [((x + 0.5) / W) * 2 - 1, 1 - ((y + 0.5) / H) * 2].map((n, i) => n * d * t30 * (i ? 1 : W / H)),
    instances = [
      { x0: -1.05, y0: 0, z: 0.9, green: 0 },
      { x0: 0.05, y0: -0.6, z: -0.9, green: 255 },
    ],
    boxNDC = [0.5 / (2.5 * t30 * (W / H)), 0.5 / (2.5 * t30)];
  /** Analytic raw colour of instance i at pixel (x, y), or null outside its quad (with a 2-pixel margin). */
  function rawColour(i, x, y, gain = 1) {
    const q = instances[i],
      d = 3 - q.z,
      [wx, wy] = toWorld(x, y, d),
      margin = (2 / W) * 2 * d * t30 * (W / H),
      t = (wx - q.x0) / 1;
    if (t < margin || t > 1 - margin || wy < q.y0 + margin || wy > q.y0 + 0.6 - margin) return null;
    return [255 * (1 - t) * gain, q.green, 255 * t * gain];
  }
  const insideBox = (x, y, grow = 2) => {
    const nx = ((x + 0.5) / W) * 2 - 1,
      ny = 1 - ((y + 0.5) / H) * 2;
    return Math.abs(nx) < boxNDC[0] + (grow * 2) / W && Math.abs(ny) < boxNDC[1] + (grow * 2) / H;
  };

  for (samples of [4, 1]) {
    if (samples === 1) await page.goto(`http://127.0.0.1:${port}/tests/shader-raw.html?samples=1`);
    await page.waitForFunction(() => window.rawFixture);
    // Feature off: no plugin, then the plugin with nothing visible, then detached again.
    const none = await show('none', 'none');
    check('scene raster sample count', none.state.sampleCount, samples);
    const idle = await show('core', 'core');
    same('attached RawShaders with nothing visible changes no pixel', idle, none);
    check('nothing visible draws nothing', idle.state.drawCalls, 0);
    // The raw mesh against the core box.
    const scene = await show('raw', 'raw');
    check('raw mesh drawn with two instances in one call', [scene.state.drawCalls, scene.state.pending], [1, 0]);
    compare(
      'instance 0 (in front of the box): per-vertex tint interpolation and per-instance offset, analytic',
      scene,
      (x, y) => rawColour(0, x, y),
      2,
    );
    compare(
      'instance 1 outside the box silhouette: analytic, green from the per-instance u32 id',
      scene,
      (x, y) => (insideBox(x, y) ? null : rawColour(1, x, y)),
      2,
    );
    compare(
      'instance 1 behind the box: reversed-Z depth test keeps every core pixel',
      scene,
      (x, y) => (insideBox(x, y, -2) && rawColour(1, x, y) ? idle.at(x, y) : null),
      0,
    );
    compare(
      'outside both quads the scene is unchanged',
      scene,
      (x, y) => {
        for (let i = 0; i < 2; i++) {
          const q = instances[i],
            d = 3 - q.z,
            [wx, wy] = toWorld(x, y, d),
            m = (4 / W) * 2 * d * t30 * (W / H);
          if (wx > q.x0 - m && wx < q.x0 + 1 + m && wy > q.y0 - m && wy < q.y0 + 0.6 + m) return null;
        }
        return idle.at(x, y);
      },
      0,
    );
    // Live updates: a uniform, then a ranged attribute upload moving instance 0 out of view.
    const half = await shot('live-gain', () => page.evaluate(() => window.rawFixture.live(0.5, false)));
    compare('live uniform gain 0.5 halves instance 0', half, (x, y) => rawColour(0, x, y, 0.5), 2);
    const moved = await shot('live-offset', () => page.evaluate(() => window.rawFixture.live(1, true)));
    compare(
      'ranged setAttribute moved instance 0 away; instance 1 stays',
      moved,
      (x, y) => (rawColour(0, x, y) ? idle.at(x, y) : insideBox(x, y) ? null : rawColour(1, x, y)),
      2,
    );
    await page.evaluate(() => window.rawFixture.live(1, false));
    // Device restoration redraws the same frame.
    const before = await show('before-restore', 'raw'),
      restored = await shot('restored', () => page.evaluate(() => window.rawFixture.restore()));
    check('restore swapped the GPU device', restored.state.changedDevice, true);
    same('device restoration redraws identical pixels', restored, before);
    const detached = await show('none-again', 'none');
    same('detaching RawShaders restores the original frame', detached, none);

    // Screen effects on known inputs (LDR stack: the 8-bit scene capture holds exactly what the canvas shows).
    const edge = await show('edge', 'edge');
    compare('edge scene: flat 0.2 and 0.6 halves', edge, (x) => (x < 160 ? [51, 51, 51] : [153, 153, 153]), 0);
    const sobel = await show('sobel', 'edge', 'sobel', { strength: 0.5 });
    // A luma step d gives |gx| = 4 d beside it: 0.5 x 4 x 0.4 = 0.8 (204) in columns 159 and 160, 0 elsewhere.
    compare(
      'Sobel: 204 beside the step, 0 elsewhere',
      sobel,
      (x) => (x === 159 || x === 160 ? [204, 204, 204] : [0, 0, 0]),
      1,
    );
    const gradient = await show('gradient', 'gradient');
    const pixelate = await show('pixelate', 'gradient', 'pixelate', { size: 16 });
    compare(
      'pixelate 16: every block is the input pixel at its centre',
      pixelate,
      (x, y) => gradient.at(Math.floor(x / 16) * 16 + 8, Math.floor(y / 16) * 16 + 8),
      0,
    );
    const posterize = await show('posterize', 'gradient', 'posterize', { levels: 4 });
    compare(
      'posterize 4: round(v x 3) / 3',
      posterize,
      (x, y) => gradient.at(x, y).map((v) => (Math.round((v / 255) * 3) / 3) * 255),
      1,
    );
    const sepia = await show('sepia', 'gradient', 'sepia', {});
    compare(
      'sepia: W3C Filter Effects matrix',
      sepia,
      (x, y) => {
        const [r, g, b] = gradient.at(x, y);
        return [
          0.393 * r + 0.769 * g + 0.189 * b,
          0.349 * r + 0.686 * g + 0.168 * b,
          0.272 * r + 0.534 * g + 0.131 * b,
        ].map((v) => Math.min(255, v));
      },
      1,
    );
    const vignette = await show('vignette', 'gradient', 'vignette', {});
    compare(
      'vignette: unchanged inside radius 0.4',
      vignette,
      (x, y) => (Math.hypot((x + 0.5) / W - 0.5, (y + 0.5) / H - 0.5) * Math.SQRT2 < 0.39 ? gradient.at(x, y) : null),
      0,
    );
    compare(
      'vignette: corners at 1 - darkness',
      vignette,
      (x, y) => ((x < 2 && y < 2) || (x > W - 3 && y > H - 3) ? gradient.at(x, y).map((v) => v * 0.2) : null),
      2,
    );
    /** Bilinear read of channel c at pixel coordinate (x, y) (texel centres at i + 0.5), clamped to the edge. */
    const bilinear = (image, x, y, c) => {
      const fx = x - 0.5,
        fy = y - 0.5,
        x0 = Math.floor(fx),
        y0 = Math.floor(fy),
        tx = fx - x0,
        ty = fy - y0,
        v = (i, j) => image.at(Math.min(W - 1, Math.max(0, i)), Math.min(H - 1, Math.max(0, j)))[c];
      return (
        (v(x0, y0) * (1 - tx) + v(x0 + 1, y0) * tx) * (1 - ty) +
        (v(x0, y0 + 1) * (1 - tx) + v(x0 + 1, y0 + 1) * tx) * ty
      );
    };
    // rgbShift 0.02 on the hard edge: red sampled 6.4 px to the left, blue 6.4 px to the right, green untouched.
    const shifted = await show('rgbShift', 'edge', 'rgbShift', { amount: 0.02 });
    compare(
      'rgbShift: red and blue shifted 6.4 px apart (bilinear), green unchanged',
      shifted,
      (x, y) => [
        bilinear(edge, x + 0.5 - 6.4, y + 0.5, 0),
        edge.at(x, y)[1],
        bilinear(edge, x + 0.5 + 6.4, y + 0.5, 2),
      ],
      2,
    );
    // chromaticAberration 0.05 on the gradient: red read at centre + d x 0.95, blue at centre + d x 1.05.
    const lens = await show('chromaticAberration', 'gradient', 'chromaticAberration', { strength: 0.05 }),
      scaled = (x, y, k) => [W / 2 + (x + 0.5 - W / 2) * k, H / 2 + (y + 0.5 - H / 2) * k];
    compare(
      'chromaticAberration: red scaled 0.95 and blue 1.05 about the centre, green unchanged',
      lens,
      (x, y) => [
        bilinear(gradient, ...scaled(x, y, 0.95), 0),
        gradient.at(x, y)[1],
        bilinear(gradient, ...scaled(x, y, 1.05), 2),
      ],
      2,
    );
    for (const [name, options] of [
      ['halftone', {}],
      ['halftone', { greyscale: true }],
      ['dotScreen', {}],
    ]) {
      const image = await show(name + (options.greyscale ? '-grey' : ''), 'gradient', name, options);
      differs(`${name}${options.greyscale ? ' greyscale' : ''} compiles and changes the image`, image, gradient);
    }
    // A screen keeps a flat tone on average: each dot covers its channel's share of the cell, also above pi / 4, where
    // the cell's sides cut the dot. The edge scene's halves are 0.2 (51) and 0.6 (153); 16 px stay clear of the step.
    // dotScreen runs at 12 px cells: its 1 px edge ramp loses its outer half where a dot meets its cell's side, about
    // 0.13 px^2 per pixel of edge (5 levels at the default 6 px with 0.8 ink), half that at 12 px.
    const mean = (image, x0, x1) => {
      const sum = [0, 0, 0];
      for (let y = 0; y < H; y++) for (let x = x0; x < x1; x++) image.at(x, y).forEach((v, c) => (sum[c] += v));
      return sum.map((v) => +(v / ((x1 - x0) * H)).toFixed(1));
    };
    for (const [name, options] of [
      ['halftone', {}],
      ['halftone', { greyscale: true }],
      ['dotScreen', { size: 12 }],
    ]) {
      const label = name + (options.greyscale ? '-grey' : ''),
        image = await show(label + '-tone', 'edge', name, options),
        tones = [mean(image, 0, 144), mean(image, 176, W)],
        near = tones.every((tone, k) => tone.every((v) => Math.abs(v - [51, 153][k]) < 5));
      check(
        `${label}: flat 0.2 and 0.6 keep their tone on average (within 5 of 51 and 153)`,
        near ? 'kept' : tones,
        'kept',
      );
    }
    const off = await show('effects-off', 'gradient');
    same('removing the PostStack restores the input frame', off, gradient);
  }
  check('no page errors', pageErrors, []);
  await writeFile(`${out}/gpu.json`, JSON.stringify({ hardware: browser.hardware, checks, failures }, null, 2) + '\n');
  console.log(
    JSON.stringify(
      { hardware: browser.hardware.webgpu, checks: checks.length, failures, report: `${out}/gpu.json` },
      null,
      2,
    ),
  );
  assert.deepEqual(failures, [], 'Raw shader / screen effect GPU checks failed');
} finally {
  await browser?.close();
  release();
}
