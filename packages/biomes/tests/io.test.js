// The /io entry: heightmap, weight and mask files, layer dumps, and the saved-world round trip.
import test from 'node:test';
import assert from 'node:assert/strict';
import { crc32, inflateSync } from 'node:zlib';
import { BiomeWorld } from '../dist/index.js';
import { encodePng, exportHeight, exportLayer, exportMasks, exportWeights, loadWorld, saveWorld } from '../dist/io.js';

const options = { seed: 5, size: [512, 512], tileSize: 256, workers: false };

/** Decodes a PNG made by the encoder (filter 0 only): header fields and the unfiltered rows. */
function decodePng(bytes) {
  assert.deepEqual([...bytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    idat = [];
  let at = 8,
    head;
  while (at < bytes.length) {
    const length = view.getUint32(at),
      type = String.fromCharCode(...bytes.subarray(at + 4, at + 8)),
      body = bytes.subarray(at + 8, at + 8 + length);
    assert.equal(
      view.getUint32(at + 8 + length),
      crc32(bytes.subarray(at + 4, at + 8 + length)),
      `CRC of ${type}`,
    );
    if (type === 'IHDR') head = { width: view.getUint32(at + 8), depth: view.getUint32(at + 12), bits: body[8], color: body[9] };
    if (type === 'IDAT') idat.push(body);
    at += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(idat)),
    stride = (head.width * (head.color === 6 ? 4 : 1) * head.bits) / 8,
    rows = new Uint8Array(stride * head.depth);
  for (let j = 0; j < head.depth; j++) {
    assert.equal(raw[j * (stride + 1)], 0, 'filter byte');
    rows.set(raw.subarray(j * (stride + 1) + 1, (j + 1) * (stride + 1)), j * stride);
  }
  return { ...head, rows };
}

test('encodePng: stored and deflated PNGs decode to the same pixels with a valid CRC', async () => {
  const rows = Uint8Array.from({ length: 5 * 3 * 2 }, (_, i) => (i * 37) & 255),
    stored = await encodePng(5, 3, 1, 16, rows),
    packed = await encodePng(5, 3, 1, 16, rows, { compress: true });
  for (const png of [stored, packed]) {
    const d = decodePng(png);
    assert.deepEqual([d.width, d.depth, d.bits, d.color], [5, 3, 16, 0]);
    assert.deepEqual([...d.rows], [...rows]);
  }
  const bad = stored.slice();
  bad[20] ^= 1;
  assert.throws(() => decodePng(bad), /CRC/, 'a flipped byte breaks the CRC check');
});

test('encodePng: more than one stored block (rows over 65,535 bytes) round trips', async () => {
  const rows = new Uint8Array(300 * 300);
  for (let i = 0; i < rows.length; i++) rows[i] = (i * 7 + (i >> 8)) & 255;
  const d = decodePng(await encodePng(300, 300, 1, 8, rows));
  assert.deepEqual([...d.rows], [...rows]);
});

test('exportHeight: raw16, png16 and f32 carry the same heights as the tiles', async () => {
  const world = await BiomeWorld.create(options),
    raw = await exportHeight(world, 'raw16'),
    png = await exportHeight(world, 'png16'),
    f32 = await exportHeight(world, 'f32');
  assert.deepEqual([raw.width, raw.depth, raw.resolution], [512, 512, 1]);
  assert.equal(raw.data.length, 512 * 512 * 2);
  assert.equal(f32.data.length, 512 * 512 * 4);
  const tile = await world.tile(1, 0, { layers: ['height'] }),
    mm = tile.layer('height').data,
    floats = new DataView(f32.data.buffer),
    shorts = new DataView(raw.data.buffer),
    range = Math.round((raw.max - raw.min) * 1000);
  for (const [i, j] of [
    [0, 0],
    [3, 9],
    [255, 255],
  ]) {
    const cell = j * 512 + 256 + i;
    assert.equal(floats.getFloat32(cell * 4, true), Math.fround(mm[j * 256 + i] / 1000));
    assert.equal(shorts.getUint16(cell * 2, true), Math.floor(((mm[j * 256 + i] - Math.round(raw.min * 1000)) * 65535) / range));
  }
  const all = new Uint16Array(raw.data.buffer);
  assert.equal(all.reduce((a, b) => Math.min(a, b)), 0);
  assert.equal(all.reduce((a, b) => Math.max(a, b)), 65535);
  // The PNG holds the RAW samples big-endian.
  const d = decodePng(png.data),
    pixels = new DataView(d.rows.buffer);
  assert.deepEqual([d.width, d.depth, d.bits, d.color], [512, 512, 16, 0]);
  for (let i = 0; i < 512 * 512; i += 997) assert.equal(pixels.getUint16(i * 2), shorts.getUint16(i * 2, true));
  assert.deepEqual([png.min, png.max], [raw.min, raw.max]);
});

test('exportHeight: tiles option exports a rectangle, and bad input is a RangeError', async () => {
  const world = await BiomeWorld.create(options),
    part = await exportHeight(world, 'f32', { tiles: [1, 0, 1, 1] });
  assert.deepEqual([part.width, part.depth], [256, 512]);
  assert.equal(part.data.length, 256 * 512 * 4, 'the file holds that rectangle');
  const stored = new DataView(part.data.buffer),
    below = (await world.tile(1, 1, { layers: ['height'] })).layer('height').data;
  assert.equal(stored.getFloat32((300 * 256 + 7) * 4, true), Math.fround(below[(300 - 256) * 256 + 7] / 1000));
  await assert.rejects(exportHeight(world, 'f32', { tiles: [0, 0, 2, 0] }), RangeError);
  await assert.rejects(exportHeight(world, 'tiff'), RangeError);
});

test('exportWeights and exportMasks: one plane and one PNG per biome, weights add up to 255 per cell', async () => {
  const world = await BiomeWorld.create(options),
    weights = await exportWeights(world),
    masks = await exportMasks(world);
  assert.deepEqual(weights.biomes, world.biomes.map((b) => b.id));
  assert.equal(weights.planes.length, weights.biomes.length);
  for (let cell = 0; cell < 512 * 512; cell += 331) {
    let sum = 0;
    for (const plane of weights.planes) sum += plane[cell];
    assert.equal(sum, 255, 'cell ' + cell);
  }
  assert.deepEqual([...masks.keys()], weights.biomes);
  const sums = new Uint16Array(512 * 512);
  weights.biomes.forEach((id, i) => {
    const d = decodePng(masks.get(id));
    assert.deepEqual([d.width, d.depth, d.bits, d.color], [512, 512, 8, 0]);
    assert.deepEqual([...d.rows], [...weights.planes[i]]);
    d.rows.forEach((value, cell) => (sums[cell] += value));
  });
  assert.ok(sums.every((sum) => sum === 255), 'the mask files, read back, add up to 255 in every cell');
  assert.equal(weights.splats.length, Math.ceil(weights.biomes.length / 4));
  const splat = decodePng(weights.splats[0].png);
  assert.deepEqual([splat.bits, splat.color], [8, 6]);
  for (let k = 0; k < weights.splats[0].biomes.length; k++)
    for (let cell = 0; cell < 512 * 512; cell += 4099) assert.equal(splat.rows[cell * 4 + k], weights.planes[k][cell]);
});

test('exportLayer: JSON and CSV hold the stored integers of the tiles', async () => {
  const world = await BiomeWorld.create(options),
    json = JSON.parse(await exportLayer(world, 'temperature', 'json', { tiles: [0, 0, 0, 0] })),
    csv = await exportLayer(world, 'temperature', 'csv', { tiles: [0, 0, 0, 0] }),
    tile = await world.tile(0, 0, { layers: ['temperature'] });
  assert.deepEqual([json.name, json.format, json.unit, json.width, json.depth, json.channels], ['temperature', 'i16', 'C', 256, 256, 1]);
  assert.deepEqual(json.data, [...tile.layer('temperature').data]);
  const rows = csv.trimEnd().split('\n');
  assert.equal(rows.length, 256);
  assert.deepEqual(rows[7].split(',').map(Number), [...tile.layer('temperature').data.subarray(7 * 256, 8 * 256)]);
  const biome = JSON.parse(await exportLayer(world, 'biome', 'json', { tiles: [0, 0, 0, 0] }));
  assert.equal(biome.channels, 4);
  assert.equal(biome.data.length, 256 * 256 * 4);
  await assert.rejects(exportLayer(world, 'nope'), RangeError);
});

test('saveWorld and loadWorld: the same digests with options, paint and edits', async () => {
  const world = await BiomeWorld.create({ ...options, climate: { latitude: 55, rainfall: 1400 }, ecotone: 8 }),
    cells = 256 * 256,
    paint = new Uint8Array(cells),
    mask = new Uint8Array(cells);
  paint.fill(200, 1000, 40000);
  mask.fill(255, 5000, 9000);
  world.writeLayer('paint/wetland', 0, 0, paint);
  world.writeLayer('mask/lake', 1, 1, mask);
  const text = JSON.stringify(saveWorld(world)),
    saved = JSON.parse(text);
  assert.equal(saved.format, 'margo-biomes-world');
  assert.equal(saved.edits.length, 2);
  const copy = await loadWorld(text, { workers: false });
  assert.deepEqual([copy.seed, copy.ecotone, copy.climate.latitude], [5, 8, world.climate.latitude]);
  assert.deepEqual([...copy.readLayer('paint/wetland', 0, 0)], [...paint]);
  assert.deepEqual([...copy.readLayer('mask/lake', 1, 1)], [...mask]);
  for (const [x, z] of [
    [0, 0],
    [1, 1],
    [0, 1],
  ])
    assert.equal(await copy.digest(x, z), await world.digest(x, z), `tile ${x},${z}`);
  assert.equal(JSON.stringify(saveWorld(copy)), text, 'saving again gives the same file');
  assert.equal((await loadWorld(saved, { workers: false })).seed, 5, 'a parsed object loads too');
  world.dispose();
  copy.dispose();
});

test('saveWorld: heightmap samples, a zone classifier and defined biomes survive the round trip', async () => {
  const samples = new Float32Array(33 * 33);
  for (let i = 0; i < samples.length; i++) samples[i] = ((i * 53) % 97) * 3;
  const { whittaker } = await import('../dist/zones.js'),
    world = await BiomeWorld.create({
      ...options,
      height: { samples, width: 33, depth: 33 },
      classifier: whittaker,
    }),
    copy = await loadWorld(JSON.stringify(saveWorld(world)), { workers: false });
  assert.equal(await copy.digest(1, 0), await world.digest(1, 0));
  assert.equal(copy.heightAt(10, 20), world.heightAt(10, 20));
});

test('saveWorld refuses what JSON cannot hold, and loadWorld refuses other data', async () => {
  const world = await BiomeWorld.create({ ...options, height: { field: () => 5 } });
  assert.throws(() => saveWorld(world), { code: 'unsupported' });
  await assert.rejects(loadWorld({ format: 'other' }), RangeError);
  // The message names the functions that exist (it once named BiomeWorld.from and world.toJSON, which do not).
  await assert.rejects(loadWorld('null'), (e) => e instanceof TypeError && /saveWorld/.test(e.message) && !/toJSON|BiomeWorld.from/.test(e.message));
});

test('the io entry is lazy: no static import of the root reaches it', async () => {
  const { readFileSync } = await import('node:fs'),
    seen = new Set(),
    walk = (file) => {
      if (seen.has(file)) return;
      seen.add(file);
      const text = readFileSync(new URL(file, import.meta.url), 'utf8');
      for (const [, name] of text.matchAll(/^import .*?from "\.\/([^"]+)"/gm)) walk('../dist/' + name);
    };
  walk('../dist/index.js');
  assert.ok(![...seen].some((f) => /(^|\/)io/.test(f)), [...seen].join(' '));
});
