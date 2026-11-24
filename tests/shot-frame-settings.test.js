// KB-SHOT-SETTINGS2: renderOnce wrote a shot's settings (docs/shots.md, Scene settings per shot) only with the warm-up,
// so a keyed row held its first value for the whole shot. Each frame now writes the keyed rows at its own time
// (shotKeyedValuesAt); a held row goes in once, with the warm-up. The scene settings tables and the page are stand-ins.
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';

const real = await import('../tools/shot/scene-settings.mjs');
mock.module('../tools/shot/scene-settings.mjs', {
  namedExports: {
    ...real,
    checkShotFileSettings: async () => 'tables',
    shotValuesAt: (shot, tables, seconds) => ({ all: { at: seconds } }),
    shotKeyedValuesAt: (shot, tables, seconds) => ({ keyed: { at: seconds } }),
  },
});
const { renderOnce, shotStep } = await import('../tools/shot/render.mjs');
const { parseShot } = await import('../tools/shot/shot-file.mjs');

test('every frame of a render writes the keyed settings at its own time; the warm-up writes them all once', async () => {
  const steps = [];
  const page = {
    on() {},
    off() {},
    url: () => 'http://127.0.0.1:5193/tools/shot/blank.html',
    async goto() {},
    waitForFunction: async () => true,
    async evaluate(fn, arg) {
      if (fn === shotStep) {
        steps.push(arg);
        return { sha256: 'x', size: [16, 16] };
      }
      return typeof arg === 'string' ? [24, 24] : null;
    },
    async $() {
      return {};
    },
  };
  const file = parseShot({
    format: 'margo-cutscene',
    version: 1,
    duration: 1,
    tracks: [],
    shot: {
      format: 'margo-shot',
      version: 1,
      id: 'keyed',
      seconds: 1,
      fps: 2,
      size: [16, 16],
      warmup: 1,
      page: { path: 'tools/shot/test/scene.html', engine: 'shotScene.engine' },
    },
  });
  await renderOnce({ page, server: { config: { server: { port: 5193 } } }, hardware: {} }, file, {
    out: 'unused',
    label: 'a',
    write: false,
  });
  const warm = steps.filter((s) => s.warmup),
    kept = steps.filter((s) => !s.warmup && s.kept !== null);
  assert.deepEqual(
    warm.map((s) => s.subs[0].settings),
    [{ all: { at: 0 } }],
  );
  assert.equal(kept.length, 2);
  assert.ok(
    kept.every((s) => s.subs.every((sub) => sub.settings?.keyed?.at === sub.time.seconds)),
    'each sub-frame writes the keyed rows at its own time',
  );
});

test('shotKeyedValuesAt keeps only the keyed rows, at the time asked', async () => {
  const { TONEMAP_SETTINGS } = await import('@margoengine/tonemap/settings');
  const shot = {
    from: 0,
    settings: {
      tonemap: {
        'tonemap.exposure': {
          keys: [
            { time: 0, value: -1 },
            { time: 2, value: 1 },
          ],
        },
      },
    },
  };
  const tables = { tonemap: TONEMAP_SETTINGS };
  assert.deepEqual(real.shotKeyedValuesAt(shot, tables, 1), { tonemap: { 'tonemap.exposure': 0 } });
  assert.equal(real.shotKeyedValuesAt({ from: 0 }, null, 1), null);
});
