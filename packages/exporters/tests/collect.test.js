// The shared scene walk as an entry of its own, for writers that live in other packages.
import test from 'node:test';
import assert from 'node:assert/strict';
import { collect, polygons, textureFiles } from '../dist/collect.js';

test('collect walks a data scene into normalized nodes with world transforms', () => {
  const geometry = {
      positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
      normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    },
    child = { name: 'Child', translation: [0, 1, 0], geometry },
    [root] = collect({ nodes: [{ name: 'Root', translation: [2, 0, 0], children: [child] }] });
  assert.equal(root.name, 'Root');
  const [node] = root.children;
  assert.equal(node.source, child);
  assert.deepEqual([node.world[12], node.world[13], node.world[14]], [2, 1, 0]);
  assert.equal(node.geometry.count, 3);
  assert.deepEqual([...node.geometry.indices], [0, 1, 2]);
});

test('polygons and textureFiles keep their exporter contracts', () => {
  assert.deepEqual(polygons(undefined, new Uint32Array([0, 1, 2])), [[0, 1, 2]]);
  assert.deepEqual(polygons(new Uint8Array([4]), new Uint32Array([0, 1, 2, 0, 2, 3])), [[0, 1, 2, 3]]);
  const files = textureFiles(''),
    image = new Uint8Array([1]);
  assert.equal(files.name({ image, mimeType: 'image/png', name: 'wood' }), 'wood.png');
  assert.deepEqual([...files.files.keys()], ['wood.png']);
});
