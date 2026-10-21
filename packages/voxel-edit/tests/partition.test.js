import assert from 'node:assert/strict';
import test from 'node:test';
import { Geometry } from '@margoengine/core';
import { createRandom } from '@margoengine/math/mathutils';
import { meshGrid, partitionMesh } from '../dist/mesh.js';
import { SparseGrid } from '../dist/sparse.js';
import { gridFromVox, voxFromGrid, voxTiles } from '../dist/vox.js';

// Margo Voxel Studio's frozen preview batching (src/viewport/scene-preview.ts buildSceneGeometry), kept as the oracle:
// quads in mesh order, one open batch per palette index, closed once it holds `limit` quads.
function studioBatches(mesh, limit) {
  const buckets = new Map(),
    batches = new Map();
  for (let quad = 0; quad < mesh.paletteIndexes.length; quad++) {
    const palette = mesh.paletteIndexes[quad],
      batch = batches.get(palette) ?? 0,
      key = `${palette}:${batch}`;
    let group = buckets.get(key);
    if (!group) buckets.set(key, (group = { palette, positions: [], normals: [], indices: [], quads: 0 }));
    const start = group.positions.length / 3;
    for (let vertex = 0; vertex < 4; vertex++)
      for (let axis = 0; axis < 3; axis++) {
        group.positions.push(mesh.positions[quad * 12 + vertex * 3 + axis]);
        group.normals.push(mesh.normals[quad * 12 + vertex * 3 + axis]);
      }
    for (let index = 0; index < 6; index++) group.indices.push(start + mesh.indices[quad * 6 + index] - quad * 4);
    group.quads++;
    if (group.quads >= limit) batches.set(palette, batch + 1);
  }
  return [...buckets.values()];
}

function checkerboard(n, colors) {
  const voxels = new Uint8Array(n * n * n);
  for (let y = 0; y < n; y++)
    for (let z = 0; z < n; z++)
      for (let x = 0; x < n; x++)
        if ((x + y + z) % 2 === 0) voxels[x + n * (z + n * y)] = colors[(x + z) % colors.length];
  return { size: [n, n, n], voxels };
}

const same = (part, group) => {
  assert.equal(part.paletteIndex, group.palette);
  assert.equal(part.quads.length, group.quads);
  assert.deepEqual(Array.from(part.positions), group.positions);
  assert.deepEqual(Array.from(part.normals), group.normals);
  assert.deepEqual(Array.from(part.indices), group.indices);
};

test("partitionMesh gives Studio's preview batches exactly, attribute for attribute", () => {
  const { mesh } = meshGrid(checkerboard(9, [3, 7, 200]), { ambientOcclusion: true });
  for (const limit of [1, 2, 7, 100, 250_000]) {
    const parts = partitionMesh(mesh, { maxQuads: limit }),
      groups = studioBatches(mesh, limit);
    assert.equal(parts.length, groups.length);
    parts.forEach((part, i) => same(part, groups[i]));
    for (const part of parts) {
      assert.ok(part.quads.length <= limit);
      assert.equal(part.ao.length, 4 * part.quads.length);
      part.quads.forEach((quad, i) =>
        assert.deepEqual(
          Array.from(part.ao.subarray(i * 4, i * 4 + 4)),
          Array.from(mesh.ao.subarray(quad * 4, quad * 4 + 4)),
        ),
      );
    }
  }
});

test('large meshes split under core Geometry limits; 250,000 quads is exactly one million vertices', () => {
  const { mesh } = meshGrid(checkerboard(48, [5, 9]));
  assert.equal(mesh.paletteIndexes.length, 331_776);
  const studio = partitionMesh(mesh, { maxQuads: 200_000 });
  studioBatches(mesh, 200_000).forEach((group, i) => same(studio[i], group));
  assert.deepEqual(
    studio.map((p) => p.quads.length),
    [165_888, 165_888],
  );
  const parts = partitionMesh(mesh, { maxQuads: 100_000 });
  studioBatches(mesh, 100_000).forEach((group, i) => same(parts[i], group));
  assert.deepEqual(parts.map((p) => p.quads.length).sort(), [100_000, 100_000, 65_888, 65_888].sort());
  const single = meshGrid(checkerboard(48, [6])).mesh,
    full = partitionMesh(single);
  assert.deepEqual(
    full.map((p) => p.quads.length),
    [250_000, 81_776],
  );
  const geometry = new Geometry(full[0].positions, full[0].normals, full[0].indices);
  assert.equal(geometry.vertices.length / 6, 1_000_000);
  assert.equal(full[0].ao.length, 0);
});

test('partitionMesh refuses arrays that are not meshGrid layout', () => {
  const { mesh } = meshGrid(checkerboard(3, [1]));
  assert.throws(() => partitionMesh(mesh, { maxQuads: 250_001 }), /maxQuads/);
  assert.throws(() => partitionMesh(mesh, { maxQuads: 0 }), /maxQuads/);
  assert.throws(() => partitionMesh({}), TypeError);
  assert.throws(() => partitionMesh({ ...mesh, normals: mesh.normals.subarray(3) }), /4 vertices/);
  const crossed = { ...mesh, indices: mesh.indices.slice() };
  crossed.indices[0] = 4;
  assert.throws(() => partitionMesh(crossed), /another quad/);
  assert.deepEqual(partitionMesh(meshGrid({ size: [1, 1, 1], voxels: new Uint8Array(1) }).mesh), []);
});

// Margo Voxel Studio's frozen tile planner (src/io/vox-sparse.ts tileLargeVoxModels), kept as the oracle: 256-cell
// buckets, each cropped to its filled bounds, sorted by lower corner y, z, x.
function studioTiles(cells) {
  const map = new Map(),
    bucket = (x, y, z) => `${Math.floor(x / 256)},${Math.floor(y / 256)},${Math.floor(z / 256)}`;
  for (const [x, y, z] of cells) {
    const key = bucket(x, y, z);
    let tile = map.get(key);
    if (!tile) map.set(key, (tile = { key, min: [x, y, z], max: [x + 1, y + 1, z + 1] }));
    const point = [x, y, z];
    for (let a = 0; a < 3; a++) {
      tile.min[a] = Math.min(tile.min[a], point[a]);
      tile.max[a] = Math.max(tile.max[a], point[a] + 1);
    }
  }
  const tiles = [...map.values()].sort((a, b) => a.min[1] - b.min[1] || a.min[2] - b.min[2] || a.min[0] - b.min[0]);
  for (const tile of tiles) {
    tile.size = tile.max.map((n, a) => n - tile.min[a]);
    tile.voxels = new Uint8Array(tile.size[0] * tile.size[1] * tile.size[2]);
  }
  for (const [x, y, z, color] of cells) {
    const tile = map.get(bucket(x, y, z));
    tile.voxels[x - tile.min[0] + tile.size[0] * (z - tile.min[2] + tile.size[2] * (y - tile.min[1]))] = color;
  }
  return tiles;
}

const denseCells = (grid) => {
  const out = [];
  for (let i = 0; i < grid.voxels.length; i++)
    if (grid.voxels[i]) {
      const row = Math.floor(i / grid.size[0]);
      out.push([i - row * grid.size[0], Math.floor(row / grid.size[2]), row % grid.size[2], grid.voxels[i]]);
    }
  return out;
};

test("voxTiles plans Studio's large-model .vox tiles exactly, dense and sparse", () => {
  const random = createRandom(71),
    size = [530, 40, 300],
    voxels = new Uint8Array(size[0] * size[1] * size[2]);
  for (let k = 0; k < 900; k++) voxels[Math.floor(random() * voxels.length)] = 1 + Math.floor(random() * 255);
  voxels[0] = 9;
  voxels[voxels.length - 1] = 250;
  const dense = { size, voxels },
    tiles = voxTiles(dense),
    expected = studioTiles(denseCells(dense));
  assert.equal(tiles.length, expected.length);
  tiles.forEach((tile, i) => {
    assert.deepEqual(tile.origin, expected[i].min);
    assert.deepEqual(tile.size, expected[i].size);
    assert.deepEqual(tile.voxels, expected[i].voxels);
    assert.ok(tile.size.every((v) => v <= 256));
  });
  const sparse = SparseGrid.fromGrid(dense, { maxWindowCells: 16_777_216 }),
    fromSparse = voxTiles(sparse);
  assert.deepEqual(fromSparse, tiles);
  // Reassembly: every filled cell sits at tile origin + local cell, nothing else.
  const back = new Uint8Array(voxels.length);
  for (const { origin, size: s, voxels: v } of tiles)
    for (let y = 0; y < s[1]; y++)
      for (let z = 0; z < s[2]; z++)
        for (let x = 0; x < s[0]; x++) {
          const value = v[x + s[0] * (z + s[2] * y)];
          if (value) back[origin[0] + x + size[0] * (origin[2] + z + size[2] * (origin[1] + y))] = value;
        }
  assert.deepEqual(back, voxels);
});

test('voxTiles reads only filled chunks of a huge sparse grid and keeps axes as they are', () => {
  const grid = SparseGrid.empty([1_000_003, 47, 900_001]).edit([
      [2, 3, 4, 7],
      [1_000_002, 46, 900_000, 255],
      [1_000_001, 40, 899_999, 6],
    ]).grid,
    tiles = voxTiles(grid);
  assert.deepEqual(
    tiles.map((t) => [t.origin, t.size]),
    [
      [
        [2, 3, 4],
        [1, 1, 1],
      ],
      [
        [1_000_001, 40, 899_999],
        [2, 7, 2],
      ],
    ],
  );
  const model = voxFromGrid(tiles[1]);
  assert.deepEqual(model.size, [2, 2, 7], '.vox turns Y up into Z up only when voxFromGrid is called');
  assert.deepEqual(gridFromVox(model), { size: tiles[1].size, voxels: tiles[1].voxels });
  assert.deepEqual(voxTiles(SparseGrid.empty([9, 9, 9])), []);
});

test('voxTiles checks tile and cell budgets before allocating, and honours a smaller tile size', () => {
  const grid = { size: [8, 1, 1], voxels: Uint8Array.from([1, 0, 0, 0, 0, 0, 0, 2]) };
  assert.deepEqual(
    voxTiles(grid, { tileSize: 4 }).map((t) => [t.origin, t.size, Array.from(t.voxels)]),
    [
      [[0, 0, 0], [1, 1, 1], [1]],
      [[7, 0, 0], [1, 1, 1], [2]],
    ],
  );
  assert.deepEqual(
    voxTiles(grid).map((t) => t.size),
    [[8, 1, 1]],
  );
  assert.throws(() => voxTiles(grid, { tileSize: 4, maxTiles: 1 }), /maxTiles/);
  assert.throws(() => voxTiles(grid, { maxCells: 7 }), /maxCells/);
  assert.throws(() => voxTiles(grid, { tileSize: 257 }), /tileSize/);
  assert.throws(() => voxTiles({ size: [2, 1, 1], voxels: new Uint8Array(1) }), RangeError);
});
