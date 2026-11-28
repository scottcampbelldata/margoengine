// @margoengine/materials/interior-mapping: the room grid and its trace (van Dongen 2008, the slab exit of Kay and
// Kajiya 1986), the grid of a rules building, the material's options and live values, its coded errors, and that the
// entry loads no material or glTF code.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseSync } from 'rolldown/utils';
import { Texture, WgslMaterial } from '../dist/index.js';
import { facadeRooms, interiorMapping, traceRoom } from '../dist/interior-mapping.js';
import { generateBuilding } from '../../procedural/dist/building-rules.js';

/** The material a caller makes from the options. */
const make = (options) => new WgslMaterial(interiorMapping(options));
const close = (a, b, label) => a.forEach((v, i) => assert.ok(Math.abs(v - b[i]) < 1e-9, `${label}: ${a} is not ${b}`));
const rooms = { width: 3, height: 2.8, depth: 4 };

test('a ray ends on the nearest plane of the room it enters', () => {
  // Straight in from the middle of the second room of the second storey.
  const straight = traceRoom([4.5, 4.2, 0], [0, 0, 1], [0, 0, -1], rooms);
  assert.deepEqual([straight.cell, straight.face, straight.size], [[1, 1, 0], 'back', [3, 2.8, 4]]);
  close(straight.point, [1.5, 1.4, 4], 'straight');
  const down = traceRoom([1.5, 1.4, 0], [0, 0, 1], [0, -1, -1], rooms);
  assert.equal(down.face, 'floor');
  close(down.point, [1.5, 0, 1.4], 'down');
  assert.equal(traceRoom([1.5, 1.4, 0], [0, 0, 1], [0, 1, -1], rooms).face, 'ceiling');
  const right = traceRoom([1.5, 1.4, 0], [0, 0, 1], [1, 0, -1], rooms);
  assert.equal(right.face, 'right');
  close(right.point, [3, 1.4, 1.5], 'right');
  assert.equal(traceRoom([1.5, 1.4, 0], [0, 0, 1], [-1, 0, -1], rooms).face, 'left');
  // Left and right are as seen from outside, whichever way the facade faces.
  const east = traceRoom([0, 1.4, -1.5], [1, 0, 0], [-1, 0, -1], rooms);
  assert.deepEqual([east.cell, east.face], [[0, 0, 1], 'right']);
  assert.equal(traceRoom([-1.5, 1.4, 0], [0, 0, -1], [0, 0, 1], rooms).cell[2], 2);
  assert.equal(traceRoom([0, 1.4, 1.5], [-1, 0, 0], [1, 0, 0], rooms).cell[2], 3);
  // A building turned a quarter keeps its rooms.
  const turned = traceRoom([0, 4.2, -4.5], [1, 0, 0], [-1, 0, 0], { ...rooms, yaw: Math.PI / 2 });
  assert.deepEqual([turned.cell, turned.face], [[1, 1, 0], 'back']);
  // Storeys of their own heights, the end ones carried on beyond the list.
  const storeys = { ...rooms, origin: [0, 10, 0], floors: [0, 4, 6.5] };
  assert.deepEqual(
    [10.5, 13.9, 14.1, 9, 30].map((y) => traceRoom([1, y, 0], [0, 0, 1], [0, 0, -1], storeys).cell[1]),
    [0, 0, 1, 0, 1],
  );
  assert.equal(traceRoom([1, 15, 0], [0, 0, 1], [0, 0, -1], storeys).size[1], 2.5);
  // A level surface and a ray that leaves the wall have no room.
  assert.equal(traceRoom([1, 1, 1], [0, 1, 0], [0, -1, 0], rooms), undefined);
  assert.equal(traceRoom([1, 1, 0], [0, 0, 1], [0, 0, 1], rooms), undefined);
});

test('every window of a rules building looks into one room of its own bay and storey', () => {
  const normals = [
    [0, 0, 1],
    [1, 0, 0],
    [0, 0, -1],
    [-1, 0, 0],
  ];
  let windows = 0;
  for (const o of [
    { style: 'japan-2011-house' },
    { style: 'japan-2011-concrete', width: 17.3, depth: 11.1, yaw: 0.7, origin: [12, 3, -8] },
    { style: 'western-1910-brick', yaw: -Math.PI / 2, origin: [-5, 0, 4] },
  ]) {
    const b = generateBuilding(o),
      grid = facadeRooms(b),
      c = Math.cos(b.options.yaw),
      s = Math.sin(b.options.yaw);
    assert.equal(grid.floors.length, b.floors.length + 1, o.style);
    const taken = new Set();
    for (const w of b.openings.filter((w) => w.kind === 'window')) {
      const [x, , z] = normals[w.side],
        n = [x * c + z * s, 0, z * c - x * s],
        right = [n[2], 0, -n[0]],
        cells = [-0.49, 0.49].flatMap((a) =>
          [-0.49, 0.49].map((v) => {
            const p = w.centre.map((m, k) => m + right[k] * a * w.width + (k === 1 ? v * w.height : 0));
            return traceRoom(p, n, [-n[0], 0, -n[2]], grid).cell.join();
          }),
        );
      assert.equal(new Set(cells).size, 1, `${o.style}: a window on side ${w.side} straddles rooms ${cells}`);
      assert.equal(Number(cells[0].split(',')[1]), w.floor, `${o.style}: the window's storey`);
      taken.add(cells[0]);
      windows++;
    }
    assert.equal(taken.size, b.openings.filter((w) => w.kind === 'window').length, `${o.style}: a room each`);
  }
  assert.ok(windows > 40, `${windows} windows`);
});

test('the material takes the grid and the looks, keeps its values live and refuses bad ones', () => {
  const m = make({ floors: [0, 3, 5.5], width: [2.5, 3.5], depth: 3, daylight: 0.5 });
  assert.ok(m instanceof WgslMaterial);
  assert.equal(m.uniforms.count, 2);
  assert.deepEqual([...m.uniforms.width], [2.5, 3.5]);
  assert.deepEqual([...m.uniforms.floors0], [0, 3, 5.5, 5.5]);
  assert.equal(m.uniforms.daylight, 0.5);
  m.uniforms.lit = 0.9;
  assert.ok(Math.abs(m.uniforms.lit - 0.9) < 1e-6);
  assert.equal(make().uniforms.count, 0);
  assert.ok(Math.abs(make().uniforms.furniture - 0.7) < 1e-6);
  const pictured = make({
    map: new Texture({ data: new Uint8Array(64), width: 4, height: 4 }),
    tiles: [2, 2],
  });
  assert.equal(pictured.uniforms.furniture, 0);
  assert.deepEqual([...pictured.uniforms.tiles], [2, 2]);
  assert.ok(pictured.wgsl.includes('roomMap') && !m.wgsl.includes('roomMap'));
  const many = make({ floors: Array.from({ length: 33 }, (_, k) => k * 3) });
  assert.deepEqual([...many.uniforms.floors8], [96, 96, 96, 96]);
  for (const bad of [
    { width: 0 },
    { width: [1, 2, 3] },
    { height: -1 },
    { depth: 0.01 },
    { floors: [0] },
    { floors: [0, 3, 2] },
    { floors: Array.from({ length: 34 }, (_, k) => k) },
    { lit: 2 },
    { curtains: -0.1 },
    { daylight: NaN },
    { wallColor: [1, 1] },
    { lampColor: [-1, 0, 0] },
    { seed: 1.5 },
    { tiles: [0, 1] },
    { map: new Texture({ data: new Uint8Array(64), width: 4, height: 4 }), backWall: 1 },
  ])
    assert.throws(
      () => make(bad),
      (e) => (e instanceof RangeError || e instanceof TypeError) && e.message.includes('#materials-interior-mapping'),
      JSON.stringify(bad),
    );
});

/** Every package specifier the built file at `url` loads statically, through its own chunks too. */
function staticImports(url, seen = new Set(), packages = new Set()) {
  if (seen.has(url.href)) return packages;
  seen.add(url.href);
  const file = fileURLToPath(url);
  for (const node of parseSync(file, readFileSync(file, 'utf8')).program.body) {
    if (!node.source || !/^(Import|ExportAll|ExportNamed)Declaration$/.test(node.type)) continue;
    if (node.source.value.startsWith('.')) staticImports(new URL(node.source.value, url), seen, packages);
    else packages.add(node.source.value);
  }
  return packages;
}

test('the entry loads no glTF or material code until the caller imports it', () => {
  // The caller passes the options to WgslMaterial, which it imports itself: the entry's own static graph holds no
  // package at all.
  const entry = new URL('../dist/interior-mapping.js', import.meta.url);
  assert.deepEqual([...staticImports(entry)], []);
  // The walk does follow chunks and packages: the root, which has the material classes, reaches the glTF models.
  assert.ok(staticImports(new URL('../dist/index.js', import.meta.url)).has('@margoengine/gltf/pbr-model'));
});
