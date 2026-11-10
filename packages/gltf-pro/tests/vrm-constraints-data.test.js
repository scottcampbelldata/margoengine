import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GLTFAsset } from '../dist/asset-entry.js';
test('required node-constraint payloads stay available to the optional runtime', () => {
  const extension = { specVersion: '1.0', constraint: { rotation: { source: 0 } } };
  const doc = {
    asset: { version: '2.0' },
    extensionsRequired: ['VRMC_node_constraint'],
    nodes: [{}, { extensions: { VRMC_node_constraint: extension } }],
  };
  const asset = new GLTFAsset(doc, []);
  assert.deepEqual(asset.doc.nodes[1].extensions.VRMC_node_constraint, extension);
  assert.deepEqual(asset.doc.extensionsRequired, ['VRMC_node_constraint']);
});
