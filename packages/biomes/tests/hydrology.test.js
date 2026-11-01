// B9 hydrology: the filled surface against a brute-force fill, flow conservation, the D8 tie rule, flats draining, wetness,
// height above drainage, lakes, channels, river lines and tile rasters.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { hydrology, hydrologyOf, hydrologyTile, riversOf } from '../dist/hydrology.js';
import { BiomeWorld } from '../dist/index.js';

const step = 16000;
// A seeded rough surface, in mm, with pits (integer hash, so it is the same everywhere).
function rough(nx, nz, seed = 7) {
  const h = new Int32Array(nx * nz);
  for (let z = 0; z < nz; z++)
    for (let x = 0; x < nx; x++) {
      const r = Math.imul((x * 73856093) ^ (z * 19349663) ^ seed, 2654435761) >>> 20;
      h[z * nx + x] = 40000 + 900 * Math.abs(x - nx / 2) + 500 * z + r * 8;
    }
  return h;
}
// The minimal filled surface by relaxation: every inner cell falls to max(own height, its lowest neighbour) until nothing moves.
function bruteFill(height, nx, nz) {
  const f = Int32Array.from(height, (v) => v);
  for (let z = 1; z < nz - 1; z++) for (let x = 1; x < nx - 1; x++) f[z * nx + x] = 2147483647;
  for (let moved = true; moved; ) {
    moved = false;
    for (let z = 1; z < nz - 1; z++)
      for (let x = 1; x < nx - 1; x++) {
        let low = 2147483647;
        for (let dz = -1; dz <= 1; dz++)
          for (let dx = -1; dx <= 1; dx++) if (dx || dz) low = Math.min(low, f[(z + dz) * nx + x + dx]);
        const v = Math.max(height[z * nx + x], low);
        if (v < f[z * nx + x]) {
          f[z * nx + x] = v;
          moved = true;
        }
      }
  }
  return f;
}
const sumOutlets = (h, values) => {
  let sum = 0;
  for (let c = 0; c < h.nx * h.nz; c++) if (h.direction[c] < 0) sum += values[c];
  return sum;
};

test('the filled surface is the brute-force minimal fill on 64 x 64', () => {
  const height = rough(64, 64),
    h = hydrology({ height, nx: 64, nz: 64, step });
  assert.deepEqual(h.filled, bruteFill(height, 64, 64));
  assert.ok(
    h.filled.some((v, i) => v > height[i]),
    'the surface has pits to fill',
  );
});

test('flow is conserved: the outlets sum to the cell count, on D8 and on multiple flow', () => {
  const h = hydrology({ height: rough(64, 64), nx: 64, nz: 64, step }, { multiple: true });
  assert.equal(sumOutlets(h, h.flow), 64 * 64);
  assert.equal(sumOutlets(h, h.shares), 64 * 64 * 65536);
  for (let c = 0; c < 64 * 64; c++) assert.ok(h.flow[c] >= 1);
});

test('D8 takes the steepest drop, diagonals over the root of 2, and ties go to the lowest direction', () => {
  // The middle cell of 3 x 3: +x and +z fall 10 m, the +x +z diagonal 12 m (8.5 m per cell): +x wins the tie with +z.
  const height = Int32Array.of(50000, 50000, 50000, 50000, 50000, 40000, 50000, 40000, 38000),
    h = hydrology({ height, nx: 3, nz: 3, step });
  assert.equal(h.direction[4], 0);
  // A diagonal of 15 m (10.6 m per cell) beats the straight 10 m.
  height[8] = 35000;
  assert.equal(hydrology({ height, nx: 3, nz: 3, step }).direction[4], 1);
});

test('a flat drains: every cell of a filled pit and a level plain reaches an outlet, away from the higher side', () => {
  const nx = 32,
    nz = 32,
    height = new Int32Array(nx * nz).fill(5000);
  // Walls on three sides, one gap at the middle of the top row, higher ground by the bottom.
  for (let x = 0; x < nx; x++) {
    height[(nz - 1) * nx + x] = 9000;
    height[(nz - 2) * nx + x] = 8000;
  }
  for (let z = 0; z < nz; z++) height[z * nx] = height[z * nx + nx - 1] = 9000;
  for (let x = 0; x < nx; x++) if (x !== 16) height[x] = 9000;
  height[16] = 4000;
  const h = hydrology({ height, nx, nz, step });
  for (let c = 0; c < nx * nz; c++) {
    if (height[c] !== 5000) continue;
    let at = c,
      hops = 0;
    while (at !== 16) {
      const d = h.direction[at];
      assert.ok(d >= 0, 'cell ' + c + ' stops at ' + at);
      const x = at % nx;
      at = ((at - x) / nx + [0, 1, 1, 1, 0, -1, -1, -1][d]) * nx + x + [1, 1, 0, -1, -1, -1, 0, 1][d];
      assert.ok(++hops < nx * nz, 'a loop from ' + c);
    }
  }
  assert.equal(sumOutlets(h, h.flow), nx * nz);
});

test('wetness grows with the catchment on one slope and falls with the slope at one catchment', () => {
  const nx = 3,
    nz = 40,
    height = new Int32Array(nx * nz);
  for (let z = 0; z < nz; z++) {
    height[z * nx] = height[z * nx + 2] = 900000;
    height[z * nx + 1] = 1000 + z * 4000;
  }
  const a = hydrology({ height, nx, nz, step });
  for (let z = nz - 3; z > 1; z--) assert.ok(a.twi[z * nx + 1 - nx] >= a.twi[z * nx + 1], 'down the slope at ' + z);
  const steeper = height.map((v, i) => (i % nx === 1 ? 1000 + ((i - 1) / nx) * 12000 : v)),
    b = hydrology({ height: steeper, nx, nz, step });
  assert.ok(b.twi[20 * nx + 1] < a.twi[20 * nx + 1]);
});

test('lakes, channels and height above drainage on a valley with a pit', () => {
  const nx = 65,
    nz = 65,
    height = new Int32Array(nx * nz);
  for (let z = 0; z < nz; z++)
    for (let x = 0; x < nx; x++) height[z * nx + x] = 2000 + 3000 * Math.abs(x - 32) + 400 * z;
  height[40 * nx + 32] = 5000; // a pit below the valley floor, 18 m at z = 40
  const h = hydrology({ height, nx, nz, step }, { channelCells: 200, lakeDepth: 1000 }),
    pit = 40 * nx + 32;
  assert.equal(h.lake[pit], 1);
  assert.equal(h.filled[pit] > height[pit], true);
  assert.equal(h.channel[10 * nx + 32], 1);
  assert.equal(h.channel[60 * nx + 2], 0);
  assert.equal(h.hand[10 * nx + 32], 0);
  // Up the side of the valley the height above drainage is the climb to the floor at the point it reaches.
  assert.ok(h.hand[10 * nx + 40] > 0);
  assert.ok(h.water[10 * nx + 32] === 0 && h.water[10 * nx + 40] > 0);
});

test('sea cells are outlets and hold no channel', () => {
  const height = rough(32, 32).map((v, i) => (i < 32 * 8 ? -5000 : v)),
    h = hydrology({ height, nx: 32, nz: 32, step }, { sea: 0, channelCells: 8 });
  for (let c = 0; c < 32 * 8; c++) {
    assert.equal(h.direction[c], -1);
    assert.equal(h.channel[c], 0);
    assert.equal(h.water[c], 0);
  }
  assert.equal(sumOutlets(h, h.flow), 32 * 32);
});

test('bad input names what to fix', () => {
  assert.throws(() => hydrology({ height: [], nx: 2, nz: 2, step }), TypeError);
  assert.throws(() => hydrology({ height: new Int32Array(3), nx: 2, nz: 2, step }), RangeError);
  assert.throws(() => hydrology({ height: new Int32Array(4), nx: 2, nz: 2, step }, { channelCells: 0 }), RangeError);
});

test('a world: rivers fall to their mouths, tile rasters read the grid, and the same world gives the same bytes', async () => {
  const world = await BiomeWorld.create({
      seed: 5,
      size: [2048, 2048],
      height: { relief: { coast: 'south', relief: 600 } },
      workers: 0,
    }),
    h = hydrologyOf(world, { channelCells: 400, multiple: true }),
    { lines, levels } = riversOf(world, h);
  assert.ok(lines.length > 0);
  assert.equal(lines.length, levels.length);
  for (let k = 0; k < lines.length; k++) {
    assert.equal(lines[k].length, 2 * levels[k].length);
    for (let i = 1; i < levels[k].length; i++) assert.ok(levels[k][i] >= levels[k][i - 1], 'never rising to the mouth');
    for (let i = 0; i < lines[k].length; i += 2) {
      assert.ok(lines[k][i] >= -1024000 && lines[k][i] <= 1024000);
      assert.equal(lines[k][i] % 16000, 0);
    }
  }
  const layers = hydrologyTile(world, h, 3, 3);
  assert.deepEqual(
    layers.map((l) => l.name),
    ['flow', 'twi', 'hand', 'lake', 'channel'],
  );
  assert.equal(layers[0].data.length, 256 * 256);
  // Tile (3, 3) starts at region corner (48, 48): cell 0 sits on it.
  assert.equal(layers[0].data[0], h.flow[48 * h.nx + 48]);
  assert.equal(layers[1].data[0], h.twi[48 * h.nx + 48]);
  assert.throws(() => hydrologyTile(world, h, 99, 0), RangeError);
  const digest = createHash('sha256');
  for (const key of ['filled', 'direction', 'flow', 'shares', 'twi', 'hand', 'lake', 'channel', 'water'])
    digest.update(Buffer.from(h[key].buffer, h[key].byteOffset, h[key].byteLength));
  assert.equal(digest.digest('hex'), 'a3678542891456f9e79e0bfc94b7bf8d53d2b222adf3c88c6ad6ae5c9b426ed8');
  world.dispose();
});
