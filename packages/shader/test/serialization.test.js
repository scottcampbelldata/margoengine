import test from 'node:test';
import assert from 'node:assert/strict';
import { captureMaterialLibrary, restoreMaterialLibrary } from '@margoengine/materials/serialization';
import { shaderMaterialCodecs } from '../dist/serialization.js';
import { NodeMaterial, storage, vertexIndex, vec3 } from '../dist/index.js';
test('compiled storage-buffer vertex programs retain all declarations, geometry stages and owned CPU data', async () => {
  const positions = storage(new Float32Array([1, 2, 3, 4]), 'vec4f');
  const material = new NodeMaterial({ positionNode: positions.element(vertexIndex).xyz.add(vec3(0.2)) });
  const archive = await captureMaterialLibrary({ material }, { codecs: shaderMaterialCodecs });
  const restored = await restoreMaterialLibrary(JSON.parse(JSON.stringify(archive)), { codecs: shaderMaterialCodecs });
  assert.equal(restored.material.program.declare(3), material.program.declare(3));
  assert.equal(restored.material.vertexCode, material.vertexCode);
  const buffer = restored.material.program.resources.find((r) => r.resource.data)?.resource;
  assert.deepEqual(buffer.data, positions.data);
  assert.notEqual(buffer.data, positions.data);
});
