import test from 'node:test';
import assert from 'node:assert/strict';
import { ContactShadows } from '../dist/index.js';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';

// Kernel uniform: axis.xy (uv step per unit offset), axis.z pair count, axis.w centre weight, then (offset, weight) pairs.
const KERNEL_BYTES = (4 + 64) * 4;

function setup(options) {
  const h = optionalGPU(),
    passes = [],
    begin = h.context.encoder.beginRenderPass;
  h.context.encoder.beginRenderPass = (d) => {
    passes.push(d.depthStencilAttachment ? 'plane' : 'texture');
    return begin(d);
  };
  const vertex = h.engine.gpu.createBuffer({ size: 240, usage: GPUBufferUsage.VERTEX }),
    index = h.engine.gpu.createBuffer({ size: 12, usage: GPUBufferUsage.INDEX }),
    node = {
      id: 0,
      engine: h.engine,
      matrix: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
      check() {},
    },
    contact = ContactShadows.attach(h.engine, options);
  contact.add({ shadowPrimitives: [{ node, vertex, index, count: 3, stride: 80 }] });
  const frame = () => {
    passes.length = 0;
    h.engine.frameGraph.execute(h.context);
    return [...passes];
  };
  return { h, contact, frame };
}

function kernel(buffer) {
  const f = new Float32Array(buffer.data),
    pairs = f[2],
    taps = [];
  for (let i = 0; i < pairs; i++) taps.push([f[4 + i * 2], f[5 + i * 2]]);
  return { axis: [f[0], f[1]], centre: f[3], taps };
}

test('the blur is one normalised separable Gaussian, round in world units on a non-square plane', () => {
  const { h, contact, frame } = setup({ size: [4, 2], blur: 0.2, resolution: 64 });
  try {
    assert.deepEqual(frame(), ['texture', 'texture', 'texture', 'plane']);
    const [x, z] = h.resources.filter((r) => r.size === KERNEL_BYTES).map((r) => kernel(r));
    assert.deepEqual(x.axis, [1 / 64, 0]);
    assert.deepEqual(z.axis, [0, 1 / 64]);
    for (const k of [x, z]) {
      const sum = k.centre + 2 * k.taps.reduce((s, [, w]) => s + w, 0);
      assert.ok(Math.abs(sum - 1) < 1e-5, 'weights sum to 1: ' + sum);
      for (let i = 1; i < k.taps.length; i++) {
        assert.ok(k.taps[i][0] > k.taps[i - 1][0], 'offsets grow outwards');
        assert.ok(k.taps[i][1] < k.taps[i - 1][1], 'weights fall outwards');
      }
    }
    // Radius 0.2 world units: 3.2 texels across the 4-unit side, 6.4 across the 2-unit side; sigma = radius / 2.
    // The kernel's second moment (in world units) must match on both axes.
    const spread = (k, texelWorld) => Math.sqrt(2 * k.taps.reduce((s, [o, w]) => s + w * o * o, 0)) * texelWorld;
    const sx = spread(x, 4 / 64),
      sz = spread(z, 2 / 64);
    assert.ok(Math.abs(sx - 0.1) < 0.012, 'x sigma ' + sx);
    assert.ok(Math.abs(sz - 0.1) < 0.012, 'z sigma ' + sz);
    assert.ok(z.taps.length > x.taps.length, 'the shorter side needs more texels for the same world radius');
  } finally {
    contact.dispose();
  }
});

test('wide blurs stay within the tap budget; blur 0 skips both blur passes', () => {
  const { h, contact, frame } = setup({ size: 4, blur: 1, resolution: 1024 });
  try {
    frame();
    for (const r of h.resources.filter((b) => b.size === KERNEL_BYTES)) {
      const k = kernel(r),
        sum = k.centre + 2 * k.taps.reduce((s, [, w]) => s + w, 0);
      assert.ok(k.taps.length <= 32);
      assert.ok(Math.abs(sum - 1) < 1e-5);
      // 256-texel radius: the outermost tap reaches about 1.5 radii (3 sigma).
      assert.ok(Math.abs(k.taps.at(-1)[0] - 384) < 12, 'reach ' + k.taps.at(-1)[0]);
    }
    contact.options.blur = 0;
    assert.deepEqual(frame(), ['texture', 'plane'], 'occluders straight to the plane');
    contact.options.opacity = 0;
    assert.deepEqual(frame(), ['texture', 'plane']);
  } finally {
    contact.dispose();
  }
});

test('default resolution is 256 and errors carry their classes', () => {
  const { h, contact, frame } = setup({});
  try {
    frame();
    assert.ok(h.resources.some((r) => r.format === 'r16float' && r.width === 256));
    assert.throws(() => contact.add(null), TypeError);
    assert.throws(() => contact.add({ size: 1 }), TypeError);
    const bad = { shadowPrimitives: [{ node: { id: 0, matrix: new Float32Array(16), check() {} }, stride: 32 }] };
    contact.add(bad);
    assert.throws(() => frame(), RangeError);
  } finally {
    contact.dispose();
  }
  assert.throws(() => contact.add({ shadowPrimitives: [] }), TypeError, 'disposed effect');
  assert.throws(() => new ContactShadows({ resolution: 64.5 }), RangeError);
  assert.throws(() => new ContactShadows({ color: [0, 0, Number.NaN] }), RangeError);
});
