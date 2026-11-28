// The shot tool's capture maths (tools/shot/pixels.js, P2 and the P3 dither) and its header fields: MSAA, supersampling
// and the sub-frame times over the shutter. Plain data: no browser and no GPU. The GPU side (the page draws the forced
// samples at the supersampled size, sub-frames on their clock times, two renders identical) is
// tools/shot/test/determinism-check.mjs (npm run test:shot).
import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  addSubframe,
  areaWeights,
  blueNoise,
  linearToSrgb,
  resampleMask,
  resampleNearness,
  resolveFrame,
  srgbToLinear,
} from '../tools/shot/pixels.js';
import { PIXEL_FUNCTIONS, pixelScript } from '../tools/shot/pixel-script.mjs';
import { parseShot, poolFrames, renderSize, subframeOffsets, validateShot } from '../tools/shot/shot-file.mjs';

const root = resolve(import.meta.dirname, '..');
const shot = (header = {}) => ({
  format: 'margo-cutscene',
  version: 1,
  duration: 4,
  tracks: [],
  shot: {
    format: 'margo-shot',
    version: 1,
    id: 'capture',
    seconds: 2,
    page: { path: 'examples/orrery/index.html', engine: 'orrery.engine' },
    ...header,
  },
});
const paths = (input) => validateShot(input).map((issue) => issue.path);
const noise = blueNoise(64);
const frame = (sum, width, height, outWidth = width, outHeight = height, count = 1) =>
  resolveFrame({ sum, width, height, count, outWidth, outHeight, noise, noiseSize: 64 });

test("capture defaults: 1.5x supersampling (1620 x 2880 for a vertical short), the tier's own MSAA, one sub-frame", () => {
  const file = parseShot(shot());
  assert.equal(file.shot.supersample, 1.5);
  assert.equal(file.shot.msaa, null);
  assert.equal(file.shot.subframes, 1);
  assert.deepEqual(renderSize(file.shot), [1620, 2880]);
  assert.deepEqual(renderSize(parseShot(shot({ size: [270, 480], supersample: 2 })).shot), [540, 960]);
  assert.deepEqual(validateShot(shot({ msaa: 1 })), []);
  assert.deepEqual(validateShot(shot({ msaa: 4, supersample: 1 })), []);
  const cases = [
    [{ msaa: 2 }, 'shot.msaa'],
    [{ msaa: '1' }, 'shot.msaa'],
    [{ supersample: 0.5 }, 'shot.supersample'],
    [{ supersample: 3 }, 'shot.supersample'],
    [{ size: [6000, 6000] }, 'shot.supersample'],
  ];
  for (const [header, path] of cases) assert.deepEqual(paths(shot(header)), [path], JSON.stringify(header));
});

test('sub-frames spread over the open shutter, each at the middle of its slice', () => {
  assert.deepEqual(subframeOffsets({ fps: 60, subframes: 1, shutter: 180 }), [0]);
  assert.deepEqual(
    subframeOffsets({ fps: 60, subframes: 4, shutter: 0 }),
    [0, 0, 0, 0],
    'a closed shutter: anti-aliasing only',
  );
  const offsets = subframeOffsets({ fps: 60, subframes: 4, shutter: 180 });
  [0.5, 1.5, 2.5, 3.5].forEach((k, i) => assert.ok(Math.abs(offsets[i] - k / 4 / 120) < 1e-15, `sub-frame ${i}`));
  assert.ok(subframeOffsets({ fps: 60, subframes: 16, shutter: 360 }).at(-1) < 1 / 60, 'inside the frame interval');
});

test('the Orrery dolly shot draws one MSAA sample at the 1.5x default (NVIDIA glass at 4x MSAA is not byte-repeatable)', () => {
  const file = parseShot(readFileSync(resolve(root, 'tools/shot/shots/orrery-dolly.json'), 'utf8'));
  assert.equal(file.shot.msaa, 1);
  assert.equal(file.shot.supersample, 1.5);
  assert.equal(file.shot.tier, 'high');
});

test('sRGB transfer functions round-trip every 8-bit level', () => {
  for (let k = 0; k < 256; k++) assert.equal(Math.round(linearToSrgb(srgbToLinear(k / 255)) * 255), k);
  assert.equal(srgbToLinear(0), 0);
  assert.ok(Math.abs(linearToSrgb(1) - 1) < 1e-12);
});

test('one 8-bit sub-frame at its own size resolves to its own bytes: the dither never moves an exact level', () => {
  const width = 37,
    height = 23,
    rgba = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < rgba.length; i++) rgba[i] = i % 4 === 3 ? 255 : (i * 37 + (i >> 7)) % 256;
  const sum = new Float32Array(width * height * 3);
  addSubframe(sum, { width, height, rgba });
  assert.deepEqual(frame(sum, width, height), rgba);
  const four = new Float32Array(width * height * 3);
  for (let k = 0; k < 4; k++) addSubframe(four, { width, height, rgba });
  assert.deepEqual(frame(four, width, height, width, height, 4), rgba, 'the mean of four equal sub-frames');
});

test('averaging and downsampling are in linear light: black and white make sRGB 188, not 128', () => {
  const sum = new Float32Array([0, 0, 0, 1, 1, 1]);
  assert.deepEqual([...frame(sum, 2, 1, 1, 1)], [188, 188, 188, 255]);
  const sub = new Float32Array(3);
  addSubframe(sub, { width: 1, height: 1, rgba: new Uint8ClampedArray([0, 0, 0, 255]) });
  addSubframe(sub, { width: 1, height: 1, rgba: new Uint8ClampedArray([255, 255, 255, 255]) });
  assert.deepEqual([...frame(sub, 1, 1, 1, 1, 2)], [188, 188, 188, 255], 'two sub-frames');
});

test('the area filter: weights add to 1 and a 1.5x step shares the middle pixel', () => {
  const { first, count, offset, weights } = areaWeights(3, 2);
  assert.deepEqual([...first], [0, 1]);
  assert.deepEqual([...count], [2, 2]);
  assert.deepEqual([...offset], [0, 2]);
  [2 / 3, 1 / 3, 1 / 3, 2 / 3].forEach((w, i) => assert.ok(Math.abs(weights[i] - w) < 1e-12));
  const big = areaWeights(2880, 1920);
  for (let j = 0; j < 1920; j++) {
    let total = 0;
    for (let k = 0; k < big.count[j]; k++) total += big.weights[big.offset[j] + k];
    assert.ok(Math.abs(total - 1) < 1e-12, `pixel ${j} weights add to ${total}`);
  }
});

test('the blue-noise array: every rank once, an even scatter at every level, the same on every run', () => {
  assert.equal(new Set(noise).size, 4096);
  assert.equal(Math.max(...noise), 4095);
  assert.deepEqual(blueNoise(64), noise, 'seeded');
  // Thresholded at a quarter, a half and three quarters, every 8 x 8 block holds close to its share (white noise at a
  // half spreads blocks over about 20 to 44 of 64; this array keeps every one within 4 of its share).
  for (const level of [1024, 2048, 3072]) {
    const share = (level / 4096) * 64;
    for (let by = 0; by < 8; by++)
      for (let bx = 0; bx < 8; bx++) {
        let on = 0;
        for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) on += noise[(by * 8 + y) * 64 + bx * 8 + x] < level;
        assert.ok(Math.abs(on - share) <= 4, `level ${level}, block ${bx}, ${by}: ${on} of 64`);
      }
  }
});

test("the dither keeps a slow gradient's mean and leaves no band: a ramp across two levels mixes them everywhere", () => {
  const width = 256,
    height = 64,
    sum = new Float32Array(width * height * 3);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++)
      sum.fill(srgbToLinear((100 + (2 * x) / width) / 255), (y * width + x) * 3, (y * width + x) * 3 + 3);
  const out = frame(sum, width, height);
  for (let x0 = 0; x0 < width; x0 += 32) {
    let mean = 0;
    const levels = new Set();
    for (let y = 0; y < height; y++)
      for (let x = x0; x < x0 + 32; x++) {
        mean += out[(y * width + x) * 4];
        levels.add(out[(y * width + x) * 4]);
      }
    mean /= height * 32;
    const want = 100 + (2 * (x0 + 15.5)) / width;
    assert.ok(Math.abs(mean - want) < 0.02, `columns ${x0}: mean ${mean}, want ${want}`);
    assert.ok(levels.size >= 2, `columns ${x0} are one flat level: a band`);
  }
});

test('half-float sub-frames (rgba16float canvases) are sRGB-encoded and clamped to 0 to 1', () => {
  // 0x3c00 is 1.0, 0x3800 is 0.5, 0x4000 is 2.0 (clamped), 0xbc00 is -1.0 (clamped to 0).
  const half = new Uint16Array([0x3c00, 0x3800, 0x4000, 0x3c00, 0xbc00, 0, 0x3800, 0x3c00]);
  const sum = new Float32Array(6);
  addSubframe(sum, { width: 2, height: 1, half, stride: 4 });
  const out = [...frame(sum, 2, 1)];
  assert.deepEqual([out[0], out[2], out[3], out[4], out[5], out[7]], [255, 255, 255, 0, 0, 255]);
  // 0.5 is level 127.5: the dither picks 127 or 128 by the pixel's rank, never a level further off.
  for (const level of [out[1], out[6]]) assert.ok(level === 127 || level === 128, `0.5 became ${level}`);
});

test('masks downsample by coverage', () => {
  const grey = new Uint8Array([255, 255, 255, 255, 0, 0, 255, 0, 0]);
  assert.deepEqual([...resampleMask({ grey, width: 3, height: 3, outWidth: 3, outHeight: 3 })], [...grey]);
  // Output pixel (0, 0) covers 1.5 x 1.5 input pixels: 1 + 0.5 + 0.5 full and 0.25 of an empty one, 2 of 2.25; pixel
  // (1, 0) covers 1.5 full of 2.25; pixel (1, 1) covers only empty ones.
  assert.deepEqual([...resampleMask({ grey, width: 3, height: 3, outWidth: 2, outHeight: 2 })], [227, 170, 170, 0]);
});

// KB-LOOK-MASKTIE1: a supersampled edge pixel half plants and half lit ground read 128 in both masks, so the timber
// valley's plants mask overlapped lit ground on 14.5k to 15.9k pixels. A mask is inside at 128 only past half coverage.
test('masks that share no sample stay disjoint after the downsample', () => {
  const plants = new Uint8Array([255, 0, 255, 255, 0, 0, 255, 0]),
    lit = plants.map((v) => 255 - v);
  for (const [w, h, ow, oh] of [
    [4, 2, 2, 1],
    [4, 2, 1, 1],
    [8, 1, 3, 1],
  ]) {
    const p = resampleMask({ grey: plants.subarray(0, w * h), width: w, height: h, outWidth: ow, outHeight: oh }),
      l = resampleMask({ grey: lit.subarray(0, w * h), width: w, height: h, outWidth: ow, outHeight: oh });
    for (let i = 0; i < p.length; i++) assert.ok(!(p[i] >= 128 && l[i] >= 128), `pixel ${i} of ${w}x${h} in both`);
  }
  // Two of four samples covered: 127.5 ties and rounds down; three of four is 191.25, 191.
  assert.deepEqual(
    [...resampleMask({ grey: plants.subarray(0, 4), width: 2, height: 2, outWidth: 1, outHeight: 1 })],
    [191],
  );
  assert.deepEqual(
    [...resampleMask({ grey: Uint8Array.of(255, 0, 255, 0), width: 2, height: 2, outWidth: 1, outHeight: 1 })],
    [127],
  );
});

// KB-SHOT-DEPTH8BIT1: an area mean of a silhouette pixel is a distance of neither surface.
test('resampleNearness keeps the nearest value of each footprint', () => {
  const value = Float32Array.of(0.25, 0, 0, 0, 0.75, 0, 0, 0, 0.5);
  assert.equal(resampleNearness({ value, width: 3, height: 3, outWidth: 3, outHeight: 3 }), value);
  assert.deepEqual(
    [...resampleNearness({ value, width: 3, height: 3, outWidth: 2, outHeight: 2 })],
    [0.75, 0.75, 0.75, 0.75],
  );
  const row = Float32Array.of(0.9, 0.1, 0, 0);
  assert.deepEqual(
    [...resampleNearness({ value: row, width: 4, height: 1, outWidth: 2, outHeight: 1 })],
    [Math.fround(0.9), 0],
  );
});

test('the page script holds every pixels.js function, working with nothing of the module around it', () => {
  const context = {};
  context.globalThis = context;
  runInNewContext(pixelScript(), context);
  assert.deepEqual(Object.keys(context.__margoShotPixels), [...PIXEL_FUNCTIONS]);
  const P = context.__margoShotPixels;
  assert.deepEqual([...P.blueNoise(16)], [...blueNoise(16)]);
  const sum = new Float32Array([0, 0, 0, 1, 1, 1]);
  assert.deepEqual(
    [...P.resolveFrame({ sum, width: 2, height: 1, count: 1, outWidth: 1, outHeight: 1, noise, noiseSize: 64 })],
    [188, 188, 188, 255],
  );
});

test('resolveFrame gives the precise frame before its dither, and probePool names the frames each probe pools (KB-LOOK-TV-TINTRES1)', () => {
  // One pixel of linear 0.2, 0.5 and 0.03: its 8-bit codes are dithered, the precise frame keeps the sRGB values.
  const sum = new Float32Array([0.2, 0.5, 0.03]),
    precise = new Float32Array(3),
    rgba = resolveFrame({
      sum,
      width: 1,
      height: 1,
      count: 1,
      outWidth: 1,
      outHeight: 1,
      noise,
      noiseSize: 64,
      precise,
    });
  for (let c = 0; c < 3; c++) {
    assert.ok(Math.abs(precise[c] - linearToSrgb(sum[c])) < 1e-6, `channel ${c}: ${precise[c]}`);
    assert.ok(Math.abs(rgba[c] - precise[c] * 255) <= 1, 'the 8-bit code is within a level of it');
  }
  assert.throws(
    () =>
      resolveFrame({
        sum,
        width: 1,
        height: 1,
        count: 1,
        outWidth: 1,
        outHeight: 1,
        noise,
        noiseSize: 64,
        precise: new Float32Array(4),
      }),
    RangeError,
  );
  // probePool: frames centred on each probe, step apart, inside the shot (2 s at 60 fps: frames 0 to 119).
  const file = parseShot(shot({ probes: { a: 0.5, b: 1.95 }, probePool: { frames: 5, step: 3 } }));
  assert.equal(file.shot.probePool.frames, 5);
  assert.deepEqual(poolFrames(file), { a: [24, 27, 33, 36], b: [105, 108, 111, 114] });
  // Near the start the window slides after the probe; a pool longer than the shot keeps every frame.
  assert.deepEqual(poolFrames(parseShot(shot({ probes: { a: 0 }, probePool: { frames: 4, step: 2 } }))), {
    a: [2, 4, 6],
  });
  assert.equal(poolFrames(parseShot(shot({ probes: { a: 1 }, probePool: { frames: 400, step: 1 } }))).a.length, 119);
  assert.deepEqual(poolFrames(parseShot(shot({ probes: { a: 0.5 } }))), { a: [] });
  for (const probePool of [{ frames: 1, step: 1 }, { frames: 4, step: 0 }, { frames: 2.5, step: 1 }, 7])
    assert.ok(paths(shot({ probes: { a: 0.5 }, probePool })).includes('shot.probePool'), JSON.stringify(probePool));
  assert.ok(paths(shot({ probePool: { frames: 3, step: 1 } })).includes('shot.probePool'), 'needs probes');
});
