import test from 'node:test';
import assert from 'node:assert/strict';
import { box, PbrMaterial } from '@margoengine/core';
import { MeshletMesh, buildMeshlets } from '../dist/meshlets.js';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';
import { wgsl } from '../../core/src/shaders.ts';

const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
// A flat grid, up facing, with counter-clockwise triangles seen from above.
function grid(side) {
  const vertices = new Float32Array((side + 1) * (side + 1) * 6),
    indices = new Uint32Array(side * side * 6);
  for (let y = 0, v = 0; y <= side; y++)
    for (let x = 0; x <= side; x++, v += 6) vertices.set([x, 0, y, 0, 1, 0], v);
  for (let y = 0, n = 0; y < side; y++)
    for (let x = 0; x < side; x++, n += 6) {
      const p = y * (side + 1) + x,
        q = p + side + 1;
      indices.set([p, q, p + 1, p + 1, q, q + 1], n);
    }
  return { vertices, indices, bounds: new Float32Array([side / 2, 0, side / 2, side]) };
}

test('every triangle lands in exactly one cluster, whole and in its winding', () => {
  const g = grid(32),
    m = buildMeshlets(g),
    key = (a, i) => [a[i], a[i + 1], a[i + 2]].join();
  const before = new Set(),
    after = new Set();
  for (let i = 0; i < g.indices.length; i += 3) before.add(key(g.indices, i));
  for (let i = 0; i < m.indices.length; i += 3) after.add(key(m.indices, i));
  assert.deepEqual(after, before);
  let covered = 0;
  for (let c = 0; c < m.count; c++) {
    assert.equal(m.ranges[c * 2], covered, 'ranges are contiguous');
    covered += m.ranges[c * 2 + 1];
  }
  assert.equal(covered, g.indices.length);
});

test('clusters keep to the limits and stay compact', () => {
  const g = grid(32),
    m = buildMeshlets(g, { maxVertices: 32, maxTriangles: 40 });
  for (let c = 0; c < m.count; c++) {
    const [first, count] = [m.ranges[c * 2], m.ranges[c * 2 + 1]];
    assert.ok(count / 3 <= 40);
    assert.ok(new Set(m.indices.subarray(first, first + count)).size <= 32);
  }
  const radii = Array.from({ length: m.count }, (_, c) => m.bounds[c * 8 + 3]).sort((a, b) => a - b);
  assert.ok(radii[m.count >> 1] < 8, `a typical cluster is a patch of the grid, not a strip (${radii[m.count >> 1]})`);
});

test('a flat patch has a zero cone; a closed box has none', () => {
  const flat = buildMeshlets(grid(4));
  assert.deepEqual([...flat.bounds.subarray(4, 8)], [0, 1, 0, 0]);
  const closed = buildMeshlets(box(), { maxVertices: 64 });
  assert.equal(closed.count > 0, true);
  for (let c = 0; c < closed.count; c++) {
    if (closed.ranges[c * 2 + 1] === 36) assert.equal(closed.bounds[c * 8 + 7], -1);
  }
});

test('a triangle with a repeated vertex counts its vertices once', () => {
  const g = grid(1);
  g.indices = new Uint32Array([0, 0, 1, 1, 2, 3]);
  assert.equal(buildMeshlets(g, { maxVertices: 3 }).count, 2);
});

test('bad limits and more than one batch are refused', () => {
  assert.throws(() => buildMeshlets(grid(1), { maxVertices: 2 }), /maxVertices/);
  assert.throws(() => buildMeshlets(grid(1), { maxTriangles: 0 }), /maxTriangles/);
  const material = new PbrMaterial();
  assert.throws(
    () =>
      new MeshletMesh([
        { geometry: box(), material, transforms: new Float32Array(identity) },
        { geometry: box(), material, transforms: new Float32Array(identity) },
      ]),
    /pass one batch/,
  );
});

function harness(vendor) {
  const h = optionalGPU();
  if (vendor) h.engine.gpu.adapterInfo = { vendor };
  globalThis.GPUTextureUsage = { RENDER_ATTACHMENT: 16, TEXTURE_BINDING: 4 };
  h.context.shader = wgsl;
  h.context.descriptor = {
    multisample: { count: 1 },
    depthStencil: { format: 'depth32float' },
    vertex: { buffers: [] },
    fragment: { targets: [] },
  };
  h.context.camera.matrix = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, -0.001, -1, 0, 0, 1, 0]);
  h.context.camera.position = new Float32Array([0, 0, 5]);
  h.engine.lighting = { direction: new Float32Array([0, 1, 0, 1]), radiance: new Float32Array([1, 1, 1, 0.2]) };
  return h;
}
const mesh = (doubleSided = false) =>
  new MeshletMesh([
    { geometry: box(), material: new PbrMaterial({ doubleSided }), transforms: new Float32Array(identity) },
  ]);
const coneTest = (m) => new Float32Array(m.clusterValues)[27];

test('the main pass draws the kept indices; the cone test is on for a single-sided mesh only', () => {
  const h = harness(),
    m = mesh();
  h.engine.use(m);
  h.engine.frameGraph.execute(h.context);
  assert.ok(h.pipelines.some((p) => /fn keep\(n:u32,m:mat4x4f\)/.test(p.compute?.module.code ?? '')));
  assert.ok(m.clusters.kept, 'the kept indices are drawn');
  assert.equal(coneTest(m), 1);
  const both = mesh(true);
  h.engine.use(both);
  h.engine.frameGraph.execute(h.context);
  assert.equal(coneTest(both), 0, 'a double-sided mesh draws its back faces');
});

test('the kernel gets the eye in the world and finds it in each part\'s own space', () => {
  const h = harness(),
    m = mesh();
  h.engine.use(m);
  m.setTransform(0, 0, [2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 2, 0, 1, 0, 1, 1]);
  h.engine.frameGraph.execute(h.context);
  assert.deepEqual([...new Float32Array(m.clusterValues).subarray(24, 27)], [0, 0, 5]);
  assert.ok(h.pipelines.some((p) => /cross\(e,a\)/.test(p.compute?.module.code ?? '')));
});

test('parts: one region and one indirect draw each, over the device limit refused', () => {
  const h = harness(),
    geometry = box(),
    material = new PbrMaterial(),
    m = new MeshletMesh([{ geometry, material, transforms: new Float32Array([...identity, ...identity, ...identity]) }]);
  h.engine.use(m);
  h.engine.frameGraph.execute(h.context);
  assert.equal(m.clusters.kept.size, geometry.indices.length * 3 * 4);
  assert.equal(m.clusters.args.size, 3 * 20);
  const over = new MeshletMesh([{ geometry, material, transforms: new Float32Array(identity) }]);
  h.engine.use(over);
  const limits = h.engine.gpu.limits;
  h.engine.gpu.limits = { ...limits, maxStorageBufferBindingSize: 8 };
  assert.throws(() => h.engine.frameGraph.execute(h.context), /use fewer parts/);
  h.engine.gpu.limits = limits;
});

test('occlusion culling compiles the Hi-Z test into the cluster kernel, frustum culling leaves it out', () => {
  const plain = harness(),
    m = mesh();
  plain.engine.use(m);
  plain.engine.frameGraph.execute(plain.context);
  assert.ok(!plain.pipelines.some((p) => /unoccluded\(vec4f\(c,r\)\)/.test(p.compute?.module.code ?? '')));
  const h = harness(),
    culled = new MeshletMesh(
      [{ geometry: box(), material: new PbrMaterial(), transforms: new Float32Array(identity) }],
      { culling: 'occlusion' },
    );
  h.engine.use(culled);
  h.engine.frameGraph.execute(h.context);
  assert.ok(h.pipelines.some((p) => /unoccluded\(vec4f\(c,r\)\)/.test(p.compute?.module.code ?? '')));
});

test('a shadow frame writes clip-box planes per cascade, and a frame without one draws the whole mesh', () => {
  const h = harness(),
    m = mesh();
  h.engine.use(m);
  h.engine.frameGraph.execute(h.context);
  const draws = [],
    pass = {
      setVertexBuffer() {},
      setIndexBuffer: (buffer) => draws.push(buffer),
      drawIndexed: () => draws.push('whole'),
      drawIndexedIndirect: () => draws.push('clusters'),
    };
  m.drawParts(pass, 0);
  assert.ok(draws.includes('whole'));
  const scale = new Float32Array([0.5, 0, 0, 0, 0, 0.5, 0, 0, 0, 0, 0.25, 0, 0, 0, 0.5, 1]);
  m.prepareShadow({ context: { device: h.engine.gpu, encoder: h.context.encoder }, matrices: scale, cascades: 1 });
  const planes = new Float32Array(m.clusterValues).subarray(0, 24);
  assert.deepEqual([...planes.subarray(0, 4)].map((v) => +v.toFixed(5)), [1, 0, 0, 2], 'x >= -2');
  assert.deepEqual([...planes.subarray(16, 20)].map((v) => +v.toFixed(5)), [0, 0, 1, 2], 'depth >= 0');
  assert.deepEqual([...planes.subarray(20, 24)].map((v) => +v.toFixed(5)), [0, 0, -1, 2], 'depth <= 1');
  draws.length = 0;
  m.drawParts(pass, 0);
  assert.ok(draws.includes('clusters') && !draws.includes('whole'));
  draws.length = 0;
  m.drawParts(pass);
  assert.ok(draws.includes('whole'), 'a pick draws the whole mesh');
});

test('a perspective camera looking along x keeps its cone test', () => {
  const h = harness(),
    m = mesh();
  h.context.camera.matrix = new Float32Array([0, 0, -0.001, -1, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0]);
  h.engine.use(m);
  h.engine.frameGraph.execute(h.context);
  assert.equal(coneTest(m), 1);
});

test('an orthographic camera has no eye, so no cone test', () => {
  const h = harness(),
    m = mesh();
  h.context.camera.matrix = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, -0.01, 0, 0, 0, 0.5, 1]);
  h.engine.use(m);
  h.engine.frameGraph.execute(h.context);
  assert.equal(coneTest(m), 0);
});

test('on the WebGL2 layer the whole mesh draws through its own index buffer', () => {
  const h = harness('margo-webgl2'),
    m = mesh();
  h.engine.use(m);
  h.engine.frameGraph.execute(h.context);
  assert.equal(m.clusters, undefined);
  assert.ok(!h.pipelines.some((p) => /fn keep\(n:u32/.test(p.compute?.module.code ?? '')));
});
