// Regression (bug sweep L3a, Firefox (b), 2026-11-11, Firefox 157 on the WebGL2 layer): the layer left every new
// texture level for the browser to initialise. WebGL reads an unwritten level as zeros, but initialises it itself at the
// first partial upload or draw that touches it, and Firefox warns for each one ("Tex image TEXTURE_2D level 1 is
// incurring lazy initialization", "Texture has not been initialized prior to a partial upload, forcing the browser to
// clear it"): 120 such lines in the materials check, 12 in the lod imposter check. Now the layer writes zeros into
// every level and layer when it allocates a texture: a framebuffer clear for colour-renderable, depth and stencil
// formats, a whole-level upload from a zero-filled pixel unpack buffer for the rest, nothing for compressed formats.
// The same test pins the fence polls (Firefox: "ClientWaitSync with timeout=0 (or GetSyncParameter(SYNC_STATUS))
// called 100 times without SYNC_FLUSH_COMMANDS_BIT"): every poll is clientWaitSync with that bit.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loggingDevice } from './support/logging-gl.js';

const U = { COPY_SRC: 0x01, COPY_DST: 0x02, TEXTURE_BINDING: 0x04, RENDER_ATTACHMENT: 0x10, MAP_READ: 0x01 };

/** The calls made while `make` runs. */
function during(gl, make) {
  const from = gl.calls.length;
  const result = make();
  return { result, calls: gl.calls.slice(from) };
}

const named = (calls, ...names) => calls.filter((c) => names.includes(c[0]));

test('a colour-renderable texture has every level and layer cleared to zero when it is made', async () => {
  const { gl, device } = await loggingDevice();
  const { calls } = during(gl, () =>
    device.createTexture({
      size: [32, 16],
      mipLevelCount: 5,
      format: 'rgba8unorm',
      usage: U.TEXTURE_BINDING | U.COPY_DST,
    }),
  );
  const attached = named(calls, 'framebufferTexture2D').filter((c) => c[4] !== null);
  assert.deepEqual(
    attached.map((c) => c[5]),
    [0, 1, 2, 3, 4],
    'each level is attached once',
  );
  assert.equal(named(calls, 'clearBufferfv').length, 5, 'and cleared');
  for (const c of named(calls, 'clearBufferfv')) assert.deepEqual([...c[3]], [0, 0, 0, 0]);
  assert.equal(named(calls, 'texSubImage2D', 'texSubImage3D').length, 0, 'no upload');
  // The clears run with scissoring off and every colour channel written.
  const disabled = calls.findIndex((c) => c[0] === 'disable' && c[1] === gl.SCISSOR_TEST);
  const firstClear = calls.findIndex((c) => c[0] === 'clearBufferfv');
  assert.ok(disabled >= 0 && disabled < firstClear, 'scissor test off before the clears');
  device.destroy();
});

test('array layers, cube faces and 3D slices are each cleared; integer formats clear as integers', async () => {
  const { gl, device } = await loggingDevice();
  const array = during(gl, () =>
    device.createTexture({ size: [8, 8, 3], mipLevelCount: 2, format: 'rgba8unorm', usage: U.TEXTURE_BINDING }),
  ).calls;
  assert.deepEqual(
    named(array, 'framebufferTextureLayer')
      .filter((c) => c[3] !== null)
      .map((c) => [c[4], c[5]]),
    [
      [0, 0],
      [0, 1],
      [0, 2],
      [1, 0],
      [1, 1],
      [1, 2],
    ],
    'level, layer',
  );
  const cube = during(gl, () =>
    device.createTexture({ size: [8, 8, 6], format: 'rgba8unorm', usage: U.TEXTURE_BINDING }),
  ).calls;
  assert.deepEqual(
    named(cube, 'framebufferTexture2D')
      .filter((c) => c[4] !== null)
      .map((c) => c[3] - gl.TEXTURE_CUBE_MAP_POSITIVE_X),
    [0, 1, 2, 3, 4, 5],
    'every face',
  );
  const volume = during(gl, () =>
    device.createTexture({
      size: [8, 8, 4],
      dimension: '3d',
      mipLevelCount: 2,
      format: 'r8unorm',
      usage: U.TEXTURE_BINDING,
    }),
  ).calls;
  assert.deepEqual(
    named(volume, 'framebufferTextureLayer')
      .filter((c) => c[3] !== null)
      .map((c) => [c[4], c[5]]),
    [
      [0, 0],
      [0, 1],
      [0, 2],
      [0, 3],
      [1, 0],
      [1, 1],
    ],
    'level 1 of a depth-4 volume has 2 slices',
  );
  const uint = during(gl, () =>
    device.createTexture({ size: [4, 4], format: 'r32uint', usage: U.TEXTURE_BINDING }),
  ).calls;
  assert.equal(named(uint, 'clearBufferuiv').length, 1);
  const sint = during(gl, () =>
    device.createTexture({ size: [4, 4], format: 'rg16sint', usage: U.TEXTURE_BINDING }),
  ).calls;
  assert.equal(named(sint, 'clearBufferiv').length, 1);
  device.destroy();
});

test('depth and stencil textures are cleared through their attachment point', async () => {
  const { gl, device } = await loggingDevice();
  const depth = during(gl, () =>
    device.createTexture({ size: [16, 16], format: 'depth32float', usage: U.TEXTURE_BINDING | U.RENDER_ATTACHMENT }),
  ).calls;
  assert.equal(
    named(depth, 'framebufferTexture2D').filter((c) => c[2] === gl.DEPTH_ATTACHMENT && c[4] !== null).length,
    1,
  );
  assert.deepEqual(
    named(depth, 'clearBufferfv').map((c) => [c[1], [...c[3]]]),
    [[gl.DEPTH, [0]]],
  );
  const both = during(gl, () =>
    device.createTexture({
      size: [16, 16],
      format: 'depth24plus-stencil8',
      usage: U.TEXTURE_BINDING | U.RENDER_ATTACHMENT,
    }),
  ).calls;
  assert.equal(
    named(both, 'framebufferTexture2D').filter((c) => c[2] === gl.DEPTH_STENCIL_ATTACHMENT && c[4] !== null).length,
    1,
  );
  assert.deepEqual(
    named(both, 'clearBufferfi').map((c) => c.slice(1)),
    [[gl.DEPTH_STENCIL, 0, 0, 0]],
  );
  device.destroy();
});

test('formats that cannot be cleared are uploaded whole, a level per call, from a zeroed pixel unpack buffer', async () => {
  const { gl, device } = await loggingDevice();
  const { calls } = during(gl, () =>
    device.createTexture({ size: [12, 6, 2], mipLevelCount: 3, format: 'rgba8snorm', usage: U.TEXTURE_BINDING }),
  );
  const uploads = named(calls, 'texSubImage3D');
  assert.deepEqual(
    uploads.map((c) => c.slice(2, 9)),
    [
      [0, 0, 0, 0, 12, 6, 2],
      [1, 0, 0, 0, 6, 3, 2],
      [2, 0, 0, 0, 3, 1, 2],
    ],
    'level, offsets and the whole size of each level',
  );
  for (const c of uploads) assert.equal(c[11], 0, 'from offset 0 of the bound unpack buffer');
  const data = named(calls, 'bufferData').find((c) => c[1] === gl.PIXEL_UNPACK_BUFFER);
  assert.ok(data && typeof data[2] === 'number' && data[2] >= 12 * 6 * 2 * 4, 'a zero-filled buffer of level 0 size');
  const binds = named(calls, 'bindBuffer').filter((c) => c[1] === gl.PIXEL_UNPACK_BUFFER);
  assert.equal(binds.at(-1)[2], null, 'the unpack buffer is unbound afterwards');
  assert.equal(named(calls, 'clearBufferfv').length, 0);
  device.destroy();
});

test('compressed textures are left alone: zero blocks are not zero texels', async () => {
  const { gl, device } = await loggingDevice(['texture-compression-bc']);
  const { calls } = during(gl, () =>
    device.createTexture({
      size: [8, 8],
      mipLevelCount: 2,
      format: 'bc7-rgba-unorm',
      usage: U.TEXTURE_BINDING | U.COPY_DST,
    }),
  );
  assert.equal(named(calls, 'clearBufferfv', 'texSubImage2D', 'compressedTexSubImage2D').length, 0);
  device.destroy();
});

test('the data texture of a storage buffer is cleared before its first partial row upload', async () => {
  const { gl, device } = await loggingDevice();
  const buffer = device.createBuffer({ size: 64, usage: 0x80 | 0x08 });
  device.queue.writeBuffer(buffer, 0, new Uint8Array(64).fill(7));
  const { result, calls } = during(gl, () => buffer.dataTexture());
  assert.ok(result, 'a storage buffer has a data texture');
  const first = calls.findIndex((c) => c[0] === 'texSubImage2D');
  const clear = calls.findIndex((c) => c[0] === 'clearBufferuiv');
  assert.ok(clear >= 0 && clear < first, 'cleared, then written');
  device.destroy();
});

test('every fence poll carries SYNC_FLUSH_COMMANDS_BIT: readbacks and onSubmittedWorkDone', async () => {
  const { gl, device } = await loggingDevice();
  const texture = device.createTexture({ size: [4, 4], format: 'rgba8unorm', usage: U.COPY_SRC | U.RENDER_ATTACHMENT });
  const out = device.createBuffer({ size: 256 * 4, usage: 0x01 | 0x08 });
  const encoder = device.createCommandEncoder();
  encoder.copyTextureToBuffer({ texture }, { buffer: out, bytesPerRow: 256 }, [4, 4]);
  const from = gl.calls.length;
  device.queue.submit([encoder.finish()]);
  await out.mapAsync(1);
  await device.queue.onSubmittedWorkDone();
  const calls = gl.calls.slice(from);
  assert.equal(named(calls, 'fenceSync').length >= 2, true, 'a readback fence and a work-done fence');
  assert.deepEqual(named(calls, 'getSyncParameter'), [], 'GetSyncParameter(SYNC_STATUS) cannot ask for a flush');
  const polls = named(calls, 'clientWaitSync');
  assert.ok(polls.length >= 2);
  for (const c of polls) {
    assert.equal(c[2] & gl.SYNC_FLUSH_COMMANDS_BIT, gl.SYNC_FLUSH_COMMANDS_BIT, 'polled with the flush bit');
    assert.equal(c[3], 0, 'and no timeout (WebGL allows none)');
  }
  device.destroy();
});
