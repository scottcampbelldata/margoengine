import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, unlinkSync, rmdirSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'vite';
import { Engine, TransformStore } from '../packages/core/dist/extension.js';
import { AvoidanceSolver, CapsuleVolume } from '@margoengine/kinematics-constraints';
import { gripPosition, localPoint, worldPosition } from '../examples/skinning-ik/rig-ik.ts';

mkdirSync(resolve('test-results'), { recursive: true });
const temporary = mkdtempSync(resolve('test-results/ik-constraints-')),
  modulePath = join(temporary, 'body.mjs');
const bundle = await build({
  configFile: false,
  publicDir: false,
  logLevel: 'silent',
  build: {
    write: false,
    target: 'es2022',
    minify: false,
    lib: { entry: resolve('examples/skinning-ik/body-ik.ts'), formats: ['es'] },
    rollupOptions: { external: (id) => id.startsWith('@margoengine/') },
  },
});
writeFileSync(modulePath, bundle[0].output[0].code);
const { BodyIK } = await import(pathToFileURL(modulePath).href);
unlinkSync(modulePath);
rmdirSync(temporary);

const bytes = readFileSync(new URL('../examples/assets/skinning-ik.glb', import.meta.url));
const doc = JSON.parse(bytes.toString('utf8', 20, 20 + bytes.readUInt32LE(12)));
async function robot() {
  const store = await TransformStore.create(doc.nodes.length + 1),
    engine = new Engine({ width: 256, height: 256, clientWidth: 256, clientHeight: 256 }, store, {
      backend: 'webgl2',
      add() {},
      remove() {},
      render() {},
      dispose() {},
    }),
    frame = engine.createMesh();
  const nodes = doc.nodes.map((node) =>
    engine
      .createMesh()
      .setParent(frame)
      .setPosition(node.translation ?? [0, 0, 0])
      .setQuaternion(node.rotation ?? [0, 0, 0, 1])
      .setScale(node.scale ?? [1, 1, 1]),
  );
  doc.nodes.forEach((node, i) => node.children?.forEach((child) => nodes[child].setParent(nodes[i])));
  store.tick(false);
  const named = (name) => nodes[doc.nodes.findIndex((node) => node.name === name)],
    shoulder = named('UpperArm'),
    elbow = named('Forearm'),
    wrist = named('Hand'),
    start = worldPosition(wrist),
    localGrip = localPoint(wrist, [start[0], start[1] + 0.13, start[2]]),
    solver = new BodyIK({ frame, shoulder, elbow, wrist, localGrip });
  const pose = () =>
    [shoulder, elbow, wrist].map(({ id }) => {
      const t = store.transforms;
      return [t.qx[id], t.qy[id], t.qz[id], t.qw[id]];
    });
  return { engine, store, frame, solver, pose };
}

test('robot projects the grip request through the constraints package in model space with explicit dt', async (t) => {
  const calls = [],
    originalProject = AvoidanceSolver.prototype.resolveTarget,
    originalReset = AvoidanceSolver.prototype.reset;
  let resets = 0;
  t.mock.method(AvoidanceSolver.prototype, 'resolveTarget', function (point, dt) {
    const result = originalProject.call(this, point, dt);
    calls.push({ point: [...point], dt, result: [...result], resolved: this.targetResult.resolved });
    return result;
  });
  t.mock.method(AvoidanceSolver.prototype, 'reset', function () {
    resets++;
    return originalReset.call(this);
  });
  const rig = await robot();
  try {
    rig.frame.setPosition([3, -0.5, 2]).setRotation([0.25, -0.6, 0.15]).setScale([1.7, 1.7, 1.7]);
    rig.store.tick(false);
    const localTarget = [0, 0.9, 0.025],
      target = gripPosition(rig.frame, localTarget),
      result = rig.solver.solve(target, 1 / 120);
    assert.equal(calls.length, 1, 'the actual library must participate in the solve');
    assert.equal(calls[0].dt, 1 / 120);
    calls[0].point.forEach((value, i) => assert.ok(Math.abs(value - localTarget[i]) < 3e-7));
    assert.equal(calls[0].resolved, true);
    const capsule = new CapsuleVolume({ start: [0, 0.81, 0.025], end: [0, 1, 0.025], radius: 0.11 });
    assert.ok(capsule.evaluate(calls[0].result, [0, 0, 0], [0, 0, 0]) >= 0.10465342044830322 + 0.003 - 1e-6);
    assert.equal(result.safe, true);
    assert.equal(rig.solver.collision(), null, 'the authored surface guard still accepts the final pose');

    rig.solver.solve(target, 1 / 60);
    assert.equal(calls.length, 1, 'stationary requests retain the existing pose cache');
    const pose = rig.pose();
    for (const dt of [0, -1, NaN, Infinity]) {
      assert.throws(() => rig.solver.solve(target, dt), /Body IK dt/);
      assert.deepEqual(rig.pose(), pose, 'invalid dt must fail before changing the cached pose');
    }
    assert.equal(calls.length, 1);
    rig.solver.reset();
    assert.equal(resets, 1, 'Home reset clears library history together with body recovery');
    assert.equal(rig.solver.solve(target, 1 / 90).safe, true);
    assert.equal(calls.length, 2);
    assert.equal(calls[1].dt, 1 / 90);
  } finally {
    rig.engine.dispose();
  }
});
