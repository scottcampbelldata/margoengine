import test from 'node:test';
import assert from 'node:assert/strict';
import { Crowd } from '../dist/index.js';
import { buildNavMesh } from '../dist/build.js';
import { crowdLines, meshLines, NavDebug, routeLines } from '../dist/debug.js';
import { TiledNavMesh } from '../dist/tiles.js';

const floor = [0, 0, 0, 20, 0, 0, 20, 0, 20, 0, 0, 20];
const faces = [0, 2, 1, 0, 3, 2];
const options = { cs: 0.25, ch: 0.1, walkableRadius: 2, walkableHeight: 10 };
const segments = ({ positions }) => positions.length / 6;
/** The colour of segment `i`. */
const colorOf = ({ colors }, i) => [...colors.subarray(i * 8, i * 8 + 3)];
const close = (a, b) => a.every((v, i) => Math.abs(v - b[i]) < 1e-6);

test('a mesh draws each edge once: outlines, shared edges and links', () => {
  // A floor with a pillar, so it needs several polygons.
  const positions = [...floor],
    indices = [...faces],
    base = positions.length / 3;
  for (const y of [0, 3]) positions.push(9, y, 9, 11, y, 9, 11, y, 11, 9, y, 11);
  for (const [a, b, c, d] of [
    [0, 1, 5, 4],
    [1, 2, 6, 5],
    [2, 3, 7, 6],
    [3, 0, 4, 7],
  ])
    indices.push(base + a, base + b, base + c, base + a, base + c, base + d);
  const mesh = buildNavMesh(positions, indices, options),
    inner = [0, 0, 1],
    outline = [1, 0, 0],
    link = [0, 1, 0],
    colors = { inner, outline, link };
  let edges = 0,
    open = 0;
  for (let p = 0; p < mesh.polygonCount; p++) {
    edges += mesh.polygonVertices(p).length;
    open += mesh.polygonVertices(p).length - mesh.polygonLinks(p).length;
  }
  const lines = meshLines(mesh, { lift: 0, colors });
  assert.equal(lines.positions.length, segments(lines) * 6);
  assert.equal(lines.colors.length, segments(lines) * 8);
  assert.equal(segments(lines), open + (edges - open) / 2);
  let outlines = 0;
  for (let i = 0; i < segments(lines); i++) if (close(colorOf(lines, i), outline)) outlines++;
  assert.equal(outlines, open);
  mesh.addOffMeshLink([1, 0, 1], [19, 0, 19]);
  const linked = meshLines(mesh, { lift: 0, colors }),
    arcs = segments(linked) - segments(lines);
  assert.equal(arcs, 8, 'a two-way link draws once');
  const y = linked.positions.filter((_, i) => i % 3 === 1);
  assert.ok(Math.max(...y) > 1, 'it arcs');
  assert.ok(meshLines(mesh).positions[1] > 0, 'lifted by default');
});

test('a tiled mesh draws its tiles and links', () => {
  const world = new TiledNavMesh(floor, faces, { ...options, tileSize: 32 }),
    plain = meshLines(world);
  world.addOffMeshLink([1, 0, 1], [19, 0, 19]);
  assert.equal(segments(meshLines(world)), segments(plain) + 8);
  const xs = plain.positions.filter((_, i) => i % 3 === 0);
  assert.ok(xs.includes(8), 'a tile line shows');
});

test('a route draws its legs, a crossing as an arc', () => {
  const route = {
      points: [
        [0, 0, 0],
        [5, 0, 0],
        [10, 0, 0],
        [10, 0, 5],
      ],
      offMesh: [1],
    },
    lines = routeLines(route, { lift: 0 });
  assert.equal(segments(lines), 2 + 8);
  assert.deepEqual([...lines.positions.subarray(0, 6)], [0, 0, 0, 5, 0, 0]);
});

test('agents draw a ring by state, their velocity and the rest of their route', () => {
  const mesh = buildNavMesh(floor, faces, options),
    crowd = new Crowd(mesh),
    idle = crowd.addAgent({ position: [5, 0, 5], radius: 0.5 }),
    busy = crowd.addAgent({ position: [10, 0, 5], radius: 1 }),
    red = [1, 0, 0],
    green = [0, 1, 0],
    colors = { agents: { idle: red, moving: green } };
  busy.setTarget([15, 0, 15]);
  crowd.update(1 / 30);
  assert.equal(idle.state, 'idle');
  assert.equal(busy.state, 'moving');
  const lines = crowdLines(crowd, { lift: 0, colors });
  assert.ok(close(colorOf(lines, 0), red));
  assert.ok(close(colorOf(lines, 16), green));
  assert.ok(Math.abs(lines.positions[0] - 5.5) < 1e-6, 'the ring is the agent radius out');
  assert.ok(segments(lines) >= 32 + 2, 'velocity and route');
  assert.equal(segments(crowdLines([idle])), 16);
});

test('NavDebug draws with the lines package and follows changes', () => {
  const added = [],
    removed = [],
    host = {
      add: (line) => (added.push(line), line),
      remove: (line) => removed.push(line),
    },
    mesh = buildNavMesh(floor, faces, options),
    crowd = new Crowd(mesh);
  crowd.addAgent({ position: [5, 0, 5] });
  const debug = new NavDebug(host, mesh, { crowd });
  assert.equal(added.length, 3);
  const [meshLine, agents, route] = added,
    before = meshLine.pointCount ?? meshLine.positions?.length;
  assert.ok(agents);
  mesh.addOffMeshLink([1, 0, 1], [19, 0, 19]);
  debug.update();
  assert.notEqual(meshLine.pointCount ?? meshLine.positions?.length, before);
  debug.showRoute(mesh.route([1, 0, 1], [19, 0, 2]));
  debug.showRoute(null);
  assert.ok(route);
  debug.dispose();
  debug.dispose();
  assert.equal(removed.length, 3);
  debug.update();
});

test('a lift must be finite', () => {
  const mesh = buildNavMesh(floor, faces, options);
  assert.throws(() => meshLines(mesh, { lift: Number.NaN }), RangeError);
});
