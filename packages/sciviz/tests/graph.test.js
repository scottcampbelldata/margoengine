import { speedEnabled, deferSpeed } from '../../../scripts/support/speed-phase.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { ForceLayout, boundsOf } from '@margoengine/sciviz/graph';

const ring = (n) => ({ nodes: n, edges: Array.from({ length: n }, (_, i) => [i, (i + 1) % n]).flat() });
const close = (a, b, eps) => assert.ok(Math.abs(a - b) <= eps, `${a} != ${b}`);
const length = (p, a, b) => Math.hypot(p[a * 3] - p[b * 3], p[a * 3 + 1] - p[b * 3 + 1], p[a * 3 + 2] - p[b * 3 + 2]);

// Ten seeds at the shipped default theta (0.9). Under the plain Barnes and Hut opening test seed 3 kept two crossed
// edges crossed for ever (edges 13 % uneven); Barnes's 1994 test opens the cell that hid them (see the far side test).
test('a ring settles into an even loop at the default theta: edges of one length, nodes apart, the plane kept in 2D', () => {
  for (let seed = 1; seed <= 10; seed++) {
    const layout = new ForceLayout(ring(24), { seed });
    for (let i = 0; i < 400; i++) layout.step();
    const p = layout.positions,
      lengths = Array.from({ length: 24 }, (_, i) => length(p, i, (i + 1) % 24));
    const mean = lengths.reduce((a, b) => a + b) / 24,
      spread = Math.sqrt(lengths.reduce((a, b) => a + (b - mean) ** 2, 0) / 24);
    assert.ok(spread / mean < 0.1, `seed ${seed}: edge lengths vary by ${spread / mean}`);
    for (let i = 0; i < 24; i++) assert.equal(p[i * 3 + 2], 0);
    // Opposite nodes lie about a diameter apart: the loop is open, not folded.
    const opposite = Array.from({ length: 12 }, (_, i) => length(p, i, i + 12)).reduce((a, b) => a + b) / 12;
    assert.ok(
      opposite > ((mean * 24) / Math.PI) * 0.8,
      `seed ${seed}: opposite nodes ${opposite} apart, edges ${mean}`,
    );
  }
});

test('the Barnes-Hut push matches exact all pairs within its opening angle', () => {
  const graph = { nodes: 300, edges: [] },
    exact = new ForceLayout(graph, { theta: 0, seed: 9, temperature: 1e9, gravity: 0 }),
    tree = new ForceLayout(graph, { theta: 0.5, seed: 9, temperature: 1e9, gravity: 0 });
  const start = Float32Array.from(exact.positions);
  exact.step();
  tree.step();
  // With no cap, a node's move is its force: compare the two forces by relative error of the sum of moves.
  let error = 0,
    size = 0;
  for (let i = 0; i < start.length; i++) {
    const a = exact.positions[i] - start[i],
      b = tree.positions[i] - start[i];
    error += (a - b) ** 2;
    size += a * a;
  }
  assert.ok(Math.sqrt(error / size) < 0.02, `tree force error ${Math.sqrt(error / size)}`);
});

test('two cliques joined by one edge end up apart, each tight; 3D uses all three axes', () => {
  const edges = [];
  for (const base of [0, 10])
    for (let i = 0; i < 10; i++) for (let j = i + 1; j < 10; j++) edges.push(base + i, base + j);
  edges.push(0, 10);
  const layout = new ForceLayout({ nodes: 20, edges }, { dimensions: 3, seed: 5 });
  for (let i = 0; i < 300; i++) layout.step();
  const p = layout.positions;
  let inside = 0,
    across = 0;
  for (let i = 0; i < 10; i++)
    for (let j = 0; j < 10; j++) {
      if (i !== j) inside += length(p, i, j) + length(p, 10 + i, 10 + j);
      across += length(p, i, 10 + j);
    }
  assert.ok(inside / 180 < across / 100, `inside ${inside / 180}, across ${across / 100}`);
  const b = boundsOf(p);
  assert.ok(b[5] - b[4] > 0.1, 'the layout uses z');
});

test('run() is an async iterator that stops at its limit, at rest, or on abort', async () => {
  const layout = new ForceLayout(ring(8), { seed: 2 });
  let steps = 0;
  for await (const step of layout.run({ iterations: 5 })) {
    steps++;
    assert.equal(step.positions, layout.positions);
  }
  assert.equal(steps, 5);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    async () => {
      for await (const _ of layout.run({ signal: controller.signal })) assert.fail('ran after abort');
    },
    { name: 'AbortError' },
  );
  const still = new ForceLayout({ nodes: 1, edges: [] }, { gravity: 0 });
  let count = 0;
  for await (const _ of still.run({ iterations: 50 })) count++;
  assert.equal(count, 1, 'a single node is at rest after one step');
});

test('a million-edge graph lays out step by step (diagnostic timing)', () => {
  const nodes = 100_000,
    edges = new Uint32Array(2_000_000);
  let seed = 7;
  const next = () => (seed = (seed * 1103515245 + 12345) >>> 0) % nodes;
  for (let i = 0; i < edges.length; i += 2) {
    edges[i] = next();
    edges[i + 1] = next();
  }
  const layout = new ForceLayout({ nodes, edges }, { seed: 1 });
  if (!speedEnabled()) deferSpeed('sciviz million-edge graph timing');
  const started = performance.now();
  for (let i = 0; i < 2; i++) {
    const step = layout.step();
    assert.ok(Number.isFinite(step.moved) && step.moved > 0);
  }
  const ms = (performance.now() - started) / 2;
  for (const v of layout.positions) assert.ok(Number.isFinite(v));
  if (speedEnabled()) console.log(`1,000,000 edges, 100,000 nodes: ${ms.toFixed(0)} ms per step (diagnostic)`);
});

test('bad graphs are refused', () => {
  assert.throws(() => new ForceLayout({ nodes: 0, edges: [] }), RangeError);
  assert.throws(() => new ForceLayout({ nodes: 2, edges: [0] }), RangeError);
  assert.throws(() => new ForceLayout({ nodes: 2, edges: [0, 2] }), /node 2/);
  assert.throws(() => new ForceLayout({ nodes: 2, edges: [0, 1], weights: [1, 2] }), RangeError);
  assert.throws(() => new ForceLayout({ nodes: 2, edges: [] }, { dimensions: 4 }), RangeError);
  assert.throws(() => new ForceLayout({ nodes: 2, edges: [] }, { positions: [0, 0] }), RangeError);
});

// One step with no cap, no edges and no pull to the centre moves each node by exactly its push.
const pushes = (positions, theta, dimensions = 2) => {
  const nodes = positions.length / 3,
    layout = new ForceLayout(
      { nodes, edges: [] },
      { theta, positions, temperature: 1e12, cooling: 1, gravity: 0, dimensions },
    );
  layout.step();
  return Array.from(layout.positions, (v, i) => v - positions[i]);
};

test('with theta 0 the push is Fruchterman and Reingold k^2 / d over every other node, exactly', () => {
  const positions = [0, 0, 0, 3, 0, 0, 3, 4, 0, -1, 2, 0, 3, 4.5, 0.5];
  for (const dimensions of [2, 3]) {
    // A 2D layout keeps every node on z = 0, so its push is over the points dropped onto that plane.
    const used = dimensions === 2 ? positions.map((v, i) => (i % 3 === 2 ? 0 : v)) : positions,
      moved = pushes(positions, 0, dimensions);
    for (let i = 0; i < 5; i++) {
      const want = [0, 0, 0];
      for (let j = 0; j < 5; j++) {
        if (i === j) continue;
        const d = [0, 1, 2].map((a) => used[i * 3 + a] - used[j * 3 + a]),
          r2 = d[0] ** 2 + d[1] ** 2 + d[2] ** 2;
        for (let a = 0; a < 3; a++) want[a] += d[a] / r2; // k = 1: (d / |d|) k^2 / |d|
      }
      for (let a = 0; a < dimensions; a++) close(moved[i * 3 + a], want[a], 1e-4);
      if (dimensions === 2)
        assert.ok(moved[i * 3 + 2] === -positions[i * 3 + 2], 'a 2D layout puts given points on z = 0');
    }
  }
});

// Barnes and Hut's acceptance test, side < theta times the distance to the centre of mass, passes for a cell that
// holds the node itself when theta is large enough (their 1989 appendix A says so). Here node 0 sits in the root's
// corner and nine nodes crowd the far corner, so the root passed the test for node 0 and the push counted node 0's
// own mass: 0.79 k^2 instead of 0.64 k^2, 23 % too strong, before the explicit inside check.
test('a cell holding the node is never taken as one body, whatever theta', () => {
  const positions = [0, 0, 0];
  for (let j = 0; j < 9; j++) positions.push(10 + j * 0.001, 10, 0);
  const exact = pushes(positions, 0),
    tree = pushes(positions, 0.9);
  const a = Math.hypot(exact[0], exact[1]),
    b = Math.hypot(tree[0], tree[1]);
  assert.ok(Math.abs(b - a) / a < 0.01, `tree push ${b} against exact ${a}`);
});

// Barnes and Hut's test d > s / theta reads d to the centre of mass, so a cell whose mass sits in its far corner
// passed it for a node just outside its near corner, with a node inside the cell right beside it (Salmon and Warren
// 1994). Here the cell [5, 10] x [5, 10] holds 20 nodes at (9.99, 9.99) and one at (5.01, 5.01), and node 0 sits at
// (4.99, 4.99): the plain test at theta 0.9 took the cell as one body 6.5 away and pushed node 0 by 3.2 k^2 where the
// near node alone pushes 35 k^2. Barnes's 1994 test, d > s / theta + delta, opens it. At the default theta 0.9 this is
// what kept a ring's crossed edges crossed for ever (seed 3 of the ring test, edges 13 % uneven).
test('a cell whose mass sits on its far side is opened for a node beside its near side', () => {
  const positions = [4.99, 4.99, 0, 0, 0, 0, 5.01, 5.01, 0];
  for (let j = 0; j < 20; j++) positions.push(9.99 - j * 1e-4, 9.99, 0);
  positions.push(10, 10, 0);
  const exact = pushes(positions, 0),
    tree = pushes(positions, 0.9);
  const a = Math.hypot(exact[0], exact[1]),
    b = Math.hypot(tree[0], tree[1]);
  assert.ok(Math.abs(b - a) / a < 0.01, `tree push ${b} against exact ${a}`);
});

test('nodes at one place part, and a body joining their leaf later sees them as one mass', () => {
  // Nodes 0 and 1 coincide; node 2 arrives in their leaf afterwards and splits it.
  const positions = [1, 1, 0, 1, 1, 0, 1.5, 1, 0],
    moved = pushes(positions, 0);
  close(moved[6], 2 / 0.5, 1e-4); // two nodes at distance 0.5 push node 2 by 2 k^2 / 0.5
  close(moved[7], 0, 1e-9);
  assert.ok(Math.hypot(moved[0] - moved[3], moved[1] - moved[4]) > 1, 'the coincident pair moves apart');
  const layout = new ForceLayout(
    { nodes: 2, edges: [0, 1] },
    { positions: [0, 0, 0, 0, 0, 0], gravity: 0, simmer: 0.001 },
  );
  for (let i = 0; i < 200; i++) layout.step();
  close(length(layout.positions, 0, 1), 1, 0.05); // k^2 / d = d^2 / k at d = k
});

test('the temperature cools to the simmer floor and stays there', () => {
  const layout = new ForceLayout(ring(6), { temperature: 1, cooling: 0.5, simmer: 0.1 });
  const seen = Array.from({ length: 8 }, () => layout.step().temperature);
  assert.deepEqual(seen.slice(0, 4), [1, 0.5, 0.25, 0.125]);
  for (const t of seen.slice(4)) close(t, 0.1, 1e-12);
  assert.throws(() => new ForceLayout(ring(3), { simmer: -1 }), RangeError);
});
