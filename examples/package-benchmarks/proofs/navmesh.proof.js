// Proof for @margoengine/navmesh: A* open set as a binary heap with cached link costs and heuristics, search arrays
// reused between calls, locate reading flat per-edge data instead of nested vertex arrays, and ORCA half-planes pooled.
// Run: node examples/package-benchmarks/proofs/navmesh.proof.js [ref] [pin]
// Pinned: f05414a against f47ff3f, the commit that recorded results/navmesh.json, so the run never depends on today's tree.
import assert from 'node:assert/strict';
import { refs, versions, time, record } from './compare.js';

const { ref, pin } = refs('f05414a', 'f47ff3f'),
  { baseline, candidate } = await versions('navmesh', ref, undefined, pin);
let seed = 12345;
const random = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
// A sloped floor of size x size cells with about 15% of cells blocked; every third open cell is split into two triangles.
function floor(size) {
  const vertices = [],
    polygons = [],
    row = size + 1;
  for (let z = 0; z <= size; z++) for (let x = 0; x <= size; x++) vertices.push([x, x * 0.125, z]);
  for (let z = 0; z < size; z++)
    for (let x = 0; x < size; x++) {
      if (random() < 0.15) continue;
      const a = z * row + x,
        b = a + 1,
        c = a + 1 + row,
        d = a + row;
      if ((x + z) % 3 === 0) polygons.push([a, b, c], [a, c, d]);
      else polygons.push([a, b, c, d]);
    }
  return { vertices, polygons, size };
}
const pointsFor = (size, count) =>
  Array.from({ length: count }, () => {
    const x = random() * (size + 1) - 0.5,
      z = random() * (size + 1) - 0.5;
    return [x, x * 0.125 + (random() - 0.5) * 0.2, z];
  });
const cases = [];
// 8x8 is one room (about 70 polygons), 32x32 a level floor (about 1,100), 56x56 is near the 4,096 polygon limit.
for (const size of [8, 32, 56]) {
  const data = floor(size),
    a = new baseline.NavMesh(data.vertices, data.polygons),
    b = new candidate.NavMesh(data.vertices, data.polygons);
  assert.ok(data.polygons.length <= 4096);
  assert.deepEqual(b.vertices, a.vertices);
  const points = pointsFor(size, 400);
  // Same polygon for every point, including points off the mesh and over blocked cells.
  const located = points.map((p) => a.locate(p));
  assert.deepEqual(
    points.map((p) => b.locate(p)),
    located,
  );
  assert.ok(located.includes(-1) && located.some((id) => id >= 0));
  // Same corner list, bit for bit, for every start/end pair; unreachable and off-mesh pairs must both give null.
  let found = 0,
    corners = 0;
  for (let i = 0; i < points.length; i++) {
    const start = points[i],
      end = points[(i * 7 + 3) % points.length],
      expected = a.path(start, end),
      actual = b.path(start, end);
    assert.deepEqual(actual, expected);
    if (expected) {
      found++;
      corners += expected.length;
    }
    // Results are caller-owned copies: a second search must not disturb an earlier result.
    if (actual) {
      const copy = structuredClone(actual);
      b.path(end, start);
      assert.deepEqual(actual, copy);
    }
  }
  assert.ok(found > 50 && corners > found * 2);
  // Fewer timed calls on the large meshes keep the proof under a minute; 100 paths is a squad replanning in one frame.
  const paths = size > 8 ? 100 : 400;
  cases.push({
    case: `path on ${data.polygons.length} polygons`,
    paths,
    ...time(
      () => {
        for (let i = 0; i < paths; i++) a.path(points[i], points[(i * 7 + 3) % 400]);
      },
      () => {
        for (let i = 0; i < paths; i++) b.path(points[i], points[(i * 7 + 3) % 400]);
      },
    ),
  });
  cases.push({
    case: `locate on ${data.polygons.length} polygons`,
    lookups: 400,
    ...time(
      () => {
        for (let i = 0; i < 400; i++) a.locate(points[i]);
      },
      () => {
        for (let i = 0; i < 400; i++) b.locate(points[i]);
      },
    ),
  });
}
// Edge cases from the package tests.
for (const { NavMesh } of [baseline, candidate]) {
  const mesh = new NavMesh(
    [
      [0, 0, 0],
      [2, 0, 0],
      [2, 0, 2],
      [0, 0, 2],
      [4, 0, 0],
      [4, 0, 2],
      [4, 0, 4],
      [2, 0, 4],
    ],
    [
      [0, 1, 2, 3],
      [1, 4, 5, 2],
      [2, 5, 6, 7],
    ],
  );
  assert.deepEqual(mesh.path([0.5, 0, 1], [3.5, 0, 1]), [
    [0.5, 0, 1],
    [3.5, 0, 1],
  ]);
  assert.deepEqual(mesh.path([0.5, 0, 0.5], [0.6, 0, 0.6]), [
    [0.5, 0, 0.5],
    [0.6, 0, 0.6],
  ]);
  assert.equal(mesh.path([-1, 0, 0], [3, 0, 3]), null);
  assert.throws(() => mesh.locate([0, NaN, 0]), { name: 'RangeError', message: 'Expected finite 3D point' });
  assert.throws(() => mesh.path([0, 0], [1, 0, 1]), { name: 'RangeError' });
  assert.throws(
    () =>
      new NavMesh(
        [
          [0, 0, 0],
          [1, 0, 0],
          [0, 0, 1],
          [0.2, 0, 0.2],
        ],
        [[0, 1, 3, 2]],
      ),
    /convex/,
  );
  assert.throws(
    () =>
      new NavMesh(
        [
          [0, 0, 0],
          [1, 0, 0],
          [0, 0, 1],
        ],
        [
          [0, 1, 2],
          [0, 1, 2],
          [0, 1, 2],
        ],
      ),
    /Non-manifold/,
  );
  const disconnected = new NavMesh(
    [
      [0, 0, 0],
      [1, 0, 0],
      [0, 0, 1],
      [3, 0, 0],
      [4, 0, 0],
      [3, 0, 1],
    ],
    [
      [0, 1, 2],
      [3, 4, 5],
    ],
  );
  assert.equal(disconnected.path([0.1, 0, 0.1], [3.1, 0, 0.1]), null);
}
const three = new baseline.NavMesh(
    [
      [0, 0, 0],
      [2, 0, 0],
      [2, 0, 2],
      [0, 0, 2],
      [4, 0, 0],
      [4, 0, 2],
      [4, 0, 4],
      [2, 0, 4],
    ],
    [
      [0, 1, 2, 3],
      [1, 4, 5, 2],
      [2, 5, 6, 7],
    ],
  ),
  threeNew = new candidate.NavMesh(
    [
      [0, 0, 0],
      [2, 0, 0],
      [2, 0, 2],
      [0, 0, 2],
      [4, 0, 0],
      [4, 0, 2],
      [4, 0, 4],
      [2, 0, 4],
    ],
    [
      [0, 1, 2, 3],
      [1, 4, 5, 2],
      [2, 5, 6, 7],
    ],
  );
assert.deepEqual(threeNew.path([0.5, 0, 0.5], [3, 0, 3.5]), three.path([0.5, 0, 0.5], [3, 0, 3.5]));

// ORCA: 200 agents in two crowds walking through each other plus a packed, overlapping knot in the middle (which
// exercises the infeasible fallback). The baseline drives the simulation; every (agent, neighbours) call is replayed.
const agents = Array.from({ length: 200 }, (_, id) => {
  const knot = id >= 160,
    side = id % 2 ? 1 : -1,
    position = knot ? [(random() - 0.5) * 2, (random() - 0.5) * 2] : [side * (6 + random() * 6), (random() - 0.5) * 10];
  const preferred = knot ? [(random() - 0.5) * 0.4, (random() - 0.5) * 0.4] : [-side * 1.3, (random() - 0.5) * 0.3];
  return {
    id,
    position,
    velocity: [...preferred],
    preferred,
    radius: 0.3 + (id % 3) * 0.05,
    maxSpeed: knot ? 0.5 : 1.4,
  };
});
const calls = [];
for (let frame = 0; frame < 90; frame++) {
  const next = agents.map((agent) => {
    const neighbors = agents
      .filter(
        (other) =>
          other !== agent &&
          Math.hypot(other.position[0] - agent.position[0], other.position[1] - agent.position[1]) < 3,
      )
      .slice(0, 12);
    // Every third frame is recorded with frozen copies, the self entry included once to cover the id skip.
    if (frame % 3 === 0)
      calls.push([structuredClone(agent), structuredClone(frame % 2 ? neighbors : [agent, ...neighbors])]);
    return baseline.avoid(agent, neighbors);
  });
  agents.forEach((agent, i) => {
    agent.velocity = [next[i][0], next[i][1]];
    agent.position = [agent.position[0] + next[i][0] / 60, agent.position[1] + next[i][1] / 60];
  });
}
for (const [agent, neighbors] of calls) {
  const expected = baseline.avoid(agent, neighbors),
    actual = candidate.avoid(agent, neighbors);
  assert.deepEqual(actual, expected);
  assert.ok(Number.isFinite(actual[0]) && Number.isFinite(actual[1]));
  assert.deepEqual(candidate.avoid(agent, neighbors, 1 / 30, 0.5), baseline.avoid(agent, neighbors, 1 / 30, 0.5));
}
for (const { avoid } of [baseline, candidate]) {
  const a = { id: 1, position: [-2, 0], velocity: [1, 0], preferred: [1, 0], radius: 0.4, maxSpeed: 1 },
    b = { ...a, id: 2, position: [2, 0], velocity: [-1, 0], preferred: [-1, 0] },
    output = new Float64Array(2);
  assert.equal(avoid(a, [b], 1 / 60, 2, output), output);
  assert.deepEqual(Array.from(output), [0.96, -0.19595917942265426]);
  assert.deepEqual(Array.from(avoid(a, [])), [1, 0]);
  assert.throws(() => avoid(a, [b], 0), { name: 'RangeError', message: 'Invalid ORCA timestep or neighbor budget' });
  assert.throws(() => avoid(a, [{ ...b, radius: NaN }]), { name: 'RangeError', message: 'Invalid ORCA agent' });
  assert.ok([...avoid(a, [{ ...b, position: [...a.position] }])].every(Number.isFinite));
  // A failed call must not leak half-built state into the next one.
  assert.throws(() => avoid(a, [b, b, { ...b, id: 3, velocity: [0] }]));
  assert.deepEqual(Array.from(avoid(a, [b], 1 / 60, 2, output)), [0.96, -0.19595917942265426]);
}
const out = new Float64Array(2);
// 6,000 calls is 200 agents for half a second at 60 FPS, each against up to 12 neighbours.
cases.push({
  case: 'avoid, 200 agents with up to 12 neighbours',
  calls: calls.length,
  ...time(
    () => {
      for (let i = 0; i < calls.length; i++) baseline.avoid(calls[i][0], calls[i][1], 1 / 60, 2, out);
    },
    () => {
      for (let i = 0; i < calls.length; i++) candidate.avoid(calls[i][0], calls[i][1], 1 / 60, 2, out);
    },
  ),
});
await record(
  'navmesh',
  ref,
  cases,
  'NavMesh.path uses a (cost, index) binary heap, link costs computed once at construction and per-search cached heuristics; NavMesh.locate reads flat edge arrays; avoid reuses its half-plane records between calls.',
  pin,
);
