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
  assert.ok(info.name?.trim(), 'Require an actual browser-reported adapter name');
  assert.doesNotMatch(
    [info.name, info.vendor, info.architecture, info.device, info.renderer].join(' '),
    /swiftshader|llvmpipe|lavapipe|softpipe|basic render|\bwarp\b|software|virtual|vmware|virgl|qemu|parallels|remote display/i,
    'Require a physical hardware GPU',
  );
  if (info.nameSource === 'webgl') {
    assert.ok(
      typeof info.vendor === 'string' &&
        info.vendor.trim().length > 0 &&
        typeof info.renderer === 'string' &&
        info.renderer.toLowerCase().includes(info.vendor.trim().toLowerCase()),
      'WebGPU adapter vendor does not match the WebGL renderer; cannot identify the GPU that ran WGSL',
    );
  }
  return info.name;
}
