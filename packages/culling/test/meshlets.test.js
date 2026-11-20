import test from 'node:test';
import assert from 'node:assert/strict';
import { box, Geometry, PbrMaterial } from '@margoengine/core';
import { MeshletMesh, buildMeshlets } from '../dist/meshlets.js';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';
import { wgsl } from '../../core/src/shaders.ts';

const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
// A flat grid, up facing, with counter-clockwise triangles seen from above.
function grid(side) {
  const vertices = new Float32Array((side + 1) * (side + 1) * 6),
    indices = new Uint32Array(side * side * 6);
  for (let y = 0, v = 0; y <= side; y++) for (let x = 0; x <= side; x++, v += 6) vertices.set([x, 0, y, 0, 1, 0], v);
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
  h.engine.gpu.createBindGroupLayout = (d) => d;
  h.engine.gpu.createPipelineLayout = (d) => d;
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

test("the kernel gets the eye in the world and finds it in each part's own space", () => {
  const h = harness(),
    m = mesh();
  h.engine.use(m);
  m.setTransform(0, 0, [2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 2, 0, 1, 0, 1, 1]);
  h.engine.frameGraph.execute(h.context);
  assert.deepEqual([...new Float32Array(m.clusterValues).subarray(24, 27)], [0, 0, 5]);
  assert.ok(h.pipelines.some((p) => /cross\(e,a\)/.test(p.compute?.module.code ?? '')));
});

// Parts used to hold a region of the whole mesh's indices each, so a few thousand copies of a large mesh passed the
// device's storage binding size and were refused. They now share one pool sized by the triangles kept.
test('parts share one pool of kept indices after the mesh, and a small device lowers the pool instead of refusing', () => {
  const h = harness(),
    geometry = box(),
    base = geometry.indices.length,
    material = new PbrMaterial(),
    m = new MeshletMesh([{ geometry, material, transforms: new Float32Array([...identity, ...identity, ...identity]) }]);
  h.engine.use(m);
  h.engine.frameGraph.execute(h.context);
  assert.equal(m.maxKeptTriangles, (base / 3) * 3, 'by default every triangle of every part fits');
  assert.equal(m.clusters.kept.size, (base + 3 * base) * 4, 'the mesh once, then the pool');
  assert.equal(m.clusters.args.size, 3 * 20 + 3 * m.meshlets.count * 4, 'draw arguments, then a word per cluster and part');
  const words = new Uint32Array(m.clusterValues);
  assert.deepEqual(
    [words[28], words[29], words[31], words[32], words[33], words[34], words[35]],
    [m.meshlets.count, base, 0, 15, base, 3 * base, 3],
  );
  const small = new MeshletMesh([{ geometry, material, transforms: new Float32Array([...identity, ...identity]) }], {
    maxKeptTriangles: 5,
  });
  h.engine.use(small);
  h.engine.frameGraph.execute(h.context);
  assert.equal(small.clusters.kept.size, (base + 15) * 4, 'a pool of five triangles');
  const limits = h.engine.gpu.limits;
  const large = ball(),
    big = large.indices.length;
  h.engine.gpu.limits = { ...limits, maxStorageBufferBindingSize: (big + 7) * 4 };
  const lowered = new MeshletMesh([{ geometry: large, material, transforms: new Float32Array(identity) }]);
  h.engine.use(lowered);
  h.engine.frameGraph.execute(h.context);
  assert.equal(lowered.clusters.kept.size, (big + 6) * 4, 'the pool is lowered to whole triangles that fit');
  h.engine.gpu.limits = { ...limits, maxStorageBufferBindingSize: large.indices.length * 4 - 4 };
  h.engine.use(new MeshletMesh([{ geometry: large, material, transforms: new Float32Array(identity) }]));
  assert.throws(() => h.engine.frameGraph.execute(h.context), /split the mesh/);
  h.engine.gpu.limits = limits;
  for (const maxKeptTriangles of [-1, 1.5])
    assert.throws(
      () => new MeshletMesh([{ geometry, material, transforms: new Float32Array(identity) }], { maxKeptTriangles }),
      /maxKeptTriangles/,
    );
  const many = new Float32Array(16 * 65536);
  for (let i = 0; i < 65536; i++) many.set(identity, i * 16);
  assert.throws(() => new MeshletMesh([{ geometry, material, transforms: many }]), /at most 65535 parts/);
});

// The place kernel puts each part's list after the ones before it in slot order; a part that does not fit draws the
// whole mesh from the indices at the buffer's start, and the copy kernel leaves its clusters alone.
test('the place kernel falls back to the whole mesh for a part past the pool, and the copy skips it', () => {
  const h = harness(),
    m = mesh();
  h.engine.use(m);
  h.engine.frameGraph.execute(h.context);
  const code = h.pipelines.find((p) => p.compute?.entryPoint === 'place').compute.module.code;
  assert.match(code, /if\(count!=0u&&add\(run,count\)>f\.list\.z\)\{args\[a\]=f\.size\.y;args\[a\+2u\]=0u;\}/);
  assert.match(code, /if\(at==0xffffffffu\|\|first<f\.list\.y\)\{return;\}/);
  assert.match(code, /kept\[first\+at\+k\]=kept\[range\.x\+k\]/);
  assert.match(code, /live\[j\]!=0u&&keep/, "the camera's kernel reads the part cull's visible word per slot");
});

// Two-pass occlusion: the Hi-Z occluders of a frame are the clusters each shown part drew the frame before, drawn per
// slot from the kept indices (first frame: the parts' own occluder list, as CulledParts).
test('occlusion draws last frame’s kept clusters of each shown part as the Hi-Z occluders', () => {
  const h = harness(),
    m = new MeshletMesh(
      [{ geometry: box(), material: new PbrMaterial(), transforms: new Float32Array([...identity, ...identity, ...identity]) }],
      { culling: 'occlusion' },
    ),
    passes = [];
  const begin = h.context.encoder.beginRenderPass;
  h.context.encoder.beginRenderPass = (descriptor) => {
    const pass = begin(descriptor),
      calls = [];
    passes.push({ descriptor, calls });
    pass.setIndexBuffer = (buffer) => calls.push(['index', buffer]);
    pass.setVertexBuffer = (slot, buffer, offset) => calls.push(['vertex', slot, buffer, offset]);
    pass.drawIndexedIndirect = (buffer, offset) => calls.push(['indirect', buffer, offset]);
    return pass;
  };
  h.engine.use(m);
  h.engine.frameGraph.execute(h.context);
  const prepass = () => passes.find((p) => !p.descriptor.colorAttachments.length).calls;
  assert.ok(prepass().some((c) => c[0] === 'indirect' && c[1] === m.buffers.earlyArgs), 'frame one: the parts list');
  passes.length = 0;
  m.setVisible(0, 1, false);
  h.engine.frameGraph.execute(h.context);
  const calls = prepass(),
    draws = calls.filter((c) => c[0] === 'indirect');
  assert.ok(calls.some((c) => c[0] === 'index' && c[1] === m.clusters.kept));
  assert.deepEqual(
    draws.map((c) => [c[1] === m.clusters.args, c[2]]),
    [
      [true, 0],
      [true, 40],
    ],
    'slots 0 and 2, the hidden one left out',
  );
  assert.deepEqual(
    calls.filter((c) => c[0] === 'vertex' && c[1] === 1).map((c) => [c[2] === m.clusters.ids, c[3]]),
    [
      [true, 0],
      [true, 8],
    ],
  );
  assert.deepEqual([...new Uint32Array(m.clusters.ids.data)], [0, 1, 2]);
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
  assert.deepEqual(
    [...planes.subarray(0, 4)].map((v) => +v.toFixed(5)),
    [1, 0, 0, 2],
    'x >= -2',
  );
  assert.deepEqual(
    [...planes.subarray(16, 20)].map((v) => +v.toFixed(5)),
    [0, 0, 1, 2],
    'depth >= 0',
  );
  assert.deepEqual(
    [...planes.subarray(20, 24)].map((v) => +v.toFixed(5)),
    [0, 0, -1, 2],
    'depth <= 1',
  );
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

// Batch 132 audit: the kept clusters went into each part's region at an atomicAdd slot, so their order, and with it every
// depth tie between them, changed from frame to frame (meshlets-check redrew the same frame 22 to 33 pixels apart on the
// M6). The cull now tests, scans and copies, so the kept clusters sit in cluster order.
test('the cluster cull keeps clusters in cluster order: test, scan, copy, and no atomics', () => {
  const h = harness(),
    m = mesh(),
    order = [];
  const begin = h.context.encoder.beginComputePass;
  h.context.encoder.beginComputePass = () => {
    const pass = begin();
    pass.setPipeline = (p) => order.push(p.compute.entryPoint);
    pass.dispatchWorkgroups = (...size) => order.push(size.join('x'));
    return pass;
  };
  h.engine.use(m);
  h.engine.frameGraph.execute(h.context);
  const n = m.meshlets.count,
    start = order.indexOf('test');
  assert.deepEqual(order.slice(start, start + 8), [
    'test',
    `${Math.ceil(n / 64)}x1x1`,
    'scan',
    '1',
    'place',
    '1',
    'copy',
    `${n}x1x1`,
  ]);
  const code = h.pipelines.find((p) => p.compute?.entryPoint === 'copy').compute.module.code;
  assert.doesNotMatch(code, /atomic/);
  assert.equal(
    new Uint32Array(m.clusterValues)[32],
    5,
    "the clusters' words start after the one part's draw arguments",
  );
});

// A ball of latitude and longitude rings, outward facing: many clusters, each with a narrow cone.
function ball(bands = 24, around = 48) {
  const vertices = [],
    indices = [];
  for (let y = 0; y <= bands; y++)
    for (let x = 0; x <= around; x++) {
      const a = (y / bands) * Math.PI,
        b = (x / around) * Math.PI * 2,
        u = [Math.sin(a) * Math.cos(b), Math.cos(a), Math.sin(a) * Math.sin(b)];
      vertices.push(...u, ...u);
    }
  for (let y = 0; y < bands; y++)
    for (let x = 0; x < around; x++) {
      const p = y * (around + 1) + x,
        q = p + around + 1;
      indices.push(p, p + 1, q, q, p + 1, q + 1);
    }
  const positions = [],
    normals = [];
  for (let i = 0; i < vertices.length; i += 6) positions.push(...vertices.slice(i, i + 3)), normals.push(...vertices.slice(i + 3, i + 6));
  return new Geometry(positions, normals, indices);
}
const row = (count, step) => {
  const t = new Float32Array(count * 16);
  for (let i = 0; i < count; i++)
    t.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, (i - (count - 1) / 2) * step, 0, 0, 1], i * 16);
  return t;
};
// The six planes of the box |x| <= 4, |y| <= 10, |z| <= 10, inside where dot(n, p) + w >= 0.
const slab = new Float32Array([1, 0, 0, 4, -1, 0, 0, 4, 0, 1, 0, 10, 0, -1, 0, 10, 0, 0, 1, 10, 0, 0, -1, 10]);
// One frame on the WebGL2 layer; returns each part's draws: its slot and its runs of [first index, index count].
function webgl2Frame(m, eye = [0, 0, 20], h = harness('margo-webgl2')) {
  const draws = [];
  h.context.camera.planes = slab;
  h.context.camera.position = new Float32Array(eye);
  const begin = h.context.encoder.beginRenderPass;
  h.context.encoder.beginRenderPass = (descriptor) => {
    const pass = begin(descriptor);
    pass.setVertexBuffer = (slot, _buffer, offset) => slot === 1 && draws.push({ part: offset / 96, runs: [] });
    pass.drawIndexed = (count, _instances, first) => draws.at(-1).runs.push([first, count]);
    return pass;
  };
  if (!m.device) h.engine.use(m);
  h.engine.frameGraph.execute(h.context);
  h.context.encoder.beginRenderPass = begin;
  return { draws, h };
}

// Work count (speed phase: no timing). Sixteen balls in a row, four of them meeting the box, seen from z = 20. The WebGL2
// layer used to draw every shown part whole, 16 x 2,304 triangles; the CPU route draws only the clusters inside the box
// that face the eye, one draw per run of neighbouring clusters, and the parts outside cost no draw at all.
test('on the WebGL2 layer the CPU route draws only kept clusters of kept parts: a deterministic work count', async () => {
  const geometry = ball(),
    total = 16 * (geometry.indices.length / 3),
    m = new MeshletMesh([{ geometry, material: new PbrMaterial({ doubleSided: false }), transforms: row(16, 2.5) }]),
    { draws, h } = webgl2Frame(m),
    parts = draws.map((d) => d.part),
    triangles = await m.readTriangles(),
    counted = draws.reduce((sum, d) => sum + d.runs.reduce((s, [, n]) => s + n / 3, 0), 0);
  assert.equal(m.clusters, undefined, 'no GPU kernel on the WebGL2 layer');
  assert.ok(!h.pipelines.some((p) => /fn keep\(n:u32/.test(p.compute?.module.code ?? '')));
  assert.deepEqual(parts, [6, 7, 8, 9], 'only the parts whose sphere meets the box draw');
  assert.equal(triangles, counted, 'the readback is the count drawn');
  for (const d of draws)
    for (const [first, count] of d.runs)
      assert.ok(first % 3 === 0 && count % 3 === 0 && first + count <= geometry.indices.length);
  const runs = draws.reduce((s, d) => s + d.runs.length, 0);
  console.log(
    `webgl2 work count: ${triangles} of ${total} triangles, ${runs} draws over ${parts.length} parts, ${m.meshlets.count} clusters a part`,
  );
  assert.equal(triangles, 8493, 'the pinned work count: 8,493 of 36,864 triangles');
  assert.equal(runs, 8, 'in eight draws');
  // Repeating the frame gives the same work to the draw.
  assert.deepEqual(webgl2Frame(m, [0, 0, 20], h).draws, draws);
  // A double-sided material keeps the far side: more triangles, same parts.
  const both = new MeshletMesh([
      { geometry, material: new PbrMaterial({ doubleSided: true }), transforms: row(16, 2.5) },
    ]),
    all = webgl2Frame(both).draws;
  assert.deepEqual(
    all.map((d) => d.part),
    parts,
  );
  assert.ok((await both.readTriangles()) > triangles);
  // A hidden part draws nothing.
  m.setVisible(0, 7, false);
  assert.deepEqual(
    webgl2Frame(m, [0, 0, 20], h).draws.map((d) => d.part),
    [6, 8, 9],
  );
});

// The CPU route runs the kernel's own tests in double precision: a triangle it drops from a ball inside the view faces
// away from the eye, so the back-face discard would have dropped it too.
test('the CPU route drops a cluster in view only when all its triangles face away', () => {
  const geometry = ball(),
    m = new MeshletMesh([{ geometry, material: new PbrMaterial({ doubleSided: false }), transforms: row(1, 0) }]),
    { draws } = webgl2Frame(m, [0, 0, 6]),
    drawn = new Uint8Array(geometry.indices.length / 3),
    v = geometry.vertices,
    order = m.meshlets.indices;
  for (const [first, count] of draws[0].runs) drawn.fill(1, first / 3, (first + count) / 3);
  let dropped = 0;
  for (let t = 0; t < drawn.length; t++) {
    if (drawn[t]) continue;
    dropped++;
    const [a, b, c] = [0, 1, 2].map((k) => order[t * 3 + k] * 6),
      u = [0, 1, 2].map((k) => v[b + k] - v[a + k]),
      w = [0, 1, 2].map((k) => v[c + k] - v[a + k]),
      n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]],
      facing = n[0] * (0 - v[a]) + n[1] * (0 - v[a + 1]) + n[2] * (6 - v[a + 2]);
    assert.ok(facing <= 1e-9, `triangle ${t} faces the eye but was dropped`);
  }
  assert.ok(dropped > 0, 'the far side drops');
});

test('on the WebGL2 layer a shadow cascade draws only the clusters in its light box', async () => {
  const geometry = ball(),
    m = new MeshletMesh([{ geometry, material: new PbrMaterial(), transforms: row(16, 2.5) }]);
  webgl2Frame(m);
  // A light box |x| <= 4, |y| <= 4, depth 0 to 1 over z from 10 down to -10.
  const light = new Float32Array([0.25, 0, 0, 0, 0, 0.25, 0, 0, 0, 0, -0.05, 0, 0, 0, 0.5, 1]),
    parts = [];
  assert.equal(await m.readShadowTriangles(0), 16 * (geometry.indices.length / 3), 'before a shadow frame: whole');
  m.prepareShadow({ context: { device: m.device, encoder: {} }, matrices: light, cascades: 1 });
  const pass = {
    setVertexBuffer: (slot, _b, offset) => slot === 1 && parts.push(offset / 96),
    setIndexBuffer() {},
    drawIndexed() {},
    drawIndexedIndirect() {},
  };
  m.drawParts(pass, 0);
  assert.deepEqual(parts, [6, 7, 8, 9]);
  const triangles = await m.readShadowTriangles(0);
  assert.equal(triangles, 4 * (geometry.indices.length / 3), 'the four balls in the box, against sixteen');
});
