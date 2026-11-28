// Pay only for what you import: cutscene.ts once took @margoengine/tween as a namespace and read easings from it by
// name, so a bundler kept every export of the tween package in any app that imported one export of this one (an app
// importing BASIC_EASINGS downloaded 14,854 B, minified; it needs 44 B). The easings are now imported by name, and the
// last cases hold that list to the tween package's own.
import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'vite';
import * as tween from '@margoengine/tween';
import { BASIC_EASINGS, Cutscene, EASING_NAMES } from '../dist/index.js';

// A message only the named tween export throws, and the constant only the back easings use.
const TWEEN = 'Tween needs a finite numeric target property';
const TIMELINE = 'Timeline times must be finite';
const SPRING = 'Spring value, target and velocity must stay finite';
const EASING = '1.70158';

async function bundled(code) {
  const out = await build({
    configFile: false,
    publicDir: false,
    logLevel: 'silent',
    build: { write: false, target: 'es2022', minify: true, rollupOptions: { input: 'app' } },
    plugins: [
      { name: 'app', resolveId: (id) => (id === 'app' ? id : null), load: (id) => (id === 'app' ? code : null) },
    ],
  });
  // Every chunk counts, lazy ones included: the cost is what the app downloads at all.
  return out.output
    .filter((file) => file.type === 'chunk')
    .map((chunk) => chunk.code)
    .join('\n');
}

const app = (name, from = '@margoengine/cutscene') => `import { ${name} } from '${from}';\nconsole.log(${name});`;

test('importing one export that needs no easing bundles none of the tween package', { timeout: 180000 }, async () => {
  for (const name of ['BASIC_EASINGS', 'parseCutscene']) {
    const code = await bundled(app(name));
    for (const marker of [TWEEN, TIMELINE, SPRING, EASING])
      assert.ok(!code.includes(marker), `${name} bundled: ${marker}`);
  }
});

test('playing a cutscene bundles the easings and no tween, timeline or spring', { timeout: 180000 }, async () => {
  const code = await bundled(app('Cutscene'));
  assert.ok(code.includes(EASING), 'the easings are in the build, so the marker is live');
  for (const marker of [TWEEN, TIMELINE, SPRING]) assert.ok(!code.includes(marker), `Cutscene bundled: ${marker}`);
});

test('importing Tween, Timeline and Spring bundles their messages, so those markers are live', {
  timeout: 180000,
}, async () => {
  const code = await bundled(app('Tween, Timeline, Spring', '@margoengine/tween'));
  for (const marker of [TWEEN, TIMELINE, SPRING]) assert.ok(code.includes(marker), `missing marker: ${marker}`);
});

const tweenEasings = Object.keys(tween).filter((name) => /^ease[A-Z]/.test(name) && typeof tween[name] === 'function');

test('the easing names are the basic ones and every ease* easing of the tween package', () => {
  assert.deepEqual([...EASING_NAMES], [...BASIC_EASINGS, ...tweenEasings]);
});

test('each ease* name evaluates with the tween easing of that name', () => {
  for (const ease of tweenEasings) {
    const cut = new Cutscene({
      format: 'margo-cutscene',
      version: 1,
      duration: 10,
      tracks: [
        {
          type: 'property',
          id: 'p',
          target: 'light',
          property: 'intensity',
          keys: [
            { time: 0, value: 0 },
            { time: 10, value: 10, ease },
          ],
        },
      ],
    });
    for (const t of [1.3, 5.5, 8.7]) {
      const value = cut.evaluate(t).properties.light.intensity;
      assert.ok(Math.abs(value - 10 * tween[ease](t / 10)) < 1e-9, `${ease} at ${t}: ${value}`);
    }
  }
});
