import test from 'node:test';
import assert from 'node:assert/strict';
import { box, PbrMaterial } from '@margoengine/core';
import { CascadeInstances, CascadeParts } from '../dist/shadows.js';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';
import { wgsl } from '../../core/src/shaders.ts';

const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const batch = () => ({
  geometry: box(),
  material: new PbrMaterial(),
  transforms: new Float32Array([...identity, ...identity]),
});
function harness() {
  const h = optionalGPU();
  globalThis.GPUTextureUsage = { RENDER_ATTACHMENT: 16, TEXTURE_BINDING: 4 };
  h.context.shader = wgsl;
  h.context.descriptor = {
    multisample: { count: 1 },
    depthStencil: { format: 'depth32float' },
    vertex: { buffers: [] },
    fragment: { targets: [] },
  };
  h.context.camera.matrix = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, -0.001, -1, 0, 0, 1, 0]);
  h.engine.lighting = { direction: new Float32Array([0, 1, 0, 1]), radiance: new Float32Array([1, 1, 1, 0.2]) };
  return h;
}
// Records what a shadow pass is asked to do.
const recorder = () => {
  const calls = [];
  return new Proxy(
    { calls },
    {
      get: (t, k) => (k === 'calls' ? calls : (...a) => void calls.push([k, ...a])),
    },
  );
};
const matrices = (n) => new Float32Array(n * 16);
const drawn = (pass, name) => pass.calls.filter((c) => c[0] === name);

test('each cascade of each batch draws through its own list and indirect arguments', () => {
  const h = harness(),
    parts = new CascadeParts([batch(), batch()]);
  h.engine.use(parts);
  h.engine.frameGraph.execute(h.context);
  parts.prepareShadow({ context: h.context, matrices: matrices(3), cascades: 3 });
  const pass = recorder();
  parts.drawShadow({ context: h.context, pass, matrix: new Float32Array(16), cascade: 2 });
  assert.deepEqual(
    drawn(pass, 'drawIndexedIndirect').map((c) => c[2]),
    [(2 * 2 + 0) * 20, (2 * 2 + 1) * 20],
  );
  const lists = drawn(pass, 'setVertexBuffer').filter((c) => c[1] === 1);
  assert.deepEqual(
    lists.map((c) => c[3]),
    [(2 * 4 + 0) * 4, (2 * 4 + 2) * 4],
    'stride of all slots, batch start inside',
  );
});

test('a pass with no prepareShadow this frame draws every part, as CulledParts does', () => {
  const h = harness(),
    parts = new CascadeParts([batch()]);
  h.engine.use(parts);
  h.engine.frameGraph.execute(h.context);
  parts.prepareShadow({ context: h.context, matrices: matrices(1), cascades: 1 });
  const pass = recorder();
  parts.drawShadow({ context: { ...h.context, encoder: {} }, pass, matrix: new Float32Array(16), cascade: 0 });
  assert.equal(drawn(pass, 'drawIndexedIndirect').length, 0);
  assert.equal(drawn(pass, 'drawIndexed').length, 1);
});

test('a cascade past the prepared count takes the plain draw', () => {
  const h = harness(),
    parts = new CascadeParts([batch()]);
  h.engine.use(parts);
  h.engine.frameGraph.execute(h.context);
  parts.prepareShadow({ context: h.context, matrices: matrices(1), cascades: 1 });
  const pass = recorder();
  parts.drawShadow({ context: h.context, pass, matrix: new Float32Array(16), cascade: 1 });
  assert.equal(drawn(pass, 'drawIndexed').length, 1);
});

test('lists too large to bind leave every cascade on the plain draw', () => {
  const h = harness(),
    parts = new CascadeParts([batch()]);
  h.engine.use(parts);
  h.engine.frameGraph.execute(h.context);
  h.engine.gpu.limits = { maxStorageBufferBindingSize: 4, maxBufferSize: 4 };
  parts.prepareShadow({ context: h.context, matrices: matrices(2), cascades: 2 });
  const pass = recorder();
  parts.drawShadow({ context: h.context, pass, matrix: new Float32Array(16), cascade: 0 });
  assert.equal(drawn(pass, 'drawIndexedIndirect').length, 0);
});

test('CascadeInstances holds one list per cascade over its capacity', () => {
  const h = harness(),
    rows = new CascadeInstances({ geometry: box(), material: new PbrMaterial(), capacity: 8 });
  h.engine.gpu.createBindGroupLayout = (d) => d;
  h.engine.gpu.createPipelineLayout = (d) => d;
  const batches = [];
  h.engine.canvas = { clientWidth: 64, width: 64, height: 64 };
  h.engine.retain = (geometry) => batches.push({ geometry, instances: new Float32Array(48), count: 0 });
  h.engine.release = () => {};
  h.engine.geometryBuffers = () => ({ vertex: {}, index: {} });
  h.context.batches = batches;
  h.context.width = h.context.height = 64;
  h.engine.use(rows);
  rows.addInstance(identity);
  h.engine.frameGraph.execute(h.context);
  rows.prepareShadow({ context: h.context, matrices: matrices(2), cascades: 2 });
  const pass = recorder();
  rows.drawShadow({ context: h.context, pass, matrix: new Float32Array(16), cascade: 1 });
  assert.equal(drawn(pass, 'setVertexBuffer').find((c) => c[1] === 1)[3], 8 * 4);
  assert.equal(drawn(pass, 'drawIndexedIndirect')[0][2], 20);
});

// The WebGL2 layer has no compute: the lists are built on the CPU and uploaded, the same as the kernel's (row 4 of lane
// A's round 2; before, that layer built none and every cascade drew every caster).
const ortho = (s) => [1 / s, 0, 0, 0, 0, 1 / s, 0, 0, 0, 0, 0.5 / s, 0, 0, 0, 0.5, 1];
const at = (x) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, 0, 0, 1];
// Prepares until the source reports lists (the first prepare builds them on the CPU).
async function prepared(source, prepare) {
  for (let t = 0; t < 200; t++) {
    prepare();
    const kept = await source.readCascades();
    if (kept.length) return kept;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return [];
}
test('on the WebGL2 layer each cascade keeps the casters that reach its light box, built on the CPU', async () => {
  const h = harness();
  h.engine.gpu.adapterInfo = { vendor: 'margo-webgl2' };
  const two = () => ({
      geometry: box(),
      material: new PbrMaterial(),
      transforms: new Float32Array([...at(0), ...at(10)]),
    }),
    parts = new CascadeParts([two(), two()]);
  h.engine.use(parts);
  h.engine.frameGraph.execute(h.context);
  const light = new Float32Array([...ortho(2), ...ortho(20)]);
  assert.deepEqual(
    await prepared(parts, () => parts.prepareShadow({ context: h.context, matrices: light, cascades: 2 })),
    [2, 4],
    'the near box drops the parts at x 10',
  );
  const pass = recorder();
  parts.drawShadow({ context: h.context, pass, matrix: light.subarray(0, 16), cascade: 0 });
  const indirect = drawn(pass, 'drawIndexedIndirect'),
    lists = drawn(pass, 'setVertexBuffer').filter((c) => c[1] === 1);
  assert.equal(indirect.length, 2, 'one indirect draw per batch');
  for (const [k, [, args, offset]] of indirect.entries()) {
    assert.equal(new Uint32Array(args.data)[offset / 4 + 1], 1, `batch ${k} keeps one part in the near cascade`);
    const [, , list, from] = lists[k];
    assert.equal(new Uint32Array(list.data)[from / 4], k * 2, `batch ${k} keeps its part at x 0`);
  }
});

test('on the WebGL2 layer CascadeInstances culls its rows per cascade on the CPU', async () => {
  const h = harness();
  h.engine.gpu.adapterInfo = { vendor: 'margo-webgl2' };
  const rows = new CascadeInstances({ geometry: box(), material: new PbrMaterial(), capacity: 8 });
  h.engine.gpu.createBindGroupLayout = (d) => d;
  h.engine.gpu.createPipelineLayout = (d) => d;
  const batches = [];
  h.engine.canvas = { clientWidth: 64, width: 64, height: 64 };
  h.engine.retain = (geometry) => batches.push({ geometry, instances: new Float32Array(48), count: 0 });
  h.engine.release = () => {};
  h.engine.geometryBuffers = () => ({ vertex: {}, index: {} });
  h.context.batches = batches;
  h.context.width = h.context.height = 64;
  h.engine.use(rows);
  for (const x of [0, 10, 0.5]) rows.addInstance(at(x));
  rows.setVisibleAt(2, false);
  h.engine.frameGraph.execute(h.context);
  const light = new Float32Array([...ortho(2), ...ortho(20)]);
  assert.deepEqual(
    await prepared(rows, () => rows.prepareShadow({ context: h.context, matrices: light, cascades: 2 })),
    [1, 2],
    'the hidden row draws in no cascade',
  );
});
