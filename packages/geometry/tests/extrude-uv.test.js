// Extrusion UV generators: the default stays as it was, every corner is offered, and world scale holds on bevels and paths.
import test from 'node:test';
import assert from 'node:assert/strict';
import { extrudeGeometry, LineCurve3, Shape, worldUVs } from '../dist/index.js';
import { close, vertexCount } from './support/mesh-checks.js';

const square = () =>
  new Shape([
    [0, 0],
    [2, 0],
    [2, 2],
    [0, 2],
  ]);

test('without the option UVs are unchanged, and a generator returning the defaults changes nothing', () => {
  const plain = extrudeGeometry(square(), { depth: 3, steps: 2 }),
    same = extrudeGeometry(square(), { depth: 3, steps: 2, uvGenerator: ({ u, v }) => [u, v] });
  assert.deepEqual(same.uvs, plain.uvs);
  assert.deepEqual(same.positions, plain.positions);
  assert.deepEqual(same.groups, plain.groups);
});

test('the generator sees every corner once, on the right surface and position', () => {
  const seen = { cap: 0, wall: 0 };
  const data = extrudeGeometry(square(), {
    depth: 3,
    bevelEnabled: false,
    uvGenerator: ({ surface, position, shape }) => {
      seen[surface]++;
      if (surface === 'cap') assert.ok(position[2] === 0 || position[2] === 3);
      assert.deepEqual(shape, [position[0], position[1]]);
      return [position[0], position[2]];
    },
  });
  assert.equal(seen.cap + seen.wall, vertexCount(data));
  assert.equal(seen.cap, 12);
  assert.equal(seen.wall, 24);
  for (let k = 0; k < vertexCount(data); k++) {
    close(data.uvs[k * 2], data.positions[k * 3], 1e-6, 'u is x');
    close(data.uvs[k * 2 + 1], data.positions[k * 3 + 2], 1e-6, 'v is z');
  }
});

test('worldUVs tiles walls and caps at one scale', () => {
  const data = extrudeGeometry(square(), { depth: 3, bevelEnabled: false, uvGenerator: worldUVs(2) }),
    [capStart, wallStart] = [data.groups[0].start, data.groups[1].start];
  let top = 0,
    round = 0;
  for (let k = capStart; k < wallStart; k++) top = Math.max(top, data.uvs[k * 2]);
  for (let k = wallStart; k < vertexCount(data); k++) {
    round = Math.max(round, data.uvs[k * 2]);
    close(data.uvs[k * 2 + 1], data.positions[k * 3 + 2] / 2, 1e-6, 'wall v is distance over tile');
  }
  close(top, 1, 1e-6, 'cap: 2 units is one repeat');
  close(round, 4, 1e-6, 'wall: 8 units round is four repeats');
});

test('distance is the true length over a bevel, more than the z it spans', () => {
  let longest = 0;
  extrudeGeometry(square(), {
    depth: 1,
    bevelThickness: 0.5,
    bevelSize: 0.5,
    bevelSegments: 8,
    uvGenerator: ({ u, v, distance }) => {
      longest = Math.max(longest, distance);
      return [u, v];
    },
  });
  // Two quarter arcs of radius 0.5 in the wall's plane, stretched by the corner's miter: at least the arcs plus the depth.
  assert.ok(longest > 1 + Math.PI * 0.5 - 0.01, `${longest}`);
});

test('along a path, shape is the flat outline and distance follows the path', () => {
  const data = [];
  extrudeGeometry(square(), {
    steps: 4,
    extrudePath: new LineCurve3([0, 0, 0], [8, 0, 0]),
    uvGenerator: (corner) => {
      data.push(corner);
      return [0, 0];
    },
  });
  assert.ok(data.every(({ shape }) => [0, 2].includes(shape[0]) && [0, 2].includes(shape[1])));
  close(Math.max(...data.map(({ distance }) => distance)), 8, 1e-5, 'path length');
});

test('invalid results and tiles are refused with the fix in the message', () => {
  assert.throws(() => extrudeGeometry(square(), { uvGenerator: () => [NaN, 0] }), /return \[u, v\]/);
  assert.throws(() => extrudeGeometry(square(), { uvGenerator: () => undefined }), /return \[u, v\]/);
  for (const tile of [0, -1, NaN, Infinity]) assert.throws(() => worldUVs(tile), /above 0/);
});
