import test from 'node:test';
import assert from 'node:assert/strict';
import { VFX } from '../dist/index.js';
import { serializeEffect, parseEffect, createEffect, loadEffect, VFX_JSON_VERSION } from '../dist/json.js';
const options = {
  capacity: 32,
  rate: 0,
  position: [-0, 1, 2],
  texture: {
    width: 2,
    height: 2,
    data: new Uint8Array([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255]),
  },
  emitter: {
    shape: 'mesh',
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    indices: new Uint16Array([0, 1, 2]),
  },
  space: {
    mode: 'local',
    transform: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
    ratePerDistance: 2,
  },
  overLife: { size: [1, 3], spin: [0, 4], speed: [0, 2], velocityLimit: 3 },
  schedule: {
    prewarm: 0.25,
    step: 0.125,
    seed: 17,
    bursts: [{ time: 0, count: 3, cycles: 2, interval: 0.125, probability: 0.5 }],
  },
};
test('versioned JSON preserves typed assets, negative zero, all new authoring features and fog', () => {
  class Fog {
    color = '#8090a0';
    near = 2;
    far = 20;
    density = 0;
    height = 1;
    enabled = true;
  }
  const effect = new VFX(options).setFog(new Fog()),
    text = serializeEffect(effect),
    preset = parseEffect(text),
    loaded = createEffect(text);
  assert.equal(VFX_JSON_VERSION, 1);
  assert.deepEqual(preset.options, options);
  assert.ok(Object.is(preset.options.position[0], -0));
  assert.ok(preset.options.texture.data instanceof Uint8Array);
  assert.ok(preset.options.emitter.indices instanceof Uint16Array);
  assert.ok(preset.options.space.transform instanceof Float32Array);
  assert.equal(preset.fog.color, '#8090a0');
  assert.equal(serializeEffect(preset), text);
  assert.equal(serializeEffect(loaded), text);
  loaded.dispose();
  effect.dispose();
});
test('external functions and resources require explicit stable bindings', () => {
  const depth = () => undefined,
    input = { capacity: 4, softness: 0.1, depth };
  assert.throws(
    () => serializeEffect(input),
    (e) => e.code === 'unsupported' && /reference/.test(e.message),
  );
  const text = serializeEffect(input, { references: new Map([[depth, 'scene-depth']]) });
  assert.throws(
    () => parseEffect(text),
    (e) => e.code === 'state',
  );
  assert.equal(parseEffect(text, { bindings: new Map([['scene-depth', depth]]) }).options.depth, depth);
  assert.throws(
    () =>
      serializeEffect(input, {
        references: new Map([
          [depth, 'x'],
          [{}, 'x'],
        ]),
      }),
    /unique/,
  );
});
test('invalid versions, unsupported settings, malformed types and pollution keys reject without mutation', () => {
  const text = serializeEffect(options),
    change = (fn) => {
      const doc = JSON.parse(text);
      fn(doc);
      return JSON.stringify(doc);
    };
  assert.throws(
    () => parseEffect(change((d) => (d.version = 2))),
    (e) => e.code === 'version' && /https:/.test(e.message),
  );
  assert.throws(() => parseEffect(change((d) => (d.options.unknown = 1))), /unknown option/);
  assert.throws(() => parseEffect(change((d) => (d.options.texture.data.data[0] = -1))), /out of range/);
  assert.throws(() => parseEffect(change((d) => (d.options.emitter.positions.data[0] = 0.1))), /precision/);
  assert.throws(
    () => parseEffect('{"format":"margo-vfx","version":1,"options":{"__proto__":{"polluted":true}}}'),
    /reserved/,
  );
  assert.equal({}.polluted, undefined);
  assert.throws(() => parseEffect('{'), /syntax/);
  assert.throws(() => serializeEffect({ rate: NaN }), /finite/);
  const cycle = {};
  cycle.self = cycle;
  assert.throws(() => serializeEffect({ curves: cycle }), /cyclic/);
  let reads = 0;
  assert.throws(
    () =>
      serializeEffect({
        get rate() {
          reads++;
          return 1;
        },
      }),
    /accessor/,
  );
  assert.equal(reads, 0);
});
test('serialization budgets and URL loading retain cancellation and failure causes', async (t) => {
  assert.throws(() => serializeEffect(options, { maxChars: 5 }), /maxChars/);
  assert.throws(() => parseEffect(serializeEffect(options), { maxDepth: 1 }), /budget/);
  assert.throws(() => serializeEffect(options, { maxNodes: 2 }), /budget/);
  assert.throws(() => serializeEffect(options, { maxChars: Infinity }), /limits/);
  const uri = 'data:application/json,' + encodeURIComponent(serializeEffect(options)),
    effect = await loadEffect(uri);
  assert.equal(effect.options.capacity, 32);
  effect.dispose();
  const controller = new AbortController(),
    reason = new Error('cancel fixture');
  controller.abort(reason);
  await assert.rejects(loadEffect(uri, { signal: controller.signal }), (e) => e === reason);
  t.mock.method(globalThis, 'fetch', async () => new Response('', { status: 404 }));
  await assert.rejects(
    loadEffect('https://example.invalid/preset.json'),
    (e) => e.code === 'failed' && /404/.test(e.message),
  );
});
