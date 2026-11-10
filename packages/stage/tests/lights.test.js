import test from 'node:test';
import assert from 'node:assert/strict';
import { Stage } from '@margoengine/stage';
import { addLights } from '@margoengine/stage/lights';
import { addScene } from '@margoengine/stage/scene';
import { Clustered } from '@margoengine/clustered';
import { loadedPBREngine } from '../../../tests/support/loaded-pbr-fixtures.js';

const point = { type: 'point', position: [1, 2, 3], intensity: 5 },
  spot = { type: 'spot', position: [-1, 2, 3], direction: [0, -1, 0], angle: 0.5 },
  area = { type: 'area', position: [0, 3, 0], direction: [0, -1, 0], width: 2, height: 1 },
  sun = { type: 'directional', direction: [0, -1, -1] };
const fixture = async () => new Stage(await loadedPBREngine());
const receiver = () => ({
  name: 'receiver',
  count: 0,
  setup() {},
  dispose() {},
  addLighting() {
    this.count++;
    return () => {
      this.count--;
    };
  },
});

test('one call attaches all four light kinds with underlying options and cleans up owned plugins', async () => {
  const stage = await fixture();
  try {
    const lights = await addLights(stage, [point, spot, area, sun]);
    assert.equal(lights.clustered.list.length, 2);
    assert.equal(lights.clustered.list[0].range, 0);
    assert.equal(lights.clustered.list[1].angle, 0.5);
    assert.equal(lights.area.list[0].width, 2);
    assert.equal(lights.directional.list[0].direction[1], -1);
    lights.dispose();
    lights.dispose();
    assert.deepEqual([...stage.engine.plugins.keys()], ['margoengine-imports']);
  } finally {
    stage.dispose();
  }
});

test('helpers combine their lights and share current and later receivers without disturbing an external owner', async () => {
  const stage = await fixture(),
    external = Clustered.attach(stage.engine),
    existing = receiver();
  const original = { position: [0, 0, 0], range: 4 };
  external.setLights([original]);
  assert.equal(external.hasReceiver(existing), false);
  const remove = external.add(existing);
  assert.equal(external.hasReceiver(existing), true);
  stage.use(existing);
  try {
    const a = await addLights(stage, [point, area]),
      b = await addLights(stage, [spot, area]);
    assert.equal(a.clustered, b.clustered);
    assert.equal(a.area, b.area);
    assert.equal(external.list.length, 3);
    assert.equal(existing.count, 1);
    const late = stage.use({ ...receiver(), name: 'late' });
    const originalRAF = globalThis.requestAnimationFrame,
      originalCancel = globalThis.cancelAnimationFrame;
    let frame;
    globalThis.requestAnimationFrame = (callback) => {
      frame = callback;
      return 1;
    };
    globalThis.cancelAnimationFrame = () => {};
    try {
      stage.engine.start();
      frame(0);
      stage.engine.stop();
    } finally {
      globalThis.requestAnimationFrame = originalRAF;
      globalThis.cancelAnimationFrame = originalCancel;
    }
    assert.equal(late.count, 1);
    a.dispose();
    assert.equal(external.list.length, 2);
    assert.equal(b.area.list.length, 1);
    assert.equal(late.count, 1);
    b.dispose();
    assert.deepEqual(external.list, [original]);
    assert.equal(existing.count, 1);
    assert.equal(late.count, 0);
    assert.equal(external.hasReceiver(late), false);
    assert.ok(stage.engine.hasPlugin('clustered'));
  } finally {
    remove();
    stage.dispose();
  }
  assert.equal(external.hasReceiver(existing), false);
});

test('invalid later groups roll back earlier additions, and cancellation adds nothing', async () => {
  const stage = await fixture();
  try {
    await assert.rejects(addLights(stage, [point, { ...area, width: -1 }]), /light/i);
    assert.deepEqual([...stage.engine.plugins.keys()], ['margoengine-imports']);
    await assert.rejects(addLights(stage, [{ type: 'invalid' }]), /type point/);
    await assert.rejects(addLights(stage, [point], { signal: AbortSignal.abort() }), { name: 'AbortError' });
    assert.deepEqual([...stage.engine.plugins.keys()], ['margoengine-imports']);
    const lights = await addLights(stage, [point, area, sun]);
    stage.dispose();
    lights.dispose();
    assert.throws(() => lights.add(receiver()), /disposed/i);
  } finally {
    stage.dispose();
  }
});

test('addScene and addLights share the clustered list in either order, and each dispose takes only its own', async () => {
  // Before: addScene's light list replaced the whole list with its own lights, dropping addLights' (and back again).
  const stage = await fixture(),
    doc = {
      format: 'margo-save',
      version: 1,
      entities: [
        { id: 'lamp', transform: { position: [0, 2, 0] }, components: { light: { type: 'point', range: 5 } } },
      ],
    };
  try {
    const lights = await addLights(stage, [{ type: 'point', position: [0, 1, 0], range: 5 }]),
      scene = await addScene(stage, doc, { fit: false });
    assert.equal(lights.clustered.list.length, 2);
    scene.dispose();
    assert.deepEqual(
      lights.clustered.list.map((light) => light.position),
      [[0, 1, 0]],
    );
    const again = await addScene(stage, doc, { fit: false }),
      more = await addLights(stage, [{ type: 'point', position: [0, 3, 0], range: 5 }]);
    assert.equal(more.clustered.list.length, 3);
    again.dispose();
    assert.deepEqual(
      more.clustered.list.map((light) => light.position),
      [
        [0, 1, 0],
        [0, 3, 0],
      ],
    );
    more.dispose();
    lights.dispose();
  } finally {
    stage.dispose();
  }
});
