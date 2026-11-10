import test from 'node:test';
import assert from 'node:assert/strict';
import { captureSceneState, restoreSceneState } from '../dist/scene-state.js';
const clone = (v) => structuredClone(v);
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
