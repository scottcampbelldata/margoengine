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

// Half the z extent of the vertices in a 0.3 m slab: the trunk's radius there (the lean is along x).
function radiusAt(data, from, to) {
  let lo = Infinity,
    hi = -Infinity;
  for (let i = 0; i < data.positions.length; i += 3)
    if (data.positions[i + 1] >= from && data.positions[i + 1] <= to) {
      lo = Math.min(lo, data.positions[i + 2]);
      hi = Math.max(hi, data.positions[i + 2]);
    }
  return (hi - lo) / 2;
}

test('trunks and limbs taper from a wide root to a narrow tip', () => {
  // Before the fix every trunk grew wider toward its top (palm 0.13 m at the root, 0.22 m at the crown).
  for (const [name, make] of [
    ['palm', generatePalmMesh],
    ['birch', generateBirchMesh],
    ['snag', generateSnagMesh],
  ]) {
    const { trunk } = make();
    let top = -Infinity;
    for (let i = 1; i < trunk.positions.length; i += 3) top = Math.max(top, trunk.positions[i]);
    const root = radiusAt(trunk, -0.3, 0.3),
      tip = radiusAt(trunk, top - 0.3, top);
    assert.ok(root > 1.5 * tip, `${name}: root radius ${root} against tip ${tip}`);
  }
});

test('cactus arms are ribbed around their own axes, not sheared about the trunk', () => {
  const cactus = generateCactusMesh();
  // Upright arms: x = -0.6 for y 1.2 to 2.3 and x = 0.6 for y 1.7 to 2.5, radius at most 0.14 plus a 6 percent rib.
  let worst = 0;
  for (let i = 0; i < cactus.positions.length; i += 3) {
    const [x, y, z] = [cactus.positions[i], cactus.positions[i + 1], cactus.positions[i + 2]];
    if (x < -0.45 && y > 1.4 && y < 2.3) worst = Math.max(worst, Math.hypot(x + 0.6, z));
    if (x > 0.45 && y > 1.9 && y < 2.5) worst = Math.max(worst, Math.hypot(x - 0.6, z));
  }
  assert.ok(worst > 0.12 && worst <= 0.14 * 1.06 + 1e-6, `arm radius ${worst}`);
});
