import assert from 'node:assert/strict';
import { random } from './random.js';

// Shared with the CPU tests so the hardware runner cannot silently omit a case class.
export function fixedLerpCases() {
  const fractions = [0, 1, 32767, 32768, 65535, 65536];
  const corners = [-2147483648, -2147483647, -65537, -1, 0, 1, 65535, 65536, 2147483646, 2147483647];
  const cases = [];
  for (const a of corners)
    for (const b of corners) for (const fx of fractions) for (const fz of fractions) cases.push([a, b, b, a, fx, fz]);
  for (const grid of [
    [-2147483648, 2147483647, -1, 1],
    [0, 1, 2147483647, -2147483648],
    [-7, 8, 13, -2],
    [2147483647, 2147483647, 2147483647, 2147483647],
  ])
    for (const fx of fractions) for (const fz of fractions) cases.push([...grid, fx, fz]);
  const next = random(0x165536);
  for (let i = 0; i < 1024; i++) {
    const values = Array.from({ length: 4 }, () => (next() * 4294967296) | 0);
    cases.push([...values, Math.floor(next() * 65537), Math.floor(next() * 65537)]);
  }
  return cases;
}

export function lerpOracle(a, b, f) {
  const product = (BigInt(b) - BigInt(a)) * BigInt(f);
  return Number(BigInt(a) + (product >= 0n ? product / 65536n : -((-product + 65535n) / 65536n)));
}

export function bilinearOracle(a, b, c, d, fx, fz) {
  return lerpOracle(lerpOracle(a, b, fx), lerpOracle(c, d, fx), fz);
}

export function requireHardwareAdapter(info) {
  assert.equal(info.fallback, false, 'Require a positively identified non-fallback WebGPU adapter');
  assert.equal(info.nameSource, 'webgpu', 'WebGPU adapter description missing; cannot identify the GPU that ran WGSL');
  assert.ok(info.name?.trim(), 'WebGPU adapter description missing; cannot identify the GPU that ran WGSL');
  assert.doesNotMatch(
    [info.name, info.vendor, info.architecture, info.device, info.renderer].join(' '),
    /swiftshader|llvmpipe|lavapipe|softpipe|basic render|\bwarp\b|software|virtual|vmware|virgl|qemu|parallels|remote display/i,
    'Require a physical hardware GPU',
  );
  const rendererDevice = info.renderer?.match(/\b0x([0-9a-f]+)\b/i);
  if (typeof info.device === 'string' && /^(?:0x)?[0-9a-f]+$/i.test(info.device.trim()) && rendererDevice) {
    assert.equal(
      Number.parseInt(info.device.trim(), 16),
      Number.parseInt(rendererDevice[1], 16),
      'WebGPU adapter device does not match the WebGL renderer',
    );
  }
  return info.name;
}
