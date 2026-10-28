// The preset plant generators (decision D5): every mesh is finite, indexed in range, with unit normals, rooted at the
// origin (nothing far below the ground) and about as tall and wide as the plant it stands for.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  generateAcaciaMesh,
  generateBirchMesh,
  generateCactusMesh,
  generatePalmMesh,
  generateReedMesh,
  generateSnagMesh,
  generateTundraShrubMesh,
} from '../dist/index.js';

function check(name, data, height) {
  const n = data.positions.length / 3;
  assert.ok(n > 0, name);
  for (const v of data.positions) assert.ok(Number.isFinite(v), `${name} position`);
  for (const i of data.indices) assert.ok(i >= 0 && i < n, `${name} index`);
  for (let i = 0; i < data.normals.length; i += 3)
    assert.ok(
      Math.abs(Math.hypot(data.normals[i], data.normals[i + 1], data.normals[i + 2]) - 1) < 1e-3,
      `${name} normal`,
    );
  let low = Infinity,
    top = -Infinity;
  for (let i = 1; i < data.positions.length; i += 3) {
    low = Math.min(low, data.positions[i]);
    top = Math.max(top, data.positions[i]);
  }
  assert.ok(low > -0.3, `${name} rooted: lowest ${low}`);
  assert.ok(top > height[0] && top < height[1], `${name} height ${top}`);
}

test('tree generators: wood and foliage at tree heights (a snag has no foliage)', () => {
  for (const [name, make, height] of [
    ['palm', generatePalmMesh, [6, 12]],
    ['birch', generateBirchMesh, [7, 13]],
    ['acacia', generateAcaciaMesh, [3, 7]],
    ['snag', generateSnagMesh, [5, 9]],
  ]) {
    const tree = make();
    check(`${name} trunk`, tree.trunk, [1.5, height[1]]);
    if (name === 'snag') assert.equal(tree.canopy.indices.length, 0);
    else check(`${name} canopy`, tree.canopy, height);
  }
});

test('small plants: cactus, reeds and a tundra shrub at their heights', () => {
  check('cactus', generateCactusMesh(), [2.5, 3.6]);
  check('reeds', generateReedMesh(), [1.3, 2.3]);
  check('tundra shrub', generateTundraShrubMesh(), [0.1, 0.4]);
  assert.throws(() => generateReedMesh(0), RangeError);
});
