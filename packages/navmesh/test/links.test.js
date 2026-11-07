import test from 'node:test';
import assert from 'node:assert/strict';
import { Crowd } from '../dist/index.js';
import { buildNavMesh } from '../dist/build.js';
import { addJumpLinks, findJumpLinks, jumpPoint } from '../dist/links.js';
import { TiledNavMesh } from '../dist/tiles.js';

/** Adds a solid box to a triangle soup: its top and four sides. These generated levels are stand-ins. */
function box(level, [x0, y0, z0], [x1, y1, z1]) {
  const { positions, indices } = level,
    base = positions.length / 3;
  for (const y of [y0, y1]) positions.push(x0, y, z0, x1, y, z0, x1, y, z1, x0, y, z1);
  for (const [a, b, c, d] of [
    [7, 6, 5, 4],
    [0, 1, 5, 4],
    [1, 2, 6, 5],
    [2, 3, 7, 6],
    [3, 0, 4, 7],
  ])
    indices.push(base + a, base + b, base + c, base + a, base + c, base + d);
}
const level = (...boxes) => {
  const out = { positions: [], indices: [] };
  for (const [a, b] of boxes) box(out, a, b);
  return out;
};
const options = { cs: 0.1, ch: 0.05, walkableRadius: 5, walkableHeight: 40, walkableClimb: 8 };
const build = ({ positions, indices }) => buildNavMesh(positions, indices, options);
const find = (mesh, { positions, indices }, extra) => findJumpLinks(mesh, positions, indices, extra);
/** Two 10 m platforms at a height, `gap` apart along X. */
const platforms = (gap, y = 2) => [
  [
    [0, 0, 0],
    [10, y, 10],
  ],
  [
    [10 + gap, 0, 0],
    [20 + gap, y, 10],
  ],
];

test('a gap gets jump links both ways, and routes and a crowd use them', () => {
  const world = level(...platforms(2)),
    mesh = build(world),
    a = [8, 2, 5],
    b = [14, 2, 5];
  assert.equal(mesh.route(a, b), null, 'no walking across');
  const links = find(mesh, world);
  assert.ok(links.some((l) => l.start[0] < 10 && l.end[0] > 12));
  assert.ok(links.some((l) => l.start[0] > 12 && l.end[0] < 10));
  for (const link of links) {
    assert.equal(link.kind, 'across');
    assert.ok(Math.abs(link.start[1] - 2) < 0.1 && Math.abs(link.end[1] - 2) < 0.1);
    assert.ok(link.cost >= Math.hypot(link.end[0] - link.start[0], link.end[2] - link.start[2]) + 1 - 1e-9);
  }
  addJumpLinks(mesh, links);
  const route = mesh.route(a, b);
  assert.equal(route.offMesh.length, 1);
  const crowd = new Crowd(mesh),
    agent = crowd.addAgent({ position: a, radius: 0.3 });
  agent.setTarget(b);
  for (let i = 0; i < 1200 && agent.state !== 'arrived'; i++) crowd.update(1 / 30);
  assert.ok(Math.hypot(agent.position[0] - b[0], agent.position[2] - b[2]) < 1, 'crossed the gap');
});

test('a gap too wide for the arc gets no link', () => {
  // A fall of 6 below the apex at d = 4, h = 1 reaches r = 2 (1 + sqrt 6) = 6.9 m, but the far side stands at the same
  // height and is crossed only at d; past d the arc is under its top.
  const world = level(...platforms(4.2)),
    links = find(build(world), world, { jumps: [{ height: 1, distance: 4 }] });
  assert.deepEqual(links, []);
});

test('the landing is where the arc of Definition 4.3 meets the ground', () => {
  // A platform 3 m over a floor; one setting, one direction: straight off the edge.
  const world = level(
      [
        [0, -1, 0],
        [30, 0, 10],
      ],
      [
        [0, 0, 0],
        [10, 3, 10],
      ],
    ),
    mesh = build(world),
    h = 1,
    d = 4,
    links = find(mesh, world, { jumps: [{ height: h, distance: d }], directions: 1 }),
    down = links.filter((l) => l.kind === 'down' && l.start[1] > 2.5);
  assert.ok(down.length > 0);
  for (const link of down) {
    const t = Math.hypot(link.end[0] - link.start[0], link.end[2] - link.start[2]),
      drop = link.start[1] - link.end[1];
    // Equation 1 solved for the height of the floor: 4h/d^2 (d t - t^2) = -drop.
    const expected = (d / 2) * (1 + Math.sqrt(1 + drop / h));
    assert.ok(Math.abs(t - expected) < 1e-6, `${t} against ${expected}`);
    assert.deepEqual(jumpPoint(link, 0), link.start);
    const landed = jumpPoint(link, 1);
    for (let i = 0; i < 3; i++) assert.ok(Math.abs(landed[i] - link.end[i]) < 1e-9);
    const top = jumpPoint(link, d / 2 / t);
    assert.ok(Math.abs(top[1] - (link.start[1] + h)) < 1e-6, 'the top of the arc is h up at d / 2');
  }
  assert.equal(links.filter((l) => l.kind === 'up').length, 0, '3 m is out of reach for a 1 m jump');
});

test('a fall past maxFall is refused, measured from the top of the arc', () => {
  const world = level(
      [
        [0, -1, 0],
        [30, 0, 10],
      ],
      [
        [0, 0, 0],
        [10, 3, 10],
      ],
    ),
    mesh = build(world),
    jumps = [{ height: 1, distance: 4 }],
    falls = (maxFall) => find(mesh, world, { jumps, maxFall }).filter((l) => l.kind === 'down').length;
  assert.equal(falls(3.9), 0, 'top of the arc is 4 m over the floor');
  assert.ok(falls(4.1) > 0);
});

test('a short wall can be jumped on to, a tall one cannot', () => {
  const step = (y) => {
    const world = level(
      [
        [0, -1, 0],
        [30, 0, 10],
      ],
      [
        [15, 0, 0],
        [30, y, 10],
      ],
    );
    return find(build(world), world, { jumps: [{ height: 1, distance: 3 }] }).filter((l) => l.kind === 'up').length;
  };
  assert.ok(step(0.7) > 0);
  assert.equal(step(1.2), 0);
});

test('the whole body is tested along the arc', () => {
  const gap = platforms(2),
    links = (...more) => {
      const world = level(...gap, ...more);
      return find(build(world), world, { jumps: [{ height: 1, distance: 4 }] }).filter(
        (l) => l.end[0] > 12 && l.start[0] < 10 && l.start[1] > 1.9 && l.end[1] > 1.9,
      );
    };
  assert.ok(links().length > 0);
  // A fence down the middle of the gap, rising past the top of the jump.
  assert.deepEqual(
    links([
      [10.9, 0, 0],
      [11.1, 6, 10],
    ]),
    [],
  );
  // A beam over the gap: the feet pass under it and the head does not.
  assert.deepEqual(
    links([
      [10.5, 4.2, 0],
      [11.5, 4.5, 10],
    ]),
    [],
  );
  // A beam just out of reach of the head, and a post a body width to the side of a jump, leave it alone.
  assert.ok(
    links([
      [10.5, 5.2, 0],
      [11.5, 5.5, 10],
    ]).length > 0,
  );
  // A beam the centre line misses by less than the radius still stops it: only the body's edge touches.
  assert.deepEqual(
    links([
      [11.3, 4.15, 0],
      [11.6, 4.4, 10],
    ]),
    [],
  );
});

test('a jump that saves no walking is dropped, and thin ledges keep their side', () => {
  // A trench with a wide bridge beside the jump points.
  const world = level(...platforms(2), [
      [10, 0, 0],
      [12, 2, 10],
    ]),
    mesh = build(world);
  assert.deepEqual(find(mesh, world), [], 'all one floor');
});

test('a tiled mesh gets links across tiles, and they sleep and wake with their ground', () => {
  const { positions, indices } = level(...platforms(2)),
    world = new TiledNavMesh(positions, indices, { ...options, tileSize: 64 }),
    links = findJumpLinks(world, positions, indices),
    single = find(buildNavMesh(positions, indices, options), { positions, indices });
  assert.ok(links.length > 0);
  assert.ok(Math.abs(links.length - single.length) <= single.length, 'seams do not read as ledges');
  const ids = addJumpLinks(world, links);
  assert.equal(ids.length, links.length);
  const a = [8, 2, 5],
    b = [14, 2, 5];
  assert.equal(world.route(a, b).offMesh.length, 1);
  const door = world.addObstacle({ min: [8, 0, -1], max: [14, 3, 11] });
  world.update();
  assert.equal(world.route([2, 2, 5], [18, 2, 5]), null);
  world.removeObstacle(door);
  world.update();
  assert.equal(world.route(a, b).offMesh.length, 1);
});

test('options are checked', () => {
  const world = level(...platforms(2)),
    mesh = build(world),
    bad = (extra) => assert.throws(() => find(mesh, world, extra), RangeError);
  bad({ radius: 0 });
  bad({ height: Number.NaN });
  bad({ climb: -1 });
  bad({ jumps: [] });
  bad({ jumps: [{ height: 0, distance: 1 }] });
  bad({ jumps: [{ height: 1, distance: Infinity }] });
  bad({ maxFall: 0 });
  bad({ spacing: -1 });
  bad({ directions: 0 });
  bad({ directions: 1.5 });
  bad({ jumpCost: -1 });
  assert.throws(() => findJumpLinks(mesh, [0, 0], [0]), RangeError);
});
