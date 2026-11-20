// MeshReflector (drei's MeshReflectorMaterial over a flat mesh): options, live values and its surface shader.
import test from 'node:test';
import assert from 'node:assert/strict';
import { MeshReflector } from '../dist/reflector-pbr.js';
import { Reflector } from '../dist/reflector.js';

test('MeshReflector takes the mix options with their defaults and checks every value', () => {
  const r = new MeshReflector();
  assert.ok(r instanceof Reflector);
  assert.deepEqual(
    [r.mixStrength, r.mixBlur, r.mixContrast, r.mirror, r.blurSize, r.depthScale, r.minDepthThreshold, r.maxDepthThreshold, r.depthToBlurRatioBias, r.reflectorOffset, r.f0],
    [1, 1, 1, 0, [0, 0], 0, 0.9, 1, 0.25, 0, [0.04, 0.04, 0.04]],
  );
  assert.equal(r.roughness, 0, 'no blur, no mip chain');
  r.blurSize = [300, 100];
  assert.equal(r.roughness, 1, 'a blur builds the mip chain');
  r.blurSize = [0, 0];
  assert.equal(r.roughness, 0);
  assert.throws(() => (r.roughness = 0.5), /blur and mixBlur/);
  assert.throws(() => new MeshReflector({ roughness: 0.5 }), /blur and mixBlur/);
  for (const [key, value] of [
    ['mixStrength', -1],
    ['mixBlur', NaN],
    ['mixContrast', Infinity],
    ['mirror', 1.5],
    ['depthScale', -0.1],
    ['depthToBlurRatioBias', 2],
    ['reflectorOffset', NaN],
    ['minDepthThreshold', '0'],
  ])
    assert.throws(() => (r[key] = value), RangeError, key);
  assert.throws(() => (r.blurSize = [1]), TypeError);
  assert.throws(() => (r.blurSize = [5000, 0]), RangeError);
  assert.throws(() => (r.f0 = [2, 0, 0]), RangeError);
  const custom = new MeshReflector({ mixStrength: 40, blur: [8, 2], mirror: 0.5, f0: '#ffffff', reflectorOffset: -0.1 });
  assert.deepEqual([custom.mixStrength, custom.blurSize, custom.mirror, custom.f0, custom.reflectorOffset], [40, [8, 2], 0.5, [1, 1, 1], -0.1]);
});

test('MeshReflector blends over the mesh: its shader writes weighted colour and a mean weight, and reads capture depth', () => {
  const r = new MeshReflector();
  const shader = r.surfaceShader;
  assert.match(shader, /@binding\(5\) var captureDepth:texture_depth_2d/);
  assert.match(shader, /mInv:mat4x4f \}/);
  assert.match(shader, /return vec4f\(c\*weight,alpha\);/);
  assert.doesNotMatch(shader, /return vec4f\(c,1\.0\);/, 'no opaque write left from the base surface');
  assert.equal(r.surfaceBlend.color.dstFactor, 'one-minus-src-alpha');
  assert.equal(r.surfaceUniformLength, 104);
  assert.equal(new Reflector().surfaceBlend, undefined, 'the plain mirror stays opaque');
});
