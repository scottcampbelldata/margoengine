import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  GPUGraphLayout,
  GraphLayoutReference,
  bundleGraphEdgesReference,
  edgeCompatibility,
  placeGraphLabels,
} from '@margoengine/sciviz/graph-gpu';
import { ForceLayout } from '@margoengine/sciviz/graph';

const close = (a, b, eps = 1e-5) => assert.ok(Math.abs(a - b) <= eps, `${a} vs ${b}`);
const graph = { nodes: 4, edges: [0, 1, 1, 2, 2, 3, 3, 0, 0, 2], weights: [1, 2, 0.5, 1, 3] };
const positions = Float32Array.of(-2, -1, 0, 2, -1, 0, 1, 2, 0, -1, 2, 0);
test('new FR reference agrees with the retained exact ForceLayout over weighted iterations', () => {
  const options = {
    model: 'fruchterman-reingold',
    positions,
    theta: 0,
    gravity: 0.02,
    temperature: 0.3,
    cooling: 0.91,
  };
  const reference = new GraphLayoutReference(graph, options),
    original = new ForceLayout(graph, options);
  for (let k = 0; k < 8; k++) {
    reference.step();
    original.step();
    for (let i = 0; i < positions.length; i++) close(reference.positions[i], original.positions[i]);
  }
});
test('FA2 analytic two-node degree masses, effective traction, swinging and local speed', () => {
  const layout = new GraphLayoutReference(
    { nodes: 2, edges: [0, 1] },
    { positions: [-1, 0, 0, 1, 0, 0], gravity: 0, scaling: 2 },
  );
  // mass 2 each, repulsion -4, attraction +2 => force -2 on the left. Global speed = 1/2.
  const factor = 0.05 / (1 + 0.5 * Math.sqrt(4));
  layout.step();
  close(layout.positions[0], -1 - 2 * factor);
  close(layout.positions[3], 1 + 2 * factor);
  close(layout.speed, 0.5);
});
test('FA2 options preserve fixed nodes, prevent overlap, handle loops, duplicates, isolates and 3D', () => {
  const g = { nodes: 4, edges: [0, 1, 0, 1, 1, 1, 2, 3], weights: [2, 0, 3, 1] },
    p = [-1, 0, 1, 1, 0, -1, 2, 1, 0, -2, 1, 0];
  const layout = new GraphLayoutReference(g, {
    positions: p,
    dimensions: 3,
    fixed: [1, 0, 0, 0],
    radii: [0.2, 0.3, 0.1, 0.1],
    linLog: true,
    dissuadeHubs: true,
    strongGravity: true,
    weightInfluence: 0.5,
  });
  for (let i = 0; i < 20; i++) layout.step();
  assert.deepEqual([...layout.positions.slice(0, 3)], p.slice(0, 3));
  assert.ok(layout.positions.every(Number.isFinite));
  assert.notDeepEqual([...layout.positions.slice(3)], p.slice(3));
  const overlap = new GraphLayoutReference(
    { nodes: 2, edges: [] },
    { positions: [0, 0, 0, 0, 0, 0], gravity: 0, radii: [1, 1] },
  );
  overlap.step();
  assert.ok(Math.hypot(...overlap.positions.slice(0, 3)) > 0);
});
test('graph inputs reject nonfinite and truncated values before GPU allocation', () => {
  for (const [g, o] of [
    [{ nodes: 0, edges: [] }, {}],
    [{ nodes: 2, edges: [0, 1.5] }, {}],
    [{ nodes: 2, edges: [0, 1], weights: [NaN] }, {}],
    [graph, { positions: [1] }],
    [graph, { theta: Infinity }],
    [graph, { gridSide: 3 }],
    [graph, { positions: new Array(12).fill(Infinity) }],
    [graph, { fixed: [0] }],
    [graph, { radii: [-1, 0, 0, 0] }],
    [graph, { jitterTolerance: 0 }],
  ])
    assert.throws(() => new GraphLayoutReference(g, o), RangeError);
  assert.equal(typeof GPUGraphLayout, 'function');
});
test('edge compatibility is symmetric and rejects orthogonal, hidden and zero-length pairs', () => {
  const a = [0, 0, 0],
    b = [10, 0, 0],
    c = [0, 1, 0],
    d = [10, 1, 0];
  close(edgeCompatibility(a, b, c, d), 10 / 11);
  close(edgeCompatibility(c, d, a, b), 10 / 11);
  close(edgeCompatibility(a, b, d, c), 10 / 11);
  close(edgeCompatibility(a, a, c, d), 0);
  close(edgeCompatibility(a, b, [5, -5, 0], [5, 5, 0]), 0);
  close(edgeCompatibility(a, b, [20, 0, 0], [30, 0, 0]), 0);
});
test('FDEB cycles keep endpoints, align reversed edges and draw parallel edges closer', () => {
  const g = { nodes: 4, edges: [0, 1, 3, 2] },
    p = Float32Array.of(0, 0, 0, 10, 0, 0, 0, 1, 0, 10, 1, 0);
  const r = bundleGraphEdgesReference(g, p, { cycles: 3, iterations: 12, step: 0.02 });
  assert.equal(r.pointsPerEdge, 6);
  assert.ok(r.positions.every(Number.isFinite));
  for (let e = 0; e < 2; e++)
    for (const j of [0, 5]) {
      const node = g.edges[e * 2 + (j ? 1 : 0)];
      assert.deepEqual(
        [...r.positions.slice((e * 6 + j) * 4, (e * 6 + j) * 4 + 3)],
        [...p.slice(node * 3, node * 3 + 3)],
      );
    }
  assert.ok(r.positions[2 * 4 + 1] > 0);
  assert.ok(r.positions[(6 + 3) * 4 + 1] < 1);
});
test('label placements are priority ordered, disjoint, clipped, repeatable and preserve literal text', () => {
  const input = Array.from({ length: 100 }, (_, i) => ({
    node: i,
    text: `<&${i}`,
    x: 100 + (i % 10),
    y: 50 + (i % 8),
    width: 45,
    height: 16,
    priority: i === 70 ? 10 : 0,
  }));
  const a = placeGraphLabels(input, 220, 120);
  assert.ok(a.length > 1 && a.length < input.length);
  assert.equal(a[0].node, 70);
  assert.equal(a[0].text, '<&70');
  assert.deepEqual(a, placeGraphLabels(input, 220, 120));
  for (const b of a) {
    assert.ok(b.x >= 0 && b.y >= 0 && b.x + b.width <= 220 && b.y + b.height <= 120);
    for (const c of a)
      if (b !== c)
        assert.ok(b.x + b.width <= c.x || c.x + c.width <= b.x || b.y + b.height <= c.y || c.y + c.height <= b.y);
  }
});
test('bundling and async GPU run honor pre-aborted signals', () => {
  const controller = new AbortController();
  controller.abort();
  assert.throws(() => bundleGraphEdgesReference(graph, positions, { signal: controller.signal }), {
    name: 'AbortError',
  });
});
test('zero compatibility threshold and zero spring stiffness retain supported bundling boundaries', () => {
  const result = bundleGraphEdgesReference(graph, positions, {
    compatibility: 0,
    stiffness: 0,
    cycles: 1,
    iterations: 1,
  });
  assert.ok(result.positions.every(Number.isFinite));
  for (const options of [{ compatibility: -1 }, { step: 0 }, { cycles: 0 }, { iterations: 0 }])
    assert.throws(() => bundleGraphEdgesReference(graph, positions, options), RangeError);
});
test('OpenAlex citation demo is original CC0 data with a pinned hash and original reference identities', () => {
  const root = new URL('./fixtures/graph-gpu/', import.meta.url),
    text = readFileSync(new URL('openalex.json', root)),
    source = JSON.parse(readFileSync(new URL('source.json', root))),
    works = JSON.parse(text);
  assert.equal(source.license, 'CC0-1.0');
  assert.equal(createHash('sha256').update(text).digest('hex'), source.sha256);
  assert.equal(works.length, 80);
  const ids = new Set(works.map((w) => w.id));
  assert.ok(works.reduce((n, w) => n + w.references.filter((id) => ids.has(id)).length, 0) > 20);
});
