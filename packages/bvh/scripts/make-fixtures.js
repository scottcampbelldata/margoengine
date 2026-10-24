// Writes the Margo-made OBJ fixtures in tests/fixtures (CRLF text, deterministic):
// - peanut.obj: a closed, lumpy two-lobed body (a subdivided icosahedron squeezed into a narrow waist and pushed
//   out by a few bumps), 5,120 triangles of very different sizes as plain `f a b c`. After the tests rescale it into a
//   2-unit box its waist runs through the middle of the shapecast box, so whole BVH nodes fall inside that box.
// - bean.obj: a bent, flattened UV sphere of 482 vertices with quads between the rings and triangle fans at the
//   poles (448 quads, 64 triangles), every corner written `v//vn`.
// Run `node packages/bvh/scripts/make-fixtures.js` to rewrite both.
import { writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const fixed = (v) => {
  const text = v.toFixed(6);
  return text === '-0.000000' ? '0.000000' : text;
};

/** Icosahedron subdivided `levels` times, vertices on the unit sphere; faces wind outward. */
function icosphere(levels) {
  const t = (1 + Math.sqrt(5)) / 2;
  let points = [
    [-1, t, 0],
    [1, t, 0],
    [-1, -t, 0],
    [1, -t, 0],
    [0, -1, t],
    [0, 1, t],
    [0, -1, -t],
    [0, 1, -t],
    [t, 0, -1],
    [t, 0, 1],
    [-t, 0, -1],
    [-t, 0, 1],
  ].map((p) => p.map((v) => v / Math.hypot(...p)));
  let faces = [
    [0, 11, 5],
    [0, 5, 1],
    [0, 1, 7],
    [0, 7, 10],
    [0, 10, 11],
    [1, 5, 9],
    [5, 11, 4],
    [11, 10, 2],
    [10, 7, 6],
    [7, 1, 8],
    [3, 9, 4],
    [3, 4, 2],
    [3, 2, 6],
    [3, 6, 8],
    [3, 8, 9],
    [4, 9, 5],
    [2, 4, 11],
    [6, 2, 10],
    [8, 6, 7],
    [9, 8, 1],
  ];
  for (let level = 0; level < levels; level++) {
    const middle = new Map(),
      split = (a, b) => {
        const key = a < b ? `${a},${b}` : `${b},${a}`;
        if (!middle.has(key)) {
          const m = points[a].map((v, i) => v + points[b][i]),
            length = Math.hypot(...m);
          middle.set(key, points.push(m.map((v) => v / length)) - 1);
        }
        return middle.get(key);
      };
    faces = faces.flatMap(([a, b, c]) => {
      const ab = split(a, b),
        bc = split(b, c),
        ca = split(c, a);
      return [
        [a, ab, ca],
        [b, bc, ab],
        [c, ca, bc],
        [ab, bc, ca],
      ];
    });
  }
  return { points, faces };
}

/**
 * The two-lobed body: x keeps the sphere's x (scaled to 2.6 units long), the cross-section radius shrinks to 0.12 of
 * the lobe radius at the waist, and three bumps make it lopsided.
 * @returns {{positions: number[][], faces: number[][]}}
 */
export function peanut() {
  const { points, faces } = icosphere(4);
  const positions = points.map(([x, y, z]) => {
    const waist = 0.12 + 0.88 * Math.min(1, (x * x) / 0.36),
      bump =
        1 +
        0.18 * Math.exp(-((x - 0.55) ** 2 + (y - 0.6) ** 2 + z * z) / 0.08) -
        0.12 * Math.exp(-((x + 0.6) ** 2 + y * y + (z - 0.7) ** 2) / 0.05) +
        0.05 * Math.sin(7 * x + 3 * z) * Math.cos(5 * y);
    return [1.3 * x * (1 + 0.04 * y), 0.8 * y * waist * bump, 0.7 * z * waist * bump];
  });
  return { positions, faces };
}

/**
 * A bent, flattened UV sphere: `segments` around, `rings` bands, quads between rings and triangles at the poles.
 * @returns {{positions: number[][], normals: number[][], faces: number[][]}}
 */
export function bean(segments = 32, rings = 16) {
  const positions = [],
    normals = [];
  const surface = (theta, phi) => {
    const s = Math.sin(theta),
      x = 1.4 * s * Math.cos(phi),
      z = 0.9 * s * Math.sin(phi),
      y = Math.cos(theta);
    return [x, y * 0.75 + 0.25 * x * x, z];
  };
  const add = (theta, phi) => {
    const p = surface(theta, phi),
      e = 1e-4,
      a = surface(theta + e, phi).map((v, i) => v - p[i]),
      b = surface(theta, phi + e).map((v, i) => v - p[i]);
    let n = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
    if (n[0] * p[0] + n[1] * (p[1] - 0.25 * p[0] * p[0]) + n[2] * p[2] < 0) n = n.map((v) => -v);
    const length = Math.hypot(...n);
    positions.push(p);
    normals.push(n.map((v) => v / length));
  };
  positions.push([0, 0.75, 0]);
  normals.push([0, 1, 0]);
  for (let r = 1; r < rings; r++)
    for (let s = 0; s < segments; s++) add((r / rings) * Math.PI, (s / segments) * Math.PI * 2);
  positions.push([0, -0.75, 0]);
  normals.push([0, -1, 0]);
  const ring = (r, s) => 1 + (r - 1) * segments + (s % segments),
    faces = [],
    last = positions.length - 1;
  for (let s = 0; s < segments; s++) faces.push([0, ring(1, s + 1), ring(1, s)]);
  for (let r = 1; r < rings - 1; r++)
    for (let s = 0; s < segments; s++) faces.push([ring(r, s), ring(r, s + 1), ring(r + 1, s + 1), ring(r + 1, s)]);
  for (let s = 0; s < segments; s++) faces.push([last, ring(rings - 1, s), ring(rings - 1, s + 1)]);
  return { positions, normals, faces };
}

function obj(name, { positions, normals, faces }) {
  const lines = ['####', '#', `# ${name}: Margo-made test mesh (packages/bvh/scripts/make-fixtures.js)`, '#', '####'];
  lines.push(`# ${positions.length} vertices, ${faces.length} faces`);
  for (const p of positions) lines.push(`v ${p.map(fixed).join(' ')}`);
  if (normals) for (const n of normals) lines.push(`vn ${n.map(fixed).join(' ')}`);
  for (const f of faces) lines.push(`f ${f.map((i) => (normals ? `${i + 1}//${i + 1}` : `${i + 1}`)).join(' ')}`);
  return `${lines.join('\r\n')}\r\n`;
}

/** Both fixtures as OBJ text, by file name. */
export function buildFixtures() {
  return { 'peanut.obj': obj('peanut.obj', peanut()), 'bean.obj': obj('bean.obj', bean()) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const folder = fileURLToPath(new URL('../tests/fixtures/', import.meta.url));
  for (const [name, text] of Object.entries(buildFixtures())) {
    writeFileSync(folder + name, text);
    console.log(`${name} ${text.length} bytes`);
  }
}
