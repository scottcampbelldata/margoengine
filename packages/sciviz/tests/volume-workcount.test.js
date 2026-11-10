import assert from 'node:assert/strict';
import test from 'node:test';
import { VolumeLayer } from '../dist/index.js';
import { invertMatrix } from '@margoengine/math/mat4';

test('volume prepare allocates no float matrices and retains exact uniform bytes across transforms', () => {
  globalThis.GPUBufferUsage = { UNIFORM: 1, COPY_DST: 2 };
  globalThis.GPUTextureUsage = { TEXTURE_BINDING: 1, COPY_DST: 2 };
  globalThis.GPUShaderStage = { VERTEX: 1, FRAGMENT: 2 };
  const resource = () => ({ createView: () => ({}), destroy() {} });
  const writes = [];
  const device = {
    limits: { maxTextureDimension3D: 2048 },
    createBuffer: resource,
    createTexture: resource,
    createBindGroup: () => ({}),
    createBindGroupLayout: () => ({}),
    createSampler: () => ({}),
    queue: {
      writeTexture() {},
      writeBuffer(_buffer, _offset, values) {
        writes.push(values.slice());
      },
    },
  };
  const layer = new VolumeLayer({ device, remove() {} }, new Float32Array(8).fill(0.5), {
    dims: [2, 2, 2],
    range: [0, 1],
    bounds: [0, 1, 0, 1, 0, 1],
  });
  const Native = globalThis.Float32Array;
  let allocated = 0;
  const Tracked = new Proxy(Native, {
    construct(target, args) {
      allocated++;
      return Reflect.construct(target, args);
    },
  });
  const matrices = [
    [2, 0, 0, 0, 0.25, 3, 0, 0, -0.5, 0.75, 4, 0, 10, -20, 30, 1],
    [-1, 0, 0, 0, 0, 0.5, 0, 0, 0, 0, 2, 0, -1, 2, -3, 1],
    Array(16).fill(0), // A singular matrix must not reuse the last inverse.
    [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
  ];
  for (const [i, matrix] of matrices.entries()) {
    layer.setModel(new Native(matrix));
    layer.quality = i + 1;
    layer.shading = i % 2 === 0;
    layer.mode = i % 2 ? 'mip' : 'composite';
    layer.clip = i % 2 ? [{ normal: [1, -2, 3], offset: -0.25 }] : [];
    const expected = new Native(80),
      inverse = new Native(16),
      normal = new Native(16);
    expected.set(layer.model);
    invertMatrix(layer.model, inverse);
    expected.set(inverse, 16);
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) normal[c * 4 + r] = inverse[r * 4 + c];
    normal[15] = 1;
    expected.set(normal, 32);
    expected.set([2, 2, 2, layer.clip.length], 48);
    expected.set([i + 1, i % 2, 1, i % 2 === 0 ? 1 : 0], 52);
    layer.clip.forEach((p, k) => expected.set([...p.normal, p.offset], 56 + 4 * k));
    expected.set(layer.classificationUniforms(), 72);
    try {
      globalThis.Float32Array = Tracked;
      layer.prepare();
    } finally {
      globalThis.Float32Array = Native;
    }
    assert.deepEqual(new Uint8Array(writes.at(-1).buffer), new Uint8Array(expected.buffer));
  }
  assert.equal(allocated, 0, 'prepare must reuse its inverse and normal matrix storage');
  layer.restore();
  layer.prepare();
  assert.deepEqual(new Uint8Array(writes.at(-1).buffer), new Uint8Array(writes.at(-2).buffer));
  layer.dispose();
});
