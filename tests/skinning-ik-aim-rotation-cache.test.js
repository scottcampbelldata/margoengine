import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, unlinkSync, rmdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'vite';
import { Engine, TransformStore } from '../packages/core/dist/extension.js';
import { HeadAim } from '../examples/skinning-ik/head-aim.ts';

const temporary = mkdtempSync(resolve('test-results/aim-rotation-'));
const bundle = await build({
  configFile: false,
  publicDir: false,
  logLevel: 'silent',
  build: {
    write: false,
    target: 'es2022',
    lib: { entry: resolve('examples/skinning-ik/torso-aim.ts'), formats: ['es'] },
    rollupOptions: { external: (id) => id.startsWith('@margoengine/') },
  },
});
for (const file of bundle[0].output) writeFileSync(join(temporary, file.fileName), file.code);
const entry = bundle[0].output.find((file) => file.isEntry);
const { TorsoAim } = await import(pathToFileURL(join(temporary, entry.fileName)).href);
for (const file of bundle[0].output) unlinkSync(join(temporary, file.fileName));
rmdirSync(temporary);

const target = [-0.48, 1.17, -0.23],
  torsoTarget = [0.1, 1.17, -0.3];
async function fixture(t) {
  const store = await TransformStore.create(8),
    engine = new Engine({ width: 1, height: 1, clientWidth: 1, clientHeight: 1 }, store, {
      backend: 'webgl2',
      add() {},
      remove() {},
      render() {},
      dispose() {},
    }),
    root = engine.createMesh(),
    body = engine.createMesh().setParent(root),
    head = engine.createMesh().setParent(body).setPosition([0, 1.15, 0]),
    torso = new TorsoAim(body, root),
    aim = new HeadAim(head, [0, 0.19, -0.232], 1.3);
  t.after(() => engine.dispose());
  torso.update(torsoTarget, 1 / 60);
  aim.update(target);
  return { store, engine, root, body, head, torso, aim };
}
function rotation(mesh) {
  const t = mesh.engine.store.transforms,
    id = mesh.id;
  return { q: [t.qx[id], t.qy[id], t.qz[id], t.qw[id]], euler: [...mesh.euler], matrix: [...mesh.matrix] };
}
function snapshot(f) {
  return {
    body: rotation(f.body),
    head: rotation(f.head),
    frame: [...f.torso.frame.matrix],
    yaw: f.torso.yaw,
    desiredYaw: f.torso.desiredYaw,
    origin: [...f.aim.origin],
    forward: [...f.aim.forward],
    angle: f.aim.angle,
    rayError: f.aim.rayError,
    rayDistance: f.aim.rayDistance,
  };
}

test('unchanged head requests repair all presented Euler fields before reusing diagnostics', async (t) => {
  const f = await fixture(t),
    expected = snapshot(f),
    diagnostics = t.mock.method(f.aim, 'diagnostics');
  for (let axis = 0; axis < 3; axis++) {
    f.store.rotations[f.head.id * 3 + axis] += 0.25;
    f.aim.update(target);
    assert.deepEqual(snapshot(f), expected, `repair head Euler axis ${axis}`);
  }
  assert.equal(diagnostics.mock.callCount(), 3, 'raw Euler changes must miss the exact request cache');
  f.aim.update(target);
  assert.equal(diagnostics.mock.callCount(), 3, 'a fully unchanged request still reuses diagnostics');
});

test('zero-delta torso holds and head cache restore Euler writes through store growth and later VectorRef writes', async (t) => {
  const a = await fixture(t),
    b = await fixture(t),
    expected = snapshot(b);
  for (const f of [a, b]) for (let i = 0; i < 40; i++) f.engine.createMesh();
  for (let axis = 0; axis < 3; axis++) {
    a.store.rotations[a.body.id * 3 + axis] += 0.25;
    a.store.rotations[a.head.id * 3 + axis] -= 0.25;
  }
  a.torso.update(torsoTarget, 0);
  a.aim.update(target);
  assert.deepEqual(snapshot(a), expected);
  a.store.rotations[a.body.id * 3] = -0;
  a.torso.applyHeld();
  assert.equal(Object.is(a.body.euler[0], b.body.euler[0]), true, 'held Euler signed zero is restored too');
  // Component setters consume all three Euler fields: stale fields would change this quaternion.
  for (const f of [a, b]) {
    f.body.rotation.z += 0.03125;
    f.head.rotation.y -= 0.03125;
  }
  assert.deepEqual(rotation(a.body), rotation(b.body));
  assert.deepEqual(rotation(a.head), rotation(b.head));
  for (const f of [a, b]) {
    f.torso.applyHeld();
    f.aim.update(target);
  }
  assert.deepEqual(snapshot(a), snapshot(b));
});

test('aim reset repairs stale Euler fields and rejected input still leaves the pose untouched', async (t) => {
  const a = await fixture(t),
    b = await fixture(t);
  a.store.rotations[a.head.id * 3 + 1] = NaN;
  const q = rotation(a.head).q;
  assert.throws(() => a.aim.update([NaN, 1, 0]), /finite/);
  assert.equal(Number.isNaN(a.head.euler[1]), true);
  assert.deepEqual(rotation(a.head).q, q);
  a.aim.reset(target);
  b.aim.reset(target);
  a.store.rotations[a.body.id * 3] = NaN;
  assert.throws(() => a.torso.update(torsoTarget, -1), /dt/);
  assert.equal(Number.isNaN(a.body.euler[0]), true);
  a.torso.reset();
  b.torso.reset();
  a.aim.reset(target);
  b.aim.reset(target);
  assert.deepEqual(snapshot(a), snapshot(b));
  a.store.rotations[a.head.id * 3] += 0.25;
  a.store.transforms.sx[a.root.id] = 0;
  const rejectedEuler = [...a.head.euler];
  assert.throws(() => a.aim.update(target), /positive uniform/);
  assert.deepEqual([...a.head.euler], rejectedEuler);
  a.store.transforms.sx[a.root.id] = 1;
  a.aim.update(target);
  b.aim.update(target);
  assert.deepEqual(snapshot(a), snapshot(b));
});
