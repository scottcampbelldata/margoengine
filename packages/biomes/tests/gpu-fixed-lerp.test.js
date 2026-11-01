import assert from 'node:assert/strict';
import test from 'node:test';
import { bilinear } from '../src/fixed.ts';
import { FIXED_LERP_WGSL, bilinearQ16Ref, lerpQ16Ref } from '../src/gpu-fixed-lerp.ts';
import { fixedLerpCases, lerpOracle, bilinearOracle, requireHardwareAdapter } from './gpu-fixed-lerp-cases.mjs';

test('Q16 references match exact floor arithmetic over Int32 corners and inclusive fractions', () => {
  for (const [a, b, c, d, fx, fz] of fixedLerpCases()) {
    assert.equal(lerpQ16Ref(a, b, fx), lerpOracle(a, b, fx), `lerp ${[a, b, fx]}`);
    assert.equal(bilinearQ16Ref(a, b, c, d, fx, fz), bilinearOracle(a, b, c, d, fx, fz));
    assert.equal(bilinearQ16Ref(a, b, c, d, fx, fz), bilinear(new Int32Array([a, b, c, d]), 2, 2, fx, fz));
  }
});

test('negative fractional differences floor, and the clamped upper endpoint reaches b', () => {
  assert.equal(lerpQ16Ref(0, -1, 1), -1);
  assert.equal(lerpQ16Ref(7, -8, 32768), -1);
  assert.equal(lerpQ16Ref(-2147483648, 2147483647, 65536), 2147483647);
  assert.equal(lerpQ16Ref(2147483647, -2147483648, 65536), -2147483648);
});

test('the exact WGSL path contains integer operations only', () => {
  assert.doesNotMatch(FIXED_LERP_WGSL, /\b(?:f32|f16|float|i64|u64)\b|\d+\.\d+/);
  assert.match(FIXED_LERP_WGSL, /fn lerpQ16\(/);
  assert.match(FIXED_LERP_WGSL, /fn bilinearQ16\(/);
});

test('hardware proof rejects missing, unknown, software, virtual and fallback adapters', () => {
  for (const info of [
    {},
    { name: 'GPU', fallback: null },
    { name: '', fallback: false },
    { name: 'RTX A6000', fallback: true },
    ...['SwiftShader', 'llvmpipe', 'Microsoft Basic Render Driver', 'WARP', 'software', 'VMware', 'Virtual GPU'].map(
      (name) => ({ name, fallback: false }),
    ),
    { name: 'GPU', fallback: false, vendor: 'software' },
  ]) {
    assert.throws(() => requireHardwareAdapter({ nameSource: 'webgpu', ...info }));
  }
});

test('WebGL adapter names are rejected even when the WebGPU vendor matches', () => {
  for (const vendor of [undefined, '', '   ', 123, 'amd', 'nvidia', 'NVIDIA']) {
    assert.throws(
      () => requireHardwareAdapter({
        name: 'ANGLE (NVIDIA, NVIDIA RTX A6000)',
        nameSource: 'webgl',
        renderer: 'ANGLE (NVIDIA, NVIDIA RTX A6000)',
        vendor,
        fallback: false,
      }),
      /WebGPU adapter description missing; cannot identify the GPU that ran WGSL/,
    );
  }
});

test('hardware proof requires a WebGPU name source', () => {
  for (const nameSource of [undefined, null, '', 'webgl', 'unknown']) {
    assert.throws(
      () => requireHardwareAdapter({ name: 'NVIDIA RTX A6000', nameSource, fallback: false }),
      /WebGPU adapter description missing; cannot identify the GPU that ran WGSL/,
    );
  }
});

test('WebGPU descriptions are accepted without a WebGL vendor link', () => {
  assert.equal(
    requireHardwareAdapter({ name: 'NVIDIA RTX A6000', nameSource: 'webgpu', fallback: false }),
    'NVIDIA RTX A6000',
  );
});

test('hardware proof rejects mismatched WebGPU and WebGL PCI device ids', () => {
  assert.throws(
    () => requireHardwareAdapter({
      name: 'NVIDIA RTX A6000',
      nameSource: 'webgpu',
      device: '0x2231',
      renderer: 'ANGLE (NVIDIA, NVIDIA RTX A6000 (0x00002230) Direct3D11)',
      fallback: false,
    }),
    /WebGPU adapter device does not match the WebGL renderer/,
  );
});

test('hardware proof accepts numerically matching WebGPU and WebGL PCI device ids', () => {
  for (const device of ['0x2230', '2230', '0X00002230', ' 0x2230 ']) {
    assert.equal(
      requireHardwareAdapter({
        name: 'NVIDIA RTX A6000',
        nameSource: 'webgpu',
        device,
        renderer: 'ANGLE (NVIDIA, NVIDIA RTX A6000 (0x00002230) Direct3D11)',
        fallback: false,
      }),
      'NVIDIA RTX A6000',
    );
  }
});
