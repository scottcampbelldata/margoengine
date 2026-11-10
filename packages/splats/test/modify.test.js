import test from 'node:test';
import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { SplatModifier, splatModifierShaders } from '../dist/modify.js';
import { Splats } from '../dist/index.js';
const data = () => ({
  positions: new Float32Array([1, 2, 3]),
  covariances: new Float32Array([1, 0, 0, 1, 0, 1]),
  colors: new Float32Array([0.2, 0.4, 0.6, 1.5625]),
});
test('modifier validates hooks, canonical snapshots, parameters and cancellation without side effects', async () => {
  const cloud = new Splats(data());
  await assert.rejects(SplatModifier.create({}), TypeError);
  await assert.rejects(SplatModifier.create(cloud, { color: 42 }), TypeError);
  await assert.rejects(SplatModifier.create(cloud, { position: '' }), TypeError);
  await assert.rejects(SplatModifier.create(cloud, { parameters: new Float32Array(65) }), RangeError);
  await assert.rejects(SplatModifier.create(cloud, { parameters: [NaN] }), RangeError);
  await assert.rejects(SplatModifier.create(cloud, { parameters: [1e100] }), RangeError);
  await assert.rejects(SplatModifier.create(cloud, { signal: AbortSignal.abort(new Error('cancel')) }), /cancel/);
  const parent = new AbortController(),
    m = await SplatModifier.create(cloud, { parameters: [1, 2, 3], signal: parent.signal });
  assert.equal(m.time, 0);
  assert.equal(m.playing, true);
  assert.equal(m.speed, 1);
  assert.equal(m.enabled, true);
  assert.deepEqual([...m.parameters.slice(0, 5)], [1, 2, 3, 0, 0]);
  assert.throws(() => m.setup({}), { code: 'unsupported' });
  assert.throws(() => m.setRest({ ...data(), positions: new Float32Array(6) }), RangeError);
  assert.equal(m.setRest(data()), m);
  parent.abort();
  assert.equal(m.disposed, true);
  m.dispose();
  assert.throws(() => m.setRest(data()), { code: 'disposed' });
  assert.throws(() => m.setup({ gpu: {} }), { code: 'disposed' });
});
test('creation aborts a pending canonical read immediately and removes the abort listener', async () => {
  const abort = new AbortController();
  let complete;
  const pending = SplatModifier.create(
    { count: 1, read: () => new Promise((r) => (complete = r)) },
    { signal: abort.signal },
  );
  abort.abort(new Error('pending cancelled'));
  await assert.rejects(pending, /pending cancelled/);
  complete(data());
  const other = await SplatModifier.create(new Splats(data()));
  other[Symbol.dispose]();
  assert.equal(other.disposed, true);
  const during = new AbortController();
  await assert.rejects(
    SplatModifier.create(
      {
        count: 1,
        read() {
          during.abort(new Error('synchronous abort'));
          return new Promise(() => {});
        },
      },
      { signal: during.signal },
    ),
    /synchronous abort/,
  );
  assert.equal(
    getEventListeners(during.signal, 'abort').length,
    0,
    'an abort during read initialization leaves no listener',
  );
});
test('hooks are separate from immutable canonical input and evaluated SH, and pass ordering brackets projection', async () => {
  const shaders = splatModifierShaders({
    position: 'return position + vec3f(sin(time),0,0);',
    opacity: 'return opacity * u.parameters[0].x;',
    color: 'return color * 0.5;',
  });
  assert.match(shaders.position, /rest=canonical\[index\]/);
  assert.match(shaders.position, /modifyOpacity\(index,result.xyz,rest.w\)/);
  assert.match(shaders.color, /original=evaluated\[index\]/);
  assert.match(shaders.color, /original.a/);
  const m = await SplatModifier.create(new Splats(data())),
    passes = [];
  m.registerPasses({ add: (p) => passes.push(p) });
  assert.deepEqual(
    passes.map((p) => p.order),
    [-7.25, -6.95],
  );
  m.dispose();
});
