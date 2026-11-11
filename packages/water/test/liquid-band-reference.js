// Oracle for the ParticleLiquid narrow band, written from F. Oliveira, A. Paiva, Narrow-Band Screen-Space Fluid
// Rendering, Computer Graphics Forum 41(6) 2022, Algorithm 1 (Layered Neighborhood Method), 3D (n_min = 2^3).

/** Labels of every voxel of a grid (origin, voxel size v, dims) and the particles in the band. */
export function layeredNeighborhood(positions, origin, v, dims) {
  const [dx, dy, dz] = dims,
    index = (x, y, z) => x + dx * (y + dy * z);
  const n = new Uint32Array(dx * dy * dz);
  const cell = [];
  for (let i = 0; i < positions.length; i += 3) {
    const c = [0, 1, 2].map((k) => Math.floor((positions[i + k] - origin[k]) / v));
    cell.push(c);
    n[index(...c)]++;
  }
  const inside = (x, y, z) => x >= 0 && y >= 0 && z >= 0 && x < dx && y < dy && z < dz;
  const around = function* (x, y, z) {
    for (let k = -1; k <= 1; k++) for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) if (i || j || k) yield [x + i, y + j, z + k];
  };
  const first = new Uint8Array(n.length),
    label = new Uint8Array(n.length);
  for (let z = 0; z < dz; z++)
    for (let y = 0; y < dy; y++)
      for (let x = 0; x < dx; x++) {
        if (!n[index(x, y, z)]) continue;
        for (const w of around(x, y, z))
          if (!inside(...w) || !n[index(...w)]) {
            first[index(x, y, z)] = 1;
            break;
          }
      }
  for (let z = 0; z < dz; z++)
    for (let y = 0; y < dy; y++)
      for (let x = 0; x < dx; x++) {
        const at = index(x, y, z);
        if (!n[at]) continue;
        if (first[at]) {
          label[at] = 1;
          continue;
        }
        for (const w of around(x, y, z))
          if (inside(...w) && first[index(...w)] && n[index(...w)] <= 8) {
            label[at] = 2;
            break;
          }
      }
  let band = 0,
    layer1 = 0,
    layer2 = 0,
    voxels = 0;
  for (let i = 0; i < n.length; i++) {
    if (n[i]) voxels++;
    if (label[i] === 1) layer1++;
    if (label[i] === 2) layer2++;
  }
  for (const c of cell) if (label[index(...c)]) band++;
  return { voxels, layer1, layer2, band, particles: cell.length };
}

/** A block of `size`^3 voxels of size v, each holding `per`^3 particles evenly inside it, starting at 0. */
export function voxelBlock(size, per, v) {
  const out = [];
  for (let z = 0; z < size * per; z++)
    for (let y = 0; y < size * per; y++)
      for (let x = 0; x < size * per; x++) out.push(...[x, y, z].map((k) => ((k + 0.5) / per) * v));
  return new Float32Array(out);
}
