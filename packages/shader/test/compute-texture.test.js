import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ComputePass,
  If,
  Loop,
  NodeMaterial,
  NodePass,
  block,
  float,
  storage,
  texture,
  uint,
  uv,
  uvec2,
  vec2,
  vec3,
  vec4,
} from '../dist/index.js';
import { PingPongTexture, StorageTexture, pingPong, storageTexture } from '../dist/compute-texture.js';

globalThis.GPUTextureUsage ??= { TEXTURE_BINDING: 4, STORAGE_BINDING: 8, COPY_DST: 2, COPY_SRC: 1 };
globalThis.GPUBufferUsage ??= { STORAGE: 128, COPY_DST: 8, COPY_SRC: 4, VERTEX: 32 };
const fakeDevice = (features = []) => {
  const made = [];
  return {
    made,
    features: new Set(features),
    lost: new Promise(() => {}),
    createTexture(d) {
      const texture = { ...d, destroyed: false, createView: () => ({ of: texture }), destroy: () => (texture.destroyed = true) };
      made.push(texture);
      return texture;
    },
    createSampler: (d) => ({ sampler: d }),
    createBuffer: (d) => ({ ...d, destroy() {} }),
    queue: {
      writes: [],
      writeTexture(...a) {
        this.writes.push(a);
      },
      writeBuffer() {},
    },
  };
};

test('a store is textureStore into a write-only binding, and a load in another pass reads a sampled one', () => {
  const t = storageTexture(16, 8, { format: 'rgba8unorm' }),
    write = new ComputePass(t.pixels, (i) => t.store(t.coord(i), vec4(1, 0, 0, 1))),
    out = storage(t.pixels, 'vec4f'),
    read = new ComputePass(t.pixels, (i) => out.store(i, t.load(t.coord(i))));
  assert.equal(t.pixels, 128);
  assert.match(write.code, /var ndw0:texture_storage_2d<rgba8unorm, write>;/);
  assert.match(write.code, /textureStore\(ndw0, vec2u\(gid\.x % 16u, gid\.x \/ 16u\), vec4f\(1\.0, 0\.0, 0\.0, 1\.0\)\);/);
  assert.match(read.code, /var ndr\d:texture_2d<f32>;/);
  assert.match(read.code, /textureLoad\(ndr\d, vec2u\(.*\), 0\)/);
});

test('integer formats read and write integer texels; a scalar fills the texel', () => {
  const t = storageTexture(4, 4, { format: 'r32uint' }),
    pass = new ComputePass(t.pixels, (i) => t.store(t.coord(i), i));
  assert.equal(t.load(uvec2(0, 0)).type, 'vec4u');
  assert.match(pass.code, /texture_storage_2d<r32uint, write>/);
  assert.match(pass.code, /vec4u\(gid\.x\)/);
  assert.equal(storageTexture(1, 1, { format: 'rg32sint' }).load(uvec2(0, 0)).type, 'vec4i');
  assert.throws(() => new ComputePass(16, (i) => t.store(t.coord(i), vec4(1))), /stored texel must be vec4u/);
});

test('a pair reads the front image, writes the back one, and swaps after a dispatch that stores', () => {
  const t = pingPong(8, 8),
    device = fakeDevice(),
    step = new ComputePass(t.pixels, (i) => t.store(t.coord(i), t.load(t.coord(i)).add(1))),
    views = () => step.program.entries(device, { width: 1, height: 1 }).map((e) => e.resource);
  assert.match(step.code, /var ndr\d:texture_2d<f32>;\n.*var ndw\d:texture_storage_2d<rgba16float, write>;/);
  const [read, write] = views();
  assert.notEqual(read, write);
  const dispatched = [],
    encoder = {
      beginComputePass: () => ({
        setPipeline() {},
        setBindGroup() {},
        dispatchWorkgroups: (n) => dispatched.push(n),
        end() {},
      }),
    };
  const gpu = Object.assign(device, {
    createShaderModule: () => ({}),
    createComputePipeline: () => ({ getBindGroupLayout: () => ({}) }),
    createBindGroup: () => ({}),
  });
  step.encode(gpu, encoder, { width: 1, height: 1 });
  const [read2, write2] = views();
  assert.equal(read2, write);
  assert.equal(write2, read);
  assert.equal(t.texture(device), write.of);
  // A pass that only reads leaves the pair alone.
  const out = storage(t.pixels, 'vec4f'),
    look = new ComputePass(t.pixels, (i) => out.store(i, t.load(t.coord(i))));
  look.encode(gpu, encoder, { width: 1, height: 1 });
  assert.equal(t.texture(device), write.of);
  t.swap();
  assert.equal(t.texture(device), read.of);
  assert.equal(dispatched.length, 2);
});

test('one pass cannot load and store a single storage texture, and says what to use', () => {
  const t = storageTexture(4, 4);
  assert.throws(() => new ComputePass(16, (i) => t.store(t.coord(i), t.load(t.coord(i)))), /use pingPong\(\)/);
});

test('readWrite is one binding for load and store, r32 formats only', () => {
  const t = storageTexture(4, 4, { format: 'r32float', readWrite: true }),
    pass = new ComputePass(16, (i) => t.store(t.coord(i), t.load(t.coord(i)).add(1)));
  assert.match(pass.code, /var ndw0:texture_storage_2d<r32float, read_write>;/);
  assert.match(pass.code, /textureLoad\(ndw0, nd\d+\)/);
  assert.equal(pass.program.resources.length, 1);
  assert.throws(() => storageTexture(4, 4, { readWrite: true }), /r32float/);
});

test('a load after a store in the same statements is read again', () => {
  const t = storageTexture(4, 4, { format: 'r32float', readWrite: true }),
    pass = new ComputePass(16, (i) => {
      const at = t.coord(i),
        v = t.load(at).x;
      t.store(at, v.add(v));
      t.store(at, v.add(v));
    });
  assert.equal(pass.code.split('textureLoad').length - 1, 2, pass.code);
});

test('texture() samples the front image in materials, passes and compute; formats that cannot filter refuse', () => {
  const t = pingPong(4, 4, { filter: 'nearest', wrap: 'repeat' }),
    device = fakeDevice();
  assert.match(new NodeMaterial({ colorNode: texture(t).rgb }).fragmentCode, /textureSample\(/);
  assert.match(new NodePass(texture(t, uv()).rgb).code(), /textureSample\(/);
  const [view, sampler] = t.bind(device);
  assert.equal(view.of, t.texture(device));
  assert.deepEqual(sampler.sampler, { magFilter: 'nearest', minFilter: 'nearest', addressModeU: 'repeat', addressModeV: 'repeat' });
  assert.equal(t.bind(device)[1], sampler, 'one sampler per device');
  t.swap();
  assert.notEqual(t.bind(device)[0], view);
  assert.throws(() => storageTexture(1, 1, { format: 'rgba32float' }).bind(device), /cannot be sampled on this device/);
  assert.throws(() => storageTexture(1, 1, { format: 'r32uint' }).bind(device), /read it with load/);
  assert.ok(storageTexture(1, 1, { format: 'rgba32float' }).bind(fakeDevice(['float32-filterable'])));
});

test('first contents are uploaded on creation, for both images of a pair, and again after dispose', () => {
  const data = new Uint8Array(16),
    t = pingPong(2, 2, { format: 'rgba8uint', data }),
    device = fakeDevice();
  const first = t.texture(device);
  assert.equal(device.queue.writes.length, 1);
  assert.deepEqual(device.queue.writes[0][2], { bytesPerRow: 8, rowsPerImage: 2 });
  t.swap();
  t.texture(device);
  assert.equal(device.queue.writes.length, 2);
  t.dispose();
  assert.equal(first.destroyed, true);
  assert.notEqual(t.texture(device), first);
  assert.equal(device.queue.writes.length, 3);
});

test('a device loss drops the images, and the next use makes them from data', async () => {
  let lose;
  const device = Object.assign(fakeDevice(), { lost: new Promise((r) => (lose = r)) }),
    t = storageTexture(1, 1),
    first = t.texture(device);
  lose({ reason: 'unknown', message: 'gone' });
  await new Promise((r) => setImmediate(r));
  assert.notEqual(t.texture(device), first);
});

test('wrong sizes, formats, data and places fail with what to do', () => {
  assert.throws(() => storageTexture(0, 1), /at least 1/);
  assert.throws(() => storageTexture(1.5, 1), /at least 1/);
  assert.throws(() => storageTexture(1, 1, { format: 'bgra8unorm' }), /not a storage format/);
  assert.throws(() => storageTexture(2, 2, { format: 'rgba8unorm', data: new Uint8Array(4) }), /must be 16 bytes/);
  const t = storageTexture(4, 4);
  assert.throws(() => t.store(uvec2(0, 0), 1), /store runs inside/);
  assert.throws(() => t.load(vec2(0, 0)), /vec2u or vec2i/);
  assert.throws(
    () =>
      new NodeMaterial({
        colorNode: block(() => {
          t.store(uvec2(0, 0), 1);
          return vec3(0);
        }),
      }),
    /only written in ComputePass/,
  );
});

test('stores work inside branches and loops', () => {
  const t = pingPong(4, 4),
    pass = new ComputePass(16, (i) => {
      const at = t.coord(i);
      If(i.mod(2).equal(0), () => t.store(at, vec4(1))).Else(() => {
        Loop(2, () => t.store(at, vec4(0)));
      });
    });
  assert.ok(pass.code.indexOf('if (') < pass.code.indexOf('textureStore'));
});

test('t.uv gives texel centres', () => {
  const t = storageTexture(4, 2),
    pass = new ComputePass(8, (i) => {
      const out = storage(8, 'vec2f');
      return out.store(i, t.uv(t.coord(i)));
    });
  assert.match(pass.code, /\+ 0\.5/);
  assert.match(pass.code, /vec2f\(4\.0, 2\.0\)/);
});

test('the classes are what the factories make, and using disposes', () => {
  assert.ok(pingPong(1, 1) instanceof PingPongTexture);
  assert.ok(storageTexture(1, 1) instanceof StorageTexture);
  const device = fakeDevice(),
    first = (() => {
      using t = storageTexture(1, 1);
      return t.texture(device);
    })();
  assert.equal(first.destroyed, true);
  assert.equal(float(1).type, 'f32');
  assert.equal(uint(1).type, 'u32');
});
