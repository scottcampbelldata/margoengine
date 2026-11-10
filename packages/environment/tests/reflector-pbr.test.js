import test from 'node:test';
import assert from 'node:assert/strict';
import { PBRReflector, reflectorFresnel, reflectorBlurFraction } from '../dist/reflector-pbr.js';
import { Reflector } from '../dist/reflector.js';

test('Fresnel floor follows Schlick endpoints and contact blur follows world distance', () => {
  assert.equal(reflectorFresnel(1), 0.04);
  assert.equal(reflectorFresnel(0), 1);
  assert.equal(reflectorFresnel(0.5), 0.07);
  for (let i = 0; i <= 100; i++) {
    const cosine = i / 100;
    assert.ok(reflectorFresnel(cosine) >= 0.04 && reflectorFresnel(cosine) <= 1);
    assert.equal(reflectorFresnel(cosine, 1), 1);
  }
  assert.equal(reflectorBlurFraction(0), 0);
  assert.equal(reflectorBlurFraction(5), 0.5);
  assert.equal(reflectorBlurFraction(20), 1);
  for (const v of [-1, NaN, Infinity]) {
    assert.throws(() => reflectorFresnel(v));
    assert.throws(() => reflectorBlurFraction(v));
  }
  assert.throws(() => reflectorBlurFraction(1, 0));
  assert.throws(() => reflectorBlurFraction(1, Number.MIN_VALUE));
  assert.throws(() => reflectorBlurFraction(1, Number.MAX_VALUE));
});

test('PBR floor owns the existing capture lifecycle and extends only its surface shader and data', () => {
  const plain = new Reflector(),
    floor = new PBRReflector({ baseColor: [0.2, 0.3, 0.4], ior: 1.33, metalness: 0.5 });
  assert.ok(floor instanceof Reflector);
  assert.equal(plain.surfaceUniformLength, 64);
  assert.equal(floor.surfaceUniformLength, 96);
  assert.doesNotMatch(plain.surfaceShader, /captureDepth|pbrEye/);
  assert.match(floor.surfaceShader, /captureDepth:texture_depth_2d/);
  assert.match(floor.surfaceShader, /pbrInv\*vec4f/);
  const aspects = [];
  floor.target.depth = {
    createView(options) {
      aspects.push(options.aspect);
      return {};
    },
  };
  assert.ok(floor.surfaceDepth);
  assert.ok(floor.surfaceDepth);
  assert.deepEqual(aspects, ['depth-only'], 'sample the depth aspect only, including stencil captures');
  floor.target.depth = undefined;
  assert.match(floor.surfaceShader, /let lod=u.size.z\*clamp\(planeDistance\/u.pbr.z/);
  floor.camera.update(1, true);
  const values = new Float32Array(96);
  floor.surfaceUniforms({ camera: { position: [2, 3, 4] } }, values);
  assert.deepEqual([...values.slice(64, 67)], [2, 3, 4]);
  assert.deepEqual([...values.slice(68, 71)], [...new Float32Array([0.2, 0.3, 0.4])]);
  assert.equal(values[72], 0.5);
  const color = floor.baseColor;
  color[0] = 9;
  assert.equal(floor.baseColor[0], 0.2);
  for (const [key, bad] of [
    ['ior', 0.9],
    ['metalness', 2],
    ['blurDistance', 0],
  ])
    assert.throws(() => (floor[key] = bad));
  for (const distance of [Number.MIN_VALUE, Number.MAX_VALUE])
    assert.throws(() => {
      floor.blurDistance = distance;
    });
  assert.throws(() => {
    floor.baseColor = [1e100, 0, 0];
  });
  floor.dispose();
  plain.dispose();
});
