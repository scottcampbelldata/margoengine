// FG-17 piece 4a: moving mesh instances (previousTransform, motionInterpolation). The GPU image is checked against a
// closed-form time coverage in mesh-motion-browser.mjs; these check the packet, the refusals and the sequence fill.
import assert from 'node:assert/strict';
import test from 'node:test';
import { MeshPathTracer, triangleMeshes } from '../dist/mesh.js';
import { ComposedVoxelPathTracer } from '../dist/compose.js';
import { traceFrames } from '../dist/sequence.js';
import { fakeEngine, simpleScene } from './support.js';

const translate = (x, y = 0, z = 0) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1];
const mirror = [-1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const QUAD = [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0];
const scene = (meshInstances, material = { id: 1, type: 'diffuse', color: [1, 1, 1] }) => ({
  ...simpleScene(),
  materials: [material],
  meshes: [
    { id: 'quad', material: 1, positions: new Float32Array(QUAD), indices: new Uint32Array([0, 1, 2, 0, 2, 3]) },
  ],
  meshInstances,
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

test('a moving instance points at its interval and its TLAS leaf bounds the whole sweep', async () => {
  for (const [name, create] of creators) {
    const h = fakeEngine(),
      t = await create(
        h.engine,
        scene([
          { id: 'still', mesh: 'quad', transform: translate(5) },
          { id: 'moving', mesh: 'quad', transform: translate(3, 1), previousTransform: translate(-2, 0, 1) },
          {
            id: 'spin',
            mesh: 'quad',
            transform: translate(0, 4),
            previousTransform: translate(0, 4),
            motionInterpolation: 'trs',
          },
        ]),
      );
    try {
      await t.ready;
      h.frame();
      const w = packet(h),
        records = w[5];
      assert.equal(w[11], 1, `${name}: one moving instance (equal transforms are still)`);
      assert.deepEqual([w[records + 31], w[records + 64 + 31]], [0, 0], `${name}: still records have no interval`);
      const block = w[records + 32 + 31];
      assert.equal(block, records + 96, `${name}: the interval follows the three records`);
      assert.equal(w[block], 0, `${name}: 'matrix' mode`);
      // Shutter-open world rows, row-major 3x4, at block + 4.
      assert.deepEqual(
        Array.from({ length: 12 }, (_, i) => f32(w, block + 4 + i)),
        [1, 0, 0, -2, 0, 1, 0, 0, 0, 0, 1, 1],
        `${name}: previous rows`,
      );
      // The root covers every vertex of the quad at every shutter time, both ends included.
      for (let k = 0; k <= 16; k++) {
        const s = k / 16;
        for (let v = 0; v < 4; v++) {
          const p = [QUAD[v * 3] - 2 + 5 * s, QUAD[v * 3 + 1] + s, 1 - s];
          for (let a = 0; a < 3; a++) {
            assert.ok(f32(w, 16 + a) <= p[a] && p[a] <= f32(w, 20 + a), `${name}: root bounds hold t = ${s}`);
          }
        }
      }
    } finally {
      t.dispose();
    }
  }
});

test("'trs' packs the rotation the shader slerps; a moving emitter gets light records", async () => {
  const c = Math.SQRT1_2,
    turned = [c, c, 0, 0, -c, c, 0, 0, 0, 0, 1, 0, 1, 0, 0, 1];
  const h = fakeEngine(),
    t = await MeshPathTracer.create(h.engine, {
      scene: scene(
        [
          { id: 'still', mesh: 'quad', transform: translate(5) },
          { id: 'spin', mesh: 'quad', transform: turned, previousTransform: translate(0), motionInterpolation: 'trs' },
        ],
        { id: 1, type: 'emit', color: [1, 1, 1], emission: 2 },
      ),
    });
  try {
    await t.ready;
    h.frame();
    const w = packet(h),
      records = w[5],
      block = w[records + 32 + 31];
    assert.equal(w[block], 1, "'trs' mode");
    // q0 identity, q1 an eighth turn about z, unit scales, angle pi/8 between them.
    assert.ok(Math.abs(f32(w, block + 16 + 3) - 1) < 1e-6);
    assert.ok(Math.abs(f32(w, block + 20 + 2) - Math.sin(Math.PI / 8)) < 1e-6);
    assert.ok(Math.abs(f32(w, block + 16 + 11) - Math.PI / 8) < 1e-5);
    // The light table: both instances' triangles are lights; the spinning one's are sampled at the path's time
    // (FG-17-EMITTERS; before it, a moving emitter had no lookup and was left to path hits).
    assert.notEqual(w[records + 30], 0, 'the still emitter has a light lookup');
    assert.notEqual(w[records + 32 + 30], 0, 'the moving emitter has one');
    assert.equal(w[w[12]], 4, 'four light records');
  } finally {
    t.dispose();
  }
});

test('an interval that becomes singular is refused only while the shutter is open', async () => {
  for (const [name, create] of creators) {
    const bad = scene([{ id: 'q', mesh: 'quad', previousTransform: mirror }]);
    await assert.rejects(create(fakeEngine().engine, bad, { shutter: 0.5 }), (e) => {
      assert.ok(e instanceof RangeError, name);
      assert.match(e.message, /meshInstances\[0\] motion interval becomes singular.*previousTransform/);
      return true;
    });
    const h = fakeEngine(),
      t = await create(h.engine, bad);
    try {
      await t.ready;
      assert.throws(() => t.setOptions({ shutter: 0.25 }), RangeError, `${name}: opening the shutter`);
      assert.equal(t.options.shutter, 0);
      await t.setScene(scene([{ id: 'q', mesh: 'quad', previousTransform: translate(1) }]));
      t.setOptions({ shutter: 0.25 });
      const revision = t.stats.sceneRevision;
      await assert.rejects(t.setScene(bad), RangeError, `${name}: a bad scene with the shutter open`);
      assert.equal(t.stats.sceneRevision, revision, `${name}: the refused scene changes nothing`);
      // 'trs' refuses shear and a flip of handedness, also only with the shutter open.
      const sheared = [1, 0, 0, 0, 0.5, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
      await assert.rejects(
        t.setScene(
          scene([
            { id: 'q', mesh: 'quad', transform: sheared, previousTransform: translate(1), motionInterpolation: 'trs' },
          ]),
        ),
        /shear/,
      );
      await assert.rejects(
        t.setScene(
          scene([
            { id: 'q', mesh: 'quad', transform: mirror, previousTransform: translate(1), motionInterpolation: 'trs' },
          ]),
        ),
        /handedness/,
      );
    } finally {
      t.dispose();
    }
  }
});

test('previousTransform and motionInterpolation are checked like transform', async () => {
  const h = fakeEngine(),
    t = await MeshPathTracer.create(h.engine, { scene: scene([{ id: 'q', mesh: 'quad' }]) });
  try {
    await t.ready;
    for (const previousTransform of [[1, 2, 3], translate(NaN), translate(2e8), [...translate(0).slice(0, 15), 2]])
      await assert.rejects(t.setScene(scene([{ id: 'q', mesh: 'quad', previousTransform }])), TypeError);
    await assert.rejects(
      t.setScene(scene([{ id: 'q', mesh: 'quad', previousTransform: translate(1), motionInterpolation: 'slerp' }])),
      /motionInterpolation must be 'matrix' or 'trs'/,
    );
  } finally {
    t.dispose();
  }
});

test('traceFrames fills previousTransform from the last frame', async () => {
  const seen = [];
  const tracer = {
    options: { shutter: 0, exposure: 1, toneMap: 'aces', gamma: 2.2 },
    setOptions(o) {
      Object.assign(this.options, o);
    },
    async setScene(s) {
      seen.push(s.meshInstances.map((i) => [i.id, i.previousTransform?.[12]]));
    },
    async whenIdle() {},
    async renderImage({ width, height }) {
      return { width, height, color: new Float32Array(width * height * 3), alpha: new Float32Array(width * height) };
    },
  };
  const frames = traceFrames(tracer, {
    frames: 3,
    fps: 24,
    width: 1,
    height: 1,
    samples: 1,
    shutter: 0.5,
    update: ({ index }) =>
      scene([
        { id: 'a', mesh: 'quad', transform: translate(index) },
        { id: 'b', mesh: 'quad', transform: translate(index), previousTransform: translate(9) },
        ...(index === 2 ? [{ id: 'new', mesh: 'quad', transform: translate(4) }] : []),
      ]),
  });
  for await (const _ of frames);
  assert.deepEqual(seen, [
    [
      ['a', undefined],
      ['b', 9],
    ],
    [
      ['a', 0],
      ['b', 9],
    ],
    [
      ['a', 1],
      ['b', 9],
      ['new', undefined],
    ],
  ]);
});
