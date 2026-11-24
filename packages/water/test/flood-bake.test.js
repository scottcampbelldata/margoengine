// FG-03: a flood's per-frame fields as EXR images, tiled atlases and 16-bit PNGs. The Doggerland bake needed its own
// browser harness to get depth, velocity and foam out frame by frame; these check the files against the cells, read
// back here with a reader written in the test from the OpenEXR and PNG layouts (not the package's own code).
import test from 'node:test';
import assert from 'node:assert/strict';
import { FLOOD_BAKE_FIELDS, encodeFloodEXR, encodeFloodPNG, floodAtlas, floodImage } from '../dist/flood-bake.js';

// A 3 x 2 reading (rows of increasing z) with distinct values in every field.
const reading = (t = 0, width = 3, height = 2) => {
  const cells = width * height,
    f = (g) => Float32Array.from({ length: cells }, (_, k) => g(k));
  return {
    time: t,
    width,
    height,
    depth: f((k) => (k % 2 ? 0 : 0.5 + k + t)),
    bed: f((k) => -2 + 0.25 * k),
    velocity: Float32Array.from({ length: cells * 2 }, (_, k) => (k % 2 ? -0.5 * k : 0.125 * k + t)),
    foam: f((k) => k / 10),
    breaker: f((k) => k / 20),
    sediment: f((k) => k * 1.5),
  };
};

// Uncompressed scanline OpenEXR: the attributes, the line offset table, then per line y, size and each channel's row
// (channels in name order, FLOAT samples little-endian).
function readEXR(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  assert.equal(view.getUint32(0, true), 20000630, 'EXR magic');
  let at = 8;
  const text = () => {
    let s = '';
    while (bytes[at] !== 0) s += String.fromCharCode(bytes[at++]);
    at++;
    return s;
  };
  const attrs = {};
  for (;;) {
    const name = text();
    if (!name) break;
    const type = text(),
      size = view.getInt32(at, true);
    attrs[name] = { type, at: at + 4, size };
    at += 4 + size;
  }
  const names = [];
  for (let p = attrs.channels.at; bytes[p] !== 0; ) {
    let s = '';
    while (bytes[p] !== 0) s += String.fromCharCode(bytes[p++]);
    names.push({ name: s, type: view.getInt32(p + 1, true) });
    p += 1 + 16;
  }
  const w = attrs.dataWindow.at,
    width = view.getInt32(w + 8, true) - view.getInt32(w, true) + 1,
    height = view.getInt32(w + 12, true) - view.getInt32(w + 4, true) + 1,
    out = Object.fromEntries(names.map((c) => [c.name, new Float32Array(width * height)]));
  for (let j = 0; j < height; j++) {
    let p = Number(view.getBigUint64(at + j * 8, true));
    const y = view.getInt32(p, true);
    p += 8;
    for (const c of names) {
      assert.equal(c.type, 2, `${c.name} is FLOAT`);
      for (let i = 0; i < width; i++, p += 4) out[c.name][y * width + i] = view.getFloat32(p, true);
    }
  }
  return { width, height, names: names.map((c) => c.name), channels: out };
}

async function readPNG(bytes) {
  assert.deepEqual([...bytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10], 'PNG signature');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    table = Array.from({ length: 256 }, (_, n) => {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      return c >>> 0;
    }),
    crc = (b) => {
      let c = 0xffffffff;
      for (const x of b) c = table[(c ^ x) & 255] ^ (c >>> 8);
      return (c ^ 0xffffffff) >>> 0;
    };
  let at = 8,
    width = 0,
    height = 0;
  const idat = [];
  for (;;) {
    const length = view.getUint32(at),
      type = String.fromCharCode(...bytes.subarray(at + 4, at + 8)),
      data = bytes.subarray(at + 8, at + 8 + length);
    assert.equal(view.getUint32(at + 8 + length), crc(bytes.subarray(at + 4, at + 8 + length)), `${type} CRC`);
    if (type === 'IHDR') {
      width = view.getUint32(at + 8);
      height = view.getUint32(at + 12);
      assert.deepEqual([...data.subarray(8)], [16, 0, 0, 0, 0], '16-bit greyscale, no interlace');
    }
    if (type === 'IDAT') idat.push(data);
    at += 12 + length;
    if (type === 'IEND') break;
  }
  const raw = new Uint8Array(
    await new Response(new Blob(idat).stream().pipeThrough(new DecompressionStream('deflate'))).arrayBuffer(),
  );
  assert.equal(raw.length, height * (1 + width * 2));
  const values = new Uint16Array(width * height);
  for (let j = 0; j < height; j++) {
    assert.equal(raw[j * (1 + width * 2)], 0, 'filter None');
    for (let i = 0; i < width; i++)
      values[j * width + i] = (raw[j * (1 + width * 2) + 1 + i * 2] << 8) | raw[j * (1 + width * 2) + 2 + i * 2];
  }
  return { width, height, values };
}

test('floodImage: one pixel a cell, the named fields, north up by default', () => {
  const r = reading();
  assert.deepEqual(FLOOD_BAKE_FIELDS, ['depth', 'surface', 'velocity', 'foam', 'breaker']);
  const image = floodImage(r);
  assert.equal(image.width, 3);
  assert.equal(image.height, 2);
  assert.deepEqual(
    image.channels.map((c) => c.name),
    ['depth', 'surface', 'velocity.x', 'velocity.z', 'foam', 'breaker'],
  );
  const get = (img, name, i, j) => img.channels.find((c) => c.name === name).data[j * img.width + i];
  // Image row 0 is the map's last row (z largest).
  for (let j = 0; j < 2; j++)
    for (let i = 0; i < 3; i++) {
      const k = j * 3 + i,
        y = 1 - j;
      assert.equal(get(image, 'depth', i, y), r.depth[k]);
      assert.equal(get(image, 'surface', i, y), Math.fround(r.depth[k] + r.bed[k]));
      assert.equal(get(image, 'velocity.x', i, y), r.velocity[2 * k]);
      assert.equal(get(image, 'velocity.z', i, y), r.velocity[2 * k + 1]);
    }
  const flat = floodImage(r, { fields: ['bed', 'speed', 'wet'], northUp: false, type: 'HALF' });
  assert.deepEqual(
    flat.channels.map((c) => [c.name, c.type]),
    [
      ['bed', 'HALF'],
      ['speed', 'HALF'],
      ['wet', 'HALF'],
    ],
  );
  assert.deepEqual([...flat.channels[0].data], [...r.bed]);
  assert.equal(flat.channels[1].data[3], Math.fround(Math.hypot(r.velocity[6], r.velocity[7])));
  assert.deepEqual(
    [...flat.channels[2].data],
    [...r.depth].map((d) => (d > 1e-3 ? 1 : 0)),
  );
  assert.throws(() => floodImage(r, { fields: ['depth', 'depth'] }), RangeError);
  assert.throws(() => floodImage(r, { fields: ['height'] }), RangeError);
  assert.throws(() => floodImage(r, { type: 'UINT' }), RangeError);
  assert.throws(() => floodImage({ width: 2, height: 2, depth: new Float32Array(3) }), TypeError);
});

test('floodImage: the sediment field is the load of the reading (FG-13), and 0 for a reading without one', () => {
  const r = reading(),
    image = floodImage(r, { fields: ['sediment'], northUp: false });
  assert.deepEqual(
    image.channels.map((c) => c.name),
    ['sediment'],
  );
  assert.deepEqual([...image.channels[0].data], [...r.sediment]);
  const { sediment, ...old } = r;
  assert.ok(sediment.length === 6);
  assert.deepEqual([...floodImage(old, { fields: ['sediment'] }).channels[0].data], [0, 0, 0, 0, 0, 0]);
  assert.ok(!FLOOD_BAKE_FIELDS.includes('sediment'), 'the default fields are unchanged');
});

test('encodeFloodEXR: the cells exactly, as FLOAT channels a reader finds by name', async () => {
  const r = reading(0.5),
    file = readEXR(await encodeFloodEXR(r)),
    image = floodImage(r);
  assert.equal(file.width, 3);
  assert.equal(file.height, 2);
  assert.deepEqual(file.names, ['breaker', 'depth', 'foam', 'surface', 'velocity.x', 'velocity.z']);
  for (const c of image.channels) assert.deepEqual([...file.channels[c.name]], [...c.data], c.name);
  const aborted = new AbortController();
  aborted.abort(new Error('stop'));
  await assert.rejects(encodeFloodEXR(r, { signal: aborted.signal }), /stop/);
});

test('floodAtlas: frames tiled row-major from the top left, empty tiles 0, the times kept', async () => {
  const frames = [0, 1, 2, 3, 4].map((t) => ({ index: t, time: t / 4, reading: reading(t) })),
    atlas = floodAtlas(frames, { fields: ['depth', 'velocity'] });
  assert.equal(atlas.columns, 3);
  assert.equal(atlas.rows, 2);
  assert.equal(atlas.width, 9);
  assert.equal(atlas.height, 4);
  assert.deepEqual([atlas.frameWidth, atlas.frameHeight], [3, 2]);
  assert.deepEqual(atlas.times, [0, 0.25, 0.5, 0.75, 1]);
  const depth = atlas.channels.find((c) => c.name === 'depth').data;
  frames.forEach((f, n) => {
    const tile = floodImage(f.reading, { fields: ['depth'] }).channels[0].data,
      x0 = (n % 3) * 3,
      y0 = Math.floor(n / 3) * 2;
    for (let j = 0; j < 2; j++) for (let i = 0; i < 3; i++) assert.equal(depth[(y0 + j) * 9 + x0 + i], tile[j * 3 + i]);
  });
  for (let j = 2; j < 4; j++) for (let i = 6; i < 9; i++) assert.equal(depth[j * 9 + i], 0, 'the sixth tile is empty');
  const file = readEXR(await (await import('@margoengine/environment/exr-write')).encodeEXR(atlas));
  assert.deepEqual([...file.channels['velocity.z']], [...atlas.channels.find((c) => c.name === 'velocity.z').data]);
  assert.equal(floodAtlas([reading()], { columns: 1 }).width, 3);
  assert.throws(() => floodAtlas([]), RangeError);
  assert.throws(() => floodAtlas([reading(), reading(0, 2, 2)]), RangeError);
  assert.throws(() => floodAtlas([reading()], { columns: 0 }), RangeError);
  assert.throws(
    () =>
      floodAtlas(
        Array.from({ length: 4 }, () => reading(0, 8192, 1)),
        { columns: 4 },
      ),
    RangeError,
  );
});

test('encodeFloodPNG: one channel as 16-bit grey over its range, valid chunks', async () => {
  const r = reading(),
    image = floodImage(r, { northUp: false }),
    png = await readPNG(await encodeFloodPNG(image, { channel: 'depth' }));
  assert.deepEqual([png.width, png.height], [3, 2]);
  const lo = Math.min(...r.depth),
    hi = Math.max(...r.depth);
  for (let k = 0; k < 6; k++) assert.equal(png.values[k], Math.round((65535 * (r.depth[k] - lo)) / (hi - lo)));
  const ranged = await readPNG(await encodeFloodPNG(image, { channel: 'velocity.x', range: [0, 0.25] }));
  for (let k = 0; k < 6; k++)
    assert.equal(
      ranged.values[k],
      Math.round(Math.min(Math.max(r.velocity[2 * k] / 0.25, 0), 1) * 65535),
      'clamped to the range',
    );
  const flat = await readPNG(
    await encodeFloodPNG({
      width: 2,
      height: 1,
      channels: [{ name: 'a', type: 'FLOAT', data: new Float32Array([3, 3]) }],
    }),
  );
  assert.deepEqual([...flat.values], [0, 0], 'a constant channel is 0');
  await assert.rejects(encodeFloodPNG(image, { channel: 'nothing' }), RangeError);
  await assert.rejects(encodeFloodPNG(image, { range: [1, 0] }), RangeError);
});
