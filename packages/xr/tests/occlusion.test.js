import test from 'node:test';
import assert from 'node:assert/strict';
import { AROcclusion, occlusionShader } from '../dist/occlusion.js';

/** A stand-in XR: its session and the frame and eye hooks, counting subscribers. */
function host(session) {
  const frames = new Set(),
    eyes = new Set();
  return {
    session,
    frames,
    eyes,
    onFrame(callback) {
      frames.add(callback);
      return () => frames.delete(callback);
    },
    onEye(callback) {
      eyes.add(callback);
      return () => eyes.delete(callback);
    },
  };
}
const session = (extra = {}) => ({
  enabledFeatures: ['depth-sensing'],
  depthUsage: 'cpu-optimized',
  depthDataFormat: 'float32',
  ...extra,
});

test('AROcclusion.create refuses a missing session, a session without depth and GPU luminance-alpha', () => {
  assert.throws(() => AROcclusion.create(host(null)), { code: 'state' });
  assert.throws(() => AROcclusion.create(host(session({ enabledFeatures: ['hit-test'] }))), { code: 'unsupported' });
  const noDepth = {
    enabledFeatures: undefined,
    get depthUsage() {
      throw new DOMException('no depth sensing', 'InvalidStateError');
    },
  };
  assert.throws(
    () => AROcclusion.create(host(noDepth)),
    (error) => error.code === 'unsupported' && !!error.cause,
  );
  assert.throws(
    () => AROcclusion.create(host(session({ depthUsage: 'gpu-optimized', depthDataFormat: 'luminance-alpha' }))),
    { code: 'unsupported' },
  );
  // CPU luminance-alpha is read as little-endian 16-bit values.
  AROcclusion.create(host(session({ depthDataFormat: 'luminance-alpha' }))).dispose();
});

test('AROcclusion feather defaults to 5 cm, takes 0 or more and rejects the rest', () => {
  const occlusion = AROcclusion.create(host(session()));
  assert.equal(occlusion.feather, 0.05);
  assert.equal(occlusion.enabled, true);
  occlusion.feather = 0;
  assert.equal(occlusion.feather, 0);
  for (const bad of [-0.01, Number.NaN, Number.POSITIVE_INFINITY, '0.1'])
    assert.throws(() => {
      occlusion.feather = bad;
    }, RangeError);
  assert.equal(AROcclusion.create(host(session()), { feather: 0.2, enabled: false }).enabled, false);
  assert.throws(() => AROcclusion.create(host(session()), { feather: -1 }), RangeError);
});

test('AROcclusion follows frames and eyes until disposed, then frees both hooks', () => {
  const xr = host(session());
  const occlusion = AROcclusion.create(xr);
  assert.equal(xr.frames.size, 1);
  assert.equal(xr.eyes.size, 1);
  // An eye without scene depth (a renderer that gives none) or without depth this frame draws nothing.
  for (const eye of xr.eyes) eye({ index: 0, view: {}, image: {} });
  for (const frame of xr.frames) frame({ frame: { getDepthInformation: () => null } });
  for (const eye of xr.eyes) eye({ index: 0, view: {}, image: {}, scene: {} });
  occlusion[Symbol.dispose]();
  assert.equal(xr.frames.size, 0);
  assert.equal(xr.eyes.size, 0);
  occlusion.dispose();
});

test('occlusionShader reads the scene depth per sample and the real depth by format', () => {
  const single = occlusionShader('r32float', 1),
    multi = occlusionShader('r16uint', 4);
  assert.match(single, /var scene: texture_depth_2d;/);
  assert.match(single, /var real: texture_2d<f32>;/);
  assert.match(single, /i < 1;/);
  assert.match(multi, /var scene: texture_depth_multisampled_2d;/);
  assert.match(multi, /var real: texture_2d<u32>;/);
  assert.match(multi, /textureLoad\(scene, q, i\)/);
  // No comment text ships in a package shader (KB-WGSL1).
  assert.doesNotMatch(single + multi, /\/\//);
});
