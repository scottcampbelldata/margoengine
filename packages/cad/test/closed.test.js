// capsAsSolid, cad's own closed-solid test (PartInstancer packs closed parts, and a section view can cap them by the
// same function): closed means every edge is shared by exactly two consistently wound triangles.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Geometry } from '@margoengine/core';
import { capsAsSolid } from '../dist/closed.js';

// A unit cube, 8 corners, 12 triangles wound counter-clockwise seen from outside.
const corners = [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 0, 0, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1],
  faces = [
    [0, 2, 1, 0, 3, 2],
    [4, 5, 6, 4, 6, 7],
    [0, 1, 5, 0, 5, 4],
    [2, 3, 7, 2, 7, 6],
    [1, 2, 6, 1, 6, 5],
    [3, 0, 4, 3, 4, 7],
  ],
  normals = corners.map(() => 0),
  cube = (list) => new Geometry(corners, normals, list.flat());

test('a closed cube caps; with a face removed it does not', () => {
  assert.equal(capsAsSolid(cube(faces)), true);
  assert.equal(capsAsSolid(cube(faces.slice(1))), false);
});

test('one face wound the wrong way is not a consistent solid', () => {
  const flipped = faces.map((f, i) => (i === 0 ? [f[0], f[2], f[1], f[3], f[5], f[4]] : f));
  assert.equal(capsAsSolid(cube(flipped)), false);
});

test('corners split per face (as the B-rep worker writes them) still weld into a closed solid', () => {
  const positions = [],
    indices = [];
  for (const f of faces)
    for (const v of f) {
      indices.push(positions.length / 3);
      positions.push(corners[v * 3], corners[v * 3 + 1], corners[v * 3 + 2]);
    }
  assert.equal(capsAsSolid(new Geometry(positions, positions.map(() => 0), indices)), true);
});
