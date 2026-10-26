// Test meshes and rigs written for these tests.

/**
 * A closed tube around the y axis through (cx, *, cz): `rings` + 1 rings from y0 to y1, `sides` around, capped with
 * a centre vertex at each end. Indexed, outward winding.
 */
export function tube({ cx = 0, cz = 0, radius = 0.2, y0 = 0, y1 = 2, rings = 16, sides = 12 } = {}) {
  const positions = [],
    indices = [];
  for (let r = 0; r <= rings; r++) {
    const y = y0 + ((y1 - y0) * r) / rings;
    for (let s = 0; s < sides; s++) {
      const a = (2 * Math.PI * s) / sides;
      positions.push(cx + radius * Math.cos(a), y, cz + radius * Math.sin(a));
    }
  }
  for (let r = 0; r < rings; r++)
    for (let s = 0; s < sides; s++) {
      const a = r * sides + s,
        b = r * sides + ((s + 1) % sides),
        c = a + sides,
        d = b + sides;
      indices.push(a, c, b, b, c, d);
    }
  const bottom = positions.length / 3;
  positions.push(cx, y0, cz);
  const top = positions.length / 3;
  positions.push(cx, y1, cz);
  for (let s = 0; s < sides; s++) {
    indices.push(bottom, s, (s + 1) % sides);
    indices.push(top, rings * sides + ((s + 1) % sides), rings * sides + s);
  }
  return { positions: Float32Array.from(positions), indices: Uint32Array.from(indices) };
}

/** Two meshes as one. */
export function merge(a, b) {
  const offset = a.positions.length / 3;
  return {
    positions: Float32Array.from([...a.positions, ...b.positions]),
    indices: Uint32Array.from([...a.indices, ...Array.from(b.indices, (i) => i + offset)]),
  };
}

/** The same triangles with three vertices of their own each (a split, unindexed mesh). */
export function split(mesh) {
  const positions = [];
  for (const i of mesh.indices)
    positions.push(mesh.positions[i * 3], mesh.positions[i * 3 + 1], mesh.positions[i * 3 + 2]);
  return { positions: Float32Array.from(positions) };
}

/** A three-joint chain up the y axis: base (0,0,0), middle (0,1,0), tip (0,2,0). */
export const chain = [
  { name: 'base', parent: -1, position: [0, 0, 0] },
  { name: 'middle', parent: 0, position: [0, 1, 0] },
  { name: 'tip', parent: 1, position: [0, 2, 0] },
];

/** Sum of each row of a WeightMap. */
export function rowSums(map) {
  const sums = [];
  for (let v = 0; v < map.vertexCount; v++) {
    let sum = 0;
    for (let b = 0; b < map.boneCount; b++) sum += map.values[v * map.boneCount + b];
    sums.push(sum);
  }
  return sums;
}
