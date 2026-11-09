import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { TABLES } from '../src/tables.ts';
import { colormap, colormapNames, cubehelix, diverging, describeColormap } from '@margoengine/sciviz';
import { linearToOklab, oklabToLinear } from '@margoengine/sciviz/colormaps';
import { SRGBToLinear as decodeSRGB } from '@margoengine/math/color';

const lightness = (rgb) => linearToOklab(...rgb.map(decodeSRGB))[0];

test('OKLab round-trips linear sRGB and maps white to L = 1 (Ottosson 2020)', () => {
  const white = linearToOklab(1, 1, 1);
  assert.ok(Math.abs(white[0] - 1) < 1e-4 && Math.abs(white[1]) < 1e-4 && Math.abs(white[2]) < 1e-4, `white ${white}`);
  for (const c of [
    [0.2, 0.5, 0.9],
    [1, 0, 0],
    [0.01, 0.02, 0.03],
  ]) {
    const back = oklabToLinear(...linearToOklab(...c));
    back.forEach((v, k) => assert.ok(Math.abs(v - c[k]) < 1e-6, `${c} -> ${back}`));
  }
});

test('cubehelix follows Green (2011): black to white, brightness monotonic, the default spiral', () => {
  assert.deepEqual(cubehelix(0), [0, 0, 0]);
  assert.deepEqual(cubehelix(1), [1, 1, 1]);
  // At t = 0.5 with the defaults, phi = 2 pi (1/6 - 0.75), a = 0.125; worked from the paper's formula.
  const phi = 2 * Math.PI * (0.5 / 3 - 1.5 * 0.5),
    a = 0.125,
    want = [
      0.5 + a * (-0.14861 * Math.cos(phi) + 1.78277 * Math.sin(phi)),
      0.5 + a * (-0.29227 * Math.cos(phi) - 0.90649 * Math.sin(phi)),
      0.5 + a * 1.97294 * Math.cos(phi),
    ];
  cubehelix(0.5).forEach((v, k) => assert.ok(Math.abs(v - want[k]) < 1e-12));
  // Green's luminance weights (0.30, 0.59, 0.11) make the grey level exactly lambda.
  for (let t = 0; t <= 1; t += 0.05) {
    const [r, g, b] = cubehelix(t),
      unclipped = 0.3 * r + 0.59 * g + 0.11 * b;
    assert.ok(Math.abs(unclipped - t) < 0.02, `luminance at ${t}: ${unclipped}`);
  }
});

test("coolwarm follows Moreland (2009): the paper's endpoints, a near-white middle, symmetric lightness", () => {
  const map = colormap('coolwarm');
  const [r0, g0, b0] = map.sample(0).map((v) => Math.round(v * 255));
  const [r1, g1, b1] = map.sample(1).map((v) => Math.round(v * 255));
  assert.deepEqual([r0, g0, b0], [59, 76, 192]);
  assert.deepEqual([r1, g1, b1], [180, 4, 38]);
  // The midpoint is unsaturated with M = 88 (CIELAB L = 88): the paper's table gives SRGB (221, 221, 221).
  const middle = map.sample(0.5).map((v) => Math.round(v * 255));
  middle.forEach((v) => assert.ok(Math.abs(v - 221) <= 2, `midpoint ${middle}`));
  for (const t of [0.1, 0.25, 0.4])
    assert.ok(Math.abs(lightness(map.sample(t)) - lightness(map.sample(1 - t))) < 0.05, `symmetric at ${t}`);
  assert.equal(diverging(0.5, [0, 0, 1], [0, 0, 1]).length, 3);
});

test('sequential maps rise monotonically in perceived lightness; the cyclic map keeps it constant and wraps', () => {
  for (const name of colormapNames) {
    const map = colormap(name),
      { kind } = describeColormap(name);
    if (kind !== 'sequential') continue;
    let last = -1;
    for (let k = 0; k <= 64; k++) {
      const L = lightness(map.sample(k / 64));
      assert.ok(L > last - 1e-9, `${name} lightness falls at ${k / 64}: ${L} after ${last}`);
      last = L;
    }
  }
  const phase = colormap('phase');
  const Ls = Array.from({ length: 16 }, (_, k) => lightness(phase.sample(k / 16)));
  assert.ok(Math.max(...Ls) - Math.min(...Ls) < 0.01, 'constant lightness');
  phase.sample(0).forEach((v, k) => assert.ok(Math.abs(v - phase.sample(1)[k]) < 1e-9, 'the ends meet'));
});

test('each sequential map passes through the colours it is named for', () => {
  // ember: purple, red, orange, yellow (red leads in the middle); glacier: blue to white; aurora: violet, teal, yellow.
  const [r, g, b] = colormap('ember').sample(0.5);
  assert.ok(r > g && r > b, `ember's middle is red-orange, got ${[r, g, b]}`);
  const [er, , eb] = colormap('ember').sample(0.2);
  assert.ok(er > 0.2 && eb > 0.15, `ember starts purple-red, got ${colormap('ember').sample(0.2)}`);
  const [, ag, ab] = colormap('aurora').sample(0.5);
  assert.ok(ag > ab * 0.8, `aurora's middle is teal-green, got ${colormap('aurora').sample(0.5)}`);
  const [gr, gg, gb] = colormap('glacier').sample(0.3);
  assert.ok(gb > gr && gb > gg * 0.9, `glacier is blue, got ${[gr, gg, gb]}`);
});

test('tables, reversed maps, CSS gradients and custom stops interpolated in OKLab', () => {
  const map = colormap('aurora');
  const table = map.table(256);
  assert.equal(table.length, 1024);
  assert.equal(table[3], 1);
  const linear = map.table(4, { linear: true });
  assert.ok(Math.abs(linear[0] - decodeSRGB(map.sample(0)[0])) < 1e-7);
  assert.deepEqual(map.reversed().sample(0.2), map.sample(0.8));
  assert.match(map.css(4), /^linear-gradient\(to right, rgb\(/);
  const custom = colormap(['#000000', '#ffffff']);
  assert.deepEqual(custom.sample(0), [0, 0, 0]);
  assert.ok(Math.abs(lightness(custom.sample(0.5)) - 0.5) < 1e-6, 'OKLab midpoint of black and white has L = 0.5');
  const paired = colormap([
    [0, '#ff0000'],
    [0.25, '#00ff00'],
    [1, '#0000ff'],
  ]);
  assert.deepEqual(
    paired.sample(0.25).map((v) => Math.round(v * 255)),
    [0, 255, 0],
  );
  assert.throws(
    () => colormap('viridis-ish'),
    (e) => e instanceof TypeError && /aurora/.test(e.message),
  );
  assert.throws(() => colormap(['#fff']), TypeError);
  assert.throws(() => map.table(1), RangeError);
});

test('the recorded standard maps match their published tables (viridis family CC0, cividis PLOS ONE S2)', () => {
  // [t, published row] pairs: first, middle (entry 128 of 256) and last entries at their published precision.
  const known = {
    viridis: [
      [0, [0.267004, 0.004874, 0.329415]],
      [128 / 255, [0.127568, 0.566949, 0.550556]],
      [1, [0.993248, 0.906157, 0.143936]],
    ],
    magma: [
      [0, [0.001462, 0.000466, 0.013866]],
      [128 / 255, [0.716387, 0.214982, 0.47529]],
      [1, [0.987053, 0.991438, 0.749504]],
    ],
    inferno: [
      [0, [0.001462, 0.000466, 0.013866]],
      [128 / 255, [0.735683, 0.215906, 0.330245]],
      [1, [0.988362, 0.998364, 0.644924]],
    ],
    plasma: [
      [0, [0.050383, 0.029803, 0.527975]],
      [128 / 255, [0.798216, 0.280197, 0.469538]],
      [1, [0.940015, 0.975158, 0.131326]],
    ],
    cividis: [
      [0, [0, 0.1262, 0.3015]],
      [128 / 255, [0.4897, 0.4856, 0.4714]],
      [1, [1, 0.9169, 0.2731]],
    ],
  };
  for (const [name, rows] of Object.entries(known)) {
    assert.equal(describeColormap(name).kind, 'sequential');
    for (const [t, want] of rows)
      colormap(name)
        .sample(t)
        .forEach((v, c) =>
          assert.ok(Math.abs(v - want[c]) <= 2e-15, `${name}(${t}) = ${colormap(name).sample(t)}, want ${want}`),
        );
  }
  // Between entries the map interpolates: halfway between viridis entries 0 and 1.
  const a = colormap('viridis').sample(0),
    b = colormap('viridis').sample(1 / 255),
    half = colormap('viridis').sample(0.5 / 255);
  half.forEach((v, c) => assert.ok(Math.abs(v - (a[c] + b[c]) / 2) < 1e-6));
});

// SHA-256 of JSON.stringify(rows), parsed from the authors' published data, independently of Margo's table reader.
// Sources and original file digests are recorded in docs/size-restore.md (finding 8).
const PUBLISHED_HASHES = {
  viridis: '7c3d75c98bc3fd26f8adbe0a82d600f04bab92d34aa69ed80e3abb28efdf3c8c',
  magma: 'aacb32ad4805d962b7a1d42041bced982453878bd8220a516bd94ccb9ea9c45a',
  inferno: 'ff9305fd6f5d01debe399a748f3e5accf0ab776fec00d6dc8fac0606f6f3fad8',
  plasma: 'bb6fd55156bcb85198928b92ccc3ab22c761385ce1c0f8b9b3eddad5c587bc26',
  cividis: '5168c11013409c66c8b297dc9fab2587c97ae4565e37477517784d2166ef62c0',
};

test('all 1280 standard rows preserve the complete published decimals and synchronous sampling', () => {
  for (const [name, rows] of Object.entries(TABLES)) {
    assert.equal(rows.length, 256);
    assert.equal(createHash('sha256').update(JSON.stringify(rows)).digest('hex'), PUBLISHED_HASHES[name], name);
    const map = colormap(name);
    for (let k = 0; k < rows.length; k++) {
      const sample = map.sample(k / 255);
      rows[k].forEach((v, c) => assert.ok(Math.abs(sample[c] - v) <= 2e-15, name + ' row ' + k + ' channel ' + c));
    }
    const first = map.sample(0);
    first[0] = -1;
    assert.deepEqual(map.sample(0), rows[0], 'sampling does not expose mutable table storage');
    assert.deepEqual(map.sample(-1), rows[0]);
    assert.deepEqual(map.sample(2), rows[255]);
    assert.deepEqual(map.sample(NaN), rows[0]);
  }
});

test('standard maps interpolate before float32 conversion, including reversed and linear-light GPU tables', () => {
  for (const [name, rows] of Object.entries(TABLES)) {
    const map = colormap(name),
      reversed = map.reversed();
    for (let k = 0; k < 255; k++) {
      const t = (k + 0.5) / 255;
      const actual = map.sample(t),
        backwards = reversed.sample(1 - t);
      rows[k].forEach((v, c) => {
        const expected = (v + rows[k + 1][c]) / 2;
        assert.ok(Math.abs(actual[c] - expected) <= 2e-15, name + ' interpolated row ' + k);
        assert.ok(Math.abs(backwards[c] - expected) <= 2e-15, name + ' reversed row ' + k);
      });
    }
    const srgb = map.table(),
      linear = map.table(256, { linear: true });
    rows.forEach((row, k) =>
      row.forEach((v, c) => {
        assert.equal(srgb[4 * k + c], Math.fround(v), name + ' sRGB table');
        const decoded = v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
        assert.equal(linear[4 * k + c], Math.fround(decoded), name + ' linear table');
      }),
    );
    for (let k = 0; k < 256; k++) {
      assert.equal(srgb[4 * k + 3], 1);
      assert.equal(linear[4 * k + 3], 1);
    }
  }
});
