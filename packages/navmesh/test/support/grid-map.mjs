// Grid maps shared by the any-angle tests.
import { NavMesh } from '../../dist/index.js';

/** A grid map: '.' is a free cell, '#' a wall. One polygon per free cell, or two triangles with `split`. */
export function grid(rows, { split = null, move = (p) => p, areas = {} } = {}) {
  const width = rows[0].length,
    vertices = [],
    polygons = [],
    numbers = [];
  for (let z = 0; z <= rows.length; z++) for (let x = 0; x <= width; x++) vertices.push(move([x, 0, z]));
  const at = (x, z) => z * (width + 1) + x;
  rows.forEach((row, z) => {
    [...row].forEach((cell, x) => {
      if (cell === '#') return;
      const a = at(x, z),
        b = at(x + 1, z),
        c = at(x + 1, z + 1),
        d = at(x, z + 1),
        add = (polygon) => {
          polygons.push(polygon);
          numbers.push(areas[cell] ?? 0);
        };
      const way = split?.();
      if (way === 0) {
        add([a, b, c]);
        add([a, c, d]);
      } else if (way === 1) {
        add([a, b, d]);
        add([b, c, d]);
      } else add([a, b, c, d]);
    });
  });
  const mesh = new NavMesh(vertices, polygons);
  numbers.forEach((area, p) => mesh.setPolygonArea(p, area));
  return mesh;
}

export const random = (seed) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

/** A random map with no two free cells meeting only at a corner (a pinch has no width to walk through). */
export function randomMap(next, width, depth, density) {
  const cells = Array.from({ length: depth }, () =>
    Array.from({ length: width }, () => (next() < density ? '#' : '.')),
  );
  for (let again = true; again; ) {
    again = false;
    for (let z = 0; z + 1 < depth; z++)
      for (let x = 0; x + 1 < width; x++) {
        const a = cells[z][x] === '.',
          b = cells[z][x + 1] === '.',
          c = cells[z + 1][x] === '.',
          d = cells[z + 1][x + 1] === '.';
        if (a === d && b === c && a !== b) {
          cells[z][x] = cells[z][x + 1] = '.';
          again = true;
        }
      }
  }
  return cells.map((row) => row.join(''));
}
