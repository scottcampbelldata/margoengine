import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Tonemap } from '../dist/index.js';
import { PostStack } from '../../post/dist/index.js';
import { gpuHarness } from '../../../tests/support/postfx-gpu.js';

const defaultShader = 'e51ef1c3708c505f628cd291ca7841a836a865031a9964ca8f144dec78d46b68',
  defaultOutputShader = '44216e96261eb27063e80e8d87f628c3b6c0a0d0edfd4593da5ddbd22549b370';
const hash = (code) => createHash('sha256').update(code).digest('hex');

function lut(size = 33, explicit = true) {
  const data = new Float32Array(size ** 3 * 4);
  for (let b = 0, i = 0; b < size; b++)
    for (let g = 0; g < size; g++)
      for (let r = 0; r < size; r++, i += 4) data.set([r / (size - 1), g / (size - 1), b / (size - 1), 1], i);
  return {
    ...(explicit ? { size } : {}),
    data,
    domainMin: new Float32Array([-1, 0.25, 2]),
    domainMax: new Float32Array([1, 2, 5]),
  };
}

function harness({ external = true, output = false } = {}) {
  const h = gpuHarness(),
    device = h.engine.gpu,
    uploads = [],
    textures = [],
    draws = [],
    createTexture = device.createTexture.bind(device),
    writeTexture = device.queue.writeTexture.bind(device.queue),
    begin = h.context.encoder.beginRenderPass,
    frame = h.frame;
  device.limits = { maxTextureDimension3D: 128 };
  device.createTexture = (descriptor) => {
    const texture = createTexture(descriptor),
      destroy = texture.destroy.bind(texture);
    texture.destroyCalls = 0;
    texture.destroy = () => {
      texture.destroyCalls++;
      destroy();
    };
    if (descriptor.dimension === '3d') textures.push(texture);
    return texture;
  };
  device.queue.writeTexture = (destination, data, layout, extent) => {
    writeTexture(destination, data, layout, extent);
    uploads.push({ texture: destination.texture, data: data.slice(), layout: { ...layout }, extent: [...extent] });
  };
  h.context.encoder.beginRenderPass = (descriptor) => {
    const pass = begin(descriptor);
    let pipeline, group;
    return {
      ...pass,
      setPipeline(value) {
        pipeline = value;
      },
      setBindGroup(index, value) {
        if (index === 0) group = value;
      },
      draw(...args) {
        draws.push({ pipeline, group, args });
        pass.draw(...args);
      },
    };
  };
  if (external)
    h.input = device.createTexture({
      size: [128, 96],
      format: 'rgba16float',
      usage: GPUTextureUsage.TEXTURE_BINDING,
    });
  if (output)
    h.context[Symbol.for('margoengine.color-output')] = { peak: 2, p3: true, excess: () => ({ excess: true }) };
  return Object.assign(h, {
    uploads,
    textures,
    draws,
    options: external ? { source: () => h.input } : {},
    frame() {
      draws.length = 0;
      frame();
      return draws.filter((draw) => draw.pipeline.fragment?.module.code.includes('fn sampleLUT'));
    },
    close(effect) {
      effect.dispose();
      h.input?.destroy();
      assert.ok(
        h.resources.every((resource) => resource.destroyed),
        'effect resources must all be released',
      );
    },
  });
}

const boundLUT = (draw) => draw.group.entries.find((entry) => entry.binding === 2).resource.texture;
const domains = (h) => [...h.writes.slice(4, 7), ...h.writes.slice(8, 11)];

test('Tonemap uploads every supported LUT size with its own row pitch and red-fastest samples', () => {
  const h = harness(),
    effect = Tonemap.attach(h.engine, h.options);
  try {
    for (const size of [2, 16, 17, 32, 33, 64, 65]) {
      const input = lut(size);
      effect.setLUT(input);
      const upload = h.uploads.at(-1),
        draw = h.frame()[0];
      assert.deepEqual(upload.texture.size, [size, size, size]);
      assert.equal(upload.texture.dimension, '3d');
      assert.equal(upload.texture.format, 'rgba32float');
      assert.deepEqual(upload.extent, [size, size, size]);
      assert.deepEqual(upload.layout, { bytesPerRow: size * 16, rowsPerImage: size });
      assert.equal(upload.data.length, size ** 3 * 4);
      assert.equal(upload.data[4], Math.fround(1 / (size - 1)));
      assert.equal(upload.data[size * 4 + 1], Math.fround(1 / (size - 1)));
      assert.equal(upload.data[size * size * 4 + 2], Math.fround(1 / (size - 1)));
      assert.deepEqual([...upload.data.slice(-4)], [1, 1, 1, 1]);
      assert.equal(boundLUT(draw), upload.texture);
      assert.equal(h.writes[3], 1);
      assert.deepEqual(domains(h), [-1, 0.25, 2, 1, 2, 5]);
    }
  } finally {
    h.close(effect);
  }
});

test('unattached LUT assignment snapshots size, data and domains through attachment and restoration', () => {
  const h = harness(),
    effect = new Tonemap(h.options),
    input = lut(16);
  try {
    input.data[0] = 0.125;
    effect.setLUT(input);
    assert.equal(h.textures.length, 0, 'unattached LUTs allocate no GPU resources');
    input.size = 65;
    input.data.fill(NaN);
    input.domainMin.fill(9);
    input.domainMax.fill(-9);
    h.engine.use(effect);
    const first = boundLUT(h.frame()[0]);
    assert.deepEqual(first.size, [16, 16, 16]);
    assert.equal(h.uploads.at(-1).data[0], 0.125);
    assert.deepEqual(domains(h), [-1, 0.25, 2, 1, 2, 5]);
    effect.onDeviceRestored(h.engine);
    const restored = boundLUT(h.frame()[0]);
    assert.notEqual(restored, first);
    assert.equal(first.destroyCalls, 1);
    assert.deepEqual(restored.size, [16, 16, 16]);
    assert.equal(h.uploads.at(-1).data[0], 0.125);
    assert.deepEqual(domains(h), [-1, 0.25, 2, 1, 2, 5]);
  } finally {
    h.close(effect);
  }
});

test('legacy omitted size, explicit 33 and no LUT preserve the existing shader, pipeline key and steady draw calls', () => {
  for (const output of [false, true])
    for (const input of [null, lut(33, false), lut(33)]) {
      const h = harness({ output }),
        effect = new Tonemap(h.options);
      try {
        if (input) effect.setLUT(input);
        h.engine.use(effect);
        const first = h.frame(),
          expectedHash = output ? defaultOutputShader : defaultShader;
        assert.equal(effect.pipelineFormat, 'bgra8unorm:4' + (output ? ':output' : ''));
        assert.deepEqual(
          first.map((draw) => hash(draw.pipeline.fragment.module.code)),
          output ? [expectedHash, expectedHash] : [expectedHash],
        );
        assert.deepEqual(
          first.map((draw) => draw.pipeline.fragment.entryPoint),
          output ? ['fragment', 'excess'] : ['fragment'],
        );
        assert.deepEqual(
          first.map((draw) => draw.args),
          output ? [[3], [3]] : [[3]],
        );
        assert.deepEqual(boundLUT(first[0]).size, [33, 33, 33]);
        assert.equal(h.uploads.length, +!!input);
        assert.equal(h.writes[3], +!!input);
        const before = { ...h.counts };
        for (let i = 0; i < 3; i++) {
          const next = h.frame();
          assert.deepEqual(
            next.map((draw) => draw.pipeline),
            first.map((draw) => draw.pipeline),
          );
          assert.deepEqual(
            next.map((draw) => draw.group),
            first.map((draw) => draw.group),
          );
          assert.deepEqual(
            next.map((draw) => draw.args),
            output ? [[3], [3]] : [[3]],
          );
        }
        for (const key of ['buffers', 'textures', 'views', 'groups', 'uploads'])
          assert.equal(h.counts[key], before[key]);
      } finally {
        h.close(effect);
      }
    }
});

test('LUT swaps select one generic pipeline for 16 and 65 then return to the exact 33 and disabled paths', () => {
  const h = harness(),
    effect = Tonemap.attach(h.engine, h.options);
  try {
    let previous = h.textures[0],
      generic;
    for (const size of [33, 16, 65, 33, null]) {
      effect.setLUT(size === null ? null : lut(size));
      const draw = h.frame()[0],
        texture = boundLUT(draw),
        code = draw.pipeline.fragment.module.code;
      assert.equal(previous.destroyCalls, 1);
      assert.equal(texture.destroyed, false);
      assert.deepEqual(texture.size, [size ?? 33, size ?? 33, size ?? 33]);
      assert.equal(h.writes[3], size === null ? 0 : 1);
      if (size === 16) {
        assert.match(code, /textureDimensions\s*\(\s*lut\s*\)/);
        assert.notEqual(hash(code), defaultShader);
        generic = draw.pipeline;
      } else if (size === 65) assert.equal(draw.pipeline, generic, 'dimension lookup reuses the generic pipeline');
      else assert.equal(hash(code), defaultShader);
      previous = texture;
    }
    assert.deepEqual(domains(h), [0, 0, 0, 1, 1, 1]);
    const allocations = { ...h.counts };
    for (let i = 0; i < 3; i++) h.frame();
    for (const key of ['buffers', 'textures', 'views', 'groups', 'uploads'])
      assert.equal(h.counts[key], allocations[key]);
  } finally {
    h.close(effect);
  }
});

test('invalid size and array/domain data preserve the previously bound LUT and uniforms', () => {
  const h = harness(),
    effect = Tonemap.attach(h.engine, h.options),
    original = lut(33);
  try {
    effect.setLUT(original);
    const previous = boundLUT(h.frame()[0]),
      before = h.textures.length;
    for (const candidate of [
      ...[null, '33', 1, 66, 2.5, NaN, Infinity].map((size) => ({ ...original, size })),
      { ...original, size: 16 },
      { ...original, data: new Float32Array(4) },
      { ...original, domainMin: new Float32Array([2, 0, 0]) },
    ]) {
      assert.throws(() => effect.setLUT(candidate));
      assert.equal(h.textures.length, before, 'validation must happen before texture allocation');
      assert.equal(boundLUT(h.frame()[0]), previous);
      assert.deepEqual(domains(h), [-1, 0.25, 2, 1, 2, 5]);
      assert.equal(previous.destroyed, false);
    }
  } finally {
    h.close(effect);
  }
});

test('create and write failures retain the previous CPU and GPU state and release only a failed new texture', () => {
  for (const mode of ['create', 'write', 'clear']) {
    const h = harness(),
      effect = Tonemap.attach(h.engine, h.options),
      device = h.engine.gpu;
    try {
      effect.setLUT(lut(33));
      const first = h.frame()[0],
        previous = boundLUT(first),
        textureCount = h.textures.length,
        create = device.createTexture,
        write = device.queue.writeTexture,
        failure = new Error('controlled LUT upload failure'),
        candidate = lut(33);
      candidate.domainMin.fill(-4);
      candidate.domainMax.fill(4);
      candidate.data.fill(0.75);
      if (mode === 'write')
        device.queue.writeTexture = () => {
          throw failure;
        };
      else
        device.createTexture = (descriptor) => {
          if (descriptor.dimension === '3d') throw failure;
          return create(descriptor);
        };
      try {
        assert.throws(
          () => effect.setLUT(mode === 'clear' ? null : candidate),
          (error) => error === failure,
        );
      } finally {
        device.createTexture = create;
        device.queue.writeTexture = write;
      }
      const retained = h.frame()[0];
      assert.equal(boundLUT(retained), previous);
      assert.equal(retained.group, first.group);
      assert.equal(previous.destroyed, false);
      assert.equal(h.writes[3], 1);
      assert.deepEqual(domains(h), [-1, 0.25, 2, 1, 2, 5]);
      assert.equal(h.textures.length, textureCount + +(mode === 'write'));
      if (mode === 'write') assert.equal(h.textures.at(-1).destroyCalls, 1);
      effect.onDeviceRestored(h.engine);
      h.frame();
      assert.equal(h.uploads.at(-1).data[0], 0);
      assert.deepEqual(domains(h), [-1, 0.25, 2, 1, 2, 5]);
      assert.equal(h.writes[3], 1);
    } finally {
      h.close(effect);
    }
  }
});

test('device dimension limits reject attachment, replacement and restoration before allocating a 3D texture', () => {
  const attached = harness(),
    effect = Tonemap.attach(attached.engine, attached.options);
  try {
    effect.setLUT(lut(33));
    const previous = boundLUT(attached.frame()[0]),
      count = attached.textures.length;
    attached.engine.gpu.limits.maxTextureDimension3D = 32;
    assert.throws(() => effect.setLUT(lut(33)), RangeError);
    assert.equal(attached.textures.length, count);
    assert.equal(boundLUT(attached.frame()[0]), previous);
    assert.deepEqual(domains(attached), [-1, 0.25, 2, 1, 2, 5]);
  } finally {
    attached.close(effect);
  }
  const lazy = harness(),
    delayed = new Tonemap(lazy.options);
  try {
    delayed.setLUT(lut(65));
    lazy.engine.gpu.limits.maxTextureDimension3D = 64;
    assert.throws(() => lazy.engine.use(delayed), RangeError);
    assert.equal(lazy.textures.length, 0);
  } finally {
    lazy.close(delayed);
  }
  const restored = harness(),
    retry = Tonemap.attach(restored.engine, restored.options);
  try {
    retry.setLUT(lut(65));
    const previous = boundLUT(restored.frame()[0]),
      count = restored.textures.length;
    restored.engine.gpu.limits.maxTextureDimension3D = 64;
    assert.throws(() => retry.onDeviceRestored(restored.engine), RangeError);
    assert.equal(restored.textures.length, count);
    assert.equal(previous.destroyCalls, 1);
    restored.engine.gpu.limits.maxTextureDimension3D = 128;
    retry.onDeviceRestored(restored.engine);
    assert.deepEqual(boundLUT(restored.frame()[0]).size, [65, 65, 65]);
  } finally {
    restored.close(retry);
  }
});

test('failed device restoration keeps enough ownership for disposal to remove the plugin and frame passes', () => {
  for (const stage of ['buffer', 'texture', 'upload']) {
    const h = harness(),
      effect = Tonemap.attach(h.engine, h.options),
      device = h.engine.gpu;
    try {
      effect.setLUT(lut(16));
      h.frame();
      const createBuffer = device.createBuffer,
        createTexture = device.createTexture,
        writeTexture = device.queue.writeTexture,
        failure = new Error('controlled restoration failure');
      if (stage === 'buffer')
        device.createBuffer = () => {
          throw failure;
        };
      else if (stage === 'texture')
        device.createTexture = () => {
          throw failure;
        };
      else
        device.queue.writeTexture = () => {
          throw failure;
        };
      try {
        assert.throws(
          () => effect.onDeviceRestored(h.engine),
          (error) => error === failure,
        );
      } finally {
        device.createBuffer = createBuffer;
        device.createTexture = createTexture;
        device.queue.writeTexture = writeTexture;
      }
      effect.dispose();
      assert.equal(h.engine.hasPlugin('tonemap'), false);
      const renderCount = h.counts.render;
      assert.doesNotThrow(() => h.frame());
      assert.equal(h.counts.render, renderCount, 'disposed grading passes must no longer run');
    } finally {
      h.close(effect);
    }
  }
});

test('ColorOutput uses dimension-based LUT sampling in both its display and excess fragments', () => {
  const h = harness({ output: true }),
    effect = Tonemap.attach(h.engine, h.options);
  try {
    effect.setLUT(lut(16));
    const first = h.frame();
    assert.deepEqual(
      first.map((draw) => draw.pipeline.fragment.entryPoint),
      ['fragment', 'excess'],
    );
    assert.equal(first[0].pipeline.fragment.module, first[1].pipeline.fragment.module);
    assert.match(first[0].pipeline.fragment.module.code, /textureDimensions\s*\(\s*lut\s*\)/);
    assert.deepEqual(
      first.map((draw) => boundLUT(draw).size),
      [
        [16, 16, 16],
        [16, 16, 16],
      ],
    );
    assert.deepEqual([...h.writes.slice(13, 15)], [2, 1]);
    effect.setLUT(lut(65));
    const next = h.frame();
    assert.equal(next[0].pipeline, first[0].pipeline);
    assert.equal(next[1].pipeline, first[1].pipeline);
    assert.deepEqual(
      next.map((draw) => boundLUT(draw).size),
      [
        [65, 65, 65],
        [65, 65, 65],
      ],
    );
  } finally {
    h.close(effect);
  }
});

test('PostStack display and string assignments use variable-size LUTs without replacing the shared HDR capture', () => {
  const h = harness({ external: false }),
    effect = new Tonemap();
  let stack;
  try {
    effect.setLUT('LUT_3D_SIZE 2\n0 0 0\n1 0 0\n0 1 0\n1 1 0\n0 0 1\n1 0 1\n0 1 1\n1 1 1\n');
    stack = PostStack.attach(h.engine, [effect]);
    const first = h.frame()[0],
      capture = stack.sceneTexture;
    assert.deepEqual(boundLUT(first).size, [2, 2, 2]);
    assert.equal(h.context.color, h.originalColor);
    effect.setLUT(lut(17));
    const next = h.frame()[0];
    assert.equal(next.pipeline, first.pipeline);
    assert.deepEqual(boundLUT(next).size, [17, 17, 17]);
    assert.equal(stack.sceneTexture, capture);
    assert.equal(h.context.color, h.originalColor);
  } finally {
    h.close(stack ?? effect);
  }
});
