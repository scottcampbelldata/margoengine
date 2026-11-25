import test from 'node:test';
import assert from 'node:assert/strict';
import { Ramp, Grid, DepthView, TextureOverlay } from '@margoengine/post/overlays';
import { DepthTexture } from '@margoengine/post/depth';
import { harness, modules, written } from './support.js';
const near = (a, b) => a.forEach((v, i) => assert.ok(Math.abs(v - b[i]) < 1e-4, `${i}: ${v} != ${b[i]}`));
/** The uniforms of one recorded frame: 64 floats. */
const frame = (h) => {
  const log = h.gpu.record(() => h.frame());
  return { log, u: written(log, 256) };
};
const done = async (h, effect) => {
  effect.dispose();
  await null;
  assert.deepEqual(h.live(), []);
};
test('Ramp writes its gradient, blend, mask and live options, and releases after a restore', async () => {
  const h = harness(),
    effect = Ramp.attach(h.engine);
  let { u, log } = frame(h);
  const [w, ht] = [h.view.c.width, h.view.c.height];
  near([...u.slice(0, 3)], [1, 6, 0]);
  near([...u.slice(12, 21)], [0, ht / 2, w, ht / 2, 0, 0.5, 0.5, 0, 2]);
  near([...u.slice(24, 32)], [0, 0, 0, 1, 1, 1, 1, 1]);
  near([...u.slice(56, 58)], [0, 1]);
  assert.ok(modules(log).some((s) => s.includes('fn bias') && !s.includes('texture_depth_2d')));
  Object.assign(effect.options, {
    type: 'linear',
    angle: 90,
    invert: true,
    blend: 'multiply',
    opacity: 0.25,
    mask: 'luminance',
    maskRange: [1, 0],
    stops: [
      { at: 0, color: '#f00', alpha: 0.5 },
      { at: 0.5, color: '#00ff00' },
      { at: 1, color: '#0000ff' },
    ],
  });
  ({ u } = frame(h));
  near([...u.slice(0, 6)], [0.25, 3, 1, 0, 1, 0]);
  near([...u.slice(12, 16)], [w / 2, ht / 2 - w / 2, w / 2, ht / 2 + w / 2]);
  near([u[19], u[20]], [1, 3]);
  near([...u.slice(24, 28), ...u.slice(56, 59)], [1, 0, 0, 0.5, 0, 0.5, 1]);
  effect.options.type = 'radial';
  delete effect.options.angle;
  ({ u } = frame(h));
  near([...u.slice(12, 17)], [w / 2, ht / 2, w, ht / 2, 1]);
  effect.options.mask = 'depth';
  delete effect.options.maskRange;
  ({ u, log } = frame(h));
  near([u[2], u[4], u[5]], [2, h.view.c.camera.near, h.view.c.camera.far]);
  assert.ok(modules(log).some((s) => s.includes('texture_depth_2d')));
  effect.options.enabled = false;
  assert.equal(frame(h).u[0], 0);
  h.engine.restore();
  h.frame();
  await done(h, effect);
});
test('Grid writes cells, dots and rotation', async () => {
  const h = harness(),
    effect = Grid.attach(h.engine);
  near([frame(h).u[0], ...frame(h).u.slice(12, 24)], [0.5, 32, 32, 1, 0, 0.5, 0.5, 1, 0, 1, 1, 1, 0]);
  Object.assign(effect.options, {
    style: 'dots',
    cellSize: [8, 16],
    offset: [2, 3],
    angle: 90,
    color: '#000',
  });
  near([...frame(h).u.slice(12, 20)], [8, 16, 3, 1, 2.5, 3.5, 0, 1]);
  await done(h, effect);
});
test('DepthView reads the stack depth or a DepthTexture, linear or raw, and passes through until it exists', async () => {
  const h = harness(),
    effect = DepthView.attach(h.engine, { near: 2, far: 12, invert: true });
  const { u, log } = frame(h);
  near([u[0], ...u.slice(12, 16)], [1, 0, 2, 12, 1]);
  assert.ok(modules(log).some((s) => s.includes('fn stored')));
  const source = new DepthTexture();
  effect.options.depth = source;
  effect.options.mode = 'raw';
  assert.equal(frame(h).u[0], 0, 'an unattached DepthTexture has no texture yet');
  h.engine.use(source);
  h.frame();
  const ready = frame(h).u;
  near([ready[0], ready[12]], [1, 1]);
  source.dispose();
  await done(h, effect);
});
test('TextureOverlay fits, transforms and uploads an image once, and again after a restore', async () => {
  const h = harness(),
    bitmap = { width: 10, height: 20 },
    effect = TextureOverlay.attach(h.engine, { source: bitmap });
  const first = frame(h),
    [w, ht] = [h.view.c.width, h.view.c.height],
    cover = Math.max(w / 10, ht / 20);
  near([...first.u.slice(12, 20)], [w / 2, ht / 2, 10 * cover, 20 * cover, 1, 0, 0, 0]);
  assert.equal(first.log.filter((e) => e[0] === 'copyExternalImageToTexture').length, 1);
  assert.equal(frame(h).log.filter((e) => e[0] === 'copyExternalImageToTexture').length, 0);
  Object.assign(effect.options, {
    fit: 'none',
    scale: [-2, 3],
    offset: [0.5, 0],
    repeat: true,
  });
  near([...frame(h).u.slice(12, 19)], [w, ht / 2, -20, 60, 1, 0, 1]);
  effect.options.fit = 'fill';
  near([...frame(h).u.slice(14, 16)], [-2 * w, 3 * ht]);
  const fresh = h.lose();
  const again = fresh.record(() => h.frame());
  assert.equal(again.filter((e) => e[0] === 'copyExternalImageToTexture').length, 1);
  let supplied;
  effect.options.source = () => supplied;
  assert.equal(
    written(
      fresh.record(() => h.frame()),
      256,
    )[0],
    0,
  );
  supplied = h.engine.gpu.createTexture({
    size: [4, 4],
    format: 'rgba8unorm-srgb',
    usage: 0x4,
  });
  assert.equal(
    written(
      fresh.record(() => h.frame()),
      256,
    )[19],
    1,
  );
  supplied.destroy();
  await done(h, effect);
});
test('overlay effects reject bad settings at construction and live', () => {
  for (const make of [
    () => new Ramp({ opacity: 2 }),
    () => new Ramp({ blend: 'burn' }),
    () => new Ramp({ mask: 'alpha' }),
    () => new Ramp({ maskRange: [1, 1] }),
    () => new Ramp({ type: 'conic' }),
    () => new Ramp({ stops: [{ at: 0, color: '#000' }] }),
    () =>
      new Ramp({
        stops: [
          { at: 1, color: '#000' },
          { at: 0, color: '#fff' },
        ],
      }),
    () =>
      new Ramp({
        stops: [
          { at: 0, color: 'red' },
          { at: 1, color: '#fff' },
        ],
      }),
    () => new Ramp({ bias: 0 }),
    () => new Ramp({ gain: 1 }),
    () => new Ramp({ start: [0] }),
    () => new Grid({ cellSize: 1 }),
    () => new Grid({ lineWidth: 0 }),
    () => new Grid({ color: 'white' }),
    () => new Grid({ style: 'cross' }),
    () => new DepthView({ mode: 'log' }),
    () => new DepthView({ near: 4, far: 4 }),
    () => new TextureOverlay({ source: () => undefined, scale: 0 }),
    () => new TextureOverlay({ source: () => undefined, fit: 'tile' }),
  ])
    assert.throws(make, RangeError, String(make));
  for (const make of [
    () => new TextureOverlay({}),
    () => new TextureOverlay({ source: { width: 0, height: 0 } }),
    () => new DepthView({ depth: 3 }),
    () => new Grid({ enabled: 1 }),
  ])
    assert.throws(make, TypeError, String(make));
  const h = harness(),
    effect = Grid.attach(h.engine);
  effect.options.opacity = -1;
  assert.throws(() => h.frame(), RangeError);
  effect.dispose();
});
