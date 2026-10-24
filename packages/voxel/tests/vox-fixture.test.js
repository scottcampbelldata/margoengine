// The Margo-made tree.vox (scripts/make-vox-fixture.js): parse, write back byte for byte, paste into a world, and
// compare with a file assembled here chunk by chunk from the format description.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { BlockTypes, VoxelWorld } from '../dist/index.js';
import { parseVox, pasteVoxModel, writeVox } from '../dist/vox.js';
import { tree } from '../scripts/make-vox-fixture.js';

const bytes = new Uint8Array(readFileSync(new URL('./fixtures/tree.vox', import.meta.url)));

// Independent oracle: "VOX ", int32 150, then MAIN (content 0, children N) holding SIZE, XYZI and RGBA, each chunk
// written as id, content size, children size (0), content. RGBA entry k is the colour of index k + 1.
function assemble({ size, voxels, palette }) {
  const parts = [];
  const int = (v) => {
    const b = Buffer.alloc(4);
    b.writeInt32LE(v);
    parts.push(b);
  };
  const id = (name) => parts.push(Buffer.from(name, 'latin1'));
  const xyziBytes = 4 + 4 * voxels.length,
    children = 12 + 12 + (12 + xyziBytes) + (12 + 1024);
  id('VOX ');
  int(150);
  id('MAIN');
  int(0);
  int(children);
  id('SIZE');
  int(12);
  int(0);
  for (const v of size) int(v);
  id('XYZI');
  int(xyziBytes);
  int(0);
  int(voxels.length);
  for (const v of voxels) parts.push(Buffer.from(v));
  id('RGBA');
  int(1024);
  int(0);
  for (let k = 1; k <= 256; k++) parts.push(Buffer.from(palette[k & 255]));
  return new Uint8Array(Buffer.concat(parts));
}

test('tree.vox equals a hand-assembled file, parses, writes back byte for byte and pastes every voxel', () => {
  const source = tree();
  assert.deepEqual(bytes, assemble(source), 'fixture matches the chunk-by-chunk assembly');
  assert.equal(bytes.length, 8 + 12 + 24 + 12 + 4 + 4 * source.voxels.length + 12 + 1024);
  const scene = parseVox(bytes);
  assert.equal(scene.version, 150);
  assert.equal(scene.models.length, 1);
  assert.deepEqual(scene.models[0].size, source.size);
  assert.deepEqual([...scene.models[0].voxels], source.voxels.flat());
  for (let i = 1; i < 256; i++)
    assert.deepEqual([...scene.palette.subarray(i * 4, i * 4 + 4)], source.palette[i], `palette ${i}`);
  assert.deepEqual(writeVox(scene), bytes, 'byte-exact round trip');
  const voxels = scene.models.reduce((count, model) => count + model.voxels.length / 4, 0),
    world = new VoxelWorld({ blocks: new BlockTypes() }),
    changed = pasteVoxModel(world, scene, [0, 0, 0]);
  assert.ok(voxels > 0 && changed > 0 && changed <= voxels, `${changed} of ${voxels} voxels pasted`);
});
