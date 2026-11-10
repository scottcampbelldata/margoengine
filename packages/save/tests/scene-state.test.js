import test from 'node:test';
import assert from 'node:assert/strict';
import { captureSceneState, restoreSceneState } from '../dist/scene-state.js';
const clone = (v) => structuredClone(v);

test('shadow setting names stay own data properties without changing the bound prototype', () => {
  for (const target of [{ resolution: 512 }, Object.assign(Object.create(null), { resolution: 512 })]) {
    const prototype = Object.getPrototypeOf(target);
    const settings = JSON.parse(
      '{"__proto__":{"polluted":true},"constructor":{"value":1},"toString":false,"resolution":32}',
    );
    const state = { version: 1, animations: {}, lights: {}, shadows: { sun: settings } };
    restoreSceneState(state, { shadows: { sun: target } });
    assert.equal(Object.getPrototypeOf(target), prototype);
    assert.deepEqual(captureSceneState({ shadows: { sun: target } }), state);
    for (const key of Object.keys(settings)) {
      assert.deepEqual(Object.getOwnPropertyDescriptor(target, key), {
        value: settings[key],
        writable: true,
        enumerable: true,
        configurable: true,
      });
    }
    assert.equal(Object.hasOwn(target, 'polluted'), false);
    assert.equal(target.polluted, undefined);
  }
});

test('shadow rollback restores values and prototypes after a later settings allocation fails', () => {
  const sun = { resolution: 512 };
  const denied = Object.preventExtensions({});
  const bindings = { shadows: { sun, denied } };
  const before = captureSceneState(bindings);
  const state = clone(before);
  state.shadows.sun = JSON.parse('{"__proto__":{"polluted":true},"resolution":32}');
  state.shadows.denied = { resolution: 32 };
  assert.throws(() => restoreSceneState(state, bindings), TypeError);
  assert.equal(Object.getPrototypeOf(sun), Object.prototype);
  assert.equal(Object.getPrototypeOf(denied), Object.prototype);
  assert.deepEqual(captureSceneState(bindings), before);
});
test('point, spot, area, directional shadow objects and layered playback round trip detached', () => {
  let playback = {
    state: 'run',
    time: 2,
    layers: [{ clip: 'wave', weight: 0.25, time: 0.4, mask: [2] }],
    fade: { elapsed: 0.2, duration: 1 },
  };
  const player = {
    captureState: () => playback,
    restoreState: (s) => {
      playback = clone(s);
    },
  };
  const light = {
    list: [{ position: [1, 2, 3], range: 4, castShadow: true, shadow: { near: 0.2, far: 20, resolution: [128, 256] } }],
    setLights(v) {
      this.list = clone(v);
    },
  };
  const shadows = { resolution: 512, bounds: { min: [-1, -2, -3], max: [1, 2, 3] } };
  const bindings = { animations: { model: player }, lights: { local: light }, shadows: { sun: shadows } };
  const state = JSON.parse(JSON.stringify(captureSceneState(bindings)));
  playback.time = 90;
  light.list[0].shadow.near = 5;
  shadows.resolution = 16;
  restoreSceneState(state, bindings);
  assert.deepEqual(captureSceneState(bindings), state);
  state.lights.local[0].position[0] = 100;
  assert.equal(light.list[0].position[0], 1);
});
test('failed light restore rolls playback and settings back and missing bindings mutate nothing', () => {
  let value = { time: 1 };
  const animations = {
    model: {
      captureState: () => value,
      restoreState: (s) => {
        value = s;
      },
    },
  };
  const lights = {
    local: {
      list: [],
      setLights(v) {
        if (v.length) throw Error('bad light');
      },
    },
  };
  const before = captureSceneState({ animations, lights });
  const bad = clone(before);
  bad.animations.model.time = 10;
  bad.lights.local = [{}];
  assert.throws(() => restoreSceneState(bad, { animations, lights }), /bad light/);
  assert.deepEqual(captureSceneState({ animations, lights }), before);
  assert.throws(() => restoreSceneState(bad, { animations }), { code: 'state' });
  assert.deepEqual(value, { time: 1 });
});
