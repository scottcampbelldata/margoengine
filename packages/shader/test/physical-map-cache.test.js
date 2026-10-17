import test from 'node:test';
import assert from 'node:assert/strict';
import { NodeMaterial, uniform } from '../dist/index.js';
import { Texture } from '../../materials/dist/index.js';
import { factorPhysicalShader } from '../../gltf-pro/src/shader.ts';

const texture = () =>
  new Texture({ data: new Uint8Array([255, 255, 255, 255]), width: 1, height: 1 }, { mipmaps: false });
const count = (source) => (source.match(/var \w+:texture_2d<f32>/g) ?? []).length;

test('NodeMaterial recompiles sparse physical map specializations while preserving node bindings and surface anchors', () => {
  const clearcoatMap = texture(),
    sheenColorMap = texture(),
    roughnessNode = uniform(0.4);
  const material = new NodeMaterial({ clearcoat: 1, clearcoatMap, sheenColorMap, roughnessNode });
  const source = factorPhysicalShader(),
    first = material.shader(source, 2);
  assert.equal(count(first), 2);
  assert.match(first, /@binding\(48\)/, 'Node bindings retain their reserved range');
  assert.match(first, /s\.roughness = clamp\(/, 'Nodes still splice into the mapped physical surface');
  material.sheenColorMap = null;
  const second = material.shader(source, 2);
  assert.equal(count(second), 1, 'Removing a map changes the generated resource layout');
  assert.notEqual(second, first);
  assert.equal(material.shader(source, 2), second, 'Unchanged specializations retain their cached shader');
  material.sheenColorMap = sheenColorMap;
  assert.equal(material.shader(source, 2), first, 'Returning to a previous layout reuses its specialization');
});
