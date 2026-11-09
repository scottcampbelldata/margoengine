import test from 'node:test';
import assert from 'node:assert/strict';
import { Painterly } from '../dist/paint.js';
import { PostStack } from '@margoengine/post/stack';
import { harness, written } from '../../post/test/support.js';

test('Painterly validates hostile options at construction and every draw, before GPU writes', () => {
  const bad = [
    null,
    [],
    1,
    'sketch',
    ...[NaN, Infinity, -1, 0, 1.1, 9, 1e300, '3', null].map((radius) => ({ radius })),
    ...[NaN, Infinity, -1, 1.01, '0.5', null].map((strength) => ({ strength })),
    ...['oil', '', null, 1].map((mode) => ({ mode })),
    ...[0, 'false', null].map((enabled) => ({ enabled })),
  ];
  for (const options of bad)
    assert.throws(
      () => new Painterly(options),
      (error) =>
        error instanceof RangeError &&
        /; pass /.test(error.message) &&
        error.message.endsWith('https://margoengine.com/errors#arguments'),
      JSON.stringify(options),
    );
  for (const radius of [1, 8])
    for (const strength of [0, 1, Number.MIN_VALUE]) assert.doesNotThrow(() => new Painterly({ radius, strength }));
  const h = harness(),
    options = {},
    effect = Painterly.attach(h.engine, options);
  h.frame();
  for (const value of [{ radius: NaN }, { mode: 'bad' }, { strength: '1' }, { enabled: 0 }]) {
    Object.assign(options, value);
    const calls = h.gpu.record(() => assert.throws(() => h.frame(), RangeError));
    assert.equal(calls.filter(([kind]) => kind === 'writeBuffer').length, 0);
    for (const key of Object.keys(value)) delete options[key];
  }
  assert.throws(() => {
    effect.enabled = 1;
  }, RangeError);
  effect.dispose();
});

test('Painterly stack modes, live controls, resize, device restoration and terminal disposal', async () => {
  for (const samples of [1, 4]) {
    const h = harness({ samples }),
      options = {},
      effect = Painterly.attach(h.engine, options);
    for (const [mode, index] of [
      ['kuwahara', 0],
      ['watercolour', 1],
      ['sketch', 2],
    ]) {
      Object.assign(options, { mode, radius: 8, strength: 0.25 });
      const log = h.gpu.record(() => h.frame()),
        u = written(log, 48);
      assert.deepEqual(
        [...u.slice(0, 4)].map((_, i) => new Int32Array(u.buffer, u.byteOffset, 4)[i]),
        [0, 0, h.view.c.width, h.view.c.height],
      );
      assert.deepEqual([...new Uint32Array(u.buffer, u.byteOffset + 16, 4)].slice(0, 3), [8, index, 1]);
      assert.equal(u[8], 0.25);
    }
    effect.enabled = false;
    assert.equal(effect.enabled, false);
    const log = h.gpu.record(() => h.frame());
    const u = written(log, 48);
    assert.equal(new Uint32Array(u.buffer, u.byteOffset + 16, 4)[2], 0);
    h.view.state.width = 17;
    h.view.state.height = 9;
    h.frame();
    h.engine.restore();
    h.frame();
    effect.dispose();
    effect[Symbol.dispose]();
    await null;
    assert.deepEqual(h.live(), []);
    assert.equal(h.plugins.size, 0);
    for (const run of [
      () => effect.setup(h.engine),
      () => effect.onDeviceRestored(h.engine),
      () => effect.joinStack(),
      () => effect.draw(h.view.c, {}, {}),
    ])
      assert.throws(run, { code: 'disposed' });
  }
});

test('Painterly refuses unsupported and invalid attachment with coded linked errors', () => {
  const h = harness(),
    p = new Painterly();
  assert.throws(
    () => Painterly.attach({ gpu: undefined }),
    (error) => error.code === 'unsupported' && /https:/.test(error.message),
  );
  assert.throws(
    () => p.setup({}),
    (error) => error.code === 'unsupported' && /https:/.test(error.message),
  );
  assert.throws(() => p.setup(h.engine), { code: 'state' });
  const stack = PostStack.attach(h.engine, [p]);
  assert.throws(() => p.setup(h.engine), { code: 'attached' });
  assert.throws(
    () => p.setup(h.engine),
    (error) => error.code === 'attached' && error.message.endsWith('#state'),
  );
  assert.throws(() => new PostStack([p]), { code: 'attached' });
  stack.dispose();
});

test('Painterly gives views separate uniforms and prunes removed views', () => {
  const h = harness(),
    p = new Painterly();
  const stage = p.joinStack();
  p.setup(h.engine);
  const c = h.view.c,
    output = { view: {}, format: 'rgba8unorm', multisample: { count: 1 }, hdr: false };
  const buffers = [];
  for (const [id, viewport] of [
    [1, [0, 0, 8, 8]],
    [2, [8, 0, 8, 8]],
  ]) {
    c.view = { id, index: id - 1, viewport };
    const calls = h.gpu.record(() => stage.render(c, {}, output));
    buffers.push(calls.find(([kind]) => kind === 'writeBuffer')[1]);
  }
  assert.notDeepEqual(buffers[0], buffers[1]);
  assert.equal(h.live().length, 2);
  p.onPreUpdate(1);
  stage.render(c, {}, output);
  p.onPreUpdate(1);
  assert.equal(h.live().length, 1);
  p.dispose();
  assert.equal(h.live().length, 0);
});
