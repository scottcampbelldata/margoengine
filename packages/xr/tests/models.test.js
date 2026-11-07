import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine, TransformStore } from '@margoengine/core/extension';
import { wgsl } from '../../core/dist/shaders.js';
import { componentStates, fetchProfile, HAND_BONES, profileLayout, responseWeight, XRModels } from '../dist/models.js';

async function engine(t) {
  const store = await TransformStore.create(256),
    context = { backend: 'webgpu', shader: wgsl, descriptor: { vertex: { entryPoint: 'vertex', buffers: [] } }, draw() {} };
  const e = new Engine(
    { width: 1, height: 1, getContext() {} },
    store,
    { backend: 'webgpu', add() {}, remove() {}, dispose() {}, render(camera, light, batches, graph) { graph.execute(context); } },
    undefined,
    null,
  );
  t.after(() => e.dispose());
  return e;
}
function host(controllers) {
  let listener;
  return {
    controllers,
    onFrame(callback) {
      listener = callback;
      return () => (listener = undefined);
    },
    step() {
      listener?.({});
    },
  };
}
const pose = (x, y, z, q = [0, 0, 0, 1]) => ({ transform: { position: { x, y, z, w: 1 }, orientation: { x: q[0], y: q[1], z: q[2], w: q[3] } } });
function controller(source) {
  return {
    source,
    grip: null,
    buttons: new Float32Array(96),
    axes: new Float32Array(16),
    buttonCount: 4,
    axisCount: 4,
    handMatrices: new Float32Array(25 * 16),
    handTracked: new Uint8Array(25),
    handRadii: new Float32Array(25),
  };
}

test('a held controller follows its grip, and its trigger, squeeze and thumbstick move and light up as they are used', async (t) => {
  const e = await engine(t),
    c = controller({ handedness: 'right', gripSpace: {}, profiles: [], gamepad: { mapping: 'xr-standard' } }),
    xr = host([c]),
    models = XRModels.attach(xr, e);
  xr.step();
  const meshes = models.controllerMeshes(c.source);
  assert.equal(meshes.length, 7);
  assert.ok(meshes.every((m) => !m.visible), 'hidden while the grip is untracked');
  c.grip = pose(0.2, 1.1, -0.3);
  c.buttons[0] = 1;
  c.buttons[1] = 1;
  c.axes[2] = 1;
  xr.step();
  const [root, , , trigger, squeeze, stick] = meshes;
  assert.ok(meshes.every((m) => m.visible));
  assert.deepEqual([root.position.x, root.position.y, root.position.z].map((v) => +v.toFixed(5)), [0.2, 1.1, -0.3]);
  assert.ok(Math.abs(trigger.rotation.x - 0.35) < 1e-6, 'trigger swings 0.35 rad when fully pulled');
  assert.notEqual(trigger.material, squeeze.material, 'the pressed trigger has the pressed colour');
  assert.ok(Math.abs(stick.rotation.z - 0.4) < 1e-6, 'thumbstick leans with its x axis');
  assert.ok(Math.abs(squeeze.position.x + 0.019) < 1e-6, 'right hand: the squeeze is on the palm side (-x)');
  // Another mapping puts its buttons where the device likes: the parts rest.
  c.source.gamepad.mapping = '';
  xr.step();
  assert.equal(trigger.rotation.x, 0);
  assert.equal(stick.rotation.z, 0);
  assert.equal(trigger.material, squeeze.material);
  c.source.gamepad.mapping = 'xr-standard';
  // skipRendering: the system draws it, so the model hides.
  c.source.skipRendering = true;
  xr.step();
  assert.ok(meshes.every((m) => !m.visible));
  // A source that leaves takes its meshes.
  const before = e.scene.meshes.size;
  xr.controllers.length = 0;
  xr.step();
  assert.equal(e.scene.meshes.size, before - 7);
  assert.equal(models.controllerMeshes(c.source), undefined);
  models.dispose();
});

test('a tracked hand draws a sphere at each joint scaled by its radius and a cylinder along each bone', async (t) => {
  const e = await engine(t),
    c = controller({ handedness: 'left', hand: new Map(), profiles: [] }),
    xr = host([c]),
    models = XRModels.attach(xr, e);
  for (let j = 0; j < 25; j++) {
    const m = c.handMatrices.subarray(j * 16, j * 16 + 16);
    m[0] = m[5] = m[10] = m[15] = 1;
    m[12] = j * 0.01;
    m[13] = 1;
    m[14] = -j * 0.02;
    c.handTracked[j] = 1;
    c.handRadii[j] = 0.005 + j * 0.0001;
  }
  xr.step();
  const { joints, bones } = models.handMeshes(c.source);
  assert.equal(joints.length, 25);
  assert.equal(bones.length, HAND_BONES.length);
  assert.equal(HAND_BONES.length, 24, 'wrist to five metacarpals, then each finger and the thumb along their joints');
  assert.ok(Math.abs(joints[7].position.x - 0.07) < 1e-6 && Math.abs(joints[7].scale.x - 0.0057) < 1e-6);
  const [from, to] = HAND_BONES[3],
    bone = bones[3],
    length = Math.hypot((to - from) * 0.01, 0, (to - from) * 0.02);
  assert.ok(Math.abs(bone.position.x - ((from + to) / 2) * 0.01) < 1e-6);
  assert.ok(Math.abs(bone.scale.z - length) < 1e-6);
  c.handTracked[0] = 0;
  xr.step();
  assert.ok(joints.every((m) => !m.visible), 'an untracked hand hides');
  models.dispose();
  assert.throws(() => XRModels.attach({}, e), /pass the XR, then the engine/);
});

const profile = {
  profileId: 'test-pad',
  layouts: {
    'left-right': {
      assetPath: 'model.glb',
      gamepad: { buttons: ['trigger', 'squeeze', null, 'stick'], axes: [null, null, { componentId: 'stick', axis: 'xAxis' }, { componentId: 'stick', axis: 'yAxis' }] },
      components: { trigger: {}, squeeze: {}, stick: {} },
    },
  },
};

test('component states follow the layout gamepad mapping, and visual responses weigh them as the assets describe', () => {
  const c = controller({});
  c.buttons.set([0.625, 1, 1], 0); // exact in the Float32Array
  c.buttons.set([0, 0, 1], 3);
  c.axes[2] = -1;
  c.axes[3] = 0.5;
  const states = componentStates(profileLayout(profile, 'right'), c);
  assert.deepEqual(states.trigger, { state: 'pressed', button: 0.625, xAxis: 0, yAxis: 0 });
  assert.equal(states.squeeze.state, 'touched');
  assert.deepEqual([states.stick.xAxis, states.stick.yAxis], [-1, 0.5]);
  assert.equal(responseWeight({ componentProperty: 'button', states: ['pressed'] }, states.trigger), 0.625);
  assert.equal(responseWeight({ componentProperty: 'yAxis', states: ['default', 'touched', 'pressed'] }, states.stick), 0.75);
  assert.equal(responseWeight({ componentProperty: 'xAxis', states: ['pressed'] }, states.stick), 0.5, 'an axis rests at the middle');
  assert.equal(responseWeight({ componentProperty: 'state', states: ['touched'] }, states.squeeze), 1);
  assert.equal(profileLayout(profile, 'none'), undefined);
});

test('fetchProfile picks the most specific listed profile, falls back, and says what to serve when a file is missing', async (t) => {
  const saved = globalThis.fetch,
    asked = [];
  t.after(() => (globalThis.fetch = saved));
  globalThis.fetch = async (url) => {
    asked.push(String(url));
    if (String(url).endsWith('profilesList.json')) return { ok: true, json: async () => ({ 'test-pad': { path: 'test-pad/profile.json' }, 'generic-trigger': { path: 'generic-trigger/profile.json' } }) };
    if (String(url).endsWith('test-pad/profile.json')) return { ok: true, json: async () => profile };
    return { ok: false, status: 404 };
  };
  const found = await fetchProfile({ profiles: ['vendor-x', 'test-pad'], handedness: 'right' }, 'https://cdn.example/profiles');
  assert.equal(found.id, 'test-pad');
  assert.equal(found.assetUrl, 'https://cdn.example/profiles/test-pad/model.glb');
  assert.deepEqual(asked, ['https://cdn.example/profiles/profilesList.json', 'https://cdn.example/profiles/test-pad/profile.json']);
  await assert.rejects(fetchProfile({ profiles: ['vendor-x'], handedness: 'right' }, 'https://cdn.example/profiles'), /serve the input profile assets/);
  await assert.rejects(fetchProfile({ profiles: ['vendor-x'], handedness: 'right' }, 'https://cdn.example/profiles', { fallback: 'none' }), /pass a listed fallback/);
});
