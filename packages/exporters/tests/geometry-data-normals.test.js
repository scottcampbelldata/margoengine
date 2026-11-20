// GeometryData.normals is optional: a triangle without normals takes its faces' area-weighted normal, a point or line
// list keeps none (glTF 2.0 section 3.9.7 draws it unlit). The README's POINTS and LINES example passes no normals and
// `npm run check:readmes` type-checks it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { exportGLB } from '../dist/index.js';
import { readGLB, validate } from './helpers.js';
import { GLTFAsset } from '@margoengine/gltf/asset';

test('a triangle without normals is written with its face normal; a point list keeps none', async () => {
  /** @type {import('../dist/index.js').GeometryData} */
  const triangle = { positions: [0, 0, 0, 0, 1, 0, 1, 0, 0] },
    glb = exportGLB({
      nodes: [
        {
          name: 'tri',
          primitives: [{ geometry: triangle }, { geometry: { positions: [0, 0, 0, 2, 0, 0] }, mode: 'POINTS' }],
        },
      ],
    }),
    report = await validate(glb);
  assert.equal(report.errors, 0, JSON.stringify(report.messages));
  const { json, bin } = readGLB(glb),
    asset = new GLTFAsset(json, [bin]),
    [tri, points] = json.meshes[0].primitives;
  // Counter-clockwise from +z is (0,0,0), (1,0,0), (0,1,0); this order faces -z.
  assert.deepEqual(Array.from(asset.accessor(tri.attributes.NORMAL)), [0, 0, -1, 0, 0, -1, 0, 0, -1]);
  assert.equal(points.attributes.NORMAL, undefined);
});
