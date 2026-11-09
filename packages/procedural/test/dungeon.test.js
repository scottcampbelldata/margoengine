import test from 'node:test';
import assert from 'node:assert/strict';
import { createDungeonGenerator } from '../dist/dungeon.js';

function connected(layout) {
  const { width: w, height: h, cells, rooms, corridors } = layout;
  assert.equal(cells.length, w * h);
  assert.ok(rooms.length >= 1);
  assert.equal(corridors.length, rooms.length - 1);
  const seen = new Uint8Array(cells.length),
    queue = new Uint32Array(cells.length);
  queue[0] = cells.indexOf(1);
  seen[queue[0]] = 1;
  let tail = 1;
  for (let at = 0; at < tail; at++) {
    const p = queue[at],
      x = p % w,
      y = Math.floor(p / w);
    for (const n of [x ? p - 1 : -1, x + 1 < w ? p + 1 : -1, y ? p - w : -1, y + 1 < h ? p + w : -1])
      if (n >= 0 && cells[n] && !seen[n]) {
        seen[n] = 1;
        queue[tail++] = n;
      }
  }
  assert.equal(
    tail,
    cells.reduce((a, b) => a + b, 0),
    'every floor cell is reachable',
  );
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) if (!x || !y || x === w - 1 || y === h - 1) assert.equal(cells[y * w + x], 0);
  for (const r of rooms) {
    assert.ok(r.x > 0 && r.y > 0 && r.x + r.width < w && r.y + r.height < h);
    for (let y = r.y; y < r.y + r.height; y++)
      for (let x = r.x; x < r.x + r.width; x++) assert.equal(cells[y * w + x], 1);
  }
  for (let i = 0; i < rooms.length; i++)
    for (let j = 0; j < i; j++) {
      const a = rooms[i],
        b = rooms[j];
      assert.ok(
        a.x + a.width < b.x || b.x + b.width < a.x || a.y + a.height < b.y || b.y + b.height < a.y,
        'room margins separate partitions',
      );
    }
  const parents = Array.from({ length: rooms.length }, (_, i) => i);
  const root = (i) => {
    while (parents[i] !== i) i = parents[i];
    return i;
  };
  for (const c of corridors) {
    assert.ok(Number.isInteger(c.from) && Number.isInteger(c.to));
    assert.ok(c.from < rooms.length && c.to < rooms.length);
    const from = rooms[c.from],
      to = rooms[c.to];
    const x0 = from.x + Math.floor(from.width / 2),
      y0 = from.y + Math.floor(from.height / 2);
    const x1 = to.x + Math.floor(to.width / 2),
      y1 = to.y + Math.floor(to.height / 2);
    assert.ok(
      (c.bend[0] === x0 && c.bend[1] === y1) || (c.bend[0] === x1 && c.bend[1] === y0),
      'both corridor segments are axis aligned and one cell wide',
    );
    const a = root(c.from),
      b = root(c.to);
    assert.notEqual(a, b, 'link graph has no cycle');
    parents[a] = b;
  }
  assert.ok(parents.every((_, i) => root(i) === root(0)));
}
test('BSP rooms and corridors have a connected grid, spanning tree, margins and stable seed across thin and small grids', async () => {
  using generator = await createDungeonGenerator();
  for (const [width, height, minRoomSize] of [
    [6, 6, 2],
    [8, 23, 2],
    [64, 48, 4],
    [257, 19, 5],
  ])
    for (let seed = 0; seed < 64; seed++) {
      const options = { width, height, minRoomSize, seed, maxRooms: 64 };
      const a = generator.generate(options);
      assert.deepEqual(a, generator.generate(options));
      connected(a);
      assert.ok(a.rooms.length <= 64);
      assert.ok(a.rooms.every((r) => r.width >= minRoomSize && r.height >= minRoomSize));
    }
  assert.notDeepEqual(generator.generate({ seed: 7 }).cells, generator.generate({ seed: 8 }).cells);
  connected(generator.generate({ width: 1024, height: 1024, maxRooms: 256 }));
  connected(generator.generate({ width: 68, height: 68, minRoomSize: 64, maxRooms: 256 }));
});
test('one room, zero/huge/nonfinite inputs, cancellation and disposal are bounded', async () => {
  const generator = await createDungeonGenerator();
  assert.equal(generator.generate({ maxRooms: 1 }).rooms.length, 1);
  const coded = (e) => e.code === 'failed' && e.message.includes('https://margoengine.com/errors#procedural');
  for (const options of [
    { width: 0 },
    { height: 0 },
    { width: 1e20 },
    { width: Infinity },
    { height: NaN },
    { width: 6 },
    { width: 64.5 },
    { minRoomSize: 0 },
    { minRoomSize: 65 },
    { maxRooms: 0 },
    { maxRooms: 257 },
    { seed: -1 },
    { seed: 2 ** 32 },
    { seed: NaN },
    { width: '64' },
  ])
    assert.throws(() => generator.generate(options), coded);
  const signal = AbortSignal.abort();
  await assert.rejects(createDungeonGenerator({ signal }), { name: 'AbortError' });
  assert.throws(() => generator.generate({ signal }), { name: 'AbortError' });
  const a = generator.generate(),
    copy = a.cells.slice();
  generator.generate({ width: 1024, height: 1024 });
  assert.deepEqual(a.cells, copy, 'no live Wasm memory view');
  generator.dispose();
  generator[Symbol.dispose]();
  assert.deepEqual(a.cells, copy);
  assert.throws(() => generator.generate(), { code: 'disposed' });
});
test('direct raster writes match an independent whole-grid membership oracle with less cell work', async () => {
  using generator = await createDungeonGenerator();
  const a = generator.generate({ seed: 19 });
  const rects = a.rooms.map((r) => [r.x, r.y, r.x + r.width - 1, r.y + r.height - 1]);
  const centre = (r) => [r.x + Math.floor(r.width / 2), r.y + Math.floor(r.height / 2)];
  for (const c of a.corridors)
    for (const [p, q] of [
      [centre(a.rooms[c.from]), c.bend],
      [c.bend, centre(a.rooms[c.to])],
    ])
      rects.push([Math.min(p[0], q[0]), Math.min(p[1], q[1]), Math.max(p[0], q[0]), Math.max(p[1], q[1])]);
  const expected = new Uint8Array(a.cells.length);
  let visits = 0;
  for (let y = 0; y < a.height; y++)
    for (let x = 0; x < a.width; x++)
      for (const [x0, y0, x1, y1] of rects) {
        visits++;
        if (x >= x0 && x <= x1 && y >= y0 && y <= y1) expected[y * a.width + x] = 1;
      }
  assert.deepEqual(a.cells, expected);
  assert.equal(a.rasterVisits, 1540, 'documented direct-write count');
  assert.equal(visits, 288768, 'documented whole-grid membership count');
  assert.ok(a.rasterVisits * 20 < visits);
  console.log(
    JSON.stringify({ dungeonWork: { directWrites: a.rasterVisits, wholeGridVisits: visits, identicalCells: true } }),
  );
});
