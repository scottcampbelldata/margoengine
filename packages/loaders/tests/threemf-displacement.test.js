// parse3MFDisplacement's surface against the formulas of the 3MF Displacement Extension specification
// (https://github.com/3MFConsortium/spec_displacement): the moved point p + d f n (chapter 2), d = texture * height +
// offset, the sampling and tile styles, and the joins between adjacent triangles (section 5.2).
import test from 'node:test';
import assert from 'node:assert/strict';
import { parse3MF } from '../dist/index.js';
import { parse3MFDisplacement } from '../dist/threemf-displacement.js';
import { box, closed, grey, volume, vertexXML, zip } from './threemf-surface.js';

const NS = 'http://schemas.3mf.io/3dmanufacturing/displacement/2023/10';
const cube = box([0, 0, 0], [10, 10, 10]);
const close = (actual, expected, epsilon = 1e-3) =>
  assert.ok(Math.abs(actual - expected) < epsilon, `${actual} is not ${expected}`);

/**
 * A package of the cube as a displacement mesh. `displaced` maps a triangle to `{ group, d: [d1, d2, d3] }`;
 * `groups` are `{ vectors, coords, height, offset }` over the one map.
 */
function pack({ rows, map = '', groups, displaced, resources = '', paint = () => '' }) {
  const body = groups
    .map(
      ({ vectors, coords, height, offset = 0 }, i) =>
        `<d:normvectorgroup id="${10 + i}">${vectors
          .map(([x, y, z]) => `<d:normvector x="${x}" y="${y}" z="${z}"/>`)
          .join(
            '',
          )}</d:normvectorgroup><d:disp2dgroup id="${20 + i}" dispid="1" nid="${10 + i}" height="${height}" offset="${offset}">${coords
          .map(([u, v, n, f = 1]) => `<d:disp2dcoord u="${u}" v="${v}" n="${n}" f="${f}"/>`)
          .join('')}</d:disp2dgroup>`,
    )
    .join('');
  const triangles = cube.triangles
    .map(([a, b, c], t) => {
      const used = displaced[t],
        d = used ? ` did="${20 + used.group}" d1="${used.d[0]}" d2="${used.d[1]}" d3="${used.d[2]}"` : '';
      return `<d:triangle v1="${a}" v2="${b}" v3="${c}"${d} ${paint(t)}/>`;
    })
    .join('');
  const xml = `<model unit="millimeter" xmlns:d="${NS}" requiredextensions="d"><resources>${resources}<d:displacement2d id="1" path="/3D/Textures/map.png" ${map}/>${body}<object id="9" type="model"><d:displacementmesh><d:vertices>${vertexXML(
    cube.vertices,
    'd:',
  )}</d:vertices><d:triangles>${triangles}</d:triangles></d:displacementmesh></object></resources><build><item objectid="9"/></build></model>`;
  return zip({ '3D/3dmodel.model': xml, '3D/Textures/map.png': grey(rows) });
}

/** The top face (triangles 2 and 3: corners 4 5 6 and 4 6 7) with u = x / 10 and v = y / 10, moved along +z. */
const topCoords = [
  [0, 0, 0],
  [1, 0, 0],
  [1, 1, 0],
  [0, 1, 0],
];
const top = (group = 0) => ({ 2: { group, d: [0, 1, 2] }, 3: { group, d: [0, 2, 3] } });
const up = { vectors: [[0, 0, 1]], coords: topCoords };
const file = { units: 'file' };
const heights = (mesh) => {
  const out = [];
  for (let v = 0; v < mesh.positions.length; v += 3) out.push([...mesh.positions.subarray(v, v + 3)]);
  return out;
};

test('a flat map moves a face by texture * height + offset and walls join it to its neighbours', async () => {
  // texture = 51 / 255 = 0.2, d = 0.2 * 4 + 1 = 1.8.
  const input = pack({ rows: [[51]], groups: [{ ...up, height: 4, offset: 1 }], displaced: top() }),
    read = await parse3MFDisplacement(input, file);
  close(volume(read), 1000 + 100 * 1.8);
  closed(read);
  close(Math.max(...heights(read).map((p) => p[2])), 11.8);
  assert.ok(read.groups.every((g) => g.displaced));
  // The base triangles stay beside the surface, and tessellate: false gives the old result.
  assert.equal(read.meshes[0].indices.length, 36);
  const base = await parse3MFDisplacement(input, { ...file, tessellate: false });
  assert.deepEqual([...base.indices], [...(await parse3MF(input, file)).indices]);
  close(volume(base), 1000);
});

/** The specification's sampling, written from its formulas: image rows run down, texel centres at halves. */
function reference(rows, u, v, { tileU = 'wrap', tileV = 'wrap', filter = 'linear' } = {}) {
  if ((tileU === 'none' && (u < 0 || u > 1)) || (tileV === 'none' && (v < 0 || v > 1))) return null;
  const H = rows.length,
    W = rows[0].length;
  const tile = (style, x, L) => {
    if (style === 'clamp') return Math.min(L - 1, Math.max(x, 0));
    if (style === 'wrap') return x - Math.floor(x / L) * L;
    if (style === 'mirror')
      return Math.abs(Math.floor(x / L)) % 2 === 0 ? x - Math.floor(x / L) * L : (Math.floor(x / L) + 1) * L - x - 1;
    return x >= 0 && x < L ? x : null;
  };
  const C = (i, j) => {
    const a = tile(tileV, i, H),
      b = tile(tileU, j, W);
    return a === null || b === null ? 0 : rows[a][b] / 255;
  };
  const ic = (1 - v) * H - 0.5,
    jc = u * W - 0.5;
  if (filter === 'nearest') return C(Math.round(ic), Math.round(jc));
  const i = Math.floor(ic),
    j = Math.floor(jc),
    a = ic - i,
    b = jc - j;
  return C(i, j) * (1 - a) * (1 - b) + C(i, j + 1) * (1 - a) * b + C(i + 1, j) * a * (1 - b) + C(i + 1, j + 1) * a * b;
}

test('every sampled point follows the filter and tile styles', async () => {
  const rows = [
    [0, 60, 120, 255],
    [30, 90, 180, 10],
    [200, 5, 45, 90],
  ];
  // u and v run from -1 to 2, past the picture on every side.
  const coords = topCoords.map(([u, v, n]) => [u * 3 - 1, v * 3 - 1, n]);
  for (const style of [
    { tileU: 'wrap', tileV: 'mirror' },
    { tileU: 'clamp', tileV: 'wrap' },
    { tileU: 'mirror', tileV: 'clamp' },
    { tileU: 'none', tileV: 'none' },
    { tileU: 'wrap', tileV: 'wrap', filter: 'nearest' },
  ]) {
    const map = `tilestyleu="${style.tileU}" tilestylev="${style.tileV}" filter="${style.filter ?? 'linear'}"`,
      read = await parse3MFDisplacement(
        pack({ rows, map, groups: [{ vectors: [[0, 0, 1]], coords, height: 2, offset: 0.5 }], displaced: top() }),
        file,
      );
    let moved = 0;
    for (const [x, y, z] of heights(read)) {
      if (z <= 0) continue;
      const u = (x / 10) * 3 - 1,
        v = (y / 10) * 3 - 1,
        sample = reference(rows, u, v, style),
        expected = 10 + (sample === null ? 0 : sample * 2 + 0.5);
      // A point of the displaced face, or of the base edge under its walls.
      if (Math.abs(z - 10) < 1e-6 && (x === 0 || x === 10 || y === 0 || y === 10)) continue;
      close(z, expected);
      moved++;
    }
    // Three tiles of four by three texels need at least that many samples each way.
    assert.ok(moved > 12 * 9, `${style.tileU}: ${moved} points`);
    closed(read);
  }
});

test('factors and interpolated vectors scale and turn the displacement', async () => {
  // f goes from 0 at x = 0 to 1 at x = 10, so d f = 2 x / 10.
  const ramp = topCoords.map(([u, v, n]) => [u, v, n, u]),
    read = await parse3MFDisplacement(
      pack({ rows: [[255]], groups: [{ vectors: [[0, 0, 1]], coords: ramp, height: 2 }], displaced: top() }),
      file,
    );
  close(volume(read), 1000 + 100 * 1);
  closed(read);
  // The vectors lean 45 degrees toward -x at x = 0 and +x at x = 10; between, their normalized mix is used.
  const lean = topCoords.map(([u, v]) => [u, v, u]),
    vectors = [
      [-1, 0, 1],
      [1, 0, 1],
    ],
    curved = await parse3MFDisplacement(
      pack({ rows: [[255]], groups: [{ vectors, coords: lean, height: 2 }], displaced: top() }),
      { ...file, samplesPerTexel: 8 },
    ),
    s = Math.SQRT1_2;
  let checked = 0;
  for (let x = 0; x <= 10; x += 1.25) {
    const a = x / 10,
      n = [-s * (1 - a) + s * a, s],
      length = Math.hypot(...n),
      expected = [x + (2 * n[0]) / length, 10 + (2 * n[1]) / length];
    if (
      heights(curved).some(
        (p) => p[1] === 0 && Math.abs(p[0] - expected[0]) < 1e-4 && Math.abs(p[2] - expected[1]) < 1e-4,
      )
    )
      checked++;
  }
  assert.equal(checked, 9);
  closed(curved);
});

test('sides that share vectors join directly, and sides that do not join through the base edge', async () => {
  // The two top triangles use groups of the same vector and different heights: a step along the diagonal.
  const step = await parse3MFDisplacement(
    pack({
      rows: [[255]],
      groups: [
        { ...up, height: 1 },
        { ...up, height: 3 },
      ],
      displaced: { 2: { group: 0, d: [0, 1, 2] }, 3: { group: 1, d: [0, 2, 3] } },
    }),
    file,
  );
  close(volume(step), 1000 + 50 * 1 + 50 * 3);
  closed(step);
  const diagonal = (mesh) => heights(mesh).filter(([x, y]) => x === 5 && y === 5);
  assert.deepEqual(
    diagonal(step)
      .map((p) => p[2])
      .sort((a, b) => a - b),
    [11, 13],
    'no wall goes down to the base edge',
  );
  // The top moves along +z and the +x face (triangles 10 and 11) along +x: both come back to the edge between them.
  const side = {
      vectors: [[1, 0, 0]],
      coords: [
        [0, 0, 0],
        [1, 0, 0],
        [1, 1, 0],
        [0, 1, 0],
      ],
      height: 3,
    },
    both = await parse3MFDisplacement(
      pack({
        rows: [[255]],
        groups: [{ ...up, height: 2 }, side],
        displaced: { ...top(), 10: { group: 1, d: [0, 1, 2] }, 11: { group: 1, d: [0, 2, 3] } },
      }),
      file,
    );
  close(volume(both), 1000 + 100 * 2 + 100 * 3);
  closed(both);
  assert.ok(
    heights(both).some(([x, , z]) => x === 10 && z === 10),
    'the base edge is part of the surface',
  );
});

test('triangles follow the map resolution, share every edge and keep their base colours', async () => {
  const rows = Array.from({ length: 16 }, (_, i) => Array.from({ length: 16 }, (_, j) => ((i + j) % 2 ? 200 : 0))),
    // The top face runs from red at x = 0 to blue at x = 10; the rest is red.
    resources = '<m:colorgroup id="2"><m:color color="#FF0000"/><m:color color="#0000FF"/></m:colorgroup>',
    corner = [
      [0, 1, 1],
      [0, 1, 0],
    ];
  const input = pack({
    rows,
    map: 'filter="nearest"',
    groups: [{ ...up, height: 1 }],
    displaced: top(),
    resources,
    paint: (t) => {
      const [a, b, c] = corner[t - 2] ?? [0, 0, 0];
      return `pid="2" p1="${a}" p2="${b}" p3="${c}"`;
    },
  });
  const read = await parse3MFDisplacement(input, file),
    fine = await parse3MFDisplacement(input, { ...file, samplesPerTexel: 2 });
  closed(read);
  closed(fine);
  // Colours are interpolated over a base triangle before it is displaced (section 5.3), and groups stay few.
  assert.ok(read.groups.length <= 3, `${read.groups.length} groups`);
  let mixed = 0;
  for (let v = 0; v < read.positions.length / 3; v++) {
    const [x, , z] = read.positions.subarray(v * 3, v * 3 + 3),
      [r, , b] = read.colors.subarray(v * 3, v * 3 + 3);
    if (z > 10.5 && x > 0 && x < 10) {
      close(b, x / 10);
      close(r, 1 - x / 10);
      mixed++;
    }
  }
  assert.ok(mixed > 100, `${mixed}`);
  // Sixteen texels along the edges: 16 segments each way at least, four times as many at two samples a texel.
  assert.ok(read.indices.length / 3 >= 2 * 16 * 16, `${read.indices.length / 3}`);
  assert.ok(fine.indices.length >= read.indices.length * 3);
  const coarse = await parse3MFDisplacement(input, { ...file, maxSegments: 1 });
  closed(coarse);
  assert.ok(coarse.indices.length / 3 < 24);
  await assert.rejects(parse3MFDisplacement(input, { ...file, maxTriangles: 100 }), { code: 'limit' });
  await assert.rejects(parse3MFDisplacement(input, { samplesPerTexel: 0 }), { code: 'range' });
  await assert.rejects(parse3MFDisplacement(input, { maxSegments: 1.5 }), { code: 'range' });
});
