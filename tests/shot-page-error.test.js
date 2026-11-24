// KB-SHOT-FAILFAST1: a shot page whose module threw (for example on a model the loader refused) never asks for a frame,
// and tools/shot waited out its 180 s timeout before naming the error. A wait on the page now ends at the page's first
// error (watchPage, untilQueued), for renders and for the measure (tools/shot/measure.mjs), which also hands the film
// pipeline the camera's clip planes and the ground under every kept frame's camera. Playwright is a stand-in here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { renderOnce, shotStep } from '../tools/shot/render.mjs';
import { measureOpen } from '../tools/shot/measure.mjs';
import { parseShot } from '../tools/shot/shot-file.mjs';

const shotFile = (page, extra = {}) =>
  parseShot({
    format: 'margo-cutscene',
    version: 1,
    duration: 1,
    tracks: [
      {
        type: 'camera',
        id: 'camera',
        path: 'linear',
        keys: [
          { time: 0, position: [10, 2, 0], target: [0, 0, 0], fov: 40 },
          { time: 1, position: [20, 2, 0], target: [0, 0, 0], fov: 40 },
        ],
      },
    ],
    shot: {
      format: 'margo-shot',
      version: 1,
      id: 'page-error',
      seconds: 1,
      fps: 4,
      size: [64, 36],
      warmup: 2,
      probes: { mid: 0.5 },
      page: { path: 'tools/shot/test/scene.html', engine: 'shotScene.engine', ...page },
      ...extra,
    },
  });

// A stand-in page: `asks` says whether the page ever asks for a frame, `throws` is the error its module throws on load,
// and page functions run here against a stand-in driver, as the browser would run them.
function standIn({ throws = null, asks = true, driver = {} } = {}) {
  const handlers = {},
    fire = (name, value) => (handlers[name] ?? []).forEach((fn) => fn(value));
  const page = {
    on: (name, fn) => (handlers[name] ??= []).push(fn),
    off: (name, fn) => (handlers[name] = (handlers[name] ?? []).filter((f) => f !== fn)),
    url: () => 'http://127.0.0.1:5193/tools/shot/blank.html',
    async goto(url) {
      fire('requestfinished', { url: () => url });
      fire('requestfinished', { url: () => 'http://127.0.0.1:5193/asset-library/fauld/a%20b.glb' });
      fire('requestfinished', { url: () => 'https://elsewhere.test/x.js' });
      if (throws) fire('pageerror', new Error(throws));
    },
    waitForFunction: () => (asks ? Promise.resolve(true) : new Promise(() => {})),
    async evaluate(fn, arg) {
      if (fn === shotStep) return {};
      if (typeof arg === 'string') return [96, 54];
      globalThis.__margoShot = { get: (name) => name.split('.').reduce((o, k) => o?.[k], driver) };
      try {
        return fn(arg);
      } finally {
        delete globalThis.__margoShot;
      }
    },
    async $() {
      return {};
    },
  };
  return { page, server: { config: { server: { port: 5193 } } }, hardware: { webgpu: { vendor: 'test' } } };
}

const within = async (ms, promise) => {
  const started = Date.now();
  await promise;
  assert.ok(Date.now() - started < ms, `took ${Date.now() - started} ms, not under ${ms} ms`);
};

test('a render fails at once with the page error when the page throws and never asks for a frame', {
  timeout: 5000,
}, async () => {
  const browser = standIn({ throws: 'GLTFLoader refused tp_baulk.glb: no POSITION', asks: false });
  await within(
    1000,
    assert.rejects(
      renderOnce(browser, shotFile(), { out: 'unused', label: 'a', write: false }),
      /the page reported an error: GLTFLoader refused tp_baulk\.glb: no POSITION/,
    ),
  );
});

test('a measure fails at once with the page error, the same way', { timeout: 5000 }, async () => {
  const browser = standIn({ throws: 'fauld-crater: no DEM', asks: false });
  await within(
    1000,
    assert.rejects(measureOpen(browser, shotFile()), /the page reported an error: fauld-crater: no DEM/),
  );
});

test("a measure gives the camera's clip planes and the ground under every kept frame's camera and target", async () => {
  const driver = {
    shotScene: { engine: { camera: { near: 0.5, far: 40000 } } },
    page: { height: (x, z) => x * 0.5 + z },
  };
  const m = await measureOpen(standIn({ driver }), shotFile({ ground: 'page.height' }));
  assert.equal(m.format, 'margo-shot-measure');
  assert.equal(m.heights, 'ground');
  assert.equal(m.near, 0.5);
  assert.equal(m.far, 40000);
  assert.equal(m.cameras.length, 4);
  assert.deepEqual(m.cameras[0], { frame: 0, ground: [5, 0] }, 'camera at x 10 over ground 5, target at x 0 over 0');
  assert.ok(m.cameras.every((c) => c.ground[0] >= 5 && c.ground[0] <= 10 && c.ground[1] === 0));
  assert.deepEqual(m.errors, []);
  assert.equal(m.subjectGround, null, 'the shot names no subject');
  const s = await measureOpen(
    standIn({ driver }),
    shotFile({ ground: 'page.height' }, { subject: { target: [4, 1, 2], size: 2 } }),
  );
  assert.equal(s.subjectGround, 4, 'the ground under the subject at x 4, z 2');
});

test('a shot without page.ground measures world heights, and a page ground that is not a function fails', async () => {
  const driver = { shotScene: { engine: { camera: { near: 0.1, far: 1000 } } } };
  const m = await measureOpen(standIn({ driver }), shotFile());
  assert.equal(m.heights, 'world');
  assert.ok(m.cameras.every((c) => c.ground === null));
  await assert.rejects(
    measureOpen(standIn({ driver }), shotFile({ ground: 'page.height' })),
    /page\.height is not a function/,
  );
});

test('a render names every file the page loaded from its own origin, and nothing from elsewhere', async () => {
  const driver = { shotScene: { engine: { camera: {} } } };
  // A render with no frame wanted past the warm-up: `only` names no kept frame, so the loop draws nothing.
  const got = await renderOnce(standIn({ driver }), shotFile(), {
    out: 'unused',
    label: 'a',
    write: false,
    only: new Set([-1]),
  });
  assert.deepEqual(got.loaded, ['/asset-library/fauld/a b.glb', '/tools/shot/test/scene.html']);
});
