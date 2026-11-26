// RGBM and LogLuv checked against the formulas of Karis (2009) and Ward (1998), worked by hand, and by round trip.
import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeRGBM, encodeRGBM, decodeLogLuv, encodeLogLuv, loadRGBM, loadLogLuv, decodeHDRJPG } from '../dist/encoded-hdr.js';

const img = (data, width = data.length / 4) => ({ width, height: 1, data: Uint8Array.from(data) });
const near = (a, b, tolerance, label = '') => assert.ok(Math.abs(a - b) <= tolerance, `${label} ${a} against ${b}`);

test('RGBM decode follows rgb * a * maxRange', () => {
  const out = decodeRGBM(img([255, 128, 0, 255, 255, 255, 255, 128]));
  [6, (128 / 255) * 6, 0, 1].forEach((v, i) => near(out.data[i], v, 1e-6));
  near(out.data[4], 6 * (128 / 255), 1e-6);
  const g = decodeRGBM(img([128, 0, 0, 255]), { maxRange: 16, gamma: 2 });
  near(g.data[0], (128 / 255) ** 2 * 16, 1e-5);
});

test('RGBM round trip stays within one stored step, past-range values clip', () => {
  const values = [0.5, 3, 0.01, 1, 1, 5.9, 5.9, 1, 0, 0, 0, 1, 100, 1, 1, 1];
  const back = decodeRGBM({ width: 4, height: 1, data: encodeRGBM({ width: 4, height: 1, data: new Float32Array(values) }) });
  for (const p of [0, 1]) for (const c of [0, 1, 2]) near(back.data[p * 4 + c], values[p * 4 + c], 6 / 255 + 0.02, `p${p}c${c}`);
  for (const c of [0, 1, 2]) near(back.data[8 + c], 0, 1e-3);
  assert.equal(back.data[12], 6); // 100 clips to maxRange
  assert.throws(() => decodeRGBM(img([0, 0, 0, 0]), { maxRange: 0 }), RangeError);
});

test('LogLuv decodes a white of luminance 1 and an exact hand-worked word', () => {
  // D65 white, Y=1: u' = 0.19784, v' = 0.46834 -> ue = 81, ve = 192; Le = 256 * 64 = 16384 = 0x4000.
  const white = decodeLogLuv(img([0x40, 0x00, 81, 192]));
  for (let c = 0; c < 3; c++) near(white.data[c], 1, 0.02, `c${c}`);
  assert.equal(white.data[3], 1);
  assert.deepEqual([...decodeLogLuv(img([0, 0, 81, 192])).data.slice(0, 3)], [0, 0, 0]);
});

test('LogLuv round trip over 40 stops of luminance is within the format\'s 0.3% / 1.5% steps', () => {
  const colors = [];
  for (let e = -20; e <= 20; e += 4) for (const [r, g, b] of [[1, 1, 1], [1, 0.4, 0.1], [0.1, 0.5, 0.9]]) colors.push(r * 2 ** e, g * 2 ** e, b * 2 ** e, 1);
  const width = colors.length / 4,
    back = decodeLogLuv({ width, height: 1, data: encodeLogLuv({ width, height: 1, data: Float32Array.from(colors) }) });
  for (let i = 0; i < width; i++) {
    const big = Math.max(colors[i * 4], colors[i * 4 + 1], colors[i * 4 + 2]);
    for (let c = 0; c < 3; c++) near(back.data[i * 4 + c], colors[i * 4 + c], big * 0.03, `p${i}c${c}`);
  }
});

test('loaders decode through a supplied picture decoder and honour the abort signal', async () => {
  const decode = () => img([255, 255, 255, 255]);
  assert.equal((await loadRGBM(new Uint8Array(4), { decode })).data[0], 6);
  near((await loadLogLuv(new Uint8Array(4), { decode: () => img([0x40, 0, 81, 192]) })).data[1], 1, 0.02);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(loadRGBM(new Uint8Array(4), { decode, signal: controller.signal }), { name: 'AbortError' });
  assert.equal(typeof decodeHDRJPG, 'function');
  assert.throws(() => decodeRGBM({ width: 2, height: 2, data: new Uint8Array(4) }), /empty or shorter/);
});
