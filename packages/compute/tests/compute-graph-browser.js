// Real-GPU checks of @margoengine/compute/graph, where edges really run at once: every algorithm against a sequential
// reference on graphs big enough to spread over many workgroups. tests/graph.test.js checks the cases on the CPU backend.
import { createCompute } from '@margoengine/compute';
import { bfs, connectedComponents, graph, shortestPaths } from '@margoengine/compute/graph';

const checks = [];
const check = async (name, run) => {
  try {
    await run();
  } catch (error) {
    throw new Error(`${name}: ${error.message}`);
  }
  checks.push(name);
};
const same = (a, b, label) => {
  if (a.length !== b.length) throw new Error(`${label}: length ${a.length} != ${b.length}`);
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) throw new Error(`${label}[${i}]: gpu ${a[i]}, expected ${b[i]}`);
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
    sources = new Int32Array(edges),
    targets = new Int32Array(edges),
    weights = new Float32Array(edges);
  for (let k = 0; k < edges; k++) {
    sources[k] = Math.floor(r() * vertices);
    targets[k] = Math.floor(r() * vertices);
    weights[k] = Math.ceil(r() * 64) / 8; // Sums of eighths stay exact in f32.
  }
  return { vertices, sources, targets, weights };
};
const adjacency = ({ vertices, sources, targets }) => {
  const out = Array.from({ length: vertices }, () => []);
  sources.forEach((s, k) => out[s].push(k));
  return (v) => out[v].map((k) => targets[k]);
};
function hostBfs(data, start) {
  const next = adjacency(data),
    distance = new Int32Array(data.vertices).fill(-1),
    queue = [start];
  distance[start] = 0;
  for (let head = 0; head < queue.length; head++)
    for (const t of next(queue[head]))
      if (distance[t] < 0) {
        distance[t] = distance[queue[head]] + 1;
        queue.push(t);
      }
  return distance;
}
function hostPaths({ vertices, sources, targets, weights }, start) {
  const distance = new Float64Array(vertices).fill(Infinity);
  distance[start] = 0;
  for (let moved = true; moved; ) {
    moved = false;
    for (let k = 0; k < sources.length; k++)
      if (distance[sources[k]] + weights[k] < distance[targets[k]]) {
        distance[targets[k]] = distance[sources[k]] + weights[k];
        moved = true;
      }
  }
  return Float32Array.from(distance);
}
function hostComponents({ vertices, sources, targets }) {
  const parent = Int32Array.from({ length: vertices }, (_, k) => k),
    find = (v) => {
      while (parent[v] !== v) v = parent[v] = parent[parent[v]];
      return v;
    };
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

window.runGraphTests = async () => {
  const gpu = await createCompute({ backend: 'webgpu' });
  try {
    const data = randomEdges(50_000, 150_000, 21),
      g = graph(gpu, data);
    await check('bfs on 50,000 vertices matches a queue, and predecessors lead back', async () => {
      const { distances, predecessors } = await bfs(g, 3),
        d = await distances.read(),
        p = await predecessors.read();
      same(d, hostBfs(data, 3), 'distance');
      for (let v = 0; v < d.length; v++)
        if (d[v] > 0 && d[p[v]] + 1 !== d[v]) throw new Error(`vertex ${v}: predecessor ${p[v]}`);
      distances.dispose();
      predecessors.dispose();
    });
    await check('shortestPaths on 50,000 vertices matches Bellman-Ford exactly', async () => {
      const { distances, predecessors, negativeCycle } = await shortestPaths(g, 3),
        d = await distances.read(),
        p = await predecessors.read();
      if (negativeCycle) throw new Error('found a negative cycle');
      same(d, hostPaths(data, 3), 'distance');
      for (let v = 0; v < d.length; v++)
        if (v !== 3 && Number.isFinite(d[v]) && !(d[p[v]] < d[v])) throw new Error(`vertex ${v}: predecessor ${p[v]}`);
      distances.dispose();
      predecessors.dispose();
    });
    await check('connectedComponents on a sparse 200,000 vertices matches union-find', async () => {
      const sparse = randomEdges(200_000, 150_000, 22);
      using h = graph(gpu, sparse);
      const { labels, count } = await connectedComponents(h),
        expected = hostComponents(sparse);
      same(await labels.read(), expected.labels, 'label');
      if (count !== expected.count) throw new Error(`count ${count}, expected ${expected.count}`);
      labels.dispose();
    });
    await check('negative edges and a negative cycle are told apart on the GPU', async () => {
      using dag = graph(gpu, { vertices: 4, sources: [0, 0, 1, 2], targets: [1, 2, 3, 3], weights: [5, 2, -4, 3] });
      const clean = await shortestPaths(dag, 0);
      same(await clean.distances.read(), [0, 5, 2, 1], 'distance');
      clean.distances.dispose();
      clean.predecessors.dispose();
      if (clean.negativeCycle) throw new Error('found a cycle in a DAG');
      using loop = graph(gpu, { vertices: 3, sources: [0, 1, 2], targets: [1, 2, 1], weights: [1, 1, -3] });
      const bad = await shortestPaths(loop, 0);
      bad.distances.dispose();
      bad.predecessors.dispose();
      if (!bad.negativeCycle) throw new Error('missed the cycle');
    });
    g.dispose();
    return { checks };
  } finally {
    gpu.dispose();
  }
};
