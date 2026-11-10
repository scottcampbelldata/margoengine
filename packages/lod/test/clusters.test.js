import assert from 'node:assert/strict';
import test from 'node:test';
import { Geometry } from '@margoengine/core';
import {
  buildClusterLOD,
  clusterScreenError,
  selectClusterLOD,
  clusterFadeShader,
  ClusterLOD,
} from '@margoengine/lod/clusters';
import { wgsl } from '../../core/src/shaders.ts';
import { fadeKeeps, coreFadeShader } from '@margoengine/lod/fade';
import { readFileSync } from 'node:fs';
import { Engine, TransformStore } from '../../core/dist/extension.js';
import { GLTFAsset, PBRModel } from '@margoengine/gltf-pro';
import { glbChunks, GLB_JSON, GLB_BIN } from '../../shared/glb.js';

const grid = (n = 12) => {
  const p = [],
    normal = [],
    indices = [];
  for (let y = 0; y <= n; y++)
    for (let x = 0; x <= n; x++) {
      p.push(x, y, 0.1 * Math.sin(x) * Math.sin(y));
      normal.push(0, 0, 1);
    }
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      const a = y * (n + 1) + x,
        b = a + n + 1;
      indices.push(a, a + 1, b, a + 1, b + 1, b);
    }
  return new Geometry(p, normal, indices);
};
const hierarchy = await buildClusterLOD(grid(), { leafTriangles: 24, maxVertices: 16 });

test('meshlet hierarchy keeps every input triangle in its leaves, respects limits and simplifies parents', () => {
  const leaves = hierarchy.nodes.filter((n) => n.children.length === 0);
  assert.equal(
    leaves.flatMap((n) => n.meshlets).reduce((n, g) => n + g.indices.length / 3, 0),
    288,
  );
  assert.ok(hierarchy.root.error > 0);
  assert.ok(hierarchy.root.meshlets.reduce((n, g) => n + g.indices.length / 3, 0) < 288);
  for (const node of hierarchy.nodes) {
    assert.ok(node.children.every((c) => node.error >= c.error));
    for (const meshlet of node.meshlets) {
      assert.ok(meshlet.vertices.length / 6 <= 16);
      assert.ok(meshlet.indices.length / 3 <= 24);
    }
  }
  assert.equal(new ClusterLOD(hierarchy, {}).errorPixels, 1);
});

test('mixed depth cuts have identical shared boundary edges', () => {
  // One half coarse, the other at leaves. All edges except the original outer border have two uses.
  const [left, right] = hierarchy.root.children;
  const descend = (n) => (n.children.length ? n.children.flatMap(descend) : [n]);
  const nodes = [left, ...descend(right)],
    edges = new Map();
  for (const g of nodes.flatMap((n) => n.meshlets))
    for (let t = 0; t < g.indices.length; t += 3)
      for (let k = 0; k < 3; k++) {
        const position = (v) => Array.from(g.vertices.subarray(v * 6, v * 6 + 3));
        const a = position(g.indices[t + k]),
          b = position(g.indices[t + ((k + 1) % 3)]);
        const key = [a.join(','), b.join(',')].sort().join('|');
        const edge = edges.get(key) ?? { count: 0, a, b };
        edge.count++;
        edges.set(key, edge);
      }
  for (const { a, b, count } of edges.values()) {
    const boundary = [0, 1].some((k) => (a[k] === 0 && b[k] === 0) || (a[k] === 12 && b[k] === 12));
    assert.equal(count, boundary ? 1 : 2, `${a} to ${b}`);
  }
});

test('screen error responds to distance, viewport, projection and nonuniform scale', () => {
  const node = { error: 1, bounds: [0, 0, 0, 1] },
    view = { position: [0, 0, 11], yScale: 2, height: 100 };
  assert.equal(clusterScreenError(node, view), 10);
  assert.equal(clusterScreenError(node, { ...view, height: 200 }), 20);
  assert.equal(clusterScreenError(node, { ...view, position: [0, 0, 1] }), Infinity);
  assert.equal(clusterScreenError(node, { ...view, orthographic: true }), 100);
  assert.ok(clusterScreenError(node, { ...view, matrix: [3, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] }) > 10);
});

test('each surface path owns exactly one level at every dither pixel, including zero and full thresholds', () => {
  const view = { position: [6, 6, 20], yScale: 1, height: 200 };
  const cut = selectClusterLOD(hierarchy, view, (hierarchy.root.error * 100) / 20, 0.5);
  const paths = (n) => (n.children.length ? n.children.flatMap((c) => paths(c).map((p) => [n, ...p])) : [[n]]);
  for (const path of paths(hierarchy.root))
    for (let x = 0; x < 16; x++)
      for (let y = 0; y < 16; y++) {
        const kept = cut.filter(
          (r) => path.includes(r.node) && fadeKeeps(x, y, r.high) && (r.low === 0 || !fadeKeeps(x, y, r.low)),
        );
        assert.equal(kept.length, 1);
      }
  const near = selectClusterLOD(hierarchy, { ...view, position: [6, 6, 0] }, 0.001, 0);
  assert.ok(near.every((r) => r.node.children.length === 0));
  assert.equal(selectClusterLOD(hierarchy, { ...view, position: [6, 6, 1e8] }, 1, 0).length, 1);
  assert.notEqual(clusterFadeShader(wgsl), wgsl);
  assert.equal(clusterFadeShader('unrelated'), 'unrelated');
  for (const code of [coreFadeShader(clusterFadeShader(wgsl)), clusterFadeShader(coreFadeShader(wgsl))]) {
    assert.equal(code.match(/lod_id:u32/g).length, 1);
    assert.ok(code.includes('@binding(94)'));
    assert.ok(code.includes('@binding(95)'));
    assert.ok(code.includes('if(!cluster_keep('));
    assert.ok(code.includes('if(!lod_fade_keep('));
  }
});

test('build cancellation, limits and empty geometry are deterministic', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(buildClusterLOD(grid(), { signal: controller.signal }), { name: 'AbortError' });
  await assert.rejects(buildClusterLOD(grid(), { leafTriangles: 0 }), RangeError);
  const empty = await buildClusterLOD(new Geometry([], [], []));
  assert.equal(empty.root.meshlets.length, 0);
});

test('real FlightHelmet manifold regions stay manifold after independently simplified children are joined', async () => {
  const chunks = glbChunks(
    new Uint8Array(readFileSync(new URL('../../../examples/assets/flight-helmet-mobile.glb', import.meta.url))),
  );
  const doc = JSON.parse(new TextDecoder().decode(chunks.find((c) => c.type === GLB_JSON).data));
  const engine = new Engine({ width: 64, height: 64 }, await TransformStore.create(256), {
    backend: 'webgl2',
    add() {},
    remove() {},
    render() {},
    dispose() {},
  });
  try {
    const model = new PBRModel(engine, new GLTFAsset(doc, [chunks.find((c) => c.type === GLB_BIN).data]));
    const p = [...model.primitives].sort((a, b) => b.indices.length - a.indices.length)[0],
      positions = [],
      normals = [];
    for (let i = 0; i < p.vertices.length; i += 20) {
      positions.push(...p.vertices.subarray(i, i + 3));
      normals.push(...p.vertices.subarray(i + 4, i + 7));
    }
    const h = await buildClusterLOD(new Geometry(positions, normals, p.indices));
    assert.ok(h.nodes.length > 100);
    assert.ok(h.root.meshlets.reduce((n, g) => n + g.indices.length, 0) < p.indices.length);
  } finally {
    engine.dispose();
  }
});

test('disposing a cluster renderer leaves subsequent frame passes inert', async () => {
  const engine = new Engine({ width: 64, height: 64 }, await TransformStore.create(256), {
    backend: 'webgpu',
    gpu: {},
    add() {},
    remove() {},
    render() {},
    dispose() {},
  });
  try {
    const renderer = ClusterLOD.attach(engine, hierarchy, engine.createMesh());
    let pass;
    renderer.registerPasses({
      add(p) {
        pass = p;
      },
    });
    renderer.dispose();
    renderer.dispose();
    assert.doesNotThrow(() => renderer.onPreUpdate());
    assert.doesNotThrow(() => pass.execute({ backend: 'webgpu' }));
    assert.deepEqual(renderer.selected, []);
  } finally {
    engine.dispose();
  }
});
