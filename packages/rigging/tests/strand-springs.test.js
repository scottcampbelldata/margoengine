import assert from 'node:assert/strict';
import test from 'node:test';
import { Engine, TransformStore } from '../../core/dist/extension.js';
import { StrandSpringRig } from '../dist/strand-springs.js';
import { springAccess } from '../dist/springs.js';

async function actor(t) {
  const store = await TransformStore.create(8);
  const engine = new Engine({ width: 16, height: 16, clientWidth: 16, clientHeight: 16 }, store, {
    backend: 'webgl2',
    add() {},
    remove() {},
    render() {},
    dispose() {},
  });
  t.after(() => engine.dispose());
  const head = engine.createMesh().setPosition([0, 1.7, 0]);
  const root = engine.createMesh().setParent(head).setPosition([0, 0.02, -0.12]);
  const first = engine.createMesh().setParent(root).setPosition([0, -0.16, -0.035]);
  const last = engine.createMesh().setParent(first).setPosition([0, -0.16, -0.035]);
  return { access: springAccess({ nodes: [head, root, first, last], root: head }), head, root: 1, first: 2, last: 3 };
}

function worldTip(access, bone) {
  return Array.from(access.world(bone)).slice(12, 15);
}
function distance(a, b) {
  return Math.hypot(...a.map((value, axis) => value - b[axis]));
}

test('time-sampled ponytail anchors replay and all visible joints follow the solver coordinates', async (t) => {
  const { access, root, first, last } = await actor(t);
  const anchor = (t) => ({ position: [0.09 * Math.sin(6 * t), 1.72, -0.12] });
  const rig = await StrandSpringRig.load(access, {
    chains: [{ joints: [root, first, last], radius: 0.009, anchor }],
    colliders: [{ offset: [0, 1.47, -0.03], tail: [0, 1.72, -0.03], radius: 0.09 }],
    wind: {
      medium: 'air',
      cell: [0, 0, 0],
      sample: () => ({ velocity: [14, 0, 0], density: 1.225, temperature: 288.15 }),
    },
  });
  for (let frame = 4; frame <= 240; frame += 4) rig.advance(frame);
  const firstRun = rig.world.hash();
  const skinTip = worldTip(access, last);
  assert.ok(distance(skinTip, rig.solver.sample(0, 2).position) < 6e-7);
  assert.ok(distance(worldTip(access, root), anchor(1).position) < 6e-7);
  rig.seek(240);
  assert.equal(rig.world.hash(), firstRun);
  assert.ok(distance(worldTip(access, last), skinTip) < 6e-7);
});

test('the live parent moves a physical rig root and a one-bone accessory has a simulated tip', async (t) => {
  const { access, head, root } = await actor(t);
  const rig = await StrandSpringRig.load(access, {
    chains: [{ joints: [root], tip: [0, -0.24, 0], radius: 0.005 }],
    fidelity: 'follow',
  });
  head.setPosition([0.2, 1.7, 0]);
  rig.advance(8);
  const sample = rig.solver.sample(0, 1);
  assert.ok(sample.position[0] < 0.15, 'the virtual tip lags its anchor during acceleration');
  assert.ok(distance(worldTip(access, root), [0.2, 1.72, -0.12]) < 6e-7);
  assert.ok(Math.abs(distance(sample.position, rig.solver.sample(0, 0).position) - 0.24) < 1e-12);
});
