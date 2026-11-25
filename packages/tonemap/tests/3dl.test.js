import test from 'node:test';
import assert from 'node:assert/strict';
import { parse3dl, export3dl } from '../dist/3dl.js';
import { exportCube } from '../dist/export-cube.js';
import { Grade } from '../dist/grade.js';
import { HueGrade } from '../dist/hue.js';
import { parseCube, Tonemap } from '../dist/index.js';
import { gpuHarness } from '../../../tests/support/postfx-gpu.js';

// A 17-sample Flame-style LUT written out here (not by the package): the 10-bit vertex line from Autodesk's
// documentation, then rows with blue varying fastest. Each output encodes its own grid indices so ordering mistakes
// show: R = 200 r + 3, G = 200 g + 5, B = 200 b + 7 (12-bit codes).
const VERTICES = '0 64 128 192 256 320 384 448 512 576 640 704 768 832 896 960 1023';
function flame(size = 17, row = (r, g, b) => `${200 * r + 3} ${200 * g + 5} ${200 * b + 7}`, head = VERTICES) {
  const lines = head ? [head] : [];
  for (let r = 0; r < size; r++) for (let g = 0; g < size; g++) for (let b = 0; b < size; b++) lines.push(row(r, g, b));
  return lines.join('\n') + '\n';
}

test('parse3dl reads the Flame layout: blue fastest in the file, red fastest in the LUT, 12-bit codes', () => {
  const lut = parse3dl('# a comment\n' + flame());
  assert.equal(lut.size, 17);
  assert.deepEqual([...lut.domainMin, ...lut.domainMax], [0, 0, 0, 1, 1, 1]);
  for (const [r, g, b] of [
    [0, 0, 0],
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
    [16, 3, 9],
    [16, 16, 16],
  ]) {
    const o = 4 * ((b * 17 + g) * 17 + r);
    assert.deepEqual(
      [...lut.data.slice(o, o + 4)],
      [(200 * r + 3) / 4095, (200 * g + 5) / 4095, (200 * b + 7) / 4095, 1].map(Math.fround),
      `${r} ${g} ${b}`,
    );
  }
});

test('parse3dl reads the Lustre header with and without a vertex line, and takes its output depth', () => {
  const values = (r, g, b) => `${r * 4} ${g * 4} ${b * 4}`;
  for (const text of [
    '3DMESH\nMesh 1 4\n0 512 1023\n' + flame(3, values, ''),
    '3DMESH\nMesh 1 4\n' + flame(3, values, ''),
  ]) {
    const lut = parse3dl(text);
    assert.equal(lut.size, 3);
    const o = 4 * ((2 * 3 + 1) * 3 + 0);
    assert.deepEqual([...lut.data.slice(o, o + 3)], [0, 4 / 15, 8 / 15].map(Math.fround));
  }
});

test('parse3dl infers the output depth from the values and the vertex line, or takes it as an option', () => {
  const identity10 = flame(17, (r, g, b) => [r, g, b].map((i) => Math.min(64 * i, 1023)).join(' '));
  const lut = parse3dl(identity10);
  assert.equal(lut.data[4 * (16 * 289 + 16 * 17 + 16)], 1, '10-bit white is 1');
  assert.equal(lut.data[4 * 8], Math.fround(512 / 1023));
  const dark = flame(17, () => '100 100 100');
  assert.equal(parse3dl(dark).data[0], Math.fround(100 / 1023), 'never below the vertex depth');
  assert.equal(parse3dl(dark, { outputBits: 12 }).data[0], Math.fround(100 / 4095));
  assert.equal(parse3dl(flame()).data[0], Math.fround(3 / 4095), 'values above 1023 read as 12-bit');
});

test('parse3dl rejects malformed files', () => {
  const bad = [
    [42, TypeError],
    ['', TypeError],
    [flame().replace('0 64 128 192', '0 10 128 192'), TypeError],
    [flame().replace(/\n[^\n]*\n$/, '\n'), TypeError],
    [flame().replace('3 5 7', '3 5'), TypeError],
    [flame().replace('3 5 7', '3 5 -7'), TypeError],
    [flame().replace('3 5 7', '3 5 7.5'), TypeError],
    [flame(), RangeError, { outputBits: 10 }],
    [flame(), RangeError, { outputBits: 17 }],
    ['Mesh 4 12\n3DMESH\n' + flame(), TypeError],
    ['3DMESH\nMesh 4 12\n' + flame(3, undefined, '0 512 1023'), TypeError],
    [flame(2, () => '70000 0 0', '0 1023'), RangeError],
    ['0\n1 1 1\n', RangeError],
  ];
  for (const [text, type, options] of bad)
    assert.throws(() => parse3dl(text, options), type, String(text).slice(0, 40));
});

test('export3dl writes the Flame layout and round-trips a Grade and a CubeLUT', () => {
  const grade = new Grade({
      shadows: [0.02, 0, -0.01],
      highlights: [0.1, 0, -0.1],
      hueSaturation: [1.2, 1, 1, 1, 0.8, 1],
    }),
    text = export3dl(grade, { size: 17 }),
    lines = text.trimEnd().split('\n');
  assert.equal(lines[0], VERTICES);
  assert.equal(lines.length, 1 + 17 ** 3);
  const back = parse3dl(text),
    cube = parseCube(exportCube(grade, { size: 17 }));
  assert.equal(back.size, 17);
  for (let i = 0; i < cube.data.length; i++) {
    const want = Math.min(1, Math.max(0, cube.data[i]));
    assert.ok(Math.abs(back.data[i] - want) <= 0.5 / 4095 + 1e-7, `sample ${i}: ${back.data[i]} against ${want}`);
  }
  // A CubeLUT keeps its size; 16-bit codes; the vertex line at 12 bits.
  const lut = parseCube(exportCube(new HueGrade({ hueShift: 30 }), { size: 5 })),
    t16 = export3dl(lut, { inputBits: 12, outputBits: 16 });
  assert.equal(t16.split('\n')[0], '0 1024 2048 3072 4095');
  const again = parse3dl(t16);
  for (let i = 0; i < lut.data.length; i++)
    assert.ok(Math.abs(again.data[i] - Math.min(1, Math.max(0, lut.data[i]))) <= 0.5 / 65535 + 1e-7);
  for (const size of [2, 33, 65]) assert.equal(parse3dl(export3dl(new Grade(), { size })).size, size);
});

test('export3dl validates its source and options', () => {
  const lut = parseCube(exportCube(new Grade(), { size: 3 }));
  assert.throws(() => export3dl(new Grade(), { size: 66 }), RangeError);
  assert.throws(() => export3dl(new Grade(), { outputBits: 7 }), RangeError);
  assert.throws(() => export3dl(new Grade(), { inputBits: 17 }), RangeError);
  assert.throws(() => export3dl(lut, { size: 5 }), RangeError);
  assert.throws(() => export3dl({ ...lut, domainMax: new Float32Array([2, 1, 1]) }), RangeError);
  assert.throws(() => export3dl({ key: 'other', values: () => new Float32Array(4) }), TypeError);
  assert.throws(
    () => export3dl({ size: 3, data: new Float32Array(4), domainMin: lut.domainMin, domainMax: lut.domainMax }),
    TypeError,
  );
});

test('Tonemap takes a parsed .3dl LUT', () => {
  const h = gpuHarness(),
    t = Tonemap.attach(h.engine, {});
  t.setLUT(parse3dl(flame()));
  h.frame();
  const draw = h.pipelines.filter((p) => p.fragment?.module.code.includes('fn sampleLUT')).at(-1);
  assert.match(draw.fragment.module.code, /let edge=i32\(textureDimensions\(lut\)\.x\)-1;/, 'a 17-sample LUT is bound');
  t.dispose();
});
