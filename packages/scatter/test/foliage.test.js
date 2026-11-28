// foliageLODs (KB-SCATTER-TEX2): a needle crown made lighter keeps its silhouette. Decimating a scanned fir removed
// 90% to 99% of its needle area and 75% to 98% of its silhouette, so it drew as a thin skeleton.
import test from 'node:test';
import assert from 'node:assert/strict';
import { foliageLODs } from '@margoengine/scatter/foliage';

function random(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}
const unit = (v) => {
  const l = Math.hypot(...v);
  return v.map((x) => x / l);
};
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

// A conical crown of flat needles 6 cm long and 3 mm wide, two triangles and four own vertices each.
function crown(needles = 6000) {
  const next = random(7),
    positions = [],
    normals = [],
    uvs = [],
    indices = [];
  for (let n = 0; n < needles; n++) {
    const h = next(),
      r = (1 - h) * 1.2 * Math.sqrt(next()),
      a = next() * 2 * Math.PI,
      c = [r * Math.cos(a), h * 4, r * Math.sin(a)],
      along = unit([next() - 0.5, next() - 0.5, next() - 0.5]),
      side = unit(cross(along, unit([next() - 0.5, next() - 0.5, next() - 0.5]))),
      normal = cross(along, side),
      first = positions.length / 3;
    for (const [i, j] of [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ]) {
      positions.push(...c.map((v, k) => v + along[k] * 0.03 * i + side[k] * 0.0015 * j));
      normals.push(...normal);
      uvs.push(n / needles, (j + 1) / 2);
    }
    indices.push(first, first + 1, first + 2, first, first + 2, first + 3);
  }
  return { positions, normals, uvs, indices };
}
function area({ positions: p, indices: x }) {
  let sum = 0;
  for (let t = 0; t < x.length; t += 3) {
    const [a, b, c] = [0, 1, 2].map((k) => [0, 1, 2].map((j) => p[x[t + k] * 3 + j]));
    sum +=
      0.5 *
      Math.hypot(
        ...cross(
          b.map((v, k) => v - a[k]),
          c.map((v, k) => v - a[k]),
        ),
      );
  }
  return sum;
}
// Share of a 5 mm pixel grid the mesh covers seen along z (point samples at pixel centres).
function coverage({ positions: p, indices: x }, pixel = 0.005) {
  const w = Math.ceil(3 / pixel),
    h = Math.ceil(4.2 / pixel),
    hit = new Uint8Array(w * h);
  for (let t = 0; t < x.length; t += 3) {
    const q = [0, 1, 2].map((k) => [(p[x[t + k] * 3] + 1.5) / pixel, (p[x[t + k] * 3 + 1] + 0.1) / pixel]);
    const [[ax, ay], [bx, by], [cx, cy]] = q,
      d = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    if (!d) continue;
    for (let j = Math.max(0, Math.floor(Math.min(ay, by, cy))); j <= Math.min(h - 1, Math.max(ay, by, cy)); j++)
      for (let i = Math.max(0, Math.floor(Math.min(ax, bx, cx))); i <= Math.min(w - 1, Math.max(ax, bx, cx)); i++) {
        const x0 = i + 0.5,
          y0 = j + 0.5,
          u = ((bx - x0) * (cy - y0) - (by - y0) * (cx - x0)) / d,
          v = ((cx - x0) * (ay - y0) - (cy - y0) * (ax - x0)) / d;
        if (u >= 0 && v >= 0 && u + v <= 1) hit[j * w + i] = 1;
      }
  }
  let n = 0;
  for (const v of hit) n += v;
  return n / hit.length;
}

test('foliageLODs keeps the silhouette that removing needles loses', () => {
  const source = crown(),
    full = coverage(source);
  const levels = foliageLODs(source, { triangles: [6000, 1200, 240] });
  assert.deepEqual(
    levels.map((l) => l.triangles),
    [6000, 1200, 240],
  );
  assert.deepEqual(
    levels.map((l) => l.elements),
    [3000, 600, 120],
  );
  for (const level of levels) {
    assert.ok(Math.abs(level.coverage - 1) <= 0.011, `coverage ${level.coverage}`);
    assert.ok(Math.abs(level.area / area(level) - 1) < 1e-5);
    assert.equal(level.indices.length, level.triangles * 3);
    assert.equal(level.uvs.length / 2, level.positions.length / 3);
  }
  // The same needles removed without growth: the skeleton.
  const bare = { positions: source.positions, indices: source.indices.slice(0, 240 * 3) };
  const [near, middle, far] = levels.map((l) => coverage(l));
  // Seen along z with the test's own raster (5 mm cells, finer than the 8 mm cells foliageLODs matches on).
  for (const [name, seen] of [
    ['near', near],
    ['middle', middle],
    ['far', far],
  ])
    assert.ok(seen > 0.88 * full && seen < 1.12 * full, `${name} ${seen} of ${full}`);
  assert.ok(coverage(bare) < 0.1 * full, `bare ${coverage(bare)} of ${full}`);
});

test('foliageLODs: nested levels, widened needles, kept uvs and normals, seeded and repeatable', () => {
  const source = crown(2000),
    kept = area(source),
    [a, b] = foliageLODs(source, { triangles: [1000, 200] });
  const ids = (level) => new Set(Array.from({ length: level.uvs.length / 2 }, (_, i) => level.uvs[i * 2]));
  assert.ok(
    [...ids(b)].every((id) => ids(a).has(id)),
    'the far level holds needles of the middle level only',
  );
  // A needle grows 8 times in area (4 times fewer needles of 500 triangles).
  const edge = (p, i, j) => Math.hypot(...[0, 1, 2].map((k) => p[i * 3 + k] - p[j * 3 + k]));
  // 6 cm by 3 mm is 20 times longer than wide: 8 times the area widens it 5 times (to 4), then both ways.
  const [thin] = foliageLODs(source, { triangles: [500], area: kept }),
    k = Math.sqrt(8 / 5);
  assert.ok(Math.abs(edge(thin.positions, 0, 1) - 0.06 * k) < 1e-5, 'length');
  assert.ok(Math.abs(edge(thin.positions, 1, 2) - 0.015 * k) < 1e-4, 'width');
  const [wide] = foliageLODs(source, { triangles: [500], area: kept, slender: 1 });
  assert.ok(Math.abs(area(wide) / kept - 1) < 0.002, `area ${area(wide)} of ${kept}`);
  assert.ok(Math.abs(edge(wide.positions, 0, 1) - 0.06) < 1e-5, 'length kept');
  assert.ok(Math.abs(edge(wide.positions, 1, 2) - 0.024) < 1e-4, 'width times 8');
  for (let i = 0; i < wide.normals.length; i += 3) {
    assert.ok(Math.abs(Math.hypot(wide.normals[i], wide.normals[i + 1], wide.normals[i + 2]) - 1) < 1e-5);
  }
  assert.deepEqual(
    foliageLODs(source, { triangles: [200], seed: 5 }),
    foliageLODs(source, { triangles: [200], seed: 5 }),
  );
  assert.notDeepEqual(
    foliageLODs(source, { triangles: [200], seed: 5 })[0].uvs,
    foliageLODs(source, { triangles: [200], seed: 6 })[0].uvs,
  );
});

test('foliageLODs: a level of everything is the source, and a given area is met', () => {
  const source = crown(100),
    [same] = foliageLODs(source, { triangles: [100000] });
  assert.deepEqual(same.positions, Float32Array.from(source.positions));
  assert.deepEqual(Array.from(same.indices), source.indices);
  assert.equal(same.normals.length, source.normals.length);
  const [grown] = foliageLODs(source, { triangles: [40], area: area(source) * 3 });
  assert.ok(Math.abs(area(grown) / (area(source) * 3) - 1) < 0.002);
});

test('foliageLODs: a stem among the needles keeps its size while the needles grow', () => {
  const m = crown(200),
    first = m.positions.length / 3;
  // A 4 m by 4 cm stem up the middle, 111 times a needle's area.
  m.positions.push(-0.02, 0, 0, 0.02, 0, 0, 0.02, 4, 0, -0.02, 4, 0);
  m.normals.push(0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1);
  m.uvs.push(2, 0, 2, 0, 2, 0, 2, 0);
  m.indices.push(first, first + 1, first + 2, first, first + 2, first + 3);
  let checked = 0;
  for (let seed = 0; seed < 40; seed++) {
    const [level] = foliageLODs(m, { triangles: [200], seed, area: area(m) * 2 });
    for (let i = 0; i < level.uvs.length / 2; i += 4) {
      if (level.uvs[i * 2] !== 2) continue;
      checked++;
      const ys = [0, 1, 2, 3].map((k) => level.positions[(i + k) * 3 + 1]);
      assert.ok(Math.abs(Math.max(...ys) - Math.min(...ys) - 4) < 1e-5, 'the stem keeps its length');
    }
  }
  assert.ok(checked > 5, `the stem was kept in ${checked} of 40 seeds`);
});

test('foliageLODs refuses malformed input with coded errors', () => {
  const m = crown(10),
    code = (type) => (e) => e instanceof type && /errors#scatter/.test(`${e.message} ${e.help ?? ''} ${e.url ?? ''}`);
  assert.throws(() => foliageLODs(null, { triangles: [4] }), code(TypeError));
  assert.throws(() => foliageLODs({ ...m, normals: [] }, { triangles: [4] }), code(TypeError));
  assert.throws(() => foliageLODs({ ...m, uvs: [0] }, { triangles: [4] }), code(TypeError));
  assert.throws(() => foliageLODs(m, {}), code(TypeError));
  for (const triangles of [[], [4, 6], [0], [1.5]])
    assert.throws(() => foliageLODs(m, { triangles }), code(RangeError));
  assert.throws(() => foliageLODs(m, { triangles: [1] }), code(RangeError));
  assert.throws(() => foliageLODs(m, { triangles: [4], area: 0 }), code(RangeError));
  assert.throws(() => foliageLODs(m, { triangles: [4], seed: -1 }), code(RangeError));
  assert.throws(() => foliageLODs(m, { triangles: [4], slender: 0.5 }), code(RangeError));
  assert.throws(() => foliageLODs({ ...m, indices: [0, 1, 99] }, { triangles: [4] }), code(RangeError));
  assert.throws(() => foliageLODs({ ...m, positions: m.positions.map(() => 0) }, { triangles: [4] }), code(RangeError));
});
