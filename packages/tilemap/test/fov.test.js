// Node checks of @margoengine/tilemap/fov: field of view against cases worked out by hand and against an exact ray
// oracle that knows nothing of octants, plus tile opacity and fog of war.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FOG_EXPLORED, FOG_UNSEEN, FOG_VISIBLE, FogOfWar, fieldOfView, tileOpacity } from '../dist/fov.js';
import { createTileLayer } from '../dist/index.js';

const grid = (width, height, walls = []) => {
  const opaque = new Uint8Array(width * height);
  for (const [x, y] of walls) opaque[y * width + x] = 1;
  return { width, height, opaque };
};
const seenList = (g, mask) => {
  const out = [];
  for (let i = 0; i < mask.length; i++) if (mask[i]) out.push(`${i % g.width},${Math.floor(i / g.width)}`);
  return out;
};

// The oracle: sight lines leave the viewer's centre in every direction between two neighbouring cell-corner angles
// (inside such a gap a line crosses the same squares in the same order and touches no corner), each walks the squares
// it passes through by entry distance and stops after the first blocking one. A cell is seen when some line reaches it.
function oracle(g, vx, vy, radius = Number.POSITIVE_INFINITY) {
  const angles = [];
  for (let y = 0; y <= g.height; y++)
    for (let x = 0; x <= g.width; x++) angles.push(Math.atan2(y - 0.5 - vy, x - 0.5 - vx));
  angles.sort((a, b) => a - b);
  const gaps = [];
  for (let i = 0; i < angles.length; i++) {
    const a = angles[i],
      b = i + 1 < angles.length ? angles[i + 1] : angles[0] + 2 * Math.PI;
    if (b - a > 1e-9) gaps.push((a + b) / 2);
  }
  const seen = new Uint8Array(g.width * g.height);
  seen[vy * g.width + vx] = 1;
  for (const angle of gaps) {
    const ux = Math.cos(angle),
      uy = Math.sin(angle),
      hits = [];
    for (let y = 0; y < g.height; y++)
      for (let x = 0; x < g.width; x++) {
        if (x === vx && y === vy) continue;
        let t0 = 0,
          t1 = Number.POSITIVE_INFINITY;
        for (const [d, lo, hi] of [
          [ux, x - 0.5 - vx, x + 0.5 - vx],
          [uy, y - 0.5 - vy, y + 0.5 - vy],
        ]) {
          if (Math.abs(d) < 1e-15) {
            if (!(lo < 0 && hi > 0)) t1 = -1;
            continue;
          }
          const a = lo / d,
            b = hi / d;
          t0 = Math.max(t0, Math.min(a, b));
          t1 = Math.min(t1, Math.max(a, b));
        }
        if (t1 > t0) hits.push([t0, x, y]);
      }
    hits.sort((a, b) => a[0] - b[0]);
    for (const [, x, y] of hits) {
      if ((x - vx) ** 2 + (y - vy) ** 2 <= radius * radius) seen[y * g.width + x] = 1;
      if (g.opaque[y * g.width + x]) break;
    }
  }
  return seen;
}

test('an open room is seen whole; a radius keeps the cells whose centre is within it', () => {
  const g = grid(9, 7);
  assert.equal(seenList(g, fieldOfView(g, 3, 2)).length, 63);
  // Radius 2 around (4, 3): the 13 cells with dx * dx + dy * dy <= 4.
  assert.equal(seenList(g, fieldOfView(g, 4, 3, { radius: 2 })).length, 13);
  assert.deepEqual(seenList(g, fieldOfView(g, 4, 3, { radius: 0 })), ['4,3']);
});

test('a pillar casts a shadow that widens behind it, worked out by hand', () => {
  // Viewer (0, 2), pillar (2, 2): the pillar spans slopes -1/3 to 1/3 (column over depth). A cell at depth d, column c
  // spans (c - 0.5) / (d + 0.5) to (c + 0.5) / (d - 0.5). Row 2 (column 0) spans at most -1/5 to 1/5: hidden from depth
  // 3 on. Column 1 spans 1/7 to 3/5 at depth 3 and 1/9 to 3/7 at depth 4, reaching past 1/3, so seen; 1/11 to 1/3 at
  // depth 5 touches 1/3 only at a point, and 1/13 to 3/11 at depth 6 is inside: hidden.
  const g = grid(7, 5, [[2, 2]]),
    seen = fieldOfView(g, 0, 2),
    hidden = [];
  for (let i = 0; i < seen.length; i++) if (!seen[i]) hidden.push(`${i % 7},${Math.floor(i / 7)}`);
  assert.deepEqual(hidden.sort(), ['3,2', '4,2', '5,1', '5,2', '5,3', '6,1', '6,2', '6,3']);
});

test('two walls that touch at a corner close the gap between them', () => {
  const g = grid(5, 5, [
      [1, 0],
      [0, 1],
    ]),
    seen = fieldOfView(g, 0, 0);
  assert.deepEqual(seenList(g, seen).sort(), ['0,0', '0,1', '1,0']);
});

test('a corridor wall is seen along its whole length', () => {
  // A 1-wide corridor along y = 1 between walls at y = 0 and y = 2, viewer at its left end.
  const walls = [];
  for (let x = 0; x < 12; x++) walls.push([x, 0], [x, 2]);
  const g = grid(12, 3, walls),
    seen = fieldOfView(g, 0, 1);
  assert.equal(seenList(g, seen).length, 36);
});

test('random maps match the exact ray oracle from many viewers, radii and wall densities', () => {
  let seed = 12345;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) >>> 0;
    return seed / 2 ** 32;
  };
  let compared = 0;
  for (let round = 0; round < 24; round++) {
    const width = 6 + Math.floor(rand() * 8),
      height = 5 + Math.floor(rand() * 8),
      density = [0.1, 0.25, 0.4][round % 3],
      g = grid(width, height);
    for (let i = 0; i < g.opaque.length; i++) g.opaque[i] = rand() < density ? 1 : 0;
    for (let k = 0; k < 4; k++) {
      const vx = Math.floor(rand() * width),
        vy = Math.floor(rand() * height),
        radius = [Number.POSITIVE_INFINITY, 3.5, 5, 2.2][k];
      assert.deepEqual(
        seenList(g, fieldOfView(g, vx, vy, { radius })),
        seenList(g, oracle(g, vx, vy, radius)),
        `round ${round}, viewer (${vx}, ${vy}), radius ${radius}`,
      );
      compared++;
    }
  }
  assert.equal(compared, 96);
});

test('tileOpacity reads the opaque property from every layer', () => {
  const map = {
    width: 3,
    height: 2,
    tileWidth: 8,
    tileHeight: 8,
    tilesets: [
      {
        name: 't',
        firstGid: 1,
        tileWidth: 8,
        tileHeight: 8,
        tileCount: 3,
        columns: 3,
        tiles: [{ id: 1, properties: { opaque: true } }],
      },
    ],
    layers: [
      createTileLayer('floor', 3, 2, Uint32Array.of(1, 1, 1, 1, 1, 1)),
      createTileLayer('walls', 3, 2, Uint32Array.of(0, 2, 0, 3, 0, 0)),
    ],
  };
  assert.deepEqual([...tileOpacity(map).opaque], [0, 1, 0, 0, 0, 0]);
  assert.deepEqual([...tileOpacity(map, { layers: ['floor'] }).opaque], [0, 0, 0, 0, 0, 0]);
});

test('fog of war: seen cells stay explored, an opened door counts on the next update, explored state restores', () => {
  // Two rooms joined by a door at (3, 1).
  const g = grid(7, 3, [
      [3, 0],
      [3, 1],
      [3, 2],
    ]),
    fog = new FogOfWar(g);
  fog.update([{ x: 0, y: 1 }]);
  assert.equal(fog.state(1, 1), FOG_VISIBLE);
  assert.equal(fog.state(3, 1), FOG_VISIBLE, 'the closed door is seen');
  assert.equal(fog.state(5, 1), FOG_UNSEEN);
  g.opaque[1 * 7 + 3] = 0;
  fog.update([{ x: 5, y: 1, radius: 1 }]);
  assert.equal(fog.state(5, 1), FOG_VISIBLE);
  assert.equal(fog.state(1, 1), FOG_EXPLORED);
  assert.equal(fog.state(-1, 0), FOG_UNSEEN);
  const back = new FogOfWar(g, fog.explored);
  assert.equal(back.state(1, 1), FOG_EXPLORED);
  const image = fog.image();
  assert.deepEqual([...image.data.subarray((1 * 7 + 5) * 4, (1 * 7 + 5) * 4 + 4)], [0, 0, 0, 0]);
  assert.deepEqual([...image.data.subarray((1 * 7 + 1) * 4, (1 * 7 + 1) * 4 + 4)], [0, 0, 0, 128]);
  assert.deepEqual([...image.data.subarray(0, 4)], [0, 0, 0, 128]);
  assert.deepEqual([...image.data.subarray((0 * 7 + 6) * 4, (0 * 7 + 6) * 4 + 4)], [0, 0, 0, 255]);
});

test('bad grids, viewers and radii are refused', () => {
  const g = grid(4, 4);
  assert.throws(() => fieldOfView(g, 4, 0), RangeError);
  assert.throws(() => fieldOfView(g, 0, 0, { radius: -1 }), RangeError);
  assert.throws(() => fieldOfView({ ...g, orientation: 'hexagonal' }, 0, 0), RangeError);
  assert.throws(() => fieldOfView({ width: 4, height: 4, opaque: [1] }, 0, 0), RangeError);
  assert.throws(() => new FogOfWar(g, [1, 0]), RangeError);
});
