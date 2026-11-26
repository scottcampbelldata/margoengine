// FG-17 piece 4b: deforming meshes (previousPositions). The GPU image is checked against a closed-form time coverage
// in mesh-deform-browser.mjs; these check the packet, the refusals and the sequence fill.
import assert from 'node:assert/strict';
import test from 'node:test';
import { MeshPathTracer, triangleMeshes } from '../dist/mesh.js';
import { ComposedVoxelPathTracer } from '../dist/compose.js';
import { traceFrames } from '../dist/sequence.js';
import { fakeEngine, simpleScene } from './support.js';

const QUAD = [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0];
const OPEN = [-2, -1, 3, 3, 0, 2, 1, 4, 1, -1, 2, 0];
const quad = (previous, id = 'quad') => ({
  id,
  material: 1,
  positions: new Float32Array(QUAD),
  indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
  ...(previous && { previousPositions: new Float32Array(previous) }),
});
const scene = (meshes, meshInstances, material = { id: 1, type: 'diffuse', color: [1, 1, 1] }) => ({
  ...simpleScene(),
  materials: [material],
  meshes,
  ...(meshInstances && { meshInstances }),
});
const creators = [
  ['MeshPathTracer', (e, s, o = {}) => MeshPathTracer.create(e, { scene: s, ...o })],
  ['composed', (e, s, o = {}) => ComposedVoxelPathTracer.create(e, { scene: s, features: [triangleMeshes()], ...o })],
];
function packet(h) {
  const w = h.device.buffers
    .map((b) => new Uint32Array(b.data))
    .findLast((w) => w[2] > 0 && w[w[2] + 9] === 0x4d494e53);
  assert.ok(w, 'two-level geometry uploaded');
  return w.slice(w[2]);
}
const f32 = (w, at) => new Float32Array(w.buffer, w.byteOffset + at * 4, 1)[0];

test('a deforming mesh points at its shutter-open section and its leaf bounds both ends', async () => {
  for (const [name, create] of creators) {
    const h = fakeEngine(),
      t = await create(
        h.engine,
        scene(
          [quad(OPEN), quad(QUAD, 'still')],
          [
            { id: 'd', mesh: 'quad', transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 5, 0, 0, 1] },
            { id: 's', mesh: 'still' },
          ],
        ),
      );
    try {
      await t.ready;
      h.frame();
      const w = packet(h),
        records = w[5];
      assert.equal(w[11], 1, `${name}: one deforming instance; previousPositions equal to positions is still`);
      const section = w[records + 27],
        head = w[records + 24];
      assert.equal(w[records + 32 + 27], 0, `${name}: the still mesh has no section`);
      assert.equal(w[records + 31], 0, `${name}: a deforming mesh is not a moving instance`);
      // The section holds the open node boxes, then each triangle's three open vertices.
      const nodes = w[head],
        triangles = w[head + 2];
      // The deforming BLAS is packed first; the section ends where the still mesh's BLAS starts.
      assert.equal(section, w[records + 32 + 24] - head - nodes * 8 - triangles * 12, `${name}: section at the end`);
      assert.ok(section >= 4 + nodes * 8 + triangles * 16, `${name}: after the triangles`);
      const verts = head + section + nodes * 8;
      const opened = new Set(
        Array.from({ length: triangles * 3 }, (_, k) =>
          [0, 1, 2].map((a) => f32(w, verts + Math.floor(k / 3) * 12 + (k % 3) * 4 + a)).join(),
        ),
      );
      for (let v = 0; v < 4; v++)
        assert.ok(opened.has(OPEN.slice(v * 3, v * 3 + 3).join()), `${name}: open vertex ${v}`);
      // The TLAS root covers every blended vertex of the placed quad at every shutter time.
      for (let k = 0; k <= 16; k++) {
        const s = k / 16;
        for (let v = 0; v < 4; v++)
          for (let a = 0; a < 3; a++) {
            const p = OPEN[v * 3 + a] * (1 - s) + QUAD[v * 3 + a] * s + (a === 0 ? 5 : 0);
            assert.ok(f32(w, 16 + a) <= p && p <= f32(w, 20 + a), `${name}: root bounds hold t = ${s}`);
          }
      }
    } finally {
      t.dispose();
    }
  }
});

test('a lone deforming mesh is placed once, and its emitters get light records', async () => {
  const h = fakeEngine(),
    t = await MeshPathTracer.create(h.engine, {
      scene: scene([quad(OPEN), quad(undefined, 'still')], undefined, {
        id: 1,
        type: 'emit',
        color: [1, 1, 1],
        emission: 2,
      }),
    });
  try {
    await t.ready;
    h.frame();
    const w = packet(h),
      records = w[5];
    assert.equal(w[4], 2, 'one identity placement a mesh');
    assert.notEqual(w[records + 27], 0, 'the deforming mesh has a section');
    // Sampled at the path's time (FG-17-EMITTERS; before it, a deforming emitter had no lookup).
    assert.notEqual(w[records + 30], 0, 'and a light lookup');
    assert.notEqual(w[records + 32 + 30], 0, 'the still emitter has one');
    assert.equal(w[w[12]], 4, 'four light records');
  } finally {
    t.dispose();
  }
});

test('previousPositions is checked like positions', async () => {
  const h = fakeEngine(),
    t = await MeshPathTracer.create(h.engine, { scene: scene([quad()]) });
  try {
    await t.ready;
    for (const previousPositions of [[0, 0, 0], new Float32Array(9), new Float64Array(12)])
      await assert.rejects(
        t.setScene(scene([{ ...quad(), previousPositions }])),
        /previousPositions must be Float32Array|previousPositions and Uint32Array/,
      );
    for (const meshInstances of [undefined, [{ id: 'q', mesh: 'quad' }]])
      await assert.rejects(
        t.setScene(scene([quad([...OPEN.slice(0, 11), 2e8])], meshInstances)),
        /positions must be finite within \+\/-1e8 world units, previousPositions too/,
      );
  } finally {
    t.dispose();
  }
});

test('traceFrames fills previousPositions from the last frame, copied', async () => {
  const seen = [];
  const tracer = {
    options: { shutter: 0, exposure: 1, toneMap: 'aces', gamma: 2.2 },
    setOptions(o) {
      Object.assign(this.options, o);
    },
    async setScene(s) {
      seen.push(s.meshes.map((m) => [m.id, m.previousPositions?.[0]]));
    },
    async whenIdle() {},
    async renderImage({ width, height }) {
      return { width, height, color: new Float32Array(width * height * 3), alpha: new Float32Array(width * height) };
    },
  };
  // One array written in place each frame, as a skinning update might.
  const shared = new Float32Array(QUAD);
  const frames = traceFrames(tracer, {
    frames: 3,
    fps: 24,
    width: 1,
    height: 1,
    samples: 1,
    shutter: 0.5,
    update: ({ index }) => {
      shared[0] = index;
      return scene([
        { ...quad(), positions: shared },
        quad(OPEN, 'given'),
        { ...quad(), id: 'grows', positions: new Float32Array(index === 2 ? 15 : 12).fill(index + 10) },
      ]);
    },
  });
  for await (const _ of frames);
  assert.deepEqual(seen, [
    [
      ['quad', undefined],
      ['given', -2],
      ['grows', undefined],
    ],
    [
      ['quad', 0],
      ['given', -2],
      ['grows', 10],
    ],
    [
      ['quad', 1],
      ['given', -2],
      ['grows', undefined],
    ],
  ]);
});
