import { bilinearOracle } from './gpu-fixed-lerp-cases.mjs';
import { random } from './random.js';

export const fieldNames = ['rain', 'continentality', 'exposure', 'water', 'fill'];

export function regionFieldCases() {
  const next = random(0x5a2001),
    cases = [];
  const extremes = [-2147483648, 2147483647, -1, 0, 1, 65535, 65536, -65537];
  for (const [nx, nz] of [
    [2, 2],
    [3, 3],
    [5, 9],
  ]) {
    for (const [cell, step] of [
      [1000, 1000],
      [1000, 2000],
      [1000, 64000],
      [1500, 64000],
      [1000, 3000],
      [1000, 65536000],
      [1000, 100000000],
    ]) {
      const region = { nx, nz, step, height: new Int32Array(nx * nz) };
      for (let g = 0; g < fieldNames.length; g++) {
        region[fieldNames[g]] = Int32Array.from({ length: nx * nz }, (_, k) =>
          k % 3 ? extremes[(k + g) % extremes.length] : (next() * 4294967296) | 0,
        );
      }
      const edgeX = Math.ceil(((nx - 1) * step) / cell),
        edgeZ = Math.ceil(((nz - 1) * step) / cell);
      for (const [ox, oz, width, depth] of [
        [0, 0, 1, 1],
        [0, 0, 9, 13],
        [-3, -7, 17, 9],
        [edgeX - 1, edgeZ - 1, 3, 5],
        [-100, 0, 9, 1],
        [0, -100, 1, 9],
        [edgeX + 20, 1, 9, 3],
        [1, edgeZ + 20, 3, 9],
        [2 ** 40, -(2 ** 40), 2, 3],
        [-(2 ** 40), 2 ** 40, 3, 2],
        [65535, 65535, 3, 3],
      ])
        cases.push({ region, cell, ox, oz, width, depth });
    }
  }
  return cases;
}

// Independent re-derivation of rectFields axes, without importing the candidate or fixed.ts.
export function oracleAxes({ region, cell, ox, oz, width, depth }) {
  const ratio = Math.floor((cell * 65536) / region.step);
  const axis = (origin, length, samples) => {
    const index = [],
      frac = [];
    for (let k = 0; k < length; k++) {
      const coordinate = Math.min((samples - 1) * 65536, Math.max(0, (origin + k) * ratio));
      const at = Math.min(samples - 2, Math.floor(coordinate / 65536));
      index.push(at);
      frac.push(coordinate - at * 65536);
    }
    return { index: Int32Array.from(index), frac: Int32Array.from(frac) };
  };
  const col = axis(ox, width, region.nx),
    row = axis(oz, depth, region.nz);
  return { colIndex: col.index, colFrac: col.frac, rowIndex: row.index, rowFrac: row.frac };
}

export function oracleFields(c) {
  const axes = oracleAxes(c),
    result = {};
  for (const name of fieldNames) {
    const grid = c.region[name],
      values = new Int32Array(c.width * c.depth);
    for (let j = 0; j < c.depth; j++)
      for (let i = 0; i < c.width; i++) {
        const at = axes.rowIndex[j] * c.region.nx + axes.colIndex[i];
        values[j * c.width + i] = bilinearOracle(
          grid[at],
          grid[at + 1],
          grid[at + c.region.nx],
          grid[at + c.region.nx + 1],
          axes.colFrac[i],
          axes.rowFrac[j],
        );
      }
    result[name] = values;
  }
  return result;
}

export function oracleStored(raw) {
  return {
    rainfall: Uint16Array.from(raw.rain, (v) => Math.min(65535, Math.max(0, v))),
    exposure: Uint8Array.from(raw.exposure, (v) => Math.min(255, Math.max(0, v))),
    waterDistance: Uint16Array.from(raw.water, (v) => Math.min(65535, Math.max(0, v))),
  };
}

export function storedCPU(module, c) {
  const layers = module.rectFields(
    {
      region: c.region,
      cell: c.cell,
      climate: module.quantizeClimate(),
      heights: { grid: (_x, _z, width, depth) => new Int32Array(width * depth) },
    },
    c.ox,
    c.oz,
    c.width,
    c.depth,
    ['rainfall', 'exposure', 'waterDistance'],
  );
  return Object.fromEntries([...layers].map(([name, layer]) => [name, layer.data]));
}
