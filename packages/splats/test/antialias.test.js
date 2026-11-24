// Splats.antialias (Mip-Splatting's 2D filter) without a GPU: the flag is off by default and live, and the projection
// shader scales opacity by sqrt(det(S) / det(S + 0.3 I)) only when it is on. test/gpu/check.mjs proves the values.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Splats } from '../dist/index.js';
import { project } from '../src/shader.ts';

test('Splats.antialias is off by default and live', () => {
  const cloud = Splats.reserve(1);
  assert.equal(cloud.antialias, false);
  cloud.antialias = true;
  assert.equal(cloud.antialias, true);
  cloud.antialias = 0;
  assert.equal(cloud.antialias, false, 'coerced to a boolean');
});

test('the projection shader applies the 2D Mip filter behind counts.z', () => {
  const code = typeof project === 'function' ? project() : String(project);
  assert.match(code, /if\(f\.counts\.z==1u\)\{opacity\*=sqrt\(max\(\(xx-0\.3\)\*\(yy-0\.3\)-xy\*xy,0\.0\)\/max\(xx\*yy-xy\*xy,1e-12\)\);\}/);
  assert.match(code, /ellipse\.center=vec4f\(ndc,opacity\)/, 'the ellipse carries the filtered opacity');
});
