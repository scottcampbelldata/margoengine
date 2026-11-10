import assert from 'node:assert/strict';
import test from 'node:test';
import { densityScatter, DensityLayer } from '../dist/density.js';

globalThis.GPUBufferUsage = { UNIFORM: 1, COPY_DST: 2, STORAGE: 4, COPY_SRC: 8, MAP_READ: 16 };
globalThis.GPUShaderStage = { COMPUTE: 1, FRAGMENT: 2 };
const fake = () => {
  const destroyed = [],
    uploads = [],
    allocations = [];
  const device = {
    limits: { maxStorageBufferBindingSize: 48, maxBufferSize: 100000, maxComputeWorkgroupsPerDimension: 1 },
    createBuffer(o) {
      const b = {
        ...o,
        destroy() {
          destroyed.push(b);
        },
      };
      allocations.push(b);
      return b;
    },
    createBindGroupLayout: (x) => x,
    createPipelineLayout: (x) => x,
    createBindGroup: (x) => x,
    createComputePipeline: (x) => x,
    createShaderModule: (x) => x,
    queue: {
      writeBuffer(...a) {
        uploads.push(a);
      },
    },
  };
  const renderer = { device, add() {}, remove() {} };
  return { figure: { renderer, layers: [], addLayer: (x) => x }, destroyed, uploads, allocations };
};
test('density options reject malformed data before allocating, and aborted construction has no side effects', () => {
  const { figure, allocations } = fake();
  for (const options of [
    { mode: 'bad' },
    { bandwidth: 0 },
    { bandwidth: 33 },
    { opacity: NaN },
    { opacity: 2 },
    { color: 'bad' },
    { dimensions: 'invalid' },
  ])
    assert.throws(() => densityScatter(figure, new Float32Array(), options));
  assert.throws(() => densityScatter(figure, new Float32Array(2)), /xyz/);
  assert.throws(
    () => densityScatter(figure, new Float32Array(), { signal: AbortSignal.abort(new Error('cancelled')) }),
    /cancelled/,
  );
  assert.equal(allocations.length, 0);
});
test('density uploads every point in bounded chunks and caches unchanged views', () => {
  const { figure, uploads } = fake(),
    data = new Float32Array(11 * 3),
    layer = densityScatter(figure, data);
  const identity = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  layer.setModel(identity);
  let dispatches = 0,
    clears = 0;
  const context = {
    width: 2,
    height: 2,
    camera: { matrix: identity },
    encoder: {
      clearBuffer() {
        clears++;
      },
      beginComputePass() {
        return {
          setPipeline() {},
          setBindGroup() {},
          dispatchWorkgroups() {
            dispatches++;
          },
          end() {},
        };
      },
    },
  };
  layer.prepare(context);
  assert.equal(
    uploads.filter((a) => a[2].length !== 32).reduce((n, a) => n + a[2].length, 0),
    data.length,
  );
  assert.equal(dispatches, 3);
  assert.equal(clears, 1);
  layer.prepare(context);
  assert.equal(dispatches, 3);
  layer.setStyle({ mode: 'kernel' });
  layer.prepare(context);
  assert.equal(dispatches, 5);
  assert.equal(clears, 1);
  layer.invalidate();
  layer.prepare(context);
  assert.equal(clears, 2);
  assert.equal(dispatches, 10);
  layer.dispose();
  assert.throws(() => layer.setStyle({ opacity: 0.5 }), /dispos/);
});
test('source ownership is exclusive and restored when publication fails', () => {
  const { figure } = fake(),
    cloud = { positions: new Float32Array(3), visible: true },
    source = { cloud, bounds: [0, 1, 0, 1, 0, 0] };
  figure.layers.push(source);
  using layer = new DensityLayer(figure, source);
  assert.equal(cloud.visible, false);
  assert.throws(() => new DensityLayer(figure, source), /replacement/);
  layer.dispose();
  assert.equal(cloud.visible, true);
  figure.addLayer = () => {
    throw new RangeError('figure dimension');
  };
  assert.throws(() => densityScatter(figure, source), /dimension/);
  assert.equal(cloud.visible, true);
});

test('a replaced native cloud transfers draw suppression and retains current source bounds', () => {
  const { figure } = fake(),
    original = { positions: new Float32Array(3), visible: true },
    source = { cloud: original, bounds: [0, 1, 0, 1, 0, 0] };
  figure.layers.push(source);
  using layer = densityScatter(figure, source);
  const next = { positions: new Float32Array(6), visible: true };
  source.cloud = next;
  source.bounds = [-2, 2, -2, 2, 0, 0];
  assert.equal(layer.count, 2);
  assert.equal(original.visible, true);
  assert.equal(next.visible, false);
  assert.deepEqual(layer.bounds, source.bounds);
  layer.dispose();
  assert.equal(next.visible, true);
});

test('hidden replacement restores original source visibility before or after its first preparation', () => {
  for (const observe of [false, true]) {
    const { figure } = fake(),
      source = { cloud: { positions: new Float32Array(3), visible: true }, bounds: [0, 1, 0, 1, 0, 0] };
    figure.layers.push(source);
    using layer = densityScatter(figure, source);
    layer.visible = false;
    const next = { positions: new Float32Array(6), visible: false };
    source.cloud = next;
    if (observe) assert.equal(layer.count, 2);
    layer.dispose();
    assert.equal(
      next.visible,
      true,
      'native data replacement copied density visibility, not original source visibility',
    );
  }
});
