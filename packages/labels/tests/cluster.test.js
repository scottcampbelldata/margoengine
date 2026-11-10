import test from 'node:test';
import assert from 'node:assert/strict';
import { ClusterLabels } from '@margoengine/labels/cluster';
import { LabelRenderer } from '@margoengine/labels';
import { Camera } from '@margoengine/core';
import { fakeEngine } from './fake-dom.js';
function context() {
  const engine = fakeEngine(Camera);
  const hidden = new Set();
  return {
    hidden,
    root: engine.document.createElement('div'),
    width: 800,
    height: 400,
    size: () => [20, 20],
    hide: (l) => hidden.add(l),
    place: () => {},
  };
}
const point = (x, y, id) => ({ screen: { x, y }, id });
const memberships = (clusters) =>
  clusters.map((c) => c.members.map((l) => l.id).sort((a, b) => a - b)).sort((a, b) => a[0] - b[0]);
test('radius components join across grid seams and transitive chains; singles stay visible', () => {
  const layout = new ClusterLabels({ radius: 10 }),
    c = context();
  const labels = [point(6, 0, 0), point(14, 0, 1), point(23, 0, 2), point(100, 100, 3)];
  layout.arrange(labels, c);
  assert.deepEqual(memberships(layout.clusters), [[0, 1, 2]]);
  assert.equal(c.hidden.size, 3);
  assert.equal(layout.clusters[0].element.textContent, '3');
  assert.equal(layout.clusters[0].x, 43 / 3);
  assert.equal(layout.clusters[0].y, 0);
  const bubble = layout.clusters[0].element;
  layout.arrange(labels, c);
  assert.equal(layout.clusters[0].element, bubble);
  labels[1].screen.x = 1000;
  layout.arrange(labels, c);
  assert.equal(layout.clusters.length, 0);
  assert.equal(bubble.parentElement, null);
});
test('grid output matches independent all-pairs connected components for seeded inputs and negative cells', () => {
  let state = 731;
  const random = () => (state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 4294967296;
  for (let round = 0; round < 20; round++) {
    const labels = Array.from({ length: 80 }, (_, i) => point(random() * 200 - 100, random() * 200 - 100, i));
    const radius = 5 + random() * 20,
      parent = labels.map((_, i) => i),
      find = (i) => {
        while (parent[i] !== i) i = parent[i];
        return i;
      };
    for (let i = 0; i < labels.length; i++)
      for (let j = 0; j < i; j++)
        if (Math.hypot(labels[i].screen.x - labels[j].screen.x, labels[i].screen.y - labels[j].screen.y) <= radius)
          parent[find(i)] = find(j);
    const groups = new Map();
    for (let i = 0; i < labels.length; i++) {
      const root = find(i);
      if (!groups.has(root)) groups.set(root, []);
      groups.get(root).push(i);
    }
    const expected = [...groups.values()].filter((g) => g.length >= 2).sort((a, b) => a[0] - b[0]);
    const layout = new ClusterLabels({ radius });
    layout.arrange(labels, context());
    assert.deepEqual(memberships(layout.clusters), expected);
    layout.dispose();
  }
});
test('coincident 100k points need no pairwise scan; minCount, logical zoom, nested singles and cleanup', () => {
  let singles = [];
  const layout = new ClusterLabels({ minCount: 3, maxZoom: 5, layout: { arrange: (l) => (singles = l) } }),
    c = context();
  const labels = Array.from({ length: 100000 }, (_, i) => point(1, 1, i));
  layout.arrange(labels, c);
  assert.equal(layout.clusters.length, 1);
  assert.equal(layout.clusters[0].count, 100000);
  assert.equal(layout.comparisons, 0);
  assert.equal(singles.length, 0);
  layout.setZoom(6).arrange(labels, c);
  assert.equal(layout.clusters.length, 0);
  assert.equal(singles.length, 100000);
  assert.equal(c.root.children.length, 0);
  layout.setZoom(5).arrange(labels.slice(0, 2), c);
  assert.equal(layout.clusters.length, 0);
  assert.equal(singles.length, 2);
  layout.arrange(labels.slice(0, 3), c);
  assert.equal(layout.clusters[0].zoom, 5);
  layout[Symbol.dispose]();
  assert.equal(c.root.children.length, 0);
  assert.throws(() => new ClusterLabels({ radius: 0 }), RangeError);
  assert.throws(() => layout.setZoom(NaN), RangeError);
});
test('real renderer camera zoom splits clusters and restores member label visibility', () => {
  const engine = fakeEngine(Camera),
    cluster = new ClusterLabels({ radius: 40 }),
    renderer = new LabelRenderer({ layout: cluster });
  renderer.setup(engine);
  renderer.registerPasses(engine.graph);
  const a = renderer.add(engine.document.createElement('div'), { position: [-0.1, 0, 0] }),
    b = renderer.add(engine.document.createElement('div'), { position: [0.1, 0, 0] });
  engine.frame();
  assert.equal(cluster.clusters[0].count, 2);
  assert.equal(a.onScreen, false);
  assert.equal(b.onScreen, false);
  engine.camera.position = [0, 0, 0.5];
  engine.frame();
  assert.equal(cluster.clusters.length, 0);
  assert.equal(a.onScreen, true);
  assert.equal(b.onScreen, true);
  renderer.dispose();
  cluster.dispose();
});
