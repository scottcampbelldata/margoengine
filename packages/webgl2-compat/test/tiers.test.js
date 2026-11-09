import assert from 'node:assert/strict';
import test from 'node:test';
import { getEventListeners } from 'node:events';
import { COMPAT_LIMITS, uninstall, waitFor } from '../dist/index.js';
import {
  createTieredGPU,
  installTiers,
  requireCompatTier,
  tierFormats,
  tierSubstitutions,
  tierTextureFormat,
} from '../dist/tiers.js';

function context(tier, highp = true) {
  return {
    ...Object.fromEntries(COMPAT_LIMITS.map((name, i) => [name, i + 100])),
    FRAGMENT_SHADER: 1,
    HIGH_FLOAT: 2,
    HIGH_INT: 3,
    RENDERER: 4,
    VERSION: 5,
    SHADING_LANGUAGE_VERSION: 6,
    lost: false,
    getExtension(name) {
      if (name === 'WEBGL_lose_context')
        return {
          loseContext: () => {
            this.lost = true;
          },
        };
      return name ===
        (tier === 'full' ? 'EXT_color_buffer_float' : tier === 'half-float' ? 'EXT_color_buffer_half_float' : '')
        ? {}
        : null;
    },
    getParameter() {
      return 4096;
    },
    getShaderPrecisionFormat(_shader, type) {
      return highp ? { precision: type === 2 ? 23 : 0, rangeMin: 127, rangeMax: 127 } : null;
    },
  };
}

test('tier creation rejects pre-aborted and in-flight module waits without allocating a context', async () => {
  let made = 0;
  const createContext = () => {
    made++;
    return context('ldr');
  };
  const controller = new AbortController(),
    reason = new Error('caller stopped');
  controller.abort(reason);
  await assert.rejects(createTieredGPU({ signal: controller.signal, createContext }), (error) => error === reason);
  await assert.rejects(installTiers({ signal: controller.signal, createContext }), (error) => error === reason);
  const inFlight = new AbortController();
  const pending = createTieredGPU({ signal: inFlight.signal, createContext });
  inFlight.abort(reason);
  await assert.rejects(pending, (error) => error === reason);
  assert.equal(made, 0);
  assert.deepEqual(getEventListeners(inFlight.signal, 'abort'), []);
});

test('abort stops a never-settling wait immediately and releases its listener; another waiter retains ownership', async () => {
  let finish;
  const shared = new Promise((resolve) => {
    finish = resolve;
  });
  const a = new AbortController(),
    b = new AbortController();
  const first = waitFor(shared, a.signal),
    second = waitFor(shared, b.signal);
  const reason = { stopped: true };
  a.abort(reason);
  await assert.rejects(first, (error) => error === reason);
  assert.deepEqual(getEventListeners(a.signal, 'abort'), []);
  finish(42);
  assert.equal(await second, 42);
  assert.deepEqual(getEventListeners(b.signal, 'abort'), []);
  const failed = new Error('load failed');
  await assert.rejects(waitFor(Promise.reject(failed), b.signal), (error) => error === failed);
  assert.deepEqual(getEventListeners(b.signal, 'abort'), []);
});

test('cancelled native probing never installs later or uninstalls a concurrent successful owner', async () => {
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  let queried, complete;
  const started = new Promise((resolve) => {
    queried = resolve;
  });
  const native = {
    requestAdapter: () => {
      queried();
      return new Promise((resolve) => {
        complete = resolve;
      });
    },
  };
  Object.defineProperty(globalThis, 'navigator', { value: { gpu: native }, configurable: true });
  try {
    const controller = new AbortController(),
      reason = new Error('cancel native wait');
    let probes = 0;
    const pending = installTiers({
      signal: controller.signal,
      createContext: () => {
        probes++;
        return context('ldr');
      },
    });
    await started;
    controller.abort(reason);
    await assert.rejects(pending, (error) => error === reason);
    assert.equal(navigator.gpu, native);
    assert.equal(probes, 0);
    assert.deepEqual(getEventListeners(controller.signal, 'abort'), []);
    const owner = await installTiers({ force: true, createContext: () => context('ldr') });
    complete(null);
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(navigator.gpu, owner.gpu);
    assert.equal(probes, 0);
    assert.equal(uninstall(), true);
    assert.equal(navigator.gpu, native);
  } finally {
    uninstall();
    if (saved) Object.defineProperty(globalThis, 'navigator', saved);
    else delete globalThis.navigator;
  }
});

for (const nativeAdapter of [null, {}])
  test(`concurrent native probe (${nativeAdapter ? 'present' : 'absent'}) preserves the first installation and its restore chain`, async () => {
    const saved = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    let queried, complete;
    const started = new Promise((resolve) => {
      queried = resolve;
    });
    const native = {
      requestAdapter: () => {
        queried();
        return new Promise((resolve) => {
          complete = resolve;
        });
      },
    };
    Object.defineProperty(globalThis, 'navigator', { value: { gpu: native }, configurable: true });
    try {
      let probes = 0;
      const pending = installTiers({
        createContext: () => {
          probes++;
          return context('ldr');
        },
      });
      await started;
      const owner = await installTiers({ force: true, createContext: () => context('ldr') });
      complete(nativeAdapter);
      const second = await pending;
      assert.equal(second.reason, 'already');
      assert.equal(second.gpu, owner.gpu);
      assert.equal(probes, 0);
      assert.equal(uninstall(), true);
      assert.equal(navigator.gpu, native);
    } finally {
      uninstall();
      if (saved) Object.defineProperty(globalThis, 'navigator', saved);
      else delete globalThis.navigator;
    }
  });

test('tier-aware adapters report the actual best tier and respect the requested minimum', async () => {
  for (const tier of ['full', 'half-float', 'ldr']) {
    const adapter = await (await createTieredGPU({ createContext: () => context(tier) })).requestAdapter();
    assert.equal(adapter.capabilities.tier, tier);
    assert.match(adapter.info.description, new RegExp(tier));
    assert.equal(!!adapter.tierFormats, tier !== 'full');
  }
  const rejected = context('ldr');
  assert.equal(
    await (await createTieredGPU({ minimumTier: 'half-float', createContext: () => rejected })).requestAdapter(),
    null,
  );
  assert.equal(rejected.lost, true);
  const noHighp = context('ldr', false);
  assert.equal(await (await createTieredGPU({ createContext: () => noHighp })).requestAdapter(), null);
  assert.equal(noHighp.lost, true);
  for (const invalid of ['bad', 'constructor', '__proto__'])
    await assert.rejects((await createTieredGPU({ minimumTier: invalid })).requestAdapter(), /minimumTier/);
});

test('installTiers probes the supplied context factory and preserves uninstall ownership', async () => {
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const made = [];
  Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true });
  try {
    await assert.rejects(
      installTiers({ minimumTier: 'half-float', createContext: () => context('ldr') }),
      (error) =>
        error.code === 'unsupported' &&
        error.message.includes('EXT_color_buffer_half_float') &&
        !error.message.includes('EXT_color_buffer_float'),
    );
    assert.equal(globalThis.navigator.gpu, undefined, 'refusal changes no installation globals');
    const result = await installTiers({
      createContext: () => {
        const gl = context('ldr');
        made.push(gl);
        return gl;
      },
    });
    assert.equal(result.installed, true);
    assert.equal(made[0].lost, true, 'probe context released');
    const adapter = await result.gpu.requestAdapter();
    assert.equal(adapter.capabilities.tier, 'ldr');
    assert.equal(made[1].lost, false, 'device context retained');
    assert.equal(uninstall(), true);
    assert.equal(globalThis.navigator.gpu, undefined);
  } finally {
    uninstall();
    if (saved) Object.defineProperty(globalThis, 'navigator', saved);
    else delete globalThis.navigator;
  }
});

test('all seven float targets map by channel count while depth, integers and sample-only data retain their formats', () => {
  const targets = ['r16float', 'rg16float', 'rgba16float', 'r32float', 'rg32float', 'rgba32float', 'rg11b10ufloat'];
  for (const format of targets) {
    const prefix =
      format.startsWith('rgba') || format === 'rg11b10ufloat' ? 'rgba' : format.startsWith('rg') ? 'rg' : 'r';
    assert.equal(tierTextureFormat(format, 'full'), format);
    assert.equal(tierTextureFormat(format, 'half-float'), `${prefix}16float`);
    assert.equal(tierTextureFormat(format, 'ldr'), `${prefix}8unorm`);
    assert.equal(tierTextureFormat(format, 'ldr', 4 | 2), format, 'sample-only precision is retained');
    assert.equal(tierTextureFormat(format, 'ldr', 8), `${prefix}8unorm`, 'compute storage uses the target policy');
  }
  for (const format of [
    'depth32float',
    'depth16unorm',
    'depth24plus-stencil8',
    'rgba32uint',
    'rgba32sint',
    'rgba8unorm',
    'rgba8unorm-srgb',
    'rgb9e5ufloat',
  ])
    for (const tier of ['full', 'half-float', 'ldr']) assert.equal(tierTextureFormat(format, tier), format);
  assert.equal(tierSubstitutions('ldr').length, 7);
  assert.equal(tierSubstitutions('half-float').length, 4);
  assert.deepEqual(tierSubstitutions('full'), []);
  assert.throws(() => tierTextureFormat('rgba32float', 'invalid'), /tier must/);
});

test('feature requirements refuse before allocation, with coded diagnostics; native devices pass', () => {
  const device = { adapter: { capabilities: { tier: 'ldr' } } };
  assert.throws(
    () => requireCompatTier(device, 'HDR lighting'),
    (e) => e.code === 'unsupported' && /HDR lighting.*full.*ldr/.test(e.message),
  );
  requireCompatTier(device, 'LDR capture', 'ldr');
  requireCompatTier({}, 'Native lighting');
  requireCompatTier(null, 'No compatibility device');
  assert.throws(() => requireCompatTier(device, 'Invalid', 'constructor'), TypeError);
});

// The adapter policy returns FormatInfo records without allocating a device or GPU resource.
function info(name, channels, bytes, type) {
  return {
    name,
    channels,
    bytes,
    type,
    kind: 'float',
    renderable: true,
    channelBytes: type === 'FLOAT' ? 4 : type === 'HALF_FLOAT' ? 2 : 0,
  };
}

test('logical float32 upload bytes become legal physical LDR uploads, including clamp and nonfinite values', () => {
  const policy = tierFormats('ldr'),
    logical = info('rgba32float', 4, 16, 'FLOAT');
  const physical = policy.target(logical, 16);
  const bytes = new Uint8Array(new Float32Array([-1, 0.5, 2, 1, -Infinity, Infinity, NaN, 0]).buffer);
  const upload = policy.upload(logical, physical, bytes);
  assert.equal(upload.info.type, 'UNSIGNED_BYTE');
  assert.equal(upload.info.bytes, 4);
  assert.deepEqual([...upload.bytes], [0, 128, 255, 255, 0, 255, 0, 0]);
  assert.deepEqual([...new Float32Array(bytes.buffer)].slice(0, 4), [-1, 0.5, 2, 1], 'input unchanged');
});

test('half-float and packed upload conversion retains signs, HDR range, denormals and implicit alpha', () => {
  const policy = tierFormats('half-float'),
    logical = info('rg32float', 2, 8, 'FLOAT');
  const bytes = new Uint8Array(new Float32Array([-0.25, 400]).buffer);
  const uploaded = policy.upload(logical, policy.target(logical, 16), bytes);
  assert.equal(uploaded.info.type, 'FLOAT');
  assert.equal(uploaded.info.bytes, 8);
  assert.deepEqual([...new Float32Array(uploaded.bytes.buffer)], [-0.25, 400]);
  const halfLogical = info('rgba16float', 4, 8, 'HALF_FLOAT');
  const halfBytes = new Uint8Array(new Uint16Array([0x8000, 1, 0x3c00, 0x7c00]).buffer);
  const ldr = tierFormats('ldr');
  assert.deepEqual([...ldr.upload(halfLogical, ldr.target(halfLogical, 16), halfBytes).bytes], [0, 0, 255, 255]);
  const packedLogical = info('rg11b10ufloat', 3, 4, 'UNSIGNED_INT_10F_11F_11F_REV');
  const packedBytes = new Uint8Array(new Uint32Array([0x3c0 | (0x400 << 11) | (0x1c0 << 22)]).buffer);
  const expanded = policy.upload(packedLogical, policy.target(packedLogical, 16), packedBytes);
  assert.deepEqual([...new Float32Array(expanded.bytes.buffer)], [1, 2, 0.5, 1]);
  assert.equal(
    policy.upload(halfLogical, halfLogical, halfBytes).bytes,
    halfBytes,
    'unchanged storage has no conversion',
  );
});

test('LDR stores select a single UNORM8 rounding rule across raster, compute and uploads, without quantizing before blending', () => {
  const policy = tierFormats('ldr');
  const source = 'layout(location = 0) out vec4 _o0; void main() { _o0 = vec4(0.5); return; }';
  const outputs = [{ location: 0 }];
  const lowered = policy.fragment(source, [{ format: 'rgba32float' }], outputs);
  assert.match(lowered, /void _margoTierMain\(\)/);
  assert.match(
    lowered,
    /void main\(\) \{ _margoTierMain\(\); _o0 = \(floor\(clamp\(_o0, 0.0, 1.0\) \* 255.0 \+ 0.5\) \/ 255.0\); \}/,
  );
  assert.equal(
    policy.fragment(source, [{ format: 'rgba32float', blend: {} }], outputs),
    source,
    'blending quantizes the blended result in hardware',
  );
  assert.equal(policy.fragment(source, [{ format: 'rgba32uint' }], outputs), source);
  assert.equal(
    policy.fragment(source, [{ format: 'rgba32float' }], []),
    source,
    'inactive attachments declare no output variable',
  );
  assert.equal(tierFormats('half-float').fragment(source, [{ format: 'rgba32float' }], outputs), source);
  assert.equal(
    policy.store('texelFetch(t, p, 0)', 'rgba32float'),
    '(floor(clamp(texelFetch(t, p, 0), 0.0, 1.0) * 255.0 + 0.5) / 255.0)',
  );
});
