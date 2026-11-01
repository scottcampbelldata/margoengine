// Seeded correctness fixtures, shared by transport tests and the hardware runner. No timings.
import { random } from './random.js';
import { lerpOracle } from './gpu-fixed-lerp-cases.mjs';
export { requireHardwareAdapter } from './gpu-fixed-lerp-cases.mjs';

export function warpCases() {
  return [
    { seed: 3, cell: 4000, gx: -1, gz: -1, n: 18, depth: 18 },
    { seed: 0xffffffff, cell: 2000, gx: -41, gz: -9, n: 130, depth: 130 },
    { seed: 3, cell: 2000, gx: -8, gz: -1, n: 7, depth: 19 },
    { seed: 0xffffffff, cell: 4000, gx: 13, gz: -200, n: 33, depth: 5 },
    { seed: 3, cell: 4000, gx: 0, gz: 0, n: 1, depth: 1 },
    { seed: 0xffffffff, cell: 2000, gx: -1, gz: -1, n: 1, depth: 1 },
    { seed: 3, cell: 4000, gx: -41, gz: 7, n: 9, depth: 17 },
    { seed: 0xffffffff, cell: 2000, gx: 7, gz: 7, n: 1, depth: 2 },
  ];
}

export function syntheticWarpCases() {
  const next = random(0x5eed7a1e);
  return warpCases().map((spec, index) => {
    const a0 = Math.floor(spec.gx / 8),
      b0 = Math.floor(spec.gz / 8),
      span = Math.floor((spec.gx + spec.n) / 8) - a0 + 2,
      rows = Math.floor((spec.gz + spec.depth) / 8) - b0 + 2;
    const corners = (phase) =>
      Int32Array.from({ length: span * rows }, (_, k) => {
        if (index === 4) return 32767; // n1=-1 requires floor(-160/32768)=-1, whereas trunc gives 0.
        if (index === 6) return -13389004;
        if (index === 7) return 13389004;
        if (index === 5) return (k + phase) % 2 ? -13389004 : 13389004;
        return Math.floor(next() * 26778009) - 13389004;
      });
    return { ...spec, lattice: { a0, b0, span, rows, warpA: corners(0), warpB: corners(1) } };
  });
}

export function warpOracle(lattice, gx, gz, n, depth) {
  const n1 = new Int32Array(n * depth),
    n2 = new Int32Array(n * depth),
    dT = new Int32Array(n * depth);
  for (let z = 0; z < depth; z++)
    for (let x = 0; x < n; x++) {
      const lx = gx + x - lattice.a0 * 8,
        lz = gz + z - lattice.b0 * 8,
        at = Math.floor(lz / 8) * lattice.span + Math.floor(lx / 8),
        fx = (lx % 8) * 8192,
        fz = (lz % 8) * 8192,
        k = z * n + x;
      for (const [grid, output] of [
        [lattice.warpA, n1],
        [lattice.warpB, n2],
      ]) {
        const top = lerpOracle(grid[at], grid[at + 1], fx),
          bottom = lerpOracle(grid[at + lattice.span], grid[at + lattice.span + 1], fx);
        output[k] = lerpOracle(top, bottom, fz) - 32768;
      }
      const product = BigInt(n1[k]) * 160n;
      dT[k] = Number(product >= 0n ? product / 32768n : -((-product + 32767n) / 32768n));
    }
  return { n1, n2, dT };
}
