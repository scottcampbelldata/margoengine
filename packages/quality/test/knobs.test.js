import test from 'node:test';
import assert from 'node:assert/strict';
import { renderTargetKnob, textureResolutionKnob, particleKnob, msaaKnob } from '../dist/knobs.js';
import { FeatureScaler } from '../dist/features.js';

function fixture() {
  const allocations = [],
    bindings = [];
  const texture = {
    width: 65,
    height: 33,
    dimension: '2d',
    depthOrArrayLayers: 1,
    sampleCount: 1,
    format: 'rgba8unorm',
    usage: 22,
    destroyed: false,
    destroy() {
      this.destroyed = true;
    },
  };
  const device = {
    createTexture(descriptor) {
      const made = { ...texture, width: descriptor.size[0], height: descriptor.size[1] };
      allocations.push(made);
      return made;
    },
  };
  const options = { device, texture, bind: (value) => bindings.push(value) };
  return { options, allocations, bindings };
}

test('target knobs allocate real rounded dimensions, rebind and release only owned resources', () => {
  const { options, allocations, bindings } = fixture();
  const knob = renderTargetKnob(options);
  assert.equal(knob.texture, options.texture);
  knob.apply(1);
  assert.deepEqual([knob.texture.width, knob.texture.height], [32, 16]);
  knob.apply(1);
  assert.equal(allocations.length, 1);
  knob.apply(2);
  assert.equal(allocations[0].destroyed, true);
  assert.deepEqual([knob.texture.width, knob.texture.height], [16, 8]);
  knob[Symbol.dispose]();
  knob.dispose();
  assert.equal(bindings.at(-1), options.texture);
  assert.equal(knob.texture, options.texture);
  assert.ok(allocations.every((texture) => texture.destroyed));
  assert.equal(options.texture.destroyed, false);
  assert.throws(() => knob.apply(1), { code: 'disposed' });
});

test('failed binding preserves the previous texture and releases the rejected allocation', () => {
  const f = fixture();
  let fail = false;
  const error = new Error('bind');
  const knob = renderTargetKnob({
    ...f.options,
    bind() {
      if (fail) throw error;
    },
  });
  knob.apply(1);
  const previous = knob.texture;
  fail = true;
  assert.throws(
    () => knob.apply(2),
    (e) => e === error,
  );
  assert.equal(knob.texture, previous);
  assert.equal(previous.destroyed, false);
  assert.equal(f.allocations.at(-1).destroyed, true);
  assert.throws(
    () => knob.dispose(),
    (e) => e === error,
  );
  fail = false;
  knob.dispose();
  assert.equal(previous.destroyed, true);
});

test('particle levels change live birth rate, stop births and restore absent or explicit rates', () => {
  for (const options of [{}, { rate: 80 }, { rate: 0 }]) {
    const original = { ...options },
      target = { capacity: 100, options };
    const knob = particleKnob(target);
    knob.apply(1);
    assert.equal(options.rate, (original.rate ?? 50) / 2);
    knob.apply(3);
    assert.equal(options.rate, 0);
    knob.apply(0);
    assert.deepEqual(options, original);
    const scaler = new FeatureScaler([knob], { window: 1, settle: 0 });
    scaler.push(20);
    assert.equal(scaler.levels.particles, 1);
    scaler.reset();
    assert.deepEqual(options, original);
  }
});

test('ladder, resource and level validation happens before allocation or mutation', () => {
  const f = fixture();
  for (const scales of [[], [1], [0.5, 0.25], [1, 1], [1, 0], [1, NaN], [1, Infinity]])
    assert.throws(() => renderTargetKnob({ ...f.options, scales }), RangeError);
  for (const weight of [0, -1, NaN, Infinity])
    assert.throws(() => renderTargetKnob({ ...f.options, weight }), RangeError);
  for (const patch of [
    { sampleCount: 4 },
    { dimension: '3d' },
    { depthOrArrayLayers: 2 },
    { usage: 2 },
    { format: 'depth32float' },
  ])
    assert.throws(() => renderTargetKnob({ ...f.options, texture: { ...f.options.texture, ...patch } }), RangeError);
  const knob = renderTargetKnob(f.options),
    particles = particleKnob({ capacity: 1, options: {} });
  for (const level of [-1, 0.5, 3, NaN, Infinity]) assert.throws(() => knob.apply(level), RangeError);
  for (const level of [-1, 0.5, 4, NaN, Infinity]) assert.throws(() => particles.apply(level), RangeError);
  assert.equal(f.allocations.length, 0);
  assert.throws(() => textureResolutionKnob({ ...f.options, source: { width: 1, height: 1 } }), RangeError);
  assert.throws(
    () =>
      textureResolutionKnob({
        ...f.options,
        texture: { ...f.options.texture, usage: 6 },
        source: { width: 65, height: 33 },
      }),
    RangeError,
    'external image uploads need RENDER_ATTACHMENT as well as COPY_DST',
  );
  for (const rate of [-1, NaN, Infinity])
    assert.throws(() => particleKnob({ capacity: 1, options: { rate } }), RangeError);
});

test('tiny targets clamp to one pixel and copied ladders cannot change after construction', () => {
  const f = fixture(),
    scales = [1, 0.5, 0.01];
  const knob = renderTargetKnob({ ...f.options, scales });
  scales[2] = 100;
  knob.apply(2);
  assert.deepEqual([knob.texture.width, knob.texture.height], [1, 1]);
  knob.dispose();
});

test('MSAA selection is deferred, excluded from live savings, and uses the public tier policy', () => {
  const oldLow = globalThis.margoLow,
    oldPreset = globalThis.margoPreset;
  try {
    globalThis.margoLow = 1.5;
    const knob = msaaKnob();
    assert.equal(knob.samples, 4);
    knob.apply(1);
    assert.equal(knob.samples, 1);
    assert.equal(globalThis.margoLow, 1.5);
    assert.equal('name' in knob, false);
    assert.equal(knob.prepare({ userAgent: 'Desktop' }), 1);
    knob.apply(0);
    assert.equal(globalThis.margoLow, 1);
    assert.equal(knob.prepare({ userAgent: 'Desktop' }), 4);
    assert.equal(knob.prepare({ userAgent: 'Android Mobi' }), 1);
    assert.equal(knob.samples, 4, 'requested and effective samples are distinct');
    assert.throws(() => knob.apply(2), RangeError);
  } finally {
    if (oldLow === undefined) delete globalThis.margoLow;
    else globalThis.margoLow = oldLow;
    if (oldPreset === undefined) delete globalThis.margoPreset;
    else globalThis.margoPreset = oldPreset;
  }
});
