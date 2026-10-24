import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { alphaToSdf, squaredDistanceTransform, sdfDistance, SDF_DEFAULTS } from '../dist/index.js';

const vectors = JSON.parse(readFileSync(new URL('./fixtures/text-sdf.json', import.meta.url), 'utf8'));
const params = (p) => (p === 'default' ? undefined : p);

test('SDF defaults', () => {
  assert.deepEqual({ ...SDF_DEFAULTS }, vectors.SDF_DEFAULTS);
});

test('squared distance transform reproduces the recorded vectors exactly', () => {
  for (const { width, height, input, output } of vectors.squaredDistanceTransform) {
    const grid = Float64Array.from(input);
    assert.equal(squaredDistanceTransform(grid, width, height), grid);
    output.forEach((expected, i) => {
      if (expected >= 1e20) assert.ok(grid[i] >= 1e20, `${width}x${height} cell ${i} stays empty`);
      else assert.ok(Math.abs(grid[i] - expected) <= 1e-9 * Math.max(1, expected), `${width}x${height} cell ${i}`);
    });
  }
});

test('squared distance transform validates its size', () => {
  assert.throws(() => squaredDistanceTransform(new Float64Array(3), 2, 2), RangeError);
  assert.throws(() => squaredDistanceTransform(new Float64Array(4), 1.5, 2), RangeError);
  assert.throws(() => squaredDistanceTransform(new Float64Array(4), 2, -1), RangeError);
  const empty = new Float64Array(0);
  assert.equal(squaredDistanceTransform(empty, 0, 0), empty);
});

test('alphaToSdf on binary images matches the recorded bytes', () => {
  for (const c of vectors.alphaToSdfBinary)
    assert.deepEqual([...alphaToSdf(c.alpha, c.width, c.height, params(c.params))], c.sdf, c.name);
});

// Brute-force definition for a binary image: distance between centres to the nearest pixel of the other kind.
function bruteForceBinary(alpha, width, height) {
  const d = new Float64Array(width * height);
  for (let q = 0; q < d.length; q++) {
    let best = Infinity;
    for (let p = 0; p < d.length; p++)
      if (alpha[p] > 0 !== alpha[q] > 0)
        best = Math.min(best, Math.hypot((p % width) - (q % width), Math.floor(p / width) - Math.floor(q / width)));
    d[q] = alpha[q] > 0 ? -best : best;
  }
  return d;
}

test('alphaToSdf on random binary images equals the brute-force centre distances', () => {
  let seed = 11;
  const rand = () => (seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32;
  const p = { radius: 5, cutoff: 0.3 };
  for (const [width, height, density] of [
    [9, 7, 0.1],
    [16, 11, 0.4],
    [5, 19, 0.03],
  ]) {
    const alpha = Uint8Array.from({ length: width * height }, () => (rand() < density ? 255 : 0));
    alpha[0] = 255;
    alpha[alpha.length - 1] = 0;
    const field = alphaToSdf(alpha, width, height, p),
      reference = bruteForceBinary(alpha, width, height);
    reference.forEach((d, i) => {
      const exact = 255 - 255 * (d / p.radius + p.cutoff);
      assert.equal(field[i], Math.min(255, Math.max(0, Math.round(exact))), `${width}x${height} pixel ${i}`);
    });
  }
});

function errorVs(field, reference, p) {
  let max = 0,
    sum = 0,
    count = 0;
  reference.forEach((d, i) => {
    if (field[i] === 0 || field[i] === 255) return;
    const e = Math.abs(sdfDistance(field[i], p) - d);
    max = Math.max(max, e);
    sum += e;
    count++;
  });
  return { max, mean: sum / count, count };
}

test('alphaToSdf on antialiased disks stays within tolerance of the analytic distance', () => {
  for (const c of vectors.alphaToSdfAntialiased) {
    const field = alphaToSdf(c.alpha, c.width, c.height, c.params),
      { radius, cutoff } = c.params,
      analytic = c.analyticSignedDistanceAtPixelCentres,
      { max, mean, count } = errorVs(field, analytic, c.params);
    // Measured 0.200 / 0.036 px (r 7.3) and 0.254 / 0.027 px (r 10.6); the spec allows 0.6 / 0.25.
    assert.ok(count > 100 && max <= 0.3 && mean <= 0.05, `${c.name}: max ${max}, mean ${mean}`);
    analytic.forEach((d, i) => {
      if (d <= -cutoff * radius - 1) assert.equal(field[i], 255, `${c.name} pixel ${i} saturates inside`);
      if (d >= (1 - cutoff) * radius + 1) assert.equal(field[i], 0, `${c.name} pixel ${i} saturates outside`);
    });
  }
});

// Antialiased shape from 16 x 16 supersampled coverage, and the brute-force reference: exact Euclidean distance from
// each pixel centre to the nearest of dense samples along the true outline, negative inside.
function shapeError(width, height, inside, outline, p) {
  const n = 16,
    alpha = new Uint8Array(width * height),
    reference = new Float64Array(width * height);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      let covered = 0;
      for (let j = 0; j < n; j++)
        for (let i = 0; i < n; i++) if (inside(x + (i + 0.5) / n, y + (j + 0.5) / n)) covered++;
      alpha[y * width + x] = Math.round((255 * covered) / (n * n));
      let best = Infinity;
      for (const [sx, sy] of outline) best = Math.min(best, Math.hypot(x + 0.5 - sx, y + 0.5 - sy));
      reference[y * width + x] = inside(x + 0.5, y + 0.5) ? -best : best;
    }
  return errorVs(alphaToSdf(alpha, width, height, p), reference, p);
}
const ellipse = (cx, cy, a, b) => [
  (x, y) => ((x - cx) / a) ** 2 + ((y - cy) / b) ** 2 < 1,
  Array.from({ length: 8000 }, (_, k) => [
    cx + a * Math.cos((k * Math.PI) / 4000),
    cy + b * Math.sin((k * Math.PI) / 4000),
  ]),
];
const polygon = (corners) => {
  const inside = (x, y) => {
    let odd = false;
    for (let i = 0, j = corners.length - 1; i < corners.length; j = i++) {
      const [xi, yi] = corners[i],
        [xj, yj] = corners[j];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) odd = !odd;
    }
    return odd;
  };
  const outline = [];
  corners.forEach(([x0, y0], i) => {
    const [x1, y1] = corners[(i + 1) % corners.length];
    for (let t = 0; t < 2000; t++) outline.push([x0 + ((x1 - x0) * t) / 2000, y0 + ((y1 - y0) * t) / 2000]);
  });
  return [inside, outline];
};

test('alphaToSdf matches a brute-force distance to the true outline on antialiased shapes', () => {
  const p = { radius: 6, cutoff: 0.25 };
  // Max errors measured: ellipse 0.30, thin ellipse 0.27, rotated rectangle 0.33, triangle 0.54 px (its sharp
  // corners); means 0.03 to 0.06 px.
  for (const [name, width, height, shape, maxError] of [
    ['ellipse', 40, 30, ellipse(20.3, 14.8, 13.1, 8.4), 0.4],
    ['thin ellipse', 40, 20, ellipse(20.2, 10.1, 15.3, 2.7), 0.4],
    [
      'rotated rectangle',
      36,
      36,
      polygon([
        [6.2, 14.1],
        [24.7, 5.3],
        [30.1, 21.9],
        [11.6, 30.4],
      ]),
      0.4,
    ],
    [
      'triangle',
      36,
      36,
      polygon([
        [5.3, 30.2],
        [30.6, 28.1],
        [17.4, 4.7],
      ]),
      0.6,
    ],
  ]) {
    const { max, mean } = shapeError(width, height, ...shape, p);
    assert.ok(max <= maxError && mean <= 0.1, `${name}: max ${max}, mean ${mean}`);
  }
});

test('half coverage puts the edge through the pixel centre', () => {
  const alpha = Uint8Array.from([255, 255, 128, 0, 0]),
    field = alphaToSdf(alpha, 5, 1, { radius: 4, cutoff: 0.5 });
  assert.ok(Math.abs(sdfDistance(field[2], { radius: 4, cutoff: 0.5 })) < 0.02, `edge byte ${field[2]}`);
  assert.ok(field[1] > field[2] && field[2] > field[3]);
});

test('alphaToSdf reads interleaved channels and writes into out', () => {
  const { width, height, params: p } = vectors.interleaved;
  const alpha = Uint8Array.from({ length: width * height }, (_, i) =>
      (i % width) + Math.floor(i / width) > 4 ? 255 : (i * 37) % 256,
    ),
    rgba = new Uint8Array(width * height * 4).fill(77);
  alpha.forEach((a, i) => (rgba[i * 4 + 3] = a));
  const out = new Uint8Array(width * height);
  assert.equal(alphaToSdf(rgba, width, height, p, 4, 3, out), out);
  assert.deepEqual(out, alphaToSdf(alpha, width, height, p));
  // The recorded binary case, read from RGBA.
  assert.deepEqual(vectors.interleaved.rgbaStride4Channel3, vectors.interleaved.single);
});

test('alphaToSdf saturates images with only one side', () => {
  assert.deepEqual([...alphaToSdf(new Uint8Array(6), 3, 2)], [0, 0, 0, 0, 0, 0]);
  assert.deepEqual([...alphaToSdf(new Uint8Array(6).fill(255), 3, 2)], [255, 255, 255, 255, 255, 255]);
});

test('alphaToSdf validates parameters and data length', () => {
  const bad = [
    { radius: 0, cutoff: 0.25 },
    { radius: Number.NaN, cutoff: 0.25 },
    { radius: 4, cutoff: 1.5 },
    { radius: 4, cutoff: -0.1 },
  ];
  for (const p of bad) assert.throws(() => alphaToSdf(new Uint8Array(4), 2, 2, p), RangeError);
  assert.throws(() => alphaToSdf(new Uint8Array(3), 2, 2), RangeError);
  assert.throws(() => alphaToSdf(new Uint8Array(15), 2, 2, undefined, 4, 3), RangeError);
  assert.equal(alphaToSdf(new Uint8Array(16), 2, 2, undefined, 4, 3).length, 4);
  assert.equal(alphaToSdf(new Uint8Array(0), 0, 0).length, 0);
});

test('sdfDistance inverts the byte mapping', () => {
  for (const { value, params: p, out } of vectors.sdfDistance)
    assert.ok(Math.abs(sdfDistance(value, params(p)) - out) <= 1e-12, `byte ${value}`);
});
