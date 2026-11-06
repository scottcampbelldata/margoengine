// Streaming KTX2 mips (@margoengine/decoders/ktx2-stream) on real files: each one-level file must transcode to the same
// bytes as that level of the whole file, and the streamer's reads, GPU writes and budget are checked against a mock device
// with the real Basis transcoder behind it. The GPU run is in tests/decoders-browser.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { transcodeKTX2Layers } from '../dist/codec.js';
import { readKTX2Index } from '../dist/ktx2-file.js';
import { ktx2LevelFile, KTX2Streamer, levelForPixels } from '../dist/ktx2-stream.js';
import { basis, fixture, sha } from './support/ktx2.js';

globalThis.GPUTextureUsage ??= { TEXTURE_BINDING: 4, COPY_DST: 2, COPY_SRC: 1 };
const top = async (name) => new Uint8Array(await readFile(new URL(`./fixtures/${name}`, import.meta.url)));

const REAL = [
  ['cube-uastc-zstd.ktx2', fixture],
  ['cube-etc1s.ktx2', fixture],
  ['array-uastc.ktx2', fixture],
  ['Dot_C.ktx2', top],
  ['Rib_N.ktx2', top],
];

test('one-level files transcode to the same bytes as the whole file, ETC1S codebooks included', async () => {
  const module = await basis();
  for (const [name, read] of REAL) {
    const bytes = await read(name),
      index = readKTX2Index(bytes),
      target = 'bc7',
      whole = transcodeKTX2Layers(module, bytes, target);
    index.levels.forEach((level, i) => {
      const single = ktx2LevelFile(bytes, index, i, bytes.subarray(level.offset, level.offset + level.length)),
        file = transcodeKTX2Layers(module, single, target, true);
      assert.equal(file.mipmaps.length, 1);
      assert.equal(file.format, whole.format);
      assert.equal(sha(file.mipmaps[0].data), sha(whole.mipmaps[i].data), `${name} level ${i}`);
    });
  }
});

test('levelForPixels picks the smallest level that still covers the screen', () => {
  assert.equal(levelForPixels(1024, 1024, 1024), 0);
  assert.equal(levelForPixels(1024, 1024, 2048), 0);
  assert.equal(levelForPixels(1024, 1024, 513), 0);
  assert.equal(levelForPixels(1024, 1024, 512), 1);
  assert.equal(levelForPixels(1024, 512, 100), 3);
  assert.equal(levelForPixels(1024, 1024, 0), 32);
});

function mockDevice() {
  const log = { created: [], writes: [], copies: [], destroyed: 0 };
  return {
    log,
    createTexture(descriptor) {
      const texture = { ...descriptor, destroy: () => log.destroyed++ };
      log.created.push(texture);
      return texture;
    },
    createCommandEncoder: () => ({
      copyTextureToTexture: (from, to, size) => log.copies.push({ from, to, size }),
      finish: () => ({}),
    }),
    queue: {
      submit() {},
      writeTexture: (destination, data, layout, size) => log.writes.push({ destination, data, layout, size }),
    },
  };
}

// A server of one file: Range reads, recorded, as a real one answers them.
function server(bytes) {
  const reads = [];
  return {
    reads,
    fetch: async (url, { headers }) => {
      const [, from, to] = /bytes=(\d+)-(\d+)/.exec(headers.Range),
        end = Math.min(+to + 1, bytes.length);
      reads.push([+from, end]);
      return new Response(bytes.slice(+from, end), {
        status: 206,
        headers: { 'Content-Range': `bytes ${from}-${end - 1}/${bytes.length}` },
      });
    },
  };
}

async function streamer(bytes, options = {}) {
  const module = await basis(),
    device = mockDevice(),
    web = server(bytes),
    decoder = {
      target: 'bc7',
      decode: async (data, { exactTarget }) => transcodeKTX2Layers(module, data, exactTarget, true),
    };
  return { web, device, streamer: new KTX2Streamer({ device, decoder, fetch: web.fetch, headBytes: 1024, ...options }) };
}
const settled = () => new Promise((resolve) => setTimeout(resolve, 20));

test('a stream shows the smallest levels from the head of the file, then loads by screen size', async () => {
  const bytes = await fixture('cube-uastc-zstd.ktx2'),
    { web, device, streamer: s } = await streamer(bytes),
    stream = await s.open('/cube.ktx2'),
    whole = transcodeKTX2Layers(await basis(), bytes, 'bc7'),
    changes = [];
  assert.equal(stream.dimension, 'cube');
  assert.equal(stream.layers, 6);
  assert.equal(stream.levels, 7);
  // Level 4 is the coarsest whole-block level of a 64 px texture: 4 px across.
  assert.equal(stream.residentLevel, 4);
  assert.deepEqual(device.log.created[0].size, [4, 4, 6]);
  assert.equal(device.log.created[0].mipLevelCount, 3);
  const read = web.reads.reduce((total, [a, b]) => total + b - a, 0);
  assert.ok(read < bytes.length / 4, `first picture took ${read} of ${bytes.length} bytes`);
  assert.deepEqual(
    device.log.writes.map((w) => w.destination.mipLevel).sort(),
    [0, 1, 2],
  );
  stream.onChange = (texture) => changes.push(texture);
  stream.want(32);
  s.update();
  await settled();
  assert.equal(stream.residentLevel, 1);
  assert.equal(changes.length, 3);
  assert.equal(stream.texture, changes[2]);
  assert.deepEqual(stream.texture.size, [32, 32, 6]);
  assert.equal(stream.texture.mipLevelCount, 6);
  assert.equal(device.log.destroyed, 3, 'old textures go');
  // The newest level holds exactly level 1 of the whole file, and the GPU copies move the rest down.
  const last = device.log.writes.at(-1);
  assert.equal(last.destination.texture, stream.texture);
  assert.equal(last.destination.mipLevel, 0);
  assert.equal(sha(last.data), sha(whole.mipmaps[1].data));
  assert.deepEqual(last.size, [32, 32, 6]);
  const copy = device.log.copies.at(-1);
  assert.equal(copy.from.mipLevel, 4);
  assert.equal(copy.to.mipLevel, 5);
  assert.deepEqual(copy.size, [4, 4, 6], 'a 2 px mip copies as one whole block');
  assert.equal(s.usedBytes, stream.bytes(1));
  stream.dispose();
  assert.equal(s.usedBytes, 0);
});

test('the budget caps what loads, and drops levels nothing needs for levels something does', async () => {
  const bytes = await fixture('cube-uastc-zstd.ktx2'),
    { streamer: s } = await streamer(bytes, { budgetBytes: 20000 }),
    near = await s.open('/near.ktx2'),
    far = await s.open('/far.ktx2');
  const cost = (base) => near.bytes(base);
  assert.ok(cost(1) + cost(4) < 20000 && cost(0) + cost(4) > 20000, 'the budget sits between level 1 and level 0');
  near.want(64);
  s.update();
  await settled();
  assert.equal(near.residentLevel, 1, 'level 0 does not fit');
  assert.ok(s.usedBytes <= 20000);
  // Now the other texture fills the screen and the first shrinks away: its levels make the room.
  far.want(64);
  near.want(4);
  s.update();
  await settled();
  assert.equal(far.residentLevel, 1);
  assert.equal(near.residentLevel, 4);
  assert.ok(s.usedBytes <= 20000);
  s.dispose();
});

test('errors, servers without Range and aborts', async () => {
  const bytes = await fixture('cube-uastc-zstd.ktx2'),
    { streamer: whole, web } = await streamer(bytes, {
      fetch: async () => {
        web.reads.push('whole');
        return new Response(bytes, { status: 200 });
      },
    });
  const stream = await whole.open('/cube.ktx2');
  assert.equal(stream.residentLevel, 4);
  stream.want(64);
  whole.update();
  await settled();
  assert.equal(stream.residentLevel, 0);
  assert.equal(web.reads.length, 1, 'a server that ignores Range is read once');
  whole.dispose();

  const { streamer: broken } = await streamer(bytes),
    { streamer: missing } = await streamer(bytes, { fetch: async () => new Response('', { status: 404 }) });
  await assert.rejects(missing.open('/nope.ktx2'), /404/);
  await assert.rejects(broken.open(new Uint8Array(10)), /truncated header/);
  const controller = new AbortController();
  controller.abort(new Error('stop'));
  await assert.rejects(broken.open('/x.ktx2', { signal: controller.signal }));
  assert.throws(() => new KTX2Streamer({}), /needs a device/);
  assert.throws(() => new KTX2Streamer({ device: {}, budgetBytes: 0 }), /budgetBytes/);
  broken.dispose();
});

test('a failed level leaves the stream as it was and reports once', async () => {
  const bytes = await fixture('cube-uastc-zstd.ktx2'),
    errors = [],
    { streamer: s } = await streamer(bytes, { onError: (error, stream) => errors.push([error, stream]) }),
    stream = await s.open(bytes);
  const texture = stream.texture,
    index = readKTX2Index(bytes),
    { offset } = index.levels[3];
  bytes.fill(0xff, offset, offset + index.levels[3].length);
  stream.want(8);
  s.update();
  await settled();
  assert.equal(errors.length, 1);
  assert.equal(errors[0][1], stream);
  assert.equal(stream.residentLevel, 4);
  assert.equal(stream.texture, texture);
  assert.ok(stream.error);
  s.dispose();
});
