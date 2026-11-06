import test from 'node:test';
import assert from 'node:assert/strict';
import { createCompute } from '@margoengine/compute';
import { coo } from '@margoengine/compute/sparse';
import { bfs, connectedComponents, graph, shortestPaths } from '@margoengine/compute/graph';

// Runs on the CPU backend, which uses the same code as the GPU; tests/compute-graph-browser.js runs it on a GPU.

const gpuOf = async (t) => {
  const gpu = await createCompute({ backend: 'cpu' });
  t.after(() => gpu.dispose());
  return gpu;
};
const rng = (seed) => {
  let s = seed | 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
};
const randomEdges = (vertices, edges, seed) => {
  const r = rng(seed),
    sources = [],
    targets = [],
    weights = [];
  for (let k = 0; k < edges; k++) {
    sources.push(Math.floor(r() * vertices));
    targets.push(Math.floor(r() * vertices));
    weights.push(Math.ceil(r() * 64) / 8); // Sums of eighths stay exact in f32.
  }
  return { vertices, sources, targets, weights };
};

// References, written the sequential way.
function hostBfs({ vertices, sources, targets, directed = true }, starts) {
  const out = Array.from({ length: vertices }, () => []);
  sources.forEach((s, k) => {
    out[s].push(targets[k]);
    if (!directed) out[targets[k]].push(s);
  });
  const distance = new Int32Array(vertices).fill(-1),
    queue = [...starts];
  for (const s of starts) distance[s] = 0;
  for (let head = 0; head < queue.length; head++)
    for (const t of out[queue[head]])
      if (distance[t] < 0) {
        distance[t] = distance[queue[head]] + 1;
        queue.push(t);
      }
  return distance;
}
function hostPaths({ vertices, sources, targets, weights }, starts) {
  const distance = new Float64Array(vertices).fill(Infinity);
  for (const s of starts) distance[s] = 0;
  for (let round = 0; round < vertices; round++)
    sources.forEach((s, k) => {
      if (distance[s] + weights[k] < distance[targets[k]]) distance[targets[k]] = distance[s] + weights[k];
    });
  return Float32Array.from(distance);
}
function hostComponents({ vertices, sources, targets }) {
  const parent = Array.from({ length: vertices }, (_, k) => k),
    find = (v) => (parent[v] === v ? v : (parent[v] = find(parent[v])));
  sources.forEach((s, k) => {
    const [a, b] = [find(s), find(targets[k])];
    parent[Math.max(a, b)] = Math.min(a, b);
  });
  const number = new Map(),
    labels = new Int32Array(vertices);
  for (let v = 0; v < vertices; v++) {
    const root = find(v);
    if (!number.has(root)) number.set(root, number.size);
    labels[v] = number.get(root);
  }
  return { labels, count: number.size };
}

test('bfs matches a queue on random graphs, from one source and from several', async (t) => {
  const gpu = await gpuOf(t);
  for (const [vertices, edges, seed] of [
    [1, 0, 1],
    [50, 60, 2],
    [300, 500, 3],
    [300, 3000, 4],
  ]) {
    const data = randomEdges(vertices, edges, seed);
    using g = graph(gpu, data);
    for (const starts of [[0], [vertices - 1, 0]]) {
      const { distances, predecessors } = await bfs(g, starts);
      const d = await distances.read(),
        p = await predecessors.read();
      assert.deepEqual(d, hostBfs(data, starts));
      for (let v = 0; v < vertices; v++) {
        if (d[v] <= 0) assert.equal(p[v], -1, `vertex ${v} has no predecessor`);
        else assert.equal(d[p[v]] + 1, d[v], `vertex ${v} follows its predecessor`);
      }
    }
  }
});

test('bfs takes a number, follows edges forward only, and undirected graphs both ways', async (t) => {
  const gpu = await gpuOf(t);
  const edges = { vertices: 4, sources: [0, 1], targets: [1, 2] };
  using one = graph(gpu, edges);
  assert.deepEqual([...(await (await bfs(one, 1)).distances.read())], [-1, 0, 1, -1]);
  using both = graph(gpu, { ...edges, directed: false });
  assert.deepEqual([...(await (await bfs(both, 1)).distances.read())], [1, 0, 1, -1]);
});

test('bfs gives the smallest predecessor when several tie', async (t) => {
  const gpu = await gpuOf(t);
  using g = graph(gpu, { vertices: 4, sources: [0, 0, 2, 1], targets: [1, 2, 3, 3] });
  assert.deepEqual([...(await (await bfs(g, 0)).predecessors.read())], [-1, 0, 0, 1]);
});

test('a chain longer than any check block reaches its end at every checkEvery', async (t) => {
  const gpu = await gpuOf(t),
    n = 100,
    sources = Array.from({ length: n - 1 }, (_, k) => k);
  using g = graph(gpu, { vertices: n, sources, targets: sources.map((k) => k + 1) });
  for (const checkEvery of [1, 7, 1000]) {
    const { distances, iterations } = await bfs(g, 0, { checkEvery });
    assert.equal((await distances.read())[n - 1], n - 1);
    assert.ok(iterations <= n, `${iterations} rounds`);
  }
  await assert.rejects(bfs(g, 0, { checkEvery: 0 }), RangeError);
});

test('shortestPaths matches Bellman-Ford on random graphs, negative edges included', async (t) => {
  const gpu = await gpuOf(t);
  for (const [vertices, edges, seed] of [
    [40, 80, 5],
    [300, 900, 6],
  ]) {
    const data = randomEdges(vertices, edges, seed);
    using g = graph(gpu, data);
    const { distances, predecessors, negativeCycle } = await shortestPaths(g, [0]);
    const d = await distances.read(),
      p = await predecessors.read();
    assert.equal(negativeCycle, false);
    assert.deepEqual(d, hostPaths(data, [0]));
    for (let v = 1; v < vertices; v++) {
      if (d[v] === Infinity) assert.equal(p[v], -1);
      else assert.ok(p[v] >= 0 && d[p[v]] < d[v], `vertex ${v}`);
    }
  }
  const dag = { vertices: 4, sources: [0, 0, 1, 2], targets: [1, 2, 3, 3], weights: [5, 2, -4, 3] };
  using g = graph(gpu, dag);
  assert.deepEqual([...(await (await shortestPaths(g, 0)).distances.read())], [0, 5, 2, 1]);
});

test('shortestPaths reports a reachable negative cycle, and only a reachable one', async (t) => {
  const gpu = await gpuOf(t);
  const cycle = { vertices: 5, sources: [0, 1, 2, 3], targets: [1, 2, 1, 4], weights: [1, 1, -3, 1] };
  using g = graph(gpu, cycle);
  assert.equal((await shortestPaths(g, 0)).negativeCycle, true);
  assert.equal((await shortestPaths(g, 3)).negativeCycle, false);
  assert.equal((await shortestPaths(g, 0, { checkEvery: 1 })).negativeCycle, true);
});

test('a path as long as the graph is not mistaken for a negative cycle', async (t) => {
  const gpu = await gpuOf(t),
    n = 20,
    sources = Array.from({ length: n - 1 }, (_, k) => n - 1 - k);
  using g = graph(gpu, { vertices: n, sources, targets: sources.map((k) => k - 1), weights: sources.map(() => -1) });
  for (const checkEvery of [1, 3, 8]) {
    const { negativeCycle, distances } = await shortestPaths(g, n - 1, { checkEvery });
    assert.equal(negativeCycle, false);
    assert.equal((await distances.read())[0], -(n - 1));
  }
});

test('parallel edges keep the smallest weight, not their sum', async (t) => {
  const gpu = await gpuOf(t);
  using g = graph(gpu, { vertices: 2, sources: [0, 0, 0], targets: [1, 1, 1], weights: [5, 2, 9] });
  assert.equal(g.nnz, 1);
  assert.deepEqual([...(await (await shortestPaths(g, 0)).distances.read())], [0, 2]);
});

test('self-loops change nothing, and a matrix from /sparse works as it is', async (t) => {
  const gpu = await gpuOf(t);
  using g = coo(gpu, { rows: [0, 0, 1], cols: [0, 1, 2], values: [3, 1, 1], shape: [3, 3] });
  const { distances, predecessors } = await shortestPaths(g, 0);
  assert.deepEqual([...(await distances.read())], [0, 1, 2]);
  assert.deepEqual([...(await predecessors.read())], [-1, 0, 1]);
});

test('connectedComponents matches union-find and numbers components by smallest vertex', async (t) => {
  const gpu = await gpuOf(t);
  for (const [vertices, edges, seed] of [
    [1, 0, 7],
    [60, 30, 8],
    [400, 300, 9],
    [400, 2000, 10],
  ]) {
    const data = randomEdges(vertices, edges, seed);
    using g = graph(gpu, data);
    const { labels, count } = await connectedComponents(g);
    const expected = hostComponents(data);
    assert.deepEqual(await labels.read(), expected.labels);
    assert.equal(count, expected.count);
  }
});

test('connectedComponents settles on a long chain, numbered against the grain', async (t) => {
  const gpu = await gpuOf(t),
    n = 2000,
    order = Array.from({ length: n }, (_, k) => (k * 997) % n); // 997 and 2000 share no factor: a shuffled path.
  using g = graph(gpu, { vertices: n, sources: order.slice(0, -1), targets: order.slice(1) });
  const { labels, count, iterations } = await connectedComponents(g, { checkEvery: 1 });
  assert.equal(count, 1);
  assert.ok((await labels.read()).every((v) => v === 0));
  assert.ok(iterations < 64, `${iterations} rounds, expected about log n`);
});

test('a graph with no edges or no vertices is handled', async (t) => {
  const gpu = await gpuOf(t);
  using g = graph(gpu, { vertices: 3, sources: [], targets: [] });
  assert.deepEqual([...(await (await bfs(g, 1)).distances.read())], [-1, 0, -1]);
  assert.deepEqual([...(await (await shortestPaths(g, 1)).distances.read())], [Infinity, 0, Infinity]);
  const parts = await connectedComponents(g);
  assert.equal(parts.count, 3);
  assert.deepEqual([...(await parts.labels.read())], [0, 1, 2]);
  using empty = graph(gpu, { vertices: 0, sources: [], targets: [] });
  const none = await connectedComponents(empty);
  assert.equal(none.count, 0);
  assert.equal(none.labels.size, 0);
});

test('wrong input is refused by name', async (t) => {
  const gpu = await gpuOf(t);
  using g = graph(gpu, { vertices: 2, sources: [0], targets: [1] });
  await assert.rejects(bfs(g, 2), /outside the 2 vertices/);
  await assert.rejects(bfs(g, []), /at least one source/);
  await assert.rejects(bfs({}, 0), /CsrMatrix/);
  using wide = coo(gpu, { rows: [0], cols: [1], values: [1], shape: [1, 2] });
  await assert.rejects(connectedComponents(wide), /square/);
  assert.throws(() => graph(gpu, { vertices: 2, sources: [0, 1], targets: [1] }), /one length/);
  assert.throws(() => graph(gpu, { vertices: 2, sources: [0], targets: [2] }), /outside the 2 vertices/);
  assert.throws(() => graph(gpu, { vertices: 2, sources: [0], targets: [1], weights: [NaN] }), /NaN/);
  assert.throws(() => graph(gpu, { vertices: -1, sources: [], targets: [] }), /whole number/);
});

test('an abort stops a run, and nothing stays allocated', async (t) => {
  const gpu = await gpuOf(t);
  let live = 0;
  const empty = gpu.empty.bind(gpu),
    track = gpu.track.bind(gpu),
    forget = gpu.forget.bind(gpu);
  gpu.empty = (...args) => (live++, empty(...args));
  gpu.track = (array) => (live++, track(array));
  gpu.forget = (array) => (live--, forget(array));
  const g = graph(gpu, randomEdges(100, 300, 11)),
    settled = live;
  const signal = AbortSignal.abort(new Error('stop'));
  await assert.rejects(bfs(g, 0, { signal }), /stop/);
  assert.equal(live, settled, 'after an abort');
  for (const result of [await bfs(g, 0), await shortestPaths(g, 0)]) {
    result.distances.dispose();
    result.predecessors.dispose();
  }
  (await connectedComponents(g)).labels.dispose();
  assert.equal(live, settled, 'after every algorithm');
});
