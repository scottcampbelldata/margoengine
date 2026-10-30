import test from 'node:test';
import assert from 'node:assert/strict';
import { preetham } from '@margoengine/sky/preetham';
import { preethamXyY } from './preetham-reference.js';

// Preetham, Shirley & Smits 1999, Appendix A.2: zenith chromaticity is [theta^3 theta^2 theta 1] * M * [T^2 T 1]^T,
// and zenith luminance is (4.0453 T - 4.9710) tan((4/9 - T/120)(pi - 2 theta)) - 0.2155 T + 2.4192.
const MX = [
    [0.00166, -0.00375, 0.00209, 0],
    [-0.02903, 0.06377, -0.03202, 0.00394],
    [0.11693, -0.21196, 0.06052, 0.25886],
  ],
  MY = [
    [0.00275, -0.0061, 0.00317, 0],
    [-0.04214, 0.0897, -0.04153, 0.00516],
    [0.15346, -0.26756, 0.0667, 0.26688],
  ],
  paper = (M, z, t) => {
    const v = [z ** 3, z ** 2, z, 1];
    return [t * t, t, 1].reduce((sum, tp, i) => sum + tp * v.reduce((s, vj, j) => s + vj * M[i][j], 0), 0);
  },
  paperYz = (z, t) => (4.0453 * t - 4.971) * Math.tan((4 / 9 - t / 120) * (Math.PI - 2 * z)) - 0.2155 * t + 2.4192;

// Evaluate the shader's own `let xz=...;` / `let zz=...;` / `let yz=max(0.001,...);` lines.
const shaderValue = (name, z, t) => {
  const line = preetham.wgsl.match(new RegExp(`let ${name}=(.*?);\n`))?.[1];
  assert.ok(line, `no ${name} line in the shader`);
  const js = line
    .replace(/\bmax\(/g, 'Math.max(')
    .replace(/\btan\(/g, 'Math.tan(')
    .replace(/3\.14159265/g, 'Math.PI');
  return new Function('z', 't', 'z2', 'z3', `return ${js};`)(z, t, z * z, z ** 3);
};

test("the sky shader's zenith chromaticity and luminance match the Preetham paper", () => {
  for (const sunY of [1, 0.8, 0.5, 0.2, 0.05])
    for (const t of [2, 3, 5, 8, 10]) {
      const z = Math.acos(sunY);
      assert.ok(Math.abs(shaderValue('xz', z, t) - paper(MX, z, t)) < 1e-9, `x zenith, sun ${sunY}, T ${t}`);
      assert.ok(Math.abs(shaderValue('zz', z, t) - paper(MY, z, t)) < 1e-9, `y zenith, sun ${sunY}, T ${t}`);
      assert.ok(
        Math.abs(shaderValue('yz', z, t) - Math.max(0.001, paperYz(z, t))) < 1e-9,
        `Y zenith, sun ${sunY}, T ${t}`,
      );
    }
});

test('the CPU reference chromaticity at the zenith is the paper zenith value', () => {
  for (const sunY of [1, 0.6, 0.3])
    for (const t of [2, 4, 9]) {
      const z = Math.acos(sunY),
        s = [Math.sqrt(1 - sunY * sunY), sunY, 0],
        { x, y } = preethamXyY([0, 1, 0], s, t, { locus: false });
      assert.ok(Math.abs(x - paper(MX, z, t)) < 1e-9, `x ${x}, sun ${sunY}, T ${t}`);
      assert.ok(Math.abs(y - paper(MY, z, t)) < 1e-9, `y ${y}, sun ${sunY}, T ${t}`);
    }
});
