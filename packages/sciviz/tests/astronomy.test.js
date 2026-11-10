import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { parseFITS, readFITS, fitsWCS, fitsGrid } from '../dist/fits.js';
import { parseMRC, readMRC, mrcGrid } from '../dist/mrc.js';
import { readOMETIFF, omeTIFFGrid } from '../dist/ometiff.js';
const root = new URL('./fixtures/astronomy/', import.meta.url),
  read = (name) => readFileSync(new URL(name, root)),
  expected = JSON.parse(read('expected.json'));
const near = (a, b, tolerance = 1e-10) => assert.ok(Math.abs(a - b) <= tolerance, `${a} != ${b}`);
test('astronomy originals and independent writer outputs retain their pinned provenance digests', {
  timeout: 10000,
}, () => {
  const manifest = JSON.parse(read('source.json'));
  for (const entry of manifest.files) {
    const b = read(entry.path);
    assert.equal(b.length, entry.bytes, entry.path);
    assert.equal(createHash('sha256').update(b).digest('hex'), entry.sha256, entry.path);
  }
});
test('full-file readers handle HTTP gzip Content-Encoding without requesting compressed byte ranges', {
  timeout: 5000,
}, async () => {
  const compressed = read('emd_1003.map.gz'),
    requests = [];
  const server = createServer((request, response) => {
    requests.push(request.headers.range);
    response.writeHead(200, { 'Content-Encoding': 'gzip', 'Content-Type': 'application/octet-stream' });
    response.end(compressed);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const url = `http://127.0.0.1:${server.address().port}/density.map.gz`,
      map = await readMRC(url);
    assert.equal(map.data.length, 125 ** 3);
    assert.equal(map.data[0], expected.emdb.first);
    await assert.rejects(readMRC(url, { maxBytes: 1024 }), /maxBytes/);
    assert.deepEqual(requests, [undefined, undefined]);
  } finally {
    server.closeAllConnections();
    await new Promise((done, reject) => server.close((error) => (error ? reject(error) : done())));
  }
});
test('Astropy images, cube axes, binary scalar/vector/complex/heap table cells and units', { timeout: 10000 }, () => {
  const file = parseFITS(read('owner.fits')),
    image = file.hdus[0],
    table = file.hdus[1];
  assert.equal(image.kind, 'image');
  assert.deepEqual(image.axes, [5, 4, 3]);
  assert.equal(image.data.length, 60);
  for (let i = 0; i < 60; i++) assert.equal(image.data[i], Math.fround(Math.fround(i / 7) - 2));
  assert.equal(table.kind, 'table');
  assert.equal(table.rows, 2);
  const columns = Object.fromEntries(table.columns.map((c) => [c.name, c]));
  assert.deepEqual(columns.vector.values, [
    [1, 2, 3],
    [4, 5, 6],
  ]);
  assert.deepEqual(columns.vector.dimensions, [3]);
  assert.equal(columns.flux.unit, 'Jy');
  assert.deepEqual(columns.name.values, ['star', 'galaxy']);
  assert.deepEqual(columns.flag.values, [true, false]);
  assert.deepEqual(columns.bits.values[0], [true, false, false, false, false, false, false, false, true]);
  assert.deepEqual(columns.id.values, [2n ** 60n + 1n, -(2n ** 60n) - 1n]);
  assert.deepEqual(columns.null.values, [null, 42]);
  assert.deepEqual(columns.complex.values, [
    [1, 2],
    [3, -4],
  ]);
  assert.deepEqual(columns.variable.values, [[1, 2, 3], [9]]);
  assert.equal(fitsGrid(image.image()).data.length, 60);
  const scaled = parseFITS(read('scaled.fits')).hdus[0];
  assert.deepEqual([...scaled.data], [80, NaN, 140, 160]);
  assert.deepEqual([...parseFITS(read('int64.fits')).hdus[0].data], [2n ** 60n + 1n, -(2n ** 60n) - 1n]);
});
test('FITS WCS agrees with Astropy WCSLIB for rotated zenithal celestial coordinates', { timeout: 1000 }, () => {
  for (const [projection, e] of Object.entries(expected.wcs)) {
    const w = fitsWCS(e.cards, 2);
    for (let i = 0; i < e.pixels.length; i++)
      for (let j = 0; j < 2; j++) near(w.world(e.pixels[i])[j], e.world[i][j], 1e-10);
    assert.ok(w.types[0].endsWith(projection));
  }
  const reference = expected.wcs.TAN,
    header = { ...reference.cards, CUNIT1: 'rad', CUNIT2: 'rad' };
  for (const key of Object.keys(header))
    if (/^(CRVAL[12]|CDELT[12]|CD[12]_[12])$/.test(key)) header[key] *= Math.PI / 180;
  const radians = fitsWCS(header, 2);
  for (let i = 0; i < reference.pixels.length; i++)
    for (let j = 0; j < 2; j++)
      near(radians.world(reference.pixels[i])[j], (reference.world[i][j] * Math.PI) / 180, 1e-12);
  const unsupported = fitsWCS({ ...reference.cards, CTYPE1: 'RA---CAR', CTYPE2: 'DEC--CAR' }, 2);
  assert.throws(() => unsupported.world([1, 2]), /projection CAR/);
});
test('real SDSS corrected frame bzip2 image and binary extensions match Astropy samples and sky axes', {
  timeout: 30000,
}, async () => {
  const file = await readFITS(read('sdss-frame.fits.bz2')),
    image = file.hdus[0],
    e = expected.sdss;
  assert.deepEqual(image.axes, [...e.shape].reverse());
  assert.equal(image.data[0], e.first);
  assert.equal(image.data.at(-1), e.last);
  let sum = 0;
  for (const v of image.data) sum += v;
  near(sum, e.sum, 1e-8);
  for (let i = 0; i < 2; i++)
    for (let j = 0; j < 2; j++)
      near(
        image.wcs.world(
          [
            [0, 0],
            [1000, 1000],
          ][i],
        )[j],
        e.world[i][j],
        1e-10,
      );
  assert.ok(file.hdus.some((h) => h.kind === 'table'));
});
test('FITS truncated, oversized, malformed and cancelled reads reject explicitly', { timeout: 1000 }, async () => {
  const bytes = read('owner.fits');
  assert.throws(() => parseFITS(bytes.subarray(0, 3000)), /truncated/);
  assert.throws(() => parseFITS(bytes, { maxBytes: 32 }), /maxBytes/);
  await assert.rejects(readFITS(bytes, { signal: AbortSignal.abort() }), { name: 'AbortError' });
  const bad = Uint8Array.from(bytes);
  bad.fill(32, 0, 80);
  assert.throws(() => parseFITS(bad), /SIMPLE/);
});
test('mrcfile owner output: integer and float modes, starts, origin, reordered axes and triclinic cell', {
  timeout: 1000,
}, async () => {
  for (const dtype of ['int8', 'int16', 'float32', 'uint16', 'float16']) {
    const map = await readMRC(read(`owner-${dtype}.mrc`));
    assert.deepEqual(map.dims, [5, 4, 3]);
    assert.deepEqual(map.axisOrder, [2, 1, 3]);
    assert.deepEqual(map.origin, [10, 20, 30]);
    for (let i = 0; i < 60; i++) assert.equal(map.data[i], dtype === 'uint16' ? i + 50000 : i - 25);
    const zero = map.world([-2, 1, -3]);
    for (let i = 0; i < 3; i++) near(zero[i], map.origin[i]);
    const p = map.world([-1, 1, -3]);
    near(p[0], 10 + 2.5 * Math.cos((70 * Math.PI) / 180), 1e-6);
    near(p[1], 20 + 2.5 * Math.sin((70 * Math.PI) / 180), 1e-6);
    assert.equal(mrcGrid(map.image()).data.length, 60);
  }
});
test('real EMDB CC0 map matches independent mrcfile dimensions and decoded densities', { timeout: 10000 }, async () => {
  const map = await readMRC(read('emd_1003.map.gz')),
    e = expected.emdb;
  assert.deepEqual(map.dims, [...e.shape].reverse());
  assert.equal(map.mode, e.mode);
  assert.equal(map.data[0], e.first);
  assert.equal(map.data.at(-1), e.last);
  let sum = 0;
  for (const v of map.data) sum += v;
  near(sum, e.sum, 1e-7);
});
test('MRC packed 4-bit, complex component choice, endian order and cancellation', { timeout: 1000 }, () => {
  const source = read('owner-float32.mrc');
  for (const mode of [3, 4, 101]) {
    const count = 60,
      bytes = new Uint8Array(1024 + (mode === 101 ? 30 : count * (mode === 3 ? 4 : 8)));
    bytes.set(source.subarray(0, 1024));
    const v = new DataView(bytes.buffer);
    v.setInt32(12, mode, true);
    if (mode === 101) for (let i = 0; i < 30; i++) bytes[1024 + i] = (i % 16) | ((15 - (i % 16)) << 4);
    else
      for (let i = 0; i < count; i++) {
        if (mode === 3) {
          v.setInt16(1024 + i * 4, 3, true);
          v.setInt16(1026 + i * 4, 4, true);
        } else {
          v.setFloat32(1024 + i * 8, 3, true);
          v.setFloat32(1028 + i * 8, 4, true);
        }
      }
    const map = parseMRC(bytes);
    assert.equal(map.data[0], mode === 101 ? 0 : 3);
    if (mode !== 101) {
      assert.equal(map.image().data[0], 5);
      assert.equal(map.image('imaginary').data[0], 4);
    } else assert.deepEqual([...map.data.slice(0, 4)], [0, 15, 1, 14]);
  }
  assert.throws(() => parseMRC(source, { signal: AbortSignal.abort() }), { name: 'AbortError' });
  assert.throws(() => parseMRC(source.subarray(0, 1025)), /truncated/);
});
test('OME BigTIFF and classic TIFF, tiles and strips, LZW and deflate retain uint16 Z/C/T stacks', {
  timeout: 10000,
}, async () => {
  for (const big of [false, true])
    for (const codec of ['lzw', 'deflate']) {
      const stack = await readOMETIFF(read(`owner-${big ? 'True' : 'False'}-${codec}.ome.tiff`));
      assert.deepEqual(stack.size, { X: 21, Y: 19, Z: 2, C: 3, T: 2 });
      assert.deepEqual(stack.spacing, [0.25, 0.5, 2]);
      assert.equal(stack.channels[1].name, 'GFP');
      for (let t = 0; t < 2; t++)
        for (let c = 0; c < 3; c++)
          for (let z = 0; z < 2; z++) {
            const plane = await stack.plane(z, c, t);
            assert.ok(plane instanceof Uint16Array);
            for (let i = 0; i < plane.length; i++)
              assert.equal(plane[i], (((t * 3 + c) * 2 + z) * 399 * 37 + i * 37 + 50000) % 65536);
          }
      const image = await stack.image(1, 1);
      assert.equal(omeTIFFGrid(image).data.length, 798);
      assert.deepEqual(image.world([4, 2, 3]), [1, 1, 6]);
      await assert.rejects(stack.plane(2), /selection/);
    }
});
test('OME explicit TiffData reverse order and multi-file UUID resolution', { timeout: 1000 }, async () => {
  const reversed = await readOMETIFF(read('reverse.ome.tiff'));
  assert.equal((await reversed.plane(0))[0], 222);
  assert.equal((await reversed.plane(1))[0], 111);
  const resolved = [];
  const stack = await readOMETIFF(read('main.ome.tiff'), {
    resolve: async (name) => {
      resolved.push(name);
      return read(name);
    },
  });
  assert.deepEqual(resolved, []);
  assert.equal((await stack.plane(0))[0], 111);
  assert.deepEqual(resolved, []);
  assert.equal((await stack.plane(1))[0], 222);
  assert.equal((await stack.plane(1))[0], 222);
  assert.deepEqual(resolved, ['part.ome.tiff']);
});
test('IDR CC BY 4.0 native pixel crop keeps each interleaved RGB sample without display scaling', {
  timeout: 10000,
}, async () => {
  const e = JSON.parse(read('idr-source.json')),
    stack = await readOMETIFF(read('idr0096-crop.ome.tiff'));
  assert.deepEqual(stack.size, { X: 256, Y: 256, Z: 1, C: 3, T: 1 });
  for (let c = 0; c < 3; c++) {
    const p = await stack.plane(0, c);
    assert.ok(p instanceof Uint8Array);
    assert.equal(p[0], e.first[c]);
    assert.equal(
      p.reduce((a, b) => a + b, 0),
      e.sum[c],
    );
  }
});
