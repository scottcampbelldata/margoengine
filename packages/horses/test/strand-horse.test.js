import assert from 'node:assert/strict';
import test from 'node:test';
import { horseDocument } from '../dist/model.js';

function words(doc, buffers, accessor, TypedArray) {
  const view = doc.bufferViews[doc.accessors[accessor].bufferView];
  const data = buffers[view.buffer];
  return new TypedArray(data.buffer, data.byteOffset, data.byteLength / TypedArray.BYTES_PER_ELEMENT);
}

test('every procedural mesh vertex has a face and a usable normal at all horse detail levels', () => {
  for (const detail of [0, 1, 2]) {
    const { doc, buffers } = horseDocument({ detail });
    for (const { attributes, indices } of doc.meshes[0].primitives) {
      const normals = words(doc, buffers, attributes.NORMAL, Float32Array);
      const triangles = words(doc, buffers, indices, Uint32Array);
      const referenced = new Uint8Array(normals.length / 3);
      for (const index of triangles) {
        assert.ok(index < referenced.length);
        referenced[index] = 1;
      }
      for (let i = 0; i < referenced.length; i++) {
        assert.equal(referenced[i], 1, `LOD ${detail} vertex ${i} must be referenced`);
        const length = Math.hypot(normals[i * 3], normals[i * 3 + 1], normals[i * 3 + 2]);
        assert.ok(Math.abs(length - 1) < 2e-7, `LOD ${detail} vertex ${i} normal: ${length}`);
      }
    }
  }
});

test('the physical horse keeps existing joints and weights every mane card to the new chains', () => {
  const plain = horseDocument({ detail: 1 }),
    physical = horseDocument({ detail: 1, strandRig: true });
  const { doc, buffers, skeleton } = physical,
    chains = skeleton.strandChains;
  assert.deepEqual(skeleton.joints.slice(0, plain.skeleton.joints.length), plain.skeleton.joints);
  assert.equal(chains.length, 11);
  assert.equal(chains[0].length, 8);
  for (const chain of chains) {
    for (let i = 1; i < chain.length; i++) assert.equal(skeleton.joints[chain[i]].parent, chain[i - 1]);
  }
  const allowed = new Set(chains.slice(1).flat());
  const mane = doc.meshes[0].primitives.find((p) => doc.materials[p.material].name === 'Mane');
  const joints = words(doc, buffers, mane.attributes.JOINTS_0, Uint16Array);
  const weights = words(doc, buffers, mane.attributes.WEIGHTS_0, Float32Array);
  for (let at = 0; at < joints.length; at++) {
    if (weights[at] > 0) assert.ok(allowed.has(joints[at]));
  }
});
