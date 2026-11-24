// KB-SHOT-SETTINGS1: renderOnce passed a shot's settings and the page's `shot.page.settings` hook into the page, but the
// frame step never called the hook, so a shot's per-package settings (docs/shots.md) never reached the scene. The step
// is now the exported shotStep, run here against a stand-in `globalThis.__margoShot`.
import test from 'node:test';
import assert from 'node:assert/strict';
import { shotStep } from '../tools/shot/render.mjs';

function standIn(calls) {
  const page = {
    engine: { camera: {} },
    settings: async (values, at) => calls.push(['settings', values, at]),
    apply: async (state, at) => calls.push(['apply', state, at]),
  };
  return {
    queued: 1,
    get: (name) =>
      name
        .split('.')
        .slice(1)
        .reduce((o, k) => o?.[k], page),
    frame: () => {
      calls.push(['frame']);
      return true;
    },
    settle: async () => {},
  };
}

const args = (sub) => ({
  subs: [sub],
  kept: null,
  engine: 'page.engine',
  apply: 'page.apply',
  settingsHook: 'page.settings',
  warmup: false,
});

test("shotStep writes the shot's settings through the page's settings hook before page.apply, every sub-frame", async () => {
  const calls = [];
  globalThis.__margoShot = standIn(calls);
  try {
    const camera = { position: [0, 2, 5], target: [0, 0, 0], fov: 40, up: [0, 1, 0] };
    await shotStep(
      args({ time: { ms: 16, seconds: 0.5 }, camera, state: { t: 1 }, settings: { weather: { rain: 0.4 } } }),
    );
    assert.deepEqual(
      calls.map((c) => c[0]),
      ['settings', 'apply', 'frame'],
    );
    assert.deepEqual(calls[0][1], { weather: { rain: 0.4 } });
    assert.equal(calls[0][2].time, 0.5);
  } finally {
    delete globalThis.__margoShot;
  }
});

test('shotStep calls no settings hook for a shot without settings, and names a hook that is not a page function', async () => {
  const calls = [];
  globalThis.__margoShot = standIn(calls);
  try {
    await shotStep(args({ time: { ms: 16, seconds: 0 }, camera: null, state: { t: 0 }, settings: null }));
    assert.deepEqual(
      calls.map((c) => c[0]),
      ['apply', 'frame'],
    );
    await assert.rejects(
      shotStep({
        ...args({ time: { ms: 16, seconds: 0 }, camera: null, state: null, settings: {} }),
        settingsHook: 'page.nope',
      }),
      /page\.nope is not a function in the page/,
    );
  } finally {
    delete globalThis.__margoShot;
  }
});
