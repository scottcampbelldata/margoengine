// MagicaVoxel's own sample file (tests/fixtures/NOTICE.md): parse, write back byte for byte, paste into a world.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { BlockTypes, VoxelWorld } from '../dist/index.js';
import { parseVox, pasteVoxModel, writeVox } from '../dist/vox.js';

const bytes = new Uint8Array(readFileSync(new URL('./fixtures/chr_knight.vox', import.meta.url)));

test('MagicaVoxel chr_knight.vox parses, writes back byte for byte and pastes every voxel', () => {
  assert.equal(bytes.length, 2688);
  const scene = parseVox(bytes);
  assert.equal(scene.version, 150);
  assert.ok(scene.models.length > 0);
  assert.deepEqual(writeVox(scene), bytes, 'byte-exact round trip of a file MagicaVoxel wrote');
  const voxels = scene.models.reduce((count, model) => count + model.voxels.length / 4, 0),
    world = new VoxelWorld({ blocks: new BlockTypes() }),
    changed = pasteVoxModel(world, scene, [0, 0, 0]);
  assert.ok(voxels > 0 && changed > 0 && changed <= voxels, `${changed} of ${voxels} voxels pasted`);
});
