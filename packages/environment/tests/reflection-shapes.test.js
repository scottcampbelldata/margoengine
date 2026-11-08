// CPU checks of sphere-projected reflection probes and weighted blending (@margoengine/environment/probes): validation,
// the packed header the shaders read (a sphere's bounding box, min.w 1, max.w its radius), moving a sphere's capture
// point, and that the shading WGSL changes only for the options used. The shader maths against a CPU mirror on a real
// GPU: tests/reflection-shapes-browser.js (npm run test:reflection-shapes:browser).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mockGPU } from '../../../examples/package-benchmarks/proofs/gpu-recorder.js';
import { LightProbes } from '../dist/probes.js';

const sphere = { shape: 'sphere', position: [1, 2, 3], radius: 2 };
const room = { position: [0, 1, 0], min: [-2, 0, -2], max: [2, 3, 2] };

test('sphere probes and reflectionBlend are validated', () => {
  for (const bad of [
    { ...sphere, radius: 0 },
    { ...sphere, radius: Number.NaN },
    { shape: 'sphere', position: [0, 0, 0] },
    { ...sphere, min: [-1, 0, 2], max: [3, 4, 5] },
    { ...room, radius: 1 },
    { ...sphere, blend: -1 },
  ])
    assert.throws(() => new LightProbes({ reflections: [bad] }), RangeError);
  assert.throws(() => new LightProbes({ reflections: [{ ...room, shape: 'cone' }] }), TypeError);
  assert.throws(() => new LightProbes({ reflections: [room], reflectionBlend: 'max' }), TypeError);
  assert.equal(new LightProbes({ reflections: [room] }).reflectionBlend, 'order');
  assert.equal(new LightProbes({ reflections: [room], reflectionBlend: 'weighted' }).reflectionBlend, 'weighted');
});

test("a sphere probe packs its bounding box, min.w 1 and max.w its radius; a box probe's words stay 0", () => {
  const probes = new LightProbes({ reflections: [room, sphere], resolution: 16 }),
    view = new DataView(probes.header),
    f = (o) => view.getFloat32(o, true);
  const [box, ball] = probes.reflections;
  assert.deepEqual(
    [ball.min, ball.max],
    [
      [-1, 0, 1],
      [3, 4, 5],
    ],
  );
  assert.ok(Math.abs(ball.blend - 0.4) < 1e-12, 'default blend: 10% of the diameter');
  assert.equal(ball.radius, 2);
  assert.deepEqual([f(128 + 28), f(128 + 44)], [1, 2]);
  assert.deepEqual([f(64 + 28), f(64 + 44)], [0, 0]);
  assert.deepEqual([f(128 + 16), f(128 + 32), f(128 + 12)], [-1, 3, Math.fround(0.4)]);
  assert.ok(Math.abs(box.blend - 0.3) < 1e-12);
});

test("a sphere probe's capture point moves inside its sphere, which stays where it was", () => {
  const probes = new LightProbes({ reflections: [sphere] });
  probes.setReflectionPosition(0, [2.9, 2, 3]);
  assert.deepEqual(probes.reflections[0].position, [2.9, 2, 3]);
  assert.deepEqual(probes.reflections[0].min, [-1, 0, 1], 'the sphere stays');
  // Inside its bounding box but outside the sphere.
  assert.throws(() => probes.setReflectionPosition(0, [2.9, 3.9, 3]), RangeError);
});

// SHA-256 of LightProbes' shading declarations (pbr(2)) at 54438d86f (main before sphere probes), without an environment
// and with one: box probes in the default order give this exact text, so no other LightProbes user changes.
const MAIN_SHADING = {
  plain: '7dac762f30886648606a951f80b2d3f0bc5f7798b279626c2a0407705cac9bd4',
  environment: '3d3107edd1c91e6866425ee516fea34f3ed9c055367fd6d36fc198ca7d56eeea',
};
const sha = (text) => createHash('sha256').update(text).digest('hex');
function declarations(environment, options) {
  const device = mockGPU().device,
    stub = { device, disposed: false, version: 0, specularView: {}, sampler: {}, brdfLut: {}, shBuffer: {} };
  const probes = new LightProbes({
    environment: environment ? { ...stub, paramsBuffer: {}, restore: () => Promise.resolve() } : undefined,
    ...options,
  });
  probes.setup({ backend: 'webgpu', gpu: device, onError() {}, removePlugin() {} });
  return probes.pbr(2).declarations;
}

test("the shading WGSL is main's for box probes in order; spheres and weighted add their code only when used", () => {
  for (const environment of [false, true]) {
    const main = environment ? MAIN_SHADING.environment : MAIN_SHADING.plain;
    const box = declarations(environment, { reflections: [room] });
    assert.equal(sha(box), main);
    assert.doesNotMatch(box, /b\.min\.w>0\.5|total\+=w/);
    const ball = declarations(environment, { reflections: [room, sphere] });
    assert.match(ball, /if\(b\.min\.w>0\.5\)\{/);
    assert.match(ball, /left-=w;/);
    const weighted = declarations(environment, { reflections: [room], reflectionBlend: 'weighted' });
    assert.match(weighted, /total\+=w;/);
    assert.match(weighted, /select\(vec4f\(sum,total\),vec4f\(sum\/total,1\.0\),total>1\.0\)/);
    assert.doesNotMatch(weighted, /b\.min\.w>0\.5|left/);
    const both = declarations(environment, { reflections: [sphere, room], reflectionBlend: 'weighted' });
    assert.match(both, /b\.min\.w>0\.5/);
    assert.match(both, /total\+=w;/);
  }
});
