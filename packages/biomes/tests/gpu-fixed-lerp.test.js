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
  assert.equal(
    requireHardwareAdapter({ name: 'ANGLE (NVIDIA RTX A6000)', fallback: false }),
    'ANGLE (NVIDIA RTX A6000)',
  );
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
    assert.throws(() => requireHardwareAdapter(info));
  }
});

test('WebGL adapter names require a non-empty WebGPU vendor', () => {
  for (const vendor of [undefined, '', '   ', 123]) {
    assert.throws(
      () => requireHardwareAdapter({
        name: 'ANGLE (NVIDIA, NVIDIA RTX A6000)',
        nameSource: 'webgl',
        renderer: 'ANGLE (NVIDIA, NVIDIA RTX A6000)',
        vendor,
        fallback: false,
      }),
      /WebGPU adapter vendor does not match the WebGL renderer; cannot identify the GPU that ran WGSL/,
    );
  }
});

test('WebGL adapter names reject a mismatched WebGPU vendor', () => {
  assert.throws(
    () => requireHardwareAdapter({
      name: 'ANGLE (NVIDIA, NVIDIA RTX A6000)',
      nameSource: 'webgl',
      renderer: 'ANGLE (NVIDIA, NVIDIA RTX A6000)',
      vendor: 'amd',
      fallback: false,
    }),
    /WebGPU adapter vendor does not match the WebGL renderer; cannot identify the GPU that ran WGSL/,
  );
});

test('WebGL adapter names accept a matching WebGPU vendor ignoring case', () => {
  const renderer = 'ANGLE (NVIDIA, NVIDIA RTX A6000)';
  assert.equal(
    requireHardwareAdapter({ name: renderer, nameSource: 'webgl', renderer, vendor: 'nvidia', fallback: false }),
    renderer,
  );
});

test('WebGPU descriptions are accepted without a WebGL vendor link', () => {
  assert.equal(
    requireHardwareAdapter({ name: 'NVIDIA RTX A6000', nameSource: 'webgpu', fallback: false }),
    'NVIDIA RTX A6000',
  );
});
