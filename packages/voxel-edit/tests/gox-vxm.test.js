// Goxel .gox and VoxEdit .vxm: bytes built here from the byte layouts of the clean-room specification
// (docs/clean-room.md, VF7 to VF12), and round trips through this package's own writers.
import assert from 'node:assert/strict';
import test from 'node:test';
import { crc32, deflateSync, inflateSync } from 'node:zlib';
import { cellIndex } from '../dist/index.js';
import { parseGOX, parseVXM, writeGOX, writeVXM } from '../dist/formats.js';

const ascii = (s) => new TextEncoder().encode(s);
const i32s = (...v) => new Uint8Array(Int32Array.from(v).buffer);
const u32s = (...v) => new Uint8Array(Uint32Array.from(v).buffer);
const f32s = (...v) => new Uint8Array(Float32Array.from(v).buffer);
const join = (...parts) => {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
};
const colorAt = (file, model, x, y, z) => {
  const { grid, position } = file.models[model],
    index = grid.voxels[cellIndex(grid.size, x - position[0], y - position[1], z - position[2])];
  return [...file.palette.subarray(index * 4, index * 4 + 4)];
};
const solid = (file) => file.models.reduce((n, m) => n + m.grid.voxels.filter(Boolean).length, 0);

// --- .gox pieces ---
const pngChunk = (type, data) => {
  const body = join(ascii(type), data),
    length = new Uint8Array(4),
    crc = new Uint8Array(4);
  new DataView(length.buffer).setUint32(0, data.length);
  new DataView(crc.buffer).setUint32(0, crc32(body));
  return join(length, body, crc);
};
/** A 64 x 64 RGBA PNG; `filter` is the row filter byte (Sub = 1 exercises the decoder's filters). */
const png = (pixels, filter = 0) => {
  const head = new Uint8Array(13),
    dv = new DataView(head.buffer);
  dv.setUint32(0, 64);
  dv.setUint32(4, 64);
  head.set([8, 6, 0, 0, 0], 8);
  const raw = new Uint8Array(64 * 257);
  for (let row = 0; row < 64; row++) {
    raw[row * 257] = filter;
    for (let i = 0; i < 256; i++) {
      const v = pixels[row * 256 + i],
        left = filter === 1 && i >= 4 ? pixels[row * 256 + i - 4] : 0;
      raw[row * 257 + 1 + i] = (v - left) & 255;
    }
  }
  return join(
    Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10),
    pngChunk('IHDR', head),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', new Uint8Array(0)),
  );
};
/** Block pixels from voxels given by block-local (x, y, z) through the spec's row and column formula. */
const blockPixels = (voxels) => {
  const pixels = new Uint8Array(64 * 64 * 4);
  for (const [x, y, z, rgba] of voxels) {
    const row = 4 * z + Math.floor(y / 4),
      column = 16 * (y % 4) + x;
    pixels.set(rgba, (row * 64 + column) * 4);
  }
  return pixels;
};
const goxChunk = (type, data, crc = 0) => join(ascii(type), i32s(data.length), data, u32s(crc));
const entry = (key, value) => join(i32s(key.length), ascii(key), i32s(value.length), value);
const layer = (records, ...entries) => join(i32s(records.length), ...records.map((r) => i32s(...r, 0)), ...entries);
const gox = (version, ...chunks) => join(ascii('GOX '), i32s(version), ...chunks);
const RED = [232, 48, 21, 255],
  GREEN = [27, 129, 62, 255];

test('GOX: a BL16 pixel maps to its voxel by row 4z + y/4, column 16(y mod 4) + x, Z up turned to Y up', () => {
  const pixels = blockPixels([
      [3, 5, 7, RED],
      [15, 15, 15, GREEN],
      [0, 0, 0, [9, 9, 9, 1]],
    ]),
    file = parseGOX(
      gox(
        2,
        goxChunk('BL16', png(pixels, 1), 0xdeadbeef), // a non-zero CRC is ignored
        goxChunk('XXXX', ascii('unknown chunks are skipped')),
        goxChunk('LAYR', layer([[0, 16, -15, 0]], entry('name', ascii('body')), entry('visible', Uint8Array.of(0)))),
      ),
    );
  assert.equal(file.models.length, 1);
  assert.equal(file.models[0].name, 'body');
  assert.equal(file.models[0].visible, false);
  assert.equal(solid(file), 3);
  // file (16 + x, -15 + y, z) is cell (16 + x, z, 15 - y)
  assert.deepEqual(colorAt(file, 0, 19, 7, 10), RED);
  assert.deepEqual(colorAt(file, 0, 31, 15, 0), GREEN);
  assert.deepEqual(colorAt(file, 0, 16, 0, 15), [9, 9, 9, 1], 'alpha 1 is solid');
  assert.deepEqual(file.models[0].position, [16, 0, 0]);
  assert.deepEqual(file.models[0].grid.size, [16, 16, 16]);
});

test('GOX: layers reuse blocks, later blocks overwrite earlier ones with air, version 1 shifts corners by 8', () => {
  const a = png(blockPixels([[0, 0, 0, RED]])),
    b = png(blockPixels([[1, 0, 0, GREEN]])),
    records = [
      [0, 0, 0, 0], // red at file x 0
      [1, -1, 0, 0], // green at file x 0, over the red
      [0, 32, 0, 0], // red at file x 32
      [1, 32, 0, 0], // air at file x 32 clears it; green at 33
    ],
    v2 = parseGOX(gox(2, goxChunk('BL16', a), goxChunk('BL16', b), goxChunk('LAYR', layer(records)))),
    v1 = parseGOX(
      gox(
        1,
        goxChunk('BL16', a),
        goxChunk('BL16', b),
        goxChunk('LAYR', layer(records.map(([i, x, y, z]) => [i, x + 8, y + 8, z + 8]))),
      ),
    );
  for (const file of [v2, v1]) {
    assert.equal(solid(file), 2);
    assert.deepEqual(colorAt(file, 0, 0, 0, 0), GREEN);
    assert.deepEqual(colorAt(file, 0, 32, 0, 0), [0, 0, 0, 0]);
    assert.deepEqual(colorAt(file, 0, 33, 0, 0), GREEN);
  }
  assert.equal(v1.version, 1);
});

test('GOX: dictionaries end at the chunk or at a key length of 0, and wrong-sized values are ignored', () => {
  const file = parseGOX(
    gox(
      2,
      goxChunk(
        'MATE',
        join(
          entry('name', ascii('steel')),
          entry('metallic', f32s(0.75)),
          entry('roughness', Uint8Array.of(1, 2)),
          entry('color', f32s(0.5, 0.25, 1, 1)),
        ),
      ),
      goxChunk('CAMR', join(entry('active', new Uint8Array(0)), entry('dist', f32s(5)))),
      goxChunk(
        'LAYR',
        layer([], entry('mode', i32s(3)), entry('material', i32s(0)), i32s(0), ascii('junk after the end')),
      ),
    ),
  );
  assert.deepEqual(file.materials, [
    { name: 'steel', color: [0.5, 0.25, 1, 1], metallic: 0.75, roughness: 1, emission: [0, 0, 0] },
  ]);
  assert.equal(file.models[0].mode, 3);
  assert.equal(file.models[0].material, 0);
  assert.equal(solid(file), 0);
  assert.deepEqual(file.models[0].grid.size, [1, 1, 1]);
});

test('GOX: shape layers fill the box, clone layers copy their base moved by mat', () => {
  // a box: half extents 2, 1, 3 at centre (10, 0, 3)
  const box = f32s(2, 0, 0, 0, 0, 1, 0, 0, 0, 0, 3, 0, 10, 0, 3, 1),
    shape = (name, id) =>
      goxChunk(
        'LAYR',
        layer(
          [],
          entry('id', i32s(id)),
          entry('shape', ascii(name)),
          entry('mat', box),
          entry('color', Uint8Array.from(RED)),
        ),
      ),
    move = f32s(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 100, 0, 1),
    file = parseGOX(
      gox(
        2,
        goxChunk('LAYR', layer([], entry('id', i32s(4)), entry('base_id', i32s(1)), entry('mat', move))),
        shape('cube', 1),
        shape('sphere', 2),
        shape('cylinder', 3),
      ),
    ),
    count = (m) => file.models[m].grid.voxels.filter(Boolean).length;
  assert.equal(count(1), 4 * 2 * 6);
  assert.deepEqual(file.models[1].position, [8, 0, 0]); // file x 8..11, y -1..0, z 0..5
  assert.deepEqual(colorAt(file, 1, 8, 0, 1), RED); // file (8, -1, 0)
  // sphere: centres inside the ellipsoid; cylinder: inside the ellipse in x y, all of z
  let sphere = 0,
    cylinder = 0;
  for (let x = 8; x < 12; x++)
    for (let y = -1; y < 1; y++)
      for (let z = 0; z < 6; z++) {
        const u = (x + 0.5 - 10) / 2,
          v = (y + 0.5) / 1,
          w = (z + 0.5 - 3) / 3;
        if (u * u + v * v + w * w <= 1) sphere++;
        if (u * u + v * v <= 1) cylinder++;
      }
  assert.equal(count(2), sphere);
  assert.equal(count(3), cylinder);
  assert.equal(count(0), count(1), 'the clone has its base cube');
  assert.deepEqual(file.models[0].position, [8, 0, -100]);
});

test('GOX: writer output is chunked as the spec lays out and round-trips', async () => {
  const palette = new Uint8Array(1024);
  palette.set(RED, 4);
  palette.set(GREEN, 8);
  const grid = (size, cells) => {
      const voxels = new Uint8Array(size[0] * size[1] * size[2]);
      for (const [x, y, z, v] of cells) voxels[cellIndex(size, x, y, z)] = v;
      return { size, voxels };
    },
    models = [
      {
        name: 'a',
        position: [-3, 2, 5],
        grid: grid(
          [20, 3, 2],
          [
            [0, 0, 0, 1],
            [19, 2, 1, 2],
          ],
        ),
      },
      {
        name: 'b',
        position: [-3, 2, 5],
        grid: grid(
          [20, 3, 2],
          [
            [0, 0, 0, 1],
            [19, 2, 1, 2],
          ],
        ),
        visible: false,
      },
    ],
    bytes = await writeGOX(models, palette),
    dv = new DataView(bytes.buffer),
    types = [];
  assert.equal(new TextDecoder().decode(bytes.subarray(0, 4)), 'GOX ');
  assert.equal(dv.getInt32(4, true), 2);
  for (let at = 8; at < bytes.length; ) {
    const length = dv.getInt32(at + 4, true),
      type = new TextDecoder().decode(bytes.subarray(at, at + 4));
    types.push(type);
    assert.equal(dv.getUint32(at + 8 + length, true), 0, 'CRC written as 0');
    if (type === 'LAYR') {
      const count = dv.getInt32(at + 8, true);
      for (let r = 0; r < count; r++)
        for (let k = 1; k < 4; k++)
          assert.equal(dv.getInt32(at + 12 + r * 20 + k * 4, true) & 15, 0, 'aligned corners');
    }
    if (type === 'BL16') {
      // the zlib data of IDAT inflates to 64 rows of filter byte plus 256 bytes
      const pngBytes = bytes.subarray(at + 8, at + 8 + length),
        idat = pngBytes.subarray(41, 41 + new DataView(pngBytes.buffer, pngBytes.byteOffset + 33).getUint32(0));
      assert.equal(inflateSync(idat).length, 64 * 257);
    }
    at += length + 12;
  }
  // two distinct blocks (the model spans file x -3..16), shared by both layers
  assert.deepEqual(types, ['BL16', 'BL16', 'MATE', 'LAYR', 'LAYR']);
  const back = parseGOX(bytes);
  for (const m of [0, 1]) {
    assert.deepEqual(back.models[m].position, [-3, 2, 5]);
    assert.deepEqual(back.models[m].grid.size, [20, 3, 2]);
    assert.deepEqual(colorAt(back, m, -3, 2, 5), RED);
    assert.deepEqual(colorAt(back, m, 16, 4, 6), GREEN);
  }
  assert.deepEqual(
    back.models.map((m) => m.visible),
    [true, false],
  );
  const aborted = new AbortController();
  aborted.abort(new Error('stop'));
  await assert.rejects(writeGOX(models, palette, { signal: aborted.signal }), /stop/);
  palette[11] = 0;
  await assert.rejects(writeGOX(models, palette), /alpha 0/);
});

test('GOX: damaged files are refused with a reason', () => {
  assert.throws(() => parseGOX(ascii('VOX 1234')), TypeError);
  assert.throws(() => parseGOX(gox(3)), /version 3/);
  assert.throws(() => parseGOX(gox(2, goxChunk('LAYR', layer([[0, 0, 0, 0]])))), /block 0, but only 0/);
  assert.throws(() => parseGOX(gox(2, goxChunk('IMG ', new Uint8Array(8))).subarray(0, 20)), /ends early/);
  const big = png(blockPixels([[0, 0, 0, RED]])),
    far = gox(
      2,
      goxChunk('BL16', big),
      goxChunk(
        'LAYR',
        layer([
          [0, 0, 0, 0],
          [0, 4096, 0, 0],
        ]),
      ),
    );
  assert.throws(() => parseGOX(far, { maxCells: 1_000_000 }), /maxCells/);
});

// --- .vxm pieces ---
const cstring = (s) => join(ascii(s), Uint8Array.of(0));
const emptyMesh = (version) =>
  join(u32s(0, 0), version >= 11 ? u32s(0) : version >= 4 ? u32s(0) : Uint8Array.of(0), u32s(0, 0, 0, 0, 0, 0));
/** A material entry as the file stores it: B, G, R, A, emissive. */
const bgra = ([r, g, b, a], glow = 0) => Uint8Array.of(b, g, r, a, glow);

test('VXM: v12 cells run Z fastest, then Y, then X, with X mirrored; materials are BGRA', () => {
  // size 2 x 2 x 3: cell c is file (c / 6, (c / 3) mod 2, c mod 3)
  const runs = Uint8Array.of(1, 0, 2, 255, 3, 1, 1, 7, 5, 255, 0),
    file = parseVXM(
      join(
        ascii('VXMC'),
        u32s(2, 2, 3),
        f32s(0.5, 0, 0.5),
        Uint8Array.of(0),
        f32s(0, 0, 0, 0),
        u32s(1),
        emptyMesh(12),
        new Uint8Array(2048),
        Uint8Array.of(0, 2),
        bgra(RED, 1),
        bgra(GREEN),
        Uint8Array.of(1),
        cstring('Main'),
        Uint8Array.of(0),
        runs,
        Uint8Array.of(0),
      ),
    );
  assert.equal(file.version, 12);
  assert.deepEqual(file.models[0].name, 'Main');
  assert.equal(file.models[0].visible, false);
  assert.deepEqual([...file.palette.subarray(4, 12)], [...RED, ...GREEN], 'BGRA in the file, RGBA here');
  assert.deepEqual([...file.emissive.subarray(0, 3)], [0, 1, 0]);
  // c 0 red -> file (0,0,0) -> cell (1,0,0); c 3..5 green -> file (0,1,0..2) -> cell (1,1,0..2)
  assert.deepEqual(colorAt(file, 0, 1, 0, 0), RED);
  assert.deepEqual(colorAt(file, 0, 0, 0, 0), [0, 0, 0, 0]);
  for (let z = 0; z < 3; z++) assert.deepEqual(colorAt(file, 0, 1, 1, z), GREEN);
  // c 6, index 7 (no such material) is air
  assert.equal(solid(file), 4);
});

test('VXM: v4 skips its run-length textures and quads, and reads the size after the mesh', () => {
  const texture = (name) => join(cstring(name), Uint8Array.of(200, 1, 2, 3, 40, 4, 5, 6, 0)),
    quad = join(f32s(0, 0, 0), i32s(1, 2)),
    mesh = join(
      u32s(10, 24),
      u32s(2),
      texture('Diffuse'),
      texture('Emissive'),
      u32s(1),
      quad,
      quad,
      quad,
      quad,
      u32s(0, 0, 0, 0, 0),
    ),
    file = parseVXM(
      join(ascii('VXM4'), mesh, u32s(1, 2, 1), Uint8Array.of(1), bgra(GREEN, 1), Uint8Array.of(1, 0, 1, 255, 0)),
    );
  assert.equal(file.version, 4);
  assert.deepEqual(file.pivot, [0.5, 0, 0.5]);
  assert.deepEqual(file.models[0].grid.size, [1, 2, 1]);
  assert.deepEqual(colorAt(file, 0, 0, 0, 0), GREEN);
  assert.equal(solid(file), 1);
});

test('VXM: v9 surface sizes come from the normal, v13 has no LOD header and a fixed trailer', () => {
  const v9 = parseVXM(
    join(
      ascii('VXM9'),
      u32s(1, 1, 1),
      f32s(0.5, 0, 0.5),
      Uint8Array.of(1),
      u32s(0, 0, 0, 2, 3, 4, 2), // normal 2: width x, height z: 2 x 4
      new Uint8Array(8),
      f32s(1, 0, 0, 0),
      u32s(1),
      emptyMesh(9),
      Uint8Array.of(1),
      bgra(RED),
      Uint8Array.of(1, 0, 0),
    ),
  );
  assert.deepEqual(colorAt(v9, 0, 0, 0, 0), RED);
  const v13 = parseVXM(
    join(
      ascii('VXMD'),
      u32s(1, 1, 1),
      f32s(0.5, 0, 0.5),
      Uint8Array.of(0),
      emptyMesh(13),
      new Uint8Array(2048),
      Uint8Array.of(1),
      cstring('p'),
      Uint8Array.of(0, 4),
      Uint8Array.of(1),
      bgra(GREEN),
      Uint8Array.of(1),
      cstring('one'),
      Uint8Array.of(1, 1, 0, 0),
      Uint8Array.of(0, 0, 255),
    ),
  );
  assert.equal(v13.version, 13);
  assert.deepEqual(colorAt(v13, 0, 0, 0, 0), GREEN);
});

test('VXM: the v12 writer lays out the spec recipe byte for byte and round-trips several models', () => {
  const palette = new Uint8Array(1024);
  palette.set(RED, 4);
  palette.set(GREEN, 8);
  const size = [3, 1, 1],
    a = { name: 'm', position: [0, 0, 0], grid: { size, voxels: Uint8Array.of(1, 2, 0) } },
    b = { name: 'n', position: [0, 0, 0], grid: { size, voxels: Uint8Array.of(0, 0, 2) }, visible: false },
    bytes = writeVXM([a, b], palette, { emissive: [0, 0, 1] }),
    expectedHead = join(
      ascii('VXMC'),
      u32s(3, 1, 1),
      f32s(0.5, 0, 0.5),
      Uint8Array.of(0),
      f32s(0, 0, 0, 0),
      u32s(1),
      u32s(0, 0, 0, 0, 0, 0, 0, 0, 0),
    );
  assert.deepEqual(bytes.subarray(0, expectedHead.length), expectedHead);
  let at = expectedHead.length;
  assert.deepEqual([...bytes.subarray(at, at + 12)], [...RED, ...GREEN, 255, 0, 255, 255], 'albedo palette RGBA');
  at += 1024;
  assert.deepEqual([...bytes.subarray(at, at + 12)], [0, 0, 0, 255, ...GREEN, 255, 0, 255, 255], 'emissive palette');
  at += 1024;
  assert.deepEqual(
    [...bytes.subarray(at, at + 12)],
    [0, 2, 21, 48, 232, 255, 0, 62, 129, 27, 255, 1],
    'BGRA materials',
  );
  at += 12;
  // model m: file x 0 is cell x 2 (air), then green, then red
  assert.deepEqual([...bytes.subarray(at)], [2, 109, 0, 1, 1, 255, 1, 1, 1, 0, 0, 110, 0, 0, 1, 1, 2, 255, 0, 0]);
  const back = parseVXM(bytes);
  assert.deepEqual(
    back.models.map((m) => [m.name, m.visible, [...m.grid.voxels]]),
    [
      ['m', true, [1, 2, 0]],
      ['n', false, [0, 0, 2]],
    ],
  );
  assert.deepEqual([...back.emissive.subarray(0, 3)], [0, 0, 1]);
  // long runs split at 255
  const long = { position: [0, 0, 0], grid: { size: [1, 1, 600], voxels: new Uint8Array(600).fill(1) } },
    again = parseVXM(writeVXM(long, palette));
  assert.equal(solid(again), 600);
  assert.throws(() => writeVXM([a, long], palette), /share one size/);
});

test('VXM: damaged files are refused with a reason', () => {
  assert.throws(() => parseVXM(ascii('VOX 1')), TypeError);
  assert.throws(() => parseVXM(ascii('VXMZ')), /not supported/);
  assert.throws(() => parseVXM(ascii('VXMC').subarray(0, 4)), /ends early/);
  assert.throws(
    () => parseVXM(join(ascii('VXM4'), emptyMesh(4), u32s(1, 1, 1), Uint8Array.of(0), Uint8Array.of(2, 255, 0))),
    /runs past/,
  );
});
