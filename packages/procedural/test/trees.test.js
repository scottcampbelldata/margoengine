import test from 'node:test';
import assert from 'node:assert/strict';
import { createTreeGenerator } from '../dist/trees.js';

function graph(a, root = [0, 0, 0], segment = 0.2) {
  assert.deepEqual([...a.positions.slice(0, 3)], root);
  assert.equal(a.positions.length, a.parents.length * 3);
  assert.equal(a.parents[0], -1);
  assert.ok(a.positions.every(Number.isFinite));
  for (let i = 1; i < a.parents.length; i++) {
    const p = a.parents[i];
    assert.ok(p >= 0 && p < i, 'every node reaches the sole root without cycles');
    const d = Math.hypot(...a.positions.slice(i * 3, i * 3 + 3).map((v, k) => v - a.positions[p * 3 + k]));
    assert.ok(Math.abs(d - segment) < 1e-8, 'each branch has the requested length');
  }
}
// Independent exhaustive all-node implementation of the published direction rule.
function reference(points, options = {}) {
  const root = options.root ?? [0, 0, 0],
    segment = options.segmentLength ?? 0.2,
    influence = options.influenceRadius ?? 3,
    kill = options.killRadius ?? 0.3,
    maxNodes = options.maxNodes ?? 2048,
    maxIterations = options.maxIterations ?? 128;
  const nodes = [[...root]],
    parents = [-1],
    active = Array(points.length / 3).fill(true);
  let tests = 0,
    remaining = active.length,
    iterations = 0,
    stopped = 'maxIterations';
  const nearest = (i) => {
    let index = -1,
      best = influence * influence;
    for (let j = 0; j < nodes.length; j++) {
      tests++;
      let d = 0;
      for (let k = 0; k < 3; k++) d += (points[i * 3 + k] - nodes[j][k]) ** 2;
      if (d < best || (d === best && index === -1)) {
        best = d;
        index = j;
      }
    }
    return [index, best];
  };
  for (let round = 0; round < maxIterations; round++) {
    const sums = nodes.map(() => [0, 0, 0]);
    for (let i = 0; i < active.length; i++)
      if (active[i]) {
        const [j, d] = nearest(i);
        if (j < 0) continue;
        if (d <= kill * kill) {
          active[i] = false;
          remaining--;
        } else for (let k = 0; k < 3; k++) sums[j][k] += (points[i * 3 + k] - nodes[j][k]) / Math.sqrt(d);
      }
    if (!remaining) {
      stopped = 'complete';
      break;
    }
    if (nodes.length === maxNodes) {
      stopped = 'maxNodes';
      break;
    }
    const before = nodes.length;
    for (let j = 0; j < sums.length; j++) {
      const s = sums[j],
        length = Math.sqrt(s[0] ** 2 + s[1] ** 2 + s[2] ** 2);
      if (length <= 1e-12) continue;
      nodes.push(s.map((v, k) => nodes[j][k] + (segment * v) / length));
      parents.push(j);
      if (nodes.length === maxNodes) break;
    }
    iterations++;
    if (nodes.length === before) {
      stopped = 'stalled';
      break;
    }
  }
  for (let i = 0; i < active.length; i++)
    if (active[i]) {
      const [j, d] = nearest(i);
      if (j >= 0 && d <= kill * kill) remaining--;
    }
  if (!remaining) stopped = 'complete';
  else if (nodes.length === maxNodes) stopped = 'maxNodes';
  return {
    positions: Float64Array.from(nodes.flat()),
    parents: Int32Array.from(parents),
    remainingAttractions: remaining,
    iterations,
    distanceTests: tests,
    stopped,
  };
}

test('seeded default crown grows connected finite branching, with owned stable output', async () => {
  using generator = await createTreeGenerator();
  for (let seed = 0; seed < 32; seed++) {
    const a = generator.generate({ seed });
    graph(a);
    assert.ok(a.parents.length > 20);
    assert.ok(a.parents.length <= 2048);
    assert.equal(a.attractionPoints.length, 512 * 3);
    const childCounts = new Uint32Array(a.parents.length);
    for (const p of a.parents.subarray(1)) childCounts[p]++;
    assert.ok(
      childCounts.some((n) => n > 1),
      'default grows branches as well as a trunk',
    );
    assert.deepEqual(a, generator.generate({ seed }));
    assert.ok(a.remainingAttractions < 512);
  }
  assert.notDeepEqual(generator.generate({ seed: 7 }).positions, generator.generate({ seed: 8 }).positions);
  const a = generator.generate(),
    saved = a.positions.slice(),
    cloud = a.attractionPoints.slice();
  generator.generate({ attractionCount: 8192, maxNodes: 64, maxIterations: 32 });
  assert.deepEqual(a.positions, saved);
  assert.deepEqual(a.attractionPoints, cloud);
  for (const root of [
    [1e6, 1e6, 1e6],
    [-1e6, -1e6, -1e6],
  ])
    graph(generator.generate({ root }), root);
});
test('grid growth equals exhaustive skeleton and reduces exact nearest distance tests', async () => {
  using generator = await createTreeGenerator();
  const input = generator.generate({ seed: 19 }).attractionPoints;
  const options = { influenceRadius: 1.5, attractionPoints: input, seed: 19 };
  const a = generator.generate(options),
    b = reference(input, options);
  assert.deepEqual(a.positions, b.positions);
  assert.deepEqual(a.parents, b.parents);
  assert.equal(a.remainingAttractions, b.remainingAttractions);
  assert.equal(a.stopped, b.stopped);
  assert.equal(a.iterations, b.iterations);
  assert.ok(a.distanceTests < b.distanceTests / 2);
  console.log(
    JSON.stringify({
      treeWork: {
        gridTests: a.distanceTests,
        exhaustiveTests: b.distanceTests,
        nodes: a.parents.length,
        identicalSkeleton: true,
      },
    }),
  );
  // Boundary cells, equidistant attractors, duplicate points and negative coordinates.
  for (const points of [
    [1, 0, 0, -1, 0, 0],
    [-1, -1, 0, -1, -1, 0, -2, 0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0.3, 0, 0, 1.5, 0, -0.0001, 0, 0],
  ]) {
    const attractionPoints = Float64Array.from(points),
      settings = { attractionPoints, influenceRadius: 1.5 };
    const a = generator.generate(settings),
      b = reference(attractionPoints, settings);
    assert.deepEqual(a.positions, b.positions);
    assert.deepEqual(a.parents, b.parents);
    assert.equal(a.remainingAttractions, b.remainingAttractions);
    assert.equal(a.stopped, b.stopped);
  }
});
test('custom downward root, caps, unreachable points, empty and reached clouds have defined results', async () => {
  using generator = await createTreeGenerator();
  const root = [0, 0, 0],
    attractionPoints = new Float64Array([0, -2, 0]);
  const a = generator.generate({ root, attractionPoints });
  graph(a, root);
  assert.equal(a.stopped, 'complete');
  assert.equal(a.remainingAttractions, 0);
  assert.ok(a.positions.at(-2) < -1.5);
  assert.equal(generator.generate({ attractionPoints: new Float64Array() }).parents.length, 1);
  assert.equal(generator.generate({ attractionPoints: new Float64Array([0, 0, 0]) }).stopped, 'complete');
  assert.equal(generator.generate({ attractionPoints: new Float64Array([0, 100, 0]) }).stopped, 'stalled');
  const cap = generator.generate({ maxNodes: 1 });
  assert.equal(cap.parents.length, 1);
  assert.equal(cap.stopped, 'maxNodes');
  assert.equal(generator.generate({ maxIterations: 1 }).stopped, 'maxIterations');
  const boundary = generator.generate({
    attractionPoints,
    segmentLength: 0.0001,
    killRadius: 0.00005,
    influenceRadius: 1e6,
    maxNodes: 16384,
    maxIterations: 512,
  });
  graph(boundary, root, 0.0001);
});
test('rounded influence boundary across two cells matches exhaustive growth', async () => {
  using generator = await createTreeGenerator();
  const attractionPoints = new Float64Array([1, 0, 0]),
    options = { attractionPoints, root: [-Number.MIN_VALUE, 0, 0], influenceRadius: 1 };
  const a = generator.generate(options),
    b = reference(attractionPoints, options);
  assert.ok(a.parents.length > 1, 'the rounded distance is within the influence radius');
  assert.deepEqual(a.positions, b.positions);
  assert.deepEqual(a.parents, b.parents);
  assert.equal(a.remainingAttractions, b.remainingAttractions);
  assert.equal(a.stopped, b.stopped);
});
test('hostile inputs, cancellation and repeat disposal report coded failures', async () => {
  const generator = await createTreeGenerator();
  const coded = (e) => e.code === 'failed' && e.message.includes('https://margoengine.com/errors#procedural');
  for (const options of [
    { seed: NaN },
    { seed: -1 },
    { seed: 2 ** 32 },
    { seed: '1' },
    { root: [0, Infinity, 0] },
    { root: [0, NaN, 0] },
    { root: [0, 1e6 + 1, 0] },
    { root: [] },
    { attractionPoints: [] },
    { attractionPoints: new Float32Array(3) },
    { attractionPoints: new Float64Array(2) },
    { attractionPoints: new Float64Array([NaN, 0, 0]) },
    { attractionPoints: new Float64Array([0, 0, 1e20]) },
    { attractionPoints: new Float64Array(8193 * 3) },
    { attractionCount: 0 },
    { attractionCount: 8193 },
    { maxNodes: 0 },
    { maxNodes: 16385 },
    { maxIterations: 0 },
    { maxIterations: 513 },
    { attractionCount: 8192, maxNodes: 16384, maxIterations: 512 },
    { influenceRadius: NaN },
    { influenceRadius: Infinity },
    { influenceRadius: 0 },
    { segmentLength: 0 },
    { segmentLength: Infinity },
    { segmentLength: 10001 },
    { killRadius: 0 },
    { killRadius: 4 },
    { killRadius: NaN },
  ])
    assert.throws(() => generator.generate(options), coded);
  const signal = AbortSignal.abort();
  await assert.rejects(createTreeGenerator({ signal }), { name: 'AbortError' });
  assert.throws(() => generator.generate({ signal }), { name: 'AbortError' });
  const a = generator.generate(),
    copy = a.positions.slice();
  generator.dispose();
  generator[Symbol.dispose]();
  assert.deepEqual(a.positions, copy);
  assert.throws(() => generator.generate(), { code: 'disposed' });
});
