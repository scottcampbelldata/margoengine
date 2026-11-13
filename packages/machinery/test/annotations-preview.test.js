// EngineeringAnnotations draws an SVG overlay, so it runs on the WebGL2 preview too: its one backend test picks the
// clip depth range, WebGPU's 0..1 or WebGL2's -1..1 (scripts/check-preview-contract.mjs lists this file as the evidence
// for that preview route).
import test from 'node:test';
import assert from 'node:assert/strict';
import { projectAnnotation } from '../dist/overlays.js';

const W = 640,
  H = 480;
// Column-major identity: clip coordinates are the point itself, w = 1.
const camera = { matrix: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]) };

test('a point in the WebGL2 near half of clip depth projects on the preview and is clipped on WebGPU', () => {
  const point = [0.5, 0.5, -0.5];
  assert.deepEqual(projectAnnotation(camera, point, W, H, false), [(1.5 * W) / 2, (0.5 * H) / 2]);
  assert.equal(projectAnnotation(camera, point, W, H, true), null);
});

test('both backends place a point inside 0..1 depth at the same pixel and clip one beyond the far plane', () => {
  const inside = [-0.5, 0, 0.25];
  assert.deepEqual(projectAnnotation(camera, inside, W, H, false), projectAnnotation(camera, inside, W, H, true));
  for (const gpu of [false, true]) assert.equal(projectAnnotation(camera, [0, 0, 1.5], W, H, gpu), null);
});

// 1e93374dd: FeatureEdges and SectionPlanes refused only a missing device, not a WebGL2 backend, so a preview engine
// with a device object was taken and drew nothing; both refuse the preview in setup now.
test('FeatureEdges and SectionPlanes refuse the WebGL2 preview in setup', async () => {
  const { FeatureEdges } = await import('../dist/edges.js'),
    { SectionPlanes } = await import('../dist/section.js'),
    preview = { backend: 'webgl2', gpu: {} };
  assert.throws(() => new FeatureEdges().setup(preview), /FeatureEdges needs WebGPU/);
  assert.throws(() => new SectionPlanes({ planes: [[0, 1, 0, 0]] }).setup(preview), /SectionPlanes needs WebGPU/);
});
