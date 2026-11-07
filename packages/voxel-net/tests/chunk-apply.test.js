// A chunk that decodes but cannot go into the world: the error reaches onError, never an unhandled rejection.
import assert from 'node:assert/strict';
import test from 'node:test';
import { VoxelChunk, VoxelWorld } from '@margoengine/voxel';
import { encodeChunk } from '@margoengine/voxel/codec';
import { encodeServerMessage, VoxelNetClient } from '../dist/index.js';
import { testBlocks } from './blocks.js';

test('a chunk the app already made at that key goes to onError as a state error, not an unhandled rejection', { timeout: 5000 }, async (t) => {
  const unhandled = [],
    onUnhandled = (reason) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  t.after(() => process.off('unhandledRejection', onUnhandled));
  const blocks = testBlocks(),
    world = new VoxelWorld({ blocks }),
    client = new VoxelNetClient(world, { send: () => {}, close: () => {} }),
    errors = [];
  let heard;
  const reported = new Promise((done) => (heard = done));
  client.onError = (error) => {
    errors.push(error);
    heard();
  };
  // The app writes a block before the server's copy of that chunk has arrived: setBlock adds the chunk.
  world.setBlock(-3, 6, 27, 1);
  assert.ok(world.getChunk(-1, 0, 0));
  client.receive(
    encodeServerMessage({
      type: 'chunk',
      cx: -1,
      cy: 0,
      cz: 0,
      data: await encodeChunk(new VoxelChunk(), { compress: false }),
    }),
  );
  await reported;
  // An unhandled rejection is reported after the microtasks that follow the rejection; a turn of the loop lets it show.
  await new Promise((done) => setImmediate(done));
  assert.deepEqual(unhandled, []);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].code, 'state');
  assert.match(errors[0].message, /Chunk -1,0,0 is already loaded/);
});
