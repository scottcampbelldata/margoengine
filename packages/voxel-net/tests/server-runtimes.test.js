import assert from 'node:assert/strict';
import test from 'node:test';
import { serveVoxelBun, serveVoxelDeno } from '../dist/server-runtimes.js';

test('native runtime factories fail with a coded unsupported error in Node', async () => {
  await assert.rejects(serveVoxelBun({}), (error) => error.code === 'unsupported' && /bun/.test(error.message));
  await assert.rejects(serveVoxelDeno({}), (error) => error.code === 'unsupported' && /deno/.test(error.message));
});
