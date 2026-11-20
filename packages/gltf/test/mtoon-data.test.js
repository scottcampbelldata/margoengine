import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GLTFAsset } from '../dist/asset-entry.js';
test('required MToon material data stays available for the optional renderer', () => {
  const extension = { specVersion: '1.0', shadeColorFactor: [0.2, 0.3, 0.4] },
    document = {
      asset: { version: '2.0' },
      extensionsRequired: ['VRMC_materials_mtoon'],
      materials: [{ extensions: { VRMC_materials_mtoon: extension } }],
    };
  const asset = new GLTFAsset(document, []);
  assert.equal(asset.doc.materials[0].extensions.VRMC_materials_mtoon, extension);
  assert.deepEqual(asset.doc.extensionsRequired, ['VRMC_materials_mtoon']);
});
