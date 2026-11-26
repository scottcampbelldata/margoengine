import test from 'node:test';
import assert from 'node:assert/strict';
import { ShadowMapViewer, cascadeMap, shadowDepthToLinear } from '../dist/viewer.js';

const close = (a, b, e = 1e-9, m = '') => assert.ok(Math.abs(a - b) <= e, `${m} expected ${b}, got ${a}`);

test('reversed perspective depth is mirrored, then linearised to distance between near and far', () => {
  const near = 0.05,
    far = 20,
    map = { projection: 'perspective', reversed: true, near, far };
  for (const d of [near, 0.3, 1, 4, 12, far]) {
    // LocalShadows' light matrix: clip z = k (far - d), w = d, k = near / (far - near); near stores 1, far 0.
    const stored = (near * (far - d)) / (d * (far - near));
    close(shadowDepthToLinear(stored, map), (d - near) / (far - near), 1e-9, `distance ${d}`);
    // Read as standard depth, the same texel would be far from linear (the reversed-Z mistake this guards).
    if (d >= 4 && d < far)
      assert.ok(Math.abs(shadowDepthToLinear(stored, { ...map, reversed: false }) - (d - near) / (far - near)) > 0.05);
  }
  // A standard perspective map (near 0, far 1) linearises the same distance.
  const standard = (d) => (far * (d - near)) / (d * (far - near));
  close(shadowDepthToLinear(standard(4), { ...map, reversed: false }), (4 - near) / (far - near));
  // Orthographic depth is already linear; reversed is mirrored.
  close(shadowDepthToLinear(0.25, { projection: 'orthographic', reversed: false }), 0.25);
  close(shadowDepthToLinear(0.25, { projection: 'orthographic', reversed: true }), 0.75);
});

test('cascadeMap reads a Shadows depth array and refuses missing cascades', () => {
  const texture = { width: 512, height: 512, depthOrArrayLayers: 4 };
  assert.deepEqual(cascadeMap({ depthTexture: texture }, 2), {
    texture,
    layer: 2,
    projection: 'orthographic',
    reversed: false,
  });
  assert.equal(cascadeMap({ depthTexture: texture }, 4), null);
  assert.equal(cascadeMap({}, 0), null, 'before the first frame');
});

test('ShadowMapViewer checks its options', () => {
  assert.throws(() => new ShadowMapViewer({}), /errors#shadow-map-viewer/);
  assert.throws(() => new ShadowMapViewer({ source: () => null, size: 0 }), RangeError);
  const viewer = new ShadowMapViewer({ source: () => null });
  assert.equal(viewer.order, 1000);
  assert.equal(viewer.size, 256);
  viewer[Symbol.dispose]();
});
