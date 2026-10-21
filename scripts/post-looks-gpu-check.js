// Real-GPU check of post's SMAA, Glitch and Afterimage (tests/post-looks.html), on the built packages. Run from the
// repository root with the GPU lock:  node scripts/gpu-lock.mjs run --owner=post-looks -- node scripts/post-looks-gpu-check.js
// Writes test-results/post-looks/gpu.json and the screenshots it compares.
//
// smaa: a black/white half-plane whose edge has slope 1/8 (and 8, each mirrored) drawn aliased (pixel centres) by a
//   pattern stage, so the true line passes through the middle of every step: SMAA's output must equal the exact box
//   coverage of the half-plane per pixel (closed form by clipping the pixel square). A pixel-aligned rectangle stays
//   unchanged with cornerRounding 0. Disabled SMAA changes nothing. The final (canvas) path matches the probed one.
//   SMAA alone on a core scene, 4x and 1x: no validation errors, and only pixels next to an edge change.
// glitch: a coordinate image (red = x, green = y): idle frames and intensity 0 pass it through exactly; glitched frames
//   keep each row's green (displacement is horizontal), move pixels, and replay exactly from the same seed.
// afterimage: a bright square (linear 3.0 on 0.05) moving 20 px per frame: the probed HDR output equals
//   max(current, history x damp) per channel, computed here with float16 rounding of the history; damp 0, disabled,
//   after a resize and after a device restore it equals the frame without Afterimage; premultiplied alpha trails
//   with the colour; the display-encoded path equals the display curve of that expectation.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { openBrowser } from './browser.js';
import { decodePNG } from '../tests/support/png.js';
import { acquire } from './gpu-lock.mjs';

const release = await acquire({ owner: 'post-looks-gpu-check' }),
  port = 5301,
  folder = 'test-results/post-looks',
  checks = [],
  failures = [];
let browser;
const check = (name, ok, detail) => {
  checks.push({ name, ok, ...detail });
  if (!ok) failures.push(name + ' ' + JSON.stringify(detail));
};
// Exact area of the unit pixel (i, j) where dot(q, n) > d.
function coverage(n, d, i, j) {
  const square = [
      [i, j],
      [i + 1, j],
      [i + 1, j + 1],
      [i, j + 1],
    ],
    f = ([x, y]) => x * n[0] + y * n[1] - d,
    kept = [];
  for (let k = 0; k < 4; k++) {
    const a = square[k],
      b = square[(k + 1) % 4],
      fa = f(a),
      fb = f(b);
    if (fa > 0) kept.push(a);
    if (fa > 0 !== fb > 0) {
      const t = fa / (fa - fb);
      kept.push([a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])]);
    }
  }
  let area = 0;
  for (let k = 0; k < kept.length; k++) {
    const a = kept[k],
      b = kept[(k + 1) % kept.length];
    area += a[0] * b[1] - b[0] * a[1];
  }
  return Math.abs(area) / 2;
}
// Nearest float16 value (ties to even), as an rgba16float target stores it.
function half(x) {
  if (x === 0 || !Number.isFinite(x)) return x;
  let e = Math.floor(Math.log2(Math.abs(x)));
  if (Math.abs(x) < 2 ** e) e--;
  const step = 2 ** (Math.max(e, -14) - 10),
    q = x / step;
  let r = Math.round(q);
  if (Math.abs(q - Math.trunc(q)) === 0.5 && r % 2) r -= Math.sign(q);
  return r * step;
}
// Margo's display curve (packages/shared/display.js): Khronos PBR Neutral, then the sRGB encoding.
function toDisplay(c) {
  const x = Math.min(...c),
    offset = x < 0.08 ? x - 6.25 * x * x : 0.04;
  let v = c.map((value) => value - offset);
  const peak = Math.max(...v);
  if (peak >= 0.76) {
    const top = 1 - (0.24 * 0.24) / (peak + 0.24 - 0.76);
    v = v.map((value) => (value * top) / peak);
    const g = 1 - 1 / (0.15 * (peak - top) + 1);
    v = v.map((value) => value + (top - value) * g);
  }
  return v.map((value) => (value >= 0.0031308 ? 1.055 * value ** (1 / 2.4) - 0.055 : value * 12.92));
}
const stats = (a, b, keep = () => true, channels = [0, 1, 2, 3]) => {
  let max = 0,
    sum = 0,
    count = 0,
    changed = 0;
  for (let i = 0; i < a.length; i++) {
    if (!channels.includes(i % 4) || !keep(Math.floor(i / 4))) continue;
    const delta = Math.abs(a[i] - b[i]);
    max = Math.max(max, delta);
    sum += delta;
    changed += +(delta > 0);
    count++;
  }
  return { max, mean: sum / count, changed };
};
async function shot(page, name) {
  const file = `${folder}/${name}.png`;
  await page.locator('canvas').screenshot({ path: file });
  const { width, data } = await decodePNG(new Uint8Array(await (await import('node:fs/promises')).readFile(file)));
  return { width, data };
}

try {
  await mkdir(folder, { recursive: true });
  browser = await openBrowser({ startPath: '/tests/post-looks.html', port });
  const page = browser.page,
    pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.waitForFunction(() => window.looks);
  assert.equal(browser.hardware.webgpu?.fallback, false, 'Physical WebGPU adapter required');
  const configure = (list, width, height) =>
    page.evaluate(([list, width, height]) => window.looks.configure(list, width, height), [list, width, height]);
  const frame = (values) => page.evaluate((values) => window.looks.frame(values), values);
  const W = 160,
    H = 120;

  // SMAA ------------------------------------------------------------------------------------------------------------
  const lines = [
    ['shallow', [-1 / 8, 1], 50.5],
    ['shallow-mirrored', [1 / 8, 1], 70.5],
    ['steep', [1, -1 / 8], 70.5],
    ['steep-mirrored', [1, 1 / 8], 75.5],
  ];
  const white = [1, 1, 1, 1],
    black = [0, 0, 0, 1];
  for (const quality of ['high', 'low', 'ultra'])
    for (const [name, n, d] of lines) {
      const steep = name.startsWith('steep'),
        // Runs cut by the image border lose their outer end; leave those 8 pixels out.
        interior = (p) => (steep ? p >= 8 * W && p < (H - 8) * W : p % W >= 8 && p % W < W - 8),
        values = [0, 0, 0, 0, n[0], n[1], d, 0, ...white, ...black],
        expected = [];
      for (let j = 0; j < H; j++)
        for (let i = 0; i < W; i++) {
          const c = coverage(n, d, i, j);
          expected.push(c, c, c, 1);
        }
      await configure([
        { type: 'pattern', kind: 'display' },
        { type: 'probe', kind: 'ldr' },
      ]);
      const aliased = (await frame(values)).pixels;
      await configure([
        { type: 'pattern', kind: 'display' },
        { type: 'smaa', options: { quality } },
        { type: 'probe', kind: 'ldr' },
      ]);
      const out = (await frame(values)).pixels,
        before = stats(aliased, expected, interior, [0]),
        after = stats(out, expected, interior, [0]);
      check(`smaa ${quality} ${name}: equals the exact coverage of the line (interior)`, after.max <= 0.006, {
        aliasedMax: before.max,
        aliasedMean: before.mean,
        smaaMax: after.max,
        smaaMean: after.mean,
        allPixelsMax: stats(out, expected, () => true, [0]).max,
      });
    }
  {
    // Colour edge detection on a red/blue edge: red follows coverage, blue its complement.
    const values = [0, 0, 0, 0, -1 / 8, 1, 50.5, 0, 1, 0, 0, 1, 0, 0, 1, 1],
      interior = (p) => p % W >= 8 && p % W < W - 8;
    await configure([
      { type: 'pattern', kind: 'display' },
      { type: 'smaa', options: { edgeDetection: 'color' } },
      { type: 'probe', kind: 'ldr' },
    ]);
    const out = (await frame(values)).pixels,
      expected = [];
    for (let j = 0; j < H; j++)
      for (let i = 0; i < W; i++) {
        const c = coverage([-1 / 8, 1], 50.5, i, j);
        expected.push(c, 0, 1 - c, 1);
      }
    const error = stats(out, expected, interior);
    check('smaa color edges: red/blue edge blends per channel by coverage', error.max <= 0.006, error);
  }
  {
    // A pixel-aligned rectangle is exact already: with cornerRounding 0 nothing changes; the low preset rounds corners.
    const values = [1, 0, 0, 0, 40, 30, 120, 90, ...white, ...black];
    await configure([
      { type: 'pattern', kind: 'display' },
      { type: 'probe', kind: 'ldr' },
    ]);
    const plain = (await frame(values)).pixels;
    await configure([
      { type: 'pattern', kind: 'display' },
      { type: 'smaa', options: { cornerRounding: 0 } },
      { type: 'probe', kind: 'ldr' },
    ]);
    const sharp = stats((await frame(values)).pixels, plain);
    check('smaa cornerRounding 0: a pixel-aligned rectangle is unchanged', sharp.max === 0, sharp);
    await configure([
      { type: 'pattern', kind: 'display' },
      { type: 'smaa', options: { quality: 'low' } },
      { type: 'probe', kind: 'ldr' },
    ]);
    const round = stats((await frame(values)).pixels, plain);
    check('smaa low (no corner detection) rounds the rectangle corners', round.changed > 0, round);
    await configure([
      { type: 'pattern', kind: 'display' },
      { type: 'smaa', options: { enabled: false } },
      { type: 'probe', kind: 'ldr' },
    ]);
    const lineValues = [0, 0, 0, 0, -1 / 8, 1, 50.5, 0, ...white, ...black];
    await frame(lineValues);
    const off = (await frame(lineValues)).pixels;
    await configure([
      { type: 'pattern', kind: 'display' },
      { type: 'probe', kind: 'ldr' },
    ]);
    const reference = (await frame(lineValues)).pixels;
    const error = stats(off, reference);
    check('smaa disabled: the frame passes through unchanged', error.max === 0, error);
    // The final path (SMAA writes the canvas, multisampled at 4x) against the probed output.
    await configure([
      { type: 'pattern', kind: 'display' },
      { type: 'smaa', options: {} },
      { type: 'probe', kind: 'ldr' },
    ]);
    const probed = (await frame(lineValues)).pixels;
    await configure([
      { type: 'pattern', kind: 'display' },
      { type: 'smaa', options: {} },
    ]);
    const state = await frame(lineValues),
      canvas = await shot(page, 'smaa-final'),
      final = [];
    for (let i = 0; i < W * H; i++) for (let c = 0; c < 4; c++) final.push(canvas.data[i * 4 + c] / 255);
    const diff = stats(final, probed, () => true, [0, 1, 2]);
    check(`smaa final canvas path (${state.sampleCount}x) matches the probed output`, diff.max <= 1 / 255 + 1e-6, diff);
  }

  // Glitch ----------------------------------------------------------------------------------------------------------
  {
    const coordinates = [2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    await configure([
      { type: 'pattern', kind: 'display' },
      { type: 'probe', kind: 'ldr' },
    ]);
    const source = (await frame(coordinates)).pixels;
    const run = async (options, count) => {
      await configure([
        { type: 'pattern', kind: 'display' },
        { type: 'glitch', options },
        { type: 'probe', kind: 'ldr' },
      ]);
      const frames = [];
      for (let i = 0; i < count; i++) frames.push(await frame(coordinates));
      return frames;
    };
    const idle = await run({ seed: 7 }, 3);
    check(
      'glitch idle frames pass the image through exactly',
      idle.every((f) => !f.active && stats(f.pixels, source).max === 0),
      {
        active: idle.map((f) => f.active),
      },
    );
    const zero = await run({ seed: 7, wild: true, intensity: 0 }, 3);
    check(
      'glitch intensity 0 passes the image through exactly',
      zero.every((f) => stats(f.pixels, source).max === 0),
      {},
    );
    const wild = await run({ seed: 7, wild: true }, 4),
      again = await run({ seed: 7, wild: true }, 4),
      other = await run({ seed: 8, wild: true }, 4);
    const moved = wild.map((f) => {
      let count = 0;
      for (let p = 0; p < W * H; p++)
        count += +(f.pixels[p * 4] !== source[p * 4] || f.pixels[p * 4 + 2] !== source[p * 4 + 2]);
      return count / (W * H);
    });
    let rows = 0;
    for (const f of wild)
      for (let p = 0; p < W * H; p++) rows += +(Math.round(f.pixels[p * 4 + 1] * 255) !== Math.floor(p / W));
    check(
      'glitch wild: every frame glitched, pixels moved, rows kept',
      wild.every((f) => f.active) && moved.every((m) => m > 0.001) && rows === 0,
      {
        movedShare: moved,
        rowsChanged: rows,
      },
    );
    check(
      'glitch replays the same seed exactly',
      wild.every((f, i) => stats(f.pixels, again[i].pixels).max === 0),
      {},
    );
    check(
      'glitch another seed glitches differently',
      other.some((f, i) => stats(f.pixels, wild[i].pixels).max > 0),
      {},
    );
  }

  // Afterimage -------------------------------------------------------------------------------------------------------
  {
    const V = 3,
      bg = 0.05,
      square = (k, alpha = 1, background = [bg, bg, bg, 1]) => [
        1,
        0,
        0,
        0,
        10 + 20 * k,
        40,
        26 + 20 * k,
        56,
        V * alpha,
        V * alpha,
        V * alpha,
        alpha,
        ...background,
      ],
      current = (values, w = W, round = half) => {
        const out = [];
        for (let j = 0; j < H; j++)
          for (let i = 0; i < w; i++) {
            const inside = i + 0.5 >= values[4] && j + 0.5 >= values[5] && i + 0.5 < values[6] && j + 0.5 < values[7];
            out.push(...(inside ? values.slice(8, 12) : values.slice(12, 16)).map(round));
          }
        return out;
      };
    const trail = async (damp, frames, list, values = square, extra) => {
      await configure(list(damp));
      const got = [],
        expected = [];
      let history;
      // Exact expectation; the history is stored as float16 each frame, so frame k may be off by up to k + 1 float16
      // steps (2^-10 relative each, whichever way the GPU rounds).
      for (let k = 0; k < frames; k++) {
        const v = values(k),
          now = current(v, W, (x) => x);
        await extra?.(k);
        got.push((await frame(v)).pixels);
        history = history ? now.map((c, i) => Math.max(c, history[i] * damp)) : now;
        expected.push(history);
      }
      return { got, expected, bound: (k) => (k + 1) * 2 ** -10 };
    };
    const hdrProbe = (damp) => [
      { type: 'pattern', kind: 'hdr' },
      { type: 'afterimage', options: { damp } },
      { type: 'probe', kind: 'display' },
    ];
    const relative = (a, b) => {
      let max = 0;
      for (let i = 0; i < a.length; i++) max = Math.max(max, Math.abs(a[i] - b[i]) / Math.max(Math.abs(b[i]), 1e-3));
      return max;
    };
    const opaque = await trail(0.9, 6, hdrProbe);
    const errors = opaque.got.map((g, k) => relative(g, opaque.expected[k])),
      tail = opaque.got[5][(48 * W + 18) * 4];
    check(
      'afterimage: output = max(current, history x damp) per channel (HDR, float16 history)',
      errors.every((e, k) => e <= opaque.bound(k)),
      {
        relativeErrorPerFrame: errors,
        boundPerFrame: errors.map((_, k) => opaque.bound(k)),
        oldestTrail: tail,
        expectedOldest: V * 0.9 ** 5,
      },
    );
    // Without the effect, damp 0 and disabled give the frame itself.
    await configure([
      { type: 'pattern', kind: 'hdr' },
      { type: 'probe', kind: 'display' },
    ]);
    const plain = [];
    for (let k = 0; k < 3; k++) plain.push((await frame(square(k))).pixels);
    for (const [label, options] of [
      ['damp 0', { damp: 0 }],
      ['disabled', { enabled: false }],
    ]) {
      await configure([
        { type: 'pattern', kind: 'hdr' },
        { type: 'afterimage', options },
        { type: 'probe', kind: 'display' },
      ]);
      let max = 0;
      for (let k = 0; k < 3; k++) max = Math.max(max, stats((await frame(square(k))).pixels, plain[k]).max);
      check(`afterimage ${label}: identical to the frame without Afterimage`, max === 0, { max });
    }
    // A resize and a device restore start a new history.
    for (const [label, action] of [
      ['resize', () => configureSize(128)],
      ['device restore', () => page.evaluate(() => window.looks.reboot())],
    ]) {
      await configure(hdrProbe(0.9));
      for (let k = 0; k < 3; k++) await frame(square(k));
      await action();
      const result = await frame(square(3)),
        w = result.width;
      const now = current(square(3), w);
      const error = stats(result.pixels, now);
      check(
        `afterimage ${label}: the first frame after it has no trail`,
        error.max === 0 && w === (label === 'resize' ? 128 : W),
        { ...error, width: w },
      );
    }
    // Premultiplied alpha on a transparent background trails with the colour (colour / alpha stays V).
    const clear = await trail(0.8, 4, hdrProbe, (k) => square(k, 0.8, [0, 0, 0, 0]));
    let ratio = 0;
    const last = clear.got[3];
    for (let p = 0; p < W * H; p++)
      if (last[p * 4 + 3] > 0.01) ratio = Math.max(ratio, Math.abs(last[p * 4] / last[p * 4 + 3] - V));
    check(
      'afterimage alpha trails with premultiplied colour',
      relative(last, clear.expected[3]) <= clear.bound(3) && ratio <= 0.01,
      {
        maxRelativeError: relative(last, clear.expected[3]),
        bound: clear.bound(3),
        colourOverAlphaError: ratio,
      },
    );
    // As the last HDR stage it presents through the display curve.
    const display = await trail(0.9, 4, (damp) => [
      { type: 'pattern', kind: 'hdr' },
      { type: 'afterimage', options: { damp } },
      { type: 'probe', kind: 'ldr' },
    ]);
    const encoded = [];
    for (let p = 0; p < W * H; p++)
      encoded.push(...toDisplay(display.expected[3].slice(p * 4, p * 4 + 3)), display.expected[3][p * 4 + 3]);
    const shown = stats(display.got[3], encoded);
    check('afterimage display path: the display curve of the expected trail (8-bit)', shown.max <= 2 / 255, shown);
    await configure([
      { type: 'pattern', kind: 'hdr' },
      { type: 'afterimage', options: { damp: 0.9 } },
    ]);
    let state;
    for (let k = 0; k < 4; k++) state = await frame(square(k));
    const canvas = await shot(page, 'afterimage-final'),
      final = [];
    for (let i = 0; i < W * H; i++) for (let c = 0; c < 4; c++) final.push(canvas.data[i * 4 + c] / 255);
    const diff = stats(final, display.got[3], () => true, [0, 1, 2]);
    check(
      `afterimage final canvas path (${state.sampleCount}x) matches the probed display path`,
      diff.max <= 1 / 255 + 1e-6,
      diff,
    );
  }
  async function configureSize(width) {
    await page.evaluate((width) => {
      document.querySelector('canvas').style.width = width + 'px';
    }, width);
  }

  // Alone on a core scene, 4x and 1x ---------------------------------------------------------------------------------
  for (const samples of [4, 1]) {
    if (samples === 1) {
      await page.goto(`http://127.0.0.1:${port}/tests/post-looks.html?samples=1`);
      await page.waitForFunction(() => window.looks);
    }
    const scene = (effect, options) => page.evaluate(([e, o]) => window.looks.scene(e, o), [effect, options]);
    const state = await scene(null),
      reference = await shot(page, `scene-${samples}x`);
    await scene('smaa', {});
    const aa = await shot(page, `scene-smaa-${samples}x`);
    await scene('glitch', { seed: 5 });
    const idle = await shot(page, `scene-glitch-idle-${samples}x`);
    const luma = (d, p) => (0.2126 * d[p * 4] + 0.7152 * d[p * 4 + 1] + 0.0722 * d[p * 4 + 2]) / 255;
    let changed = 0,
      away = 0,
      idleDiff = 0;
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        const p = y * W + x;
        idleDiff = Math.max(
          idleDiff,
          ...[0, 1, 2].map((c) => Math.abs(idle.data[p * 4 + c] - reference.data[p * 4 + c])),
        );
        if ([0, 1, 2].every((c) => aa.data[p * 4 + c] === reference.data[p * 4 + c])) continue;
        changed++;
        const near = [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
        ].some(([dx, dy]) => {
          const q = (y + dy) * W + x + dx;
          return (
            x + dx >= 0 &&
            x + dx < W &&
            y + dy >= 0 &&
            y + dy < H &&
            Math.abs(luma(reference.data, p) - luma(reference.data, q)) >= 0.1
          );
        });
        away += +!near;
      }
    check(
      `smaa alone on a core scene (${state.sampleCount}x): edges change, pixels away from edges do not`,
      changed > 0 && away === 0,
      {
        changed,
        awayFromEdges: away,
      },
    );
    check(`glitch alone (${state.sampleCount}x): an idle frame equals the frame without it`, idleDiff === 0, {
      idleDiff,
    });
  }
  const gpuErrors = await page.evaluate(() => window.looks.errors);
  check('no WebGPU validation or page errors', !gpuErrors.length && !pageErrors.length, { gpuErrors, pageErrors });
  await page.evaluate(() => window.looks.dispose());
  await writeFile(
    `${folder}/gpu.json`,
    JSON.stringify({ hardware: browser.hardware, checks, failures }, null, 2) + '\n',
  );
  console.log(
    JSON.stringify(
      { hardware: browser.hardware.webgpu, browser: browser.hardware.browserVersion, checks, failures },
      null,
      1,
    ),
  );
  assert.deepEqual(failures, [], 'post looks GPU checks failed');
} finally {
  await browser?.close();
  release();
}
