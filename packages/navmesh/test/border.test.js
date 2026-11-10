import test from 'node:test';
import assert from 'node:assert/strict';
import { buildNavMesh } from '../dist/build.js';
import { TiledNavMesh } from '../dist/tiles.js';
import { encodeNavMesh } from '../dist/codec.js';
import { fileURLToPath } from 'node:url';
import { bundleBytes } from '../../../scripts/measure-size.js';
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const positions = [0, 0, 0, 16, 0, 0, 16, 0, 16, 0, 0, 16],
  indices = [0, 2, 1, 0, 3, 2],
  options = { cs: 0.5, ch: 0.1, walkableRadius: 0, minRegionArea: 0 };
class InspectTiles extends TiledNavMesh {
  grid(x, z) {
    return this.gridOf({ x, z });
  }
}

test('borderSize allocates empty world-grid padding while preserving the world lattice and polygons', async () => {
  await mkdir(new URL('../../../test-results/', import.meta.url), { recursive: true });
  const path = new URL('../../../test-results/batch252-border-pipeline.mjs', import.meta.url);
  await writeFile(path, await bundleBytes(fileURLToPath(new URL('../src/pipeline.ts', import.meta.url))));
  const { validate, gridOf, voxelise } = await import(path.href),
    input = validate(positions, indices, { ...options, borderSize: 3 }),
    grid = gridOf(input),
    raster = voxelise(input.points, input.triangles, input.config, grid);
  assert.equal(grid.width, 38);
  assert.equal(grid.depth, 38);
  assert.equal(grid.cx, -3);
  assert.equal(grid.cz, -3);
  assert.equal(raster.spans.head.length, 38 * 38);
  assert.equal(raster.spans.head[0], -1);
  assert.ok(raster.spans.head[3 * 38 + 3] >= 0);
  assert.deepEqual(
    encodeNavMesh(buildNavMesh(positions, indices, { ...options, borderSize: 3 })),
    encodeNavMesh(buildNavMesh(positions, indices, options)),
  );
  const fractional = gridOf(validate(positions, indices, { ...options, borderSize: 2.1 }));
  assert.equal(fractional.width, 38);
});

test('tile padding honors borderSize above automatic clearance, crops to the tile and retains seam routes', () => {
  using standard = new InspectTiles(positions, indices, { ...options, tileSize: 8 }),
    padded = new InspectTiles(positions, indices, { ...options, tileSize: 8, borderSize: 7 });
  const a = standard.grid(1, 1),
    b = padded.grid(1, 1);
  assert.equal(a.width, 12);
  assert.equal(b.width, 22);
  assert.equal(b.cx, 1);
  assert.deepEqual(b.keep, [7, 7, 14, 14]);
  assert.deepEqual(padded.path([1, 0, 1], [15, 0, 15]), standard.path([1, 0, 1], [15, 0, 15]));
  for (const tile of padded.tileList())
    if (tile.mesh)
      for (const point of tile.mesh.vertices) {
        assert.ok(point[0] >= tile.x * 4 && point[0] <= (tile.x + 1) * 4);
        assert.ok(point[2] >= tile.z * 4 && point[2] <= (tile.z + 1) * 4);
      }
  for (let r = 1; r < 31; r++)
    for (let c = 1; c < 31; c++) {
      const point = [(c + 0.5) * 0.5, 0, (r + 0.5) * 0.5];
      assert.equal(padded.locate(point) >= 0, standard.locate(point) >= 0);
    }
  const obstacle = { min: [7, -1, 0], max: [9, 3, 16] },
    id = padded.addObstacle(obstacle);
  padded.update();
  assert.equal(padded.path([2, 0, 2], [14, 0, 2]), null);
  padded.removeObstacle(id);
  padded.update();
  assert.ok(padded.path([2, 0, 2], [14, 0, 2]));
});

test('small border settings never remove the automatic radius margin; padded budgets reject before allocation', () => {
  using mesh = new InspectTiles(positions, indices, { ...options, tileSize: 8, walkableRadius: 4, borderSize: 1 });
  assert.equal(mesh.grid(0, 0).width, 20);
  assert.throws(() => buildNavMesh(positions, indices, { ...options, borderSize: 2000 }), RangeError);
  assert.throws(() => new TiledNavMesh(positions, indices, { ...options, borderSize: 2000, tileSize: 8 }), RangeError);
  assert.throws(() => new TiledNavMesh([], [], { origin: [0, 0, 0], deferred: true, borderSize: 1e12 }), RangeError);
});
