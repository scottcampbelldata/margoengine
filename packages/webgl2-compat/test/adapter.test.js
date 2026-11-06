// allowCompatibilityAdapters against a fake navigator.gpu: which requests reach the browser, in which order.
// test/adapter-browser.mjs runs it on a real device.
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { allowCompatibilityAdapters } from '../dist/adapter.js';

const real = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
/** A browser that answers `answer(options)`, recording each request. `requestAdapter` sits on the prototype, as in browsers. */
const browser = (answer) => {
  const calls = [];
  class GPU {
    requestAdapter(options) {
      assert.ok(this instanceof GPU, 'called on the GPU object');
      calls.push(options);
      return Promise.resolve(answer(options));
    }
  }
  const gpu = new GPU();
  Object.defineProperty(globalThis, 'navigator', { value: { gpu }, configurable: true });
  return { gpu, calls };
};
const open = [];
const allow = (options) => {
  const handle = allowCompatibilityAdapters(options);
  open.push(handle);
  return handle;
};
afterEach(() => {
  for (const handle of open.splice(0)) handle.dispose();
  Object.defineProperty(globalThis, 'navigator', real);
});

/** An adapter whose device records the shader code it is given. */
const adapter = (limits = { maxColorAttachments: 8 }, deviceFeatures = []) => {
  const seen = { requests: [], code: [] },
    self = {
      limits,
      features: new Set(['core-features-and-limits']),
      seen,
      requestDevice(descriptor) {
        assert.equal(this, self, 'called on the adapter');
        seen.requests.push(descriptor);
        const device = {
          features: new Set(deviceFeatures),
          createShaderModule(module) {
            assert.equal(this, device, 'called on the device');
            seen.code.push(module.code);
            return { label: module.label };
          },
        };
        return Promise.resolve(device);
      },
    };
  return self;
};

test('a device with the full level never sees the compatibility request', async () => {
  const { gpu, calls } = browser(() => 'full');
  allow();
  assert.equal(await gpu.requestAdapter({ powerPreference: 'low-power' }), 'full');
  assert.deepEqual(calls, [{ powerPreference: 'low-power' }]);
});

test('no full adapter: the same request again at compatibility level', async () => {
  const older = adapter(),
    { gpu, calls } = browser((options) => (options?.featureLevel === 'compatibility' ? older : null));
  allow();
  assert.equal(await gpu.requestAdapter({ powerPreference: 'low-power' }), older);
  assert.deepEqual(calls, [{ powerPreference: 'low-power' }, { powerPreference: 'low-power', featureLevel: 'compatibility' }]);
});

test('no adapter at all stays null, so a fallback still runs', async () => {
  const { gpu } = browser(() => null);
  allow();
  assert.equal(await gpu.requestAdapter(), null);
});

test('force goes straight to compatibility level', async () => {
  const older = adapter(),
    { gpu, calls } = browser(() => older);
  allow({ force: true });
  assert.equal(await gpu.requestAdapter({}), older);
  assert.deepEqual(calls, [{ featureLevel: 'compatibility' }]);
});

test('a compatibility device takes every limit the adapter has, and a limit the caller set wins', async () => {
  const older = adapter({ maxColorAttachments: 8, maxComputeWorkgroupSizeX: 1024 }),
    { gpu } = browser(() => older);
  allow({ force: true });
  await (await gpu.requestAdapter()).requestDevice({
    requiredFeatures: ['float32-filterable'],
    requiredLimits: { maxColorAttachments: 6 },
  });
  assert.deepEqual(older.seen.requests, [
    {
      requiredFeatures: ['float32-filterable'],
      requiredLimits: { maxColorAttachments: 6, maxComputeWorkgroupSizeX: 1024 },
    },
  ]);
});

test('a compatibility device takes flat varyings without first-vertex sampling', async () => {
  const older = adapter(),
    { gpu } = browser(() => older);
  allow({ force: true });
  const device = await (await gpu.requestAdapter()).requestDevice(),
    code = '@location(4) @interpolate(flat) a:u32,@location(5) @interpolate( flat ) b:u32,@interpolate(flat, first) c:u32';
  assert.deepEqual(device.createShaderModule({ label: 'pick', code }), { label: 'pick' });
  assert.deepEqual(older.seen.code, [
    '@location(4) @interpolate(flat, either) a:u32,@location(5) @interpolate(flat, either) b:u32,@interpolate(flat, first) c:u32',
  ]);
});

test('a device that asked for the full level keeps its shaders', async () => {
  const older = adapter(undefined, ['core-features-and-limits']),
    { gpu } = browser(() => older);
  allow({ force: true });
  const device = await (await gpu.requestAdapter()).requestDevice({ requiredFeatures: ['core-features-and-limits'] });
  device.createShaderModule({ code: '@interpolate(flat) a:u32' });
  assert.deepEqual(older.seen.code, ['@interpolate(flat) a:u32']);
});

test('a rejected request stays rejected', async () => {
  const { gpu } = browser(() => {
    throw new Error('blocked');
  });
  allow();
  await assert.rejects(gpu.requestAdapter(), /blocked/);
});

test('dispose puts the browser back, once, and a new call works', async () => {
  const { gpu, calls } = browser(() => null),
    native = gpu.requestAdapter,
    first = allow();
  assert.notEqual(gpu.requestAdapter, native);
  first.dispose();
  first.dispose();
  assert.equal(gpu.requestAdapter, native);
  assert.ok(!Object.hasOwn(gpu, 'requestAdapter'));
  await gpu.requestAdapter();
  assert.equal(calls.length, 1, 'one request, no retry');
  const second = allow();
  first.dispose();
  assert.notEqual(gpu.requestAdapter, native, 'the old handle leaves the new call alone');
  second[Symbol.dispose]();
  assert.equal(gpu.requestAdapter, native);
});

test('a second call while one is active says so, and no WebGPU says so', () => {
  browser(() => null);
  allow();
  assert.throws(() => allowCompatibilityAdapters(), (error) => error.code === 'state');
  Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true });
  assert.throws(() => allowCompatibilityAdapters(), (error) => error.code === 'unsupported');
});
