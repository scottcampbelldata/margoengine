// Bug (the compute lab on the WebGL2 layer drew a scrambled CDF): the radix sort's local pass runs on the layer's CPU
// tier (it uses workgroup memory), about 40 loop steps per key, so a 4-million-key sort went over the layer's CPU work
// budget, the layer dropped the pass and reported an internal error that no error scope caught: the sort came back
// unsorted and nothing failed. Now the layer takes the sort route of ./compat.ts (one invocation, an LSD radix sort
// with 8-bit digits, about 9 steps per key), and waits reject on internal errors as on validation errors.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createCompute } from '@margoengine/compute';
import { runComputeOnCPU } from '../../webgl2-compat/dist/compute.js';

globalThis.GPUBufferUsage ??= {
  MAP_READ: 1,
  MAP_WRITE: 2,
  COPY_SRC: 4,
  COPY_DST: 8,
  INDEX: 16,
  VERTEX: 32,
  UNIFORM: 64,
  STORAGE: 128,
  INDIRECT: 256,
  QUERY_RESOLVE: 512,
};
globalThis.GPUMapMode ??= { READ: 1, WRITE: 2 };
globalThis.GPUShaderStage ??= { VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 };

/** A stand-in device that records shader code and error scopes; `internal` makes the next internal scope fail. */
function standIn(vendor) {
  const noop = () => {},
    scopes = [];
  const device = {
    codes: [],
    internal: null,
    adapterInfo: { vendor },
    features: new Set(),
    limits: {
      maxComputeWorkgroupsPerDimension: 65535,
      minStorageBufferOffsetAlignment: 256,
      maxStorageBufferBindingSize: 1 << 30,
      maxBufferSize: 1 << 30,
      maxStorageBuffersPerShaderStage: 8,
    },
    lost: new Promise(noop),
    pushErrorScope: (filter) => scopes.push(filter),
    popErrorScope() {
      const filter = scopes.pop(),
        error = filter === 'internal' ? device.internal : null;
      if (filter === 'internal') device.internal = null;
      return Promise.resolve(error);
    },
    createShaderModule: ({ code }) => (device.codes.push(code), {}),
    createComputePipeline: () => ({ getBindGroupLayout: () => ({}) }),
    createBindGroup: () => ({}),
    createBindGroupLayout: () => ({}),
    createPipelineLayout: () => ({}),
    createBuffer: ({ size }) => ({
      size,
      destroy: noop,
      mapAsync: async () => {},
      getMappedRange: () => new ArrayBuffer(size),
      unmap: noop,
    }),
    createCommandEncoder: () => ({
      beginComputePass: () => ({
        setPipeline: noop,
        setBindGroup: noop,
        dispatchWorkgroups: noop,
        dispatchWorkgroupsIndirect: noop,
        end: noop,
      }),
      copyBufferToBuffer: noop,
      clearBuffer: noop,
      finish: () => ({}),
    }),
    queue: { writeBuffer: noop, submit: noop, onSubmittedWorkDone: async () => {} },
    destroy: noop,
  };
  return device;
}

test('on the WebGL2 layer, sort takes the one-invocation route; on WebGPU, the radix passes', async () => {
  const layer = standIn('margo-webgl2'),
    native = standIn('nvidia');
  const onLayer = await createCompute({ device: layer }),
    onNative = await createCompute({ device: native });
  assert.equal(typeof onLayer.sortRoute, 'string', 'createCompute waits for the route to load');
  assert.equal(onNative.sortRoute, undefined, 'WebGPU never loads it');
  onLayer.sort(onLayer.zeros(1000));
  onNative.sort(onNative.zeros(1000));
  const local = (codes) => codes.some((c) => c.includes('var<workgroup> sharedKeys'));
  assert.ok(layer.codes.includes(onLayer.sortRoute) && !local(layer.codes));
  assert.ok(local(native.codes) && !native.codes.some((c) => c.includes('spareKeys')));
});

test("the route's kernel on the layer's CPU tier: stable, by the same low bits as the 4-bit WebGPU passes", async () => {
  const { sortRoute } = await createCompute({ device: standIn('margo-webgl2') });
  let seed = 7;
  const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
  for (const [n, low] of [
    [3000, 32],
    [2000, 12],
    [1500, 8],
    [1, 32],
  ]) {
    // Many equal keys (stability shows), and bits above `low` set (the mask shows).
    const source = Uint32Array.from({ length: n }, () => (random() & 0xfff00000) | (random() % 97));
    const keys = source.slice(),
      values = Uint32Array.from({ length: n }, (_, i) => i),
      mask = low === 32 ? 0xffffffff : 2 ** low - 1;
    runComputeOnCPU({
      source: sortRoute,
      workgroups: [1],
      buffers: new Map([
        ['0:0', Uint32Array.of(n, mask, Math.ceil(low / 8), 1)],
        ['0:1', keys],
        ['0:2', values],
        ['0:3', new Uint32Array(n)],
        ['0:4', new Uint32Array(n)],
      ]),
    });
    const order = [...source.keys()].sort((a, b) => ((source[a] & mask) >>> 0) - ((source[b] & mask) >>> 0) || a - b);
    assert.deepEqual([...values], order, `n ${n}, ${low} bits: the stable order`);
    assert.deepEqual(
      [...keys],
      order.map((i) => source[i]),
      `n ${n}, ${low} bits: the keys moved with it`,
    );
  }
});

test('a wait rejects when queued work raised an internal error (the layer drops a pass over its CPU budget so)', async () => {
  const device = standIn('margo-webgl2'),
    gpu = await createCompute({ device });
  const x = gpu.zeros(64);
  device.internal = { message: 'A compute dispatch on the CPU tier stopped at its work budget' };
  const y = x.add(1).eval();
  await assert.rejects(y.read(), /GPU internal error: A compute dispatch on the CPU tier stopped at its work budget/);
});
