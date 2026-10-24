import test from 'node:test';
import assert from 'node:assert/strict';
import { MotionBlur, PostStack, FXAA } from '../dist/index.js';
import { harness, modules, written } from './support.js';

const passes = (log, kind) => log.filter((e) => e[0] === kind).length;
/** A viewport-sized velocity texture on the mock, and motion vectors over it. */
function vectors(h, extra = {}) {
  const texture = h.gpu.device.createTexture({
    size: [1280, 720],
    format: 'rg16float',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT,
  });
  return { texture, jitter: new Float32Array([0.001, -0.002]), ...extra };
}

for (const samples of [4, 1])
  test(`MotionBlur blurs the stack's HDR frame along the vectors, after tile and neighbour maxima (${samples}x)`, async () => {
    const h = harness({ samples }),
      state = {},
      blur = new MotionBlur({ velocity: () => state.vectors, shutter: 0.25, maxBlur: 20, samples: 12 });
    h.engine.use(new PostStack([blur]));
    state.vectors = vectors(h);
    const log = h.gpu.record(() => h.frame());
    const v = written(log, 112);
    // inverse (16), eye, then: width, height, tile size, samples, radius scale (shutter / 2), max radius, jitter.
    assert.deepEqual([...v.subarray(20, 26)], [1280, 720, 20, 12, 0.125, 20]);
    assert.deepEqual([v[26], v[27]], [Math.fround(0.001), Math.fround(-0.002)]);
    const tiles = log.filter((e) => e[0] === 'texture' && e[2].format === 'rgba16float' && e[2].size?.[0] === 64);
    assert.equal(tiles.length, 2, 'tile maxima and neighbour maxima, ceil(1280 / 20) x ceil(720 / 20)');
    assert.equal(passes(log, 'pass.dispatchWorkgroups'), 2);
    const code = modules(log).find((c) => c.includes('fn reach('));
    assert.match(code, /return vec4f\(toDisplay\(c\.rgb\),c\.a\);/, 'last stage: display-encoded');
    blur.enabled = false;
    const off = h.gpu.record(() => h.frame());
    assert.equal(passes(off, 'pass.dispatchWorkgroups'), 0, 'disabled: a copy only');
    assert.ok(
      modules(off).every((c) => !c.includes('fn reach(')),
      'no reconstruction',
    );
    blur.enabled = true;
    state.vectors = undefined;
    assert.equal(
      passes(
        h.gpu.record(() => h.frame()),
        'pass.dispatchWorkgroups',
      ),
      0,
      'no vectors this frame: a copy',
    );
    h.engine.removePlugin('post:stack');
    await null;
    assert.deepEqual(
      h.live().filter((r) => r !== state.vectors?.texture && r.format !== 'rg16float'),
      [],
    );
  });

test("with TAA's vectors the stack's frame is copied unblurred and the blur runs on TAA's resolved frame at 41", () => {
  const h = harness(),
    state = {},
    blur = new MotionBlur({ velocity: () => state.vectors });
  h.engine.use(new PostStack([blur]));
  const resolved = h.gpu.device.createTexture({
    size: [1280, 720],
    format: 'rgba16float',
    usage: GPUTextureUsage.TEXTURE_BINDING,
  });
  state.vectors = vectors(h, { resolved });
  const log = h.gpu.record(() => h.frame());
  // Stack compose (30): one copy; after TAA (41): tile passes and the reconstruction into the canvas, sRGB-encoded.
  assert.equal(passes(log, 'pass.dispatchWorkgroups'), 2);
  const after = modules(log).find((c) => c.includes('fn reach('));
  assert.match(after, /pow\(x,vec3f\(1\.0\/2\.4\)\)/, 'bgra8unorm canvas: sRGB encoding like TAA present');
  assert.doesNotMatch(after, /toDisplay/, 'no second tone mapping of the resolved frame');
  const copy = modules(log).find((c) => c.includes('var scene') && !c.includes('fn reach('));
  assert.ok(copy, "the stack's frame is copied, not blurred");
  h.engine.removePlugin('post:stack');
});

test('MotionBlur validates its options, its vectors and where it runs', () => {
  assert.throws(() => new MotionBlur({}), TypeError);
  for (const options of [{ shutter: 1.5 }, { maxBlur: 0 }, { maxBlur: 200 }, { samples: 1 }, { samples: 65 }])
    assert.throws(() => new MotionBlur({ velocity: () => undefined, ...options }), RangeError);
  const h = harness();
  assert.throws(() => h.engine.use(new MotionBlur({ velocity: () => undefined })), {
    name: 'MargoError',
    code: 'state',
    message: /MotionBlur.attach/,
  });
  const small = h.gpu.device.createTexture({
    size: [64, 64],
    format: 'rg16float',
    usage: GPUTextureUsage.TEXTURE_BINDING,
  });
  const blur = MotionBlur.attach(h.engine, { velocity: () => ({ texture: small }) });
  assert.ok(h.engine.hasPlugin('post:stack') && h.engine.hasPlugin('motion-blur'));
  assert.throws(() => h.frame(), { name: 'MargoError', code: 'state', message: /viewport-sized/ });
  blur.dispose();
  assert.ok(!h.engine.hasPlugin('post:stack'));
});

test('MotionBlur releases and retries a partial tile allocation', async () => {
  const h = harness(),
    state = {},
    blur = new MotionBlur({ velocity: () => state.vectors });
  h.engine.use(new PostStack([blur]));
  state.vectors = vectors(h);
  const device = h.gpu.device,
    original = device.createTexture;
  let tiles = 0;
  device.createTexture = (descriptor) => {
    if (descriptor.size[0] === 40 && ++tiles === 2) throw new Error('injected tile allocation failure');
    return original(descriptor);
  };
  try {
    assert.throws(() => h.frame(), /injected tile allocation failure/);
    device.createTexture = original;
    assert.doesNotThrow(() => h.frame());
  } finally {
    device.createTexture = original;
    h.engine.removePlugin('post:stack');
    state.vectors.texture.destroy();
    await null;
    assert.deepEqual(h.live(), []);
  }
});

test('PostStack and MotionBlur keep a right-hand view inside every render attachment', () => {
  const h = harness(),
    state = {},
    blur = new MotionBlur({ velocity: () => state.vectors });
  const stack = new PostStack([blur, new FXAA()]);
  h.engine.use(stack);
  state.vectors = vectors(h);
  h.view.c.view = { id: 'right', viewport: [640, 0, 640, 720], index: 1, count: 2 };
  const begin = h.view.c.encoder.beginRenderPass;
  h.view.c.encoder.beginRenderPass = (descriptor) => {
    const pass = begin(descriptor);
    return {
      ...pass,
      setViewport(x, y, width, height, ...rest) {
        const target = descriptor.colorAttachments?.find((a) => a?.view)?.view;
        // Recording GPU views expose their owning texture as an id; the texture dimensions are tracked below.
        const dimensions = viewSizes.get(target);
        if (dimensions)
          assert.ok(
            x + width <= dimensions[0] && y + height <= dimensions[1],
            `viewport ${x},${y},${width},${height} exceeds attachment ${dimensions}`,
          );
        pass.setViewport(x, y, width, height, ...rest);
      },
    };
  };
  const viewSizes = new WeakMap(),
    create = h.gpu.device.createTexture;
  h.gpu.device.createTexture = (descriptor) => {
    const texture = create(descriptor),
      view = texture.createView;
    texture.createView = (...args) => {
      const result = view(...args);
      viewSizes.set(result, [texture.width, texture.height]);
      return result;
    };
    return texture;
  };
  try {
    assert.doesNotThrow(() => h.frame());
  } finally {
    h.engine.removePlugin('post:stack');
    state.vectors.texture.destroy();
  }
});
