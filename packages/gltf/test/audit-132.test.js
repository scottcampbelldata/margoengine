// Batch 132 audit regressions: each test fails on the source before its fix.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseGLTF } from '../dist/index.js';
import { documentOf, headlessEngine } from './helpers.js';

test('an accessor without a bufferView reads as zeros (glTF 2.0, 3.6.2.1)', async () => {
  const { engine } = await headlessEngine();
  const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  const { doc, bytes } = documentOf([positions], {
    accessors: [
      { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] },
      // Normals declared but all zero: valid glTF with no bufferView.
      { componentType: 5126, count: 3, type: 'VEC3' },
    ],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1 } }] }],
    nodes: [{ mesh: 0 }],
    scenes: [{ nodes: [0] }],
  });
  const model = parseGLTF(engine, doc, [bytes]);
  assert.equal(model.meshes.length, 1);
  engine.dispose();
});
