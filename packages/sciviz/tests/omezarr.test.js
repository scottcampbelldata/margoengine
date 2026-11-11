import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import {
  cloudStore,
  openCloudZarr,
  cloudZarrStore,
  openOMEZarr,
  openN5,
  openPrecomputed,
  decodeBlosc,
  decodeCloudCodec,
} from '@margoengine/sciviz/omezarr';
import { openZarr } from '@margoengine/sciviz/formats';

const fixture = (name) => new Uint8Array(readFileSync(new URL(`./fixtures/cloud-codecs/${name}`, import.meta.url)));
const expected = fixture('expected.bin');
const manifest = JSON.parse(new TextDecoder().decode(fixture('manifest.json')));
for (const entry of manifest)
  test(`cloud codec matches numcodecs writer: ${entry.name}`, { timeout: 15000 }, async () => {
    const encoded = fixture(entry.name);
    const decoded = await decodeCloudCodec(entry.codec, encoded, expected.length);
    assert.equal(Buffer.compare(decoded, expected), 0, 'every decoded byte equals the independent writer output');
    await assert.rejects(decodeCloudCodec(entry.codec, encoded, expected.length - 1), RangeError);
  });

const meta2 = (shape, chunks, extra = {}) =>
  JSON.stringify({
    zarr_format: 2,
    shape,
    chunks,
    dtype: '|u1',
    compressor: null,
    fill_value: 0,
    order: 'C',
    filters: null,
    ...extra,
  });
const req = (size, extra = {}) => ({
  level: 0,
  frame: 0,
  origin: [0, 0, 0],
  size,
  signal: new AbortController().signal,
  ...extra,
});

test('OME 0.4 axes, composed transforms, channels, frames and stored LOD', { timeout: 15000 }, async () => {
  const axes = ['t', 'c', 'x', 'z', 'y'].map((name) => ({ name }));
  const store = {
    '.zattrs': JSON.stringify({
      multiscales: [
        {
          version: '0.4',
          axes,
          coordinateTransformations: [
            { type: 'scale', scale: [1, 1, 2, 3, 4] },
            { type: 'translation', translation: [0, 0, 10, 20, 30] },
          ],
          datasets: [
            { path: 'fine', coordinateTransformations: [{ type: 'scale', scale: [1, 1, 1, 1, 1] }] },
            { path: 'coarse', coordinateTransformations: [{ type: 'scale', scale: [1, 1, 2, 2, 2] }] },
          ],
        },
      ],
    }),
    'fine/.zarray': meta2([2, 2, 4, 4, 4], [2, 2, 4, 4, 4]),
    'fine/0.0.0.0.0': Uint8Array.from({ length: 256 }, (_, i) => i),
    'coarse/.zarray': meta2([2, 2, 2, 2, 2], [2, 2, 2, 2, 2]),
    'coarse/0.0.0.0.0': Uint8Array.from({ length: 32 }, (_, i) => i + 100),
  };
  const volume = await openOMEZarr(store, '', { channel: 1 });
  assert.deepEqual(volume.bounds, [10, 16, 30, 42, 20, 29]);
  assert.equal(volume.source.frames, 2);
  assert.deepEqual(
    [...(await volume.source.read(req([2, 2, 2], { frame: 1 })))],
    [192, 208, 193, 209, 196, 212, 197, 213],
  );
  assert.deepEqual(
    [...(await volume.source.read(req([2, 2, 2], { level: 1, frame: 1 })))],
    [124, 128, 125, 129, 126, 130, 127, 131],
  );
  assert.deepEqual(
    volume.levels.map((l) => l.dims),
    [
      [4, 4, 4],
      [2, 2, 2],
    ],
  );
  await assert.rejects(volume.source.read(req([2, 2, 2], { frame: 2 })), /frame/);
});

function sharded(location = 'end') {
  const index = new Uint8Array(32),
    view = new DataView(index.buffer);
  view.setBigUint64(0, BigInt(location === 'start' ? 32 : 0), true);
  view.setBigUint64(8, 8n, true);
  view.setBigUint64(16, (1n << 64n) - 1n, true);
  view.setBigUint64(24, (1n << 64n) - 1n, true);
  const payload = Uint8Array.from({ length: 8 }, (_, i) => i + 1),
    shard = new Uint8Array(40);
  shard.set(index, location === 'start' ? 0 : 8);
  shard.set(payload, location === 'start' ? 32 : 0);
  const metadata = {
    zarr_format: 3,
    node_type: 'array',
    shape: [2, 2, 4],
    data_type: 'uint8',
    chunk_grid: { name: 'regular', configuration: { chunk_shape: [2, 2, 4] } },
    chunk_key_encoding: { name: 'default', configuration: { separator: '/' } },
    fill_value: 99,
    codecs: [
      {
        name: 'sharding_indexed',
        configuration: {
          chunk_shape: [2, 2, 2],
          codecs: [{ name: 'bytes' }],
          index_codecs: [{ name: 'bytes', configuration: { endian: 'little' } }],
          index_location: location,
        },
      },
    ],
  };
  return { 'zarr.json': JSON.stringify(metadata), 'c/0/0/0': shard };
}
for (const location of ['start', 'end'])
  test(`Zarr v3 shard ${location}: bounded index+payload and fill; existing reader reused`, {
    timeout: 15000,
  }, async () => {
    const objects = sharded(location),
      calls = [];
    const source = {
      async get(key, signal, range) {
        calls.push({ key, range });
        return cloudStore(objects).get(key, signal, range);
      },
    };
    const array = await openZarr(await cloudZarrStore(source));
    assert.deepEqual([...(await array.read({ start: [0, 0, 0], stop: [1, 1, 1] }).then((r) => r.data))], [1]);
    assert.deepEqual(
      calls.filter((c) => c.range).map((c) => c.range.length),
      [32, 8],
    );
    assert.equal(calls.filter((c) => c.key === 'c/0/0/0' && !c.range).length, 0);
    assert.deepEqual(
      [...(await array.read({ start: [0, 0, 2], stop: [2, 2, 4] }).then((r) => r.data))],
      new Array(8).fill(99),
    );
    assert.equal(calls.filter((c) => c.range).length, 2, 'index cache and absent inner payload need no more ranges');
  });

test('OME 0.5 has ome metadata and sharded arrays', { timeout: 15000 }, async () => {
  const shard = sharded();
  const store = {
    'zarr.json': JSON.stringify({
      zarr_format: 3,
      node_type: 'group',
      attributes: {
        ome: {
          version: '0.5',
          multiscales: [
            {
              axes: ['z', 'y', 'x'].map((name) => ({ name })),
              datasets: [{ path: '0', coordinateTransformations: [{ type: 'scale', scale: [1, 2, 3] }] }],
            },
          ],
        },
      },
    }),
    ...Object.fromEntries(Object.entries(shard).map(([k, v]) => [`0/${k}`, v])),
  };
  const volume = await openOMEZarr(store);
  assert.deepEqual(volume.levels[0].spacing, [3, 2, 1]);
  assert.deepEqual([...(await volume.source.read(req([1, 1, 1])))], [1]);
});

test('N5 big-endian sparse and partial edge blocks adapt to existing ROI reader', { timeout: 15000 }, async () => {
  const block = new Uint8Array(20),
    v = new DataView(block.buffer);
  v.setUint16(2, 3);
  [1, 2, 1].forEach((n, d) => v.setUint32(4 + d * 4, n));
  v.setUint16(16, 1234);
  v.setUint16(18, 5678);
  const volume = await openN5({
    'attributes.json': JSON.stringify({
      dimensions: [3, 2, 2],
      blockSize: [2, 2, 2],
      dataType: 'uint16',
      compression: { type: 'raw' },
    }),
    '1/0/0': block,
  });
  assert.deepEqual([...(await volume.source.read(req([3, 2, 2])))], [0, 0, 1234, 0, 0, 5678, 0, 0, 0, 0, 0, 0]);
});

test('precomputed raw chunks honour offset, channel planes and partial edges', { timeout: 15000 }, async () => {
  const volume = await openPrecomputed(
    {
      info: JSON.stringify({
        data_type: 'uint8',
        num_channels: 2,
        scales: [
          {
            key: 's',
            size: [3, 2, 2],
            chunk_sizes: [[2, 2, 2]],
            resolution: [2, 3, 4],
            voxel_offset: [-5, 6, 7],
            encoding: 'raw',
          },
        ],
      }),
      's/-3--2_6-8_7-9': Uint8Array.from([1, 2, 3, 4, 11, 12, 13, 14]),
    },
    '',
    { channel: 1 },
  );
  assert.deepEqual(volume.bounds, [-10, -6, 18, 21, 28, 32]);
  assert.deepEqual([...(await volume.source.read(req([1, 2, 2], { origin: [2, 0, 0] })))], [11, 12, 13, 14]);
});

test('cloud HTTP ranges validate, retain auth headers and respect lifetime abort', { timeout: 15000 }, async (t) => {
  const calls = [],
    bytes = Uint8Array.from({ length: 40 }, (_, i) => i);
  const server = createServer((request, response) => {
    calls.push([request.url, request.headers.range, request.headers.authorization]);
    if (request.url === '/missing') {
      response.writeHead(404).end();
      return;
    }
    if (request.url === '/forbidden') {
      response.writeHead(403).end();
      return;
    }
    const range = request.headers.range,
      match = /^bytes=(\d*)-(\d*)$/.exec(range ?? '');
    if (match && request.url !== '/ignored') {
      const start = match[1] ? Number(match[1]) : bytes.length - Number(match[2]),
        end = match[1] ? Number(match[2]) : bytes.length - 1;
      response
        .writeHead(206, {
          'Content-Range': `bytes ${request.url === '/wrong' ? start + 1 : start}-${end}/${bytes.length}`,
        })
        .end(bytes.slice(start, end + 1));
    } else response.end(bytes);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const controller = new AbortController(),
    store = cloudStore(`http://127.0.0.1:${server.address().port}`, {
      signal: controller.signal,
      init: { headers: { Authorization: 'test' } },
      maxBytes: 64,
    });
  assert.deepEqual([...(await store.get('object', undefined, { offset: -4, length: 4 }))], [36, 37, 38, 39]);
  assert.deepEqual([...(await store.get('ignored', undefined, { offset: 3, length: 2 }))], [3, 4]);
  await assert.rejects(store.get('wrong', undefined, { offset: 3, length: 2 }), /Content-Range/);
  assert.equal(await store.get('missing'), undefined);
  await assert.rejects(store.get('forbidden'), /403/);
  assert.equal(calls[0][2], 'test');
  controller.abort('lifetime');
  await assert.rejects(store.get('object', new AbortController().signal), (e) => e === 'lifetime');
});

test('cloud rejects corrupt codecs and invalid bounds without allocating declared output', {
  timeout: 15000,
}, async () => {
  await assert.rejects(decodeBlosc(new Uint8Array(2)), /header/);
  const data = fixture('lz4-1.blosc').slice();
  new DataView(data.buffer).setUint32(4, 2 ** 31, true);
  await assert.rejects(decodeBlosc(data, 1024), /sizes/);
  const c = new AbortController();
  c.abort('stop');
  await assert.rejects(decodeCloudCodec('raw', new Uint8Array(), 10, c.signal), (e) => e === 'stop');
  await assert.rejects(cloudStore({}).get('../escape'), /relative/);
  await assert.rejects(openCloudZarr({ 'zarr.json': '{}' }), /counts/);
});

for (const [name, open] of [
  ['idr-lightsheet', openOMEZarr],
  ['openorganelle', openN5],
  ['hemibrain', openPrecomputed],
])
  test(`original public cloud snapshot: ${name}`, { timeout: 20000 }, async () => {
    const base = new URL(`./fixtures/cloud-volumes/${name}/`, import.meta.url);
    const manifest = JSON.parse(readFileSync(new URL('manifest.json', base), 'utf8'));
    const counts = { reads: 0, bytes: 0, ranges: 0 };
    const store = {
      async get(key, signal, range) {
        signal?.throwIfAborted();
        counts.reads++;
        const record = manifest.requests.find(
          (r) => r.key === key && r.range?.offset === range?.offset && r.range?.length === range?.length,
        );
        assert(record, `recorded request ${key} ${JSON.stringify(range)}`);
        if (!record.file) return undefined;
        const data = new Uint8Array(readFileSync(new URL(record.file, base)));
        assert.equal(createHash('sha256').update(data).digest('hex'), record.sha256);
        counts.bytes += data.length;
        if (range) counts.ranges++;
        return data;
      },
    };
    const volume = await open(store),
      level = volume.levels[manifest.selected];
    const opened = { ...counts };
    const data = await level.source.read(req(manifest.size, { origin: manifest.origin }));
    const expected = readFileSync(new URL('expected.f32', base));
    assert.equal(Buffer.compare(Buffer.from(data.buffer, data.byteOffset, data.byteLength), expected), 0);
    assert(opened.bytes < 100000, 'opening only reads small metadata, independent of full volume voxel count');
    assert(data.byteLength === 131072, '32^3 float32 region has a fixed byte cost');
    if (name === 'hemibrain') assert(counts.ranges >= 3, 'real sharded source uses index and data ranges');
  });

test('teravoxel metadata stays lazy: no requests or allocations proportional to sample count', {
  timeout: 15000,
}, async () => {
  let chunks = 0;
  const meta = meta2([10000, 10000, 10000], [2, 2, 2]);
  const array = await openCloudZarr(async (key) => {
    if (key === '.zarray') return new TextEncoder().encode(meta);
    if (key === 'zarr.json' || key === '.zattrs') return undefined;
    chunks++;
    return new Uint8Array(8).fill(7);
  });
  assert.equal(chunks, 0);
  const read = await array.read({ start: [500, 500, 500], stop: [501, 501, 501] });
  assert.equal(chunks, 1);
  assert.equal(read.data.byteLength, 1);
  assert.equal(read.data[0], 7);
});

test('N5 Java LZ4 block stream checksum and compressed bytes match an independent writer', {
  timeout: 15000,
}, async () => {
  const payload = fixture('n5-lz4-java.bin'),
    header = new Uint8Array(12),
    view = new DataView(header.buffer);
  view.setUint16(2, 2);
  view.setUint32(4, expected.length);
  view.setUint32(8, 1);
  const packed = new Uint8Array(header.length + payload.length);
  packed.set(header);
  packed.set(payload, header.length);
  const input = {
    'attributes.json': JSON.stringify({
      dimensions: [expected.length, 1],
      blockSize: [expected.length, 1],
      dataType: 'uint8',
      compression: { type: 'lz4' },
    }),
    '0/0': packed,
  };
  const volume = await openN5(input);
  const read = await volume.source.read(req([expected.length, 1, 1]));
  assert.equal(Buffer.compare(Uint8Array.from(read), expected), 0);
  packed[header.length + 17] ^= 1;
  await assert.rejects((await openN5(input)).source.read(req([expected.length, 1, 1])), /checksum/);
});

test('precomputed compressed segmentation expands bit-packed labels and constant blocks', {
  timeout: 15000,
}, async () => {
  const bytes = new Uint8Array(24),
    v = new DataView(bytes.buffer);
  v.setUint32(0, 1, true);
  v.setUint32(4, (1 << 24) | 3, true);
  v.setUint32(8, 2, true);
  v.setUint32(12, 0b10101010, true);
  v.setUint32(16, 17, true);
  v.setUint32(20, 42, true);
  const store = {
    info: JSON.stringify({
      data_type: 'uint32',
      num_channels: 1,
      scales: [
        {
          key: 's',
          size: [2, 2, 2],
          chunk_sizes: [[2, 2, 2]],
          resolution: [1, 1, 1],
          encoding: 'compressed_segmentation',
          compressed_segmentation_block_size: [2, 2, 2],
        },
      ],
    }),
    's/0-2_0-2_0-2': bytes,
  };
  assert.deepEqual(
    [...(await (await openPrecomputed(store)).source.read(req([2, 2, 2])))],
    [17, 42, 17, 42, 17, 42, 17, 42],
  );
  v.setUint32(4, 3, true);
  assert.deepEqual([...(await (await openPrecomputed(store)).source.read(req([2, 2, 2])))], new Array(8).fill(17));
});

test('openCloudZarr reads rank-zero scalar arrays, v2 and v3 (KB5822b)', { timeout: 10000 }, async () => {
  const v2 = {
    '.zarray': JSON.stringify({ zarr_format: 2, shape: [], chunks: [], dtype: '<f8', compressor: null, fill_value: null, order: 'C', filters: null }),
    0: new Uint8Array(Float64Array.of(2.5).buffer),
  };
  const v3 = {
    'zarr.json': JSON.stringify({
      zarr_format: 3,
      node_type: 'array',
      shape: [],
      data_type: 'float32',
      chunk_grid: { name: 'regular', configuration: { chunk_shape: [] } },
      chunk_key_encoding: { name: 'default' },
      fill_value: 0,
      codecs: [{ name: 'bytes', configuration: { endian: 'little' } }],
    }),
    c: new Uint8Array(Float32Array.of(-4).buffer),
  };
  for (const [objects, value] of [[v2, 2.5], [v3, -4]]) {
    const array = await openCloudZarr(objects);
    assert.deepEqual(array.shape, []);
    assert.deepEqual([...(await array.read({ start: [], stop: [] })).data], [value]);
  }
});
