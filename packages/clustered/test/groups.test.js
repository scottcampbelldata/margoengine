// LightGroups (@margoengine/clustered/groups): several owners share one Clustered list. Before it, animateFlicker and
// every setLights replaced the whole list, so a fire and a user's own lights could not both own lights.
import test from 'node:test';
import assert from 'node:assert/strict';
import { LightGroups } from '../dist/groups.js';
import { Clustered } from '../dist/index.js';
import { animateFlicker } from '../dist/flicker.js';
import { lineLights } from '../dist/line.js';

const at = (x, extra = {}) => ({ position: [x, 1, 0], range: 5, ...extra });
/** A fake engine: one frame runs the frame callbacks, then the plugins' onPreUpdate, as the engine's frame loop does. */
function fakeEngine() {
  const callbacks = new Set(),
    plugins = [];
  return {
    onFrame(callback) {
      callbacks.add(callback);
      return () => callbacks.delete(callback);
    },
    use(plugin) {
      plugins.push(plugin);
      plugin.setup(this);
    },
    sceneOf(plugin) {
      return plugins.includes(plugin) ? { removePlugin: () => plugins.splice(plugins.indexOf(plugin), 1) } : undefined;
    },
    frame(delta = 1 / 60) {
      for (const callback of callbacks) callback(this, delta);
      for (const plugin of plugins) plugin.onPreUpdate?.(delta);
    },
    callbacks,
  };
}
/** A Clustered that counts its setLights calls. */
function counted() {
  const clustered = new Clustered(),
    set = clustered.setLights.bind(clustered);
  clustered.calls = 0;
  clustered.setLights = (lights) => (clustered.calls++, set(lights));
  return clustered;
}

test('LightGroups: each group replaces only its own lights, in the order the groups were made', () => {
  const clustered = counted(),
    groups = new LightGroups(clustered),
    fire = groups.group('fire'),
    mine = groups.group('mine');
  fire.setLights([at(0), at(1)]);
  mine.setLights([at(5)]);
  assert.deepEqual(
    clustered.list.map((l) => l.position[0]),
    [0, 1, 5],
  );
  fire.setLights([at(2)]);
  assert.deepEqual(
    clustered.list.map((l) => l.position[0]),
    [2, 5],
    "the fire's change keeps my light",
  );
  assert.equal(groups.group('fire'), fire, 'one group per name');
  assert.deepEqual(groups.names, ['fire', 'mine']);
  assert.deepEqual(
    groups.list.map((l) => l.position[0]),
    [2, 5],
  );
  assert.ok(Object.isFrozen(fire.lights));
  fire.dispose();
  assert.deepEqual(
    clustered.list.map((l) => l.position[0]),
    [5],
    'a disposed group takes its lights with it',
  );
  assert.deepEqual(groups.names, ['mine']);
  assert.throws(() => fire.setLights([]), { name: 'MargoError', code: 'disposed' });
  assert.notEqual(groups.group('fire'), fire, 'the name can be used again');
  assert.throws(() => groups.group(''), TypeError);
  assert.throws(() => mine.setLights('lights'), TypeError);
});

test('LightGroups: invalid lights throw at the call and leave every group and the list as they were', () => {
  const clustered = new Clustered(),
    groups = new LightGroups(clustered),
    a = groups.group('a').setLights([at(0)]),
    b = groups.group('b').setLights([at(1)]);
  assert.throws(() => b.setLights([{ position: [0, 0, 0], range: -1 }]), RangeError);
  assert.deepEqual(
    b.lights.map((l) => l.position[0]),
    [1],
  );
  assert.deepEqual(
    clustered.list.map((l) => l.position[0]),
    [0, 1],
  );
  a.setLights([at(3)]);
  assert.deepEqual(
    clustered.list.map((l) => l.position[0]),
    [3, 1],
  );
});

test('LightGroups attached: changes made during a frame go in one setLights before it renders', () => {
  const engine = fakeEngine(),
    clustered = counted(),
    groups = LightGroups.attach(engine, clustered);
  assert.equal(groups.owner, engine);
  const fire = groups.group('fire'),
    lamp = groups.group('lamp'),
    user = groups.group('user').setLights([at(9)]);
  // Two flickering owners and a steady one: before groups, each animateFlicker replaced the whole list.
  const stopFire = animateFlicker(
      engine,
      fire,
      lineLights({ start: [0, 1, 0], end: [1, 1, 0], range: 5, intensity: 4, flicker: { curve: 'fire' } }),
    ),
    stopLamp = animateFlicker(engine, lamp, [at(4, { intensity: 2, flicker: { curve: 'candle' } })]);
  assert.equal(clustered.list.length, 4, 'fire (2), lamp and user all lit at once');
  const before = clustered.calls,
    seen = new Set();
  for (let i = 0; i < 10; i++) {
    engine.frame();
    seen.add(clustered.list[0].intensity);
    assert.equal(clustered.list[0].intensity, clustered.list[1].intensity, "the fire's points flicker as one");
  }
  assert.equal(clustered.calls - before, 10, 'one setLights a frame for both flickers');
  assert.equal(clustered.list.length, 4);
  assert.deepEqual(clustered.list[3].position, [9, 1, 0], 'the steady light stays');
  assert.ok(seen.size > 1, 'flickered intensities reached Clustered');
  // Outside a frame a change still goes through at once.
  user.setLights([at(8)]);
  assert.deepEqual(clustered.list[3].position, [8, 1, 0]);
  stopFire();
  stopLamp();
  assert.ok(Math.abs(clustered.list[0].intensity - 2) < 1e-12, 'stopping puts the steady intensities back');
  const callbacks = engine.callbacks.size;
  groups.dispose();
  assert.equal(engine.callbacks.size, callbacks - 1, 'dispose removes its frame callback');
  assert.equal(engine.sceneOf(groups), undefined, 'and leaves the scene it joined');
  assert.equal(clustered.list.length, 4, 'Clustered keeps the lights last sent');
  assert.throws(() => groups.group('x'), { name: 'MargoError', code: 'disposed' });
  groups.dispose();
});

test('LightGroups: a group changed in a frame that fails to apply goes back, and the error reaches the frame', () => {
  const engine = fakeEngine(),
    clustered = new Clustered(),
    groups = LightGroups.attach(engine, clustered),
    a = groups.group('a').setLights([at(0)]);
  engine.onFrame(() => a.setLights([{ position: [0, 0, 0], range: -1 }]));
  assert.throws(() => engine.frame(), RangeError);
  assert.deepEqual(
    a.lights.map((l) => l.position[0]),
    [0],
  );
  assert.deepEqual(
    clustered.list.map((l) => l.position[0]),
    [0],
  );
});

// KB-FLICKER-DISPOSE1: closing the Cabin Hearth page disposed the Clustered (with the engine) before the page's own
// plugin stopped its flicker, and the stop's restoring setLights threw "Expected at most 1,024 lights" on every close.
test('animateFlicker: stopping after its Clustered or its group was disposed sets nothing and throws nothing', () => {
  const engine = fakeEngine(),
    clustered = counted(),
    flame = [at(0, { intensity: 4, flicker: { curve: 'fire' } })];
  const stop = animateFlicker(engine, clustered, flame);
  engine.frame();
  const calls = clustered.calls;
  clustered.dispose();
  assert.equal(clustered.isDisposed, true);
  engine.frame();
  stop();
  assert.equal(clustered.calls, calls, 'no setLights on a disposed Clustered, in a frame or at stop');
  assert.equal(engine.callbacks.size, 0);
  // A group: disposed by itself, or with its LightGroups.
  for (const end of ['group', 'groups']) {
    const lights = counted(),
      groups = LightGroups.attach(engine, lights),
      group = groups.group('fire'),
      halt = animateFlicker(engine, group, flame);
    engine.frame();
    assert.equal(group.isDisposed, false);
    if (end === 'group') group.dispose();
    else groups.dispose();
    assert.equal(group.isDisposed, true);
    assert.equal(groups.isDisposed, end === 'groups');
    const before = lights.calls;
    engine.frame();
    halt();
    assert.equal(lights.calls, before, `${end}: nothing set after disposal`);
    assert.deepEqual(groups.names, []);
    if (end === 'group') groups.dispose();
  }
});

test('LightGroups: a group disposed after its Clustered goes quietly, in or out of a frame (KB-LIGHTGROUP-ORDER1)', () => {
  // A scene disposes its Clustered before the fire or flame that owns a group in it; the group's dispose then sent the
  // list without it to the disposed Clustered and threw 'disposed'.
  for (const inFrame of [false, true]) {
    const engine = fakeEngine(),
      clustered = new Clustered(),
      groups = LightGroups.attach(engine, clustered),
      fire = groups.group('fire'),
      lamp = groups.group('lamp');
    fire.setLights([at(0)]);
    lamp.setLights([at(1)]);
    clustered.dispose();
    assert.equal(fire.isDisposed, true, 'a group of a disposed Clustered reads disposed');
    if (inFrame) engine.callbacks.forEach((callback) => callback(engine, 1 / 60));
    assert.doesNotThrow(() => fire.dispose());
    assert.doesNotThrow(() => engine.frame());
    assert.deepEqual(groups.names, ['lamp']);
    assert.throws(
      () => lamp.setLights([at(2)]),
      { code: 'disposed' },
      'setting lights of a disposed Clustered still throws',
    );
    assert.doesNotThrow(() => lamp.dispose());
    assert.deepEqual(groups.names, []);
    groups.dispose();
  }
});
