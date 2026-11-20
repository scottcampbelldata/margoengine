import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
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
  assert.throws(
    () => fitsGrid(image.image()),
    (e) => e.code === 'unsupported',
  );
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
test('corrupt or truncated gzip FITS and MRC input rejects with the coded gzip error', { timeout: 2000 }, async () => {
  const fits = gzipSync(read('owner.fits')),
    mrc = read('emd_1003.map.gz'),
    damaged = Uint8Array.from(fits);
  for (let i = 20; i < 60; i++) damaged[i] ^= 0xa5;
  const gzipError = (error) =>
    error instanceof TypeError &&
    /^Scientific image gzip data is corrupt or truncated; supply the complete file/.test(error.message) &&
    error.cause !== undefined;
  for (const input of [fits.subarray(0, fits.length >> 1), damaged, new Uint8Array([31, 139, 0, 0])])
    await assert.rejects(readFITS(input), gzipError);
  for (const input of [mrc.subarray(0, mrc.length >> 1), new Uint8Array([31, 139, 0, 0])])
    await assert.rejects(readMRC(input), gzipError);
  assert.equal((await readFITS(fits)).hdus[0].data.length, 60);
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
    // ORIGIN places the first sample; START (2, -1, 3) describes the same place and is not added again.
    const zero = map.world([0, 0, 0]);
    for (let i = 0; i < 3; i++) near(zero[i], map.origin[i]);
    const p = map.world([1, 0, 0]);
    near(p[0], 10 + 2.5 * Math.cos((70 * Math.PI) / 180), 1e-6);
    near(p[1], 20 + 2.5 * Math.sin((70 * Math.PI) / 180), 1e-6);
    assert.throws(
      () => mrcGrid(map.image()),
      (e) => e.code === 'unsupported',
    );
  }
});
test('MRC first sample: ORIGIN or START, never both; IMOD origin sign and unsigned bytes', { timeout: 1000 }, () => {
  const source = read('owner-int8.mrc'),
    make = (edit) => {
      const bytes = Uint8Array.from(source),
        v = new DataView(bytes.buffer);
      edit(v);
      return parseMRC(bytes);
    },
    stamp = (flags) => (v) => {
      v.setInt32(152, 1146047817, true);
      v.setInt32(156, flags, true);
    };
  // With ORIGIN zero the crystallographic START places the first sample.
  const crystal = make((v) => [196, 200, 204].forEach((o) => v.setFloat32(o, 0, true)));
  const fromStarts = crystal.world([-2, 1, -3]);
  for (let j = 0; j < 3; j++) near(fromStarts[j], 0, 1e-9);
  // IMOD before 4.11 stores the origin negated (flag 4 clear); 4.11 and later set flag 4.
  assert.deepEqual(make(stamp(1)).world([0, 0, 0]).map(Math.round), [-10, -20, -30]);
  assert.deepEqual(make(stamp(5)).world([0, 0, 0]).map(Math.round), [10, 20, 30]);
  // Mode 0 is signed (MRC2014) unless an IMOD stamp leaves flag 1 clear (IMOD before 4.9 wrote unsigned bytes).
  assert.equal(make(() => {}).data[0], -25);
  assert.equal(make(stamp(5)).data[0], -25);
  assert.equal(make(stamp(4)).data[0], 231);
  // Complex modes keep ORIGIN as a phase origin in pixels, not a position.
  const complex = new Uint8Array(1024 + 60 * 8);
  complex.set(read('owner-float32.mrc').subarray(0, 1024));
  new DataView(complex.buffer).setInt32(12, 4, true);
  const fourier = parseMRC(complex);
  assert.deepEqual(fourier.origin, [10, 20, 30]);
  for (let j = 0; j < 3; j++) near(fourier.world([-2, 1, -3])[j], 0, 1e-9);
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
    // This case covers even-width rows; odd-width padding is checked separately.
    if (mode === 101) {
      v.setInt32(0, 6, true);
      v.setInt32(4, 5, true);
      v.setInt32(8, 2, true);
    }
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

test('MRC mode 101 skips odd-width row padding and requires every padded byte', { timeout: 1000 }, () => {
  for (const nx of [1, 3, 5]) {
    const ny = 2,
      nz = 2,
      stride = Math.ceil(nx / 2),
      bytes = new Uint8Array(1024 + stride * ny * nz);
    bytes.set(read('owner-float32.mrc').subarray(0, 1024));
    const header = new DataView(bytes.buffer);
    for (const [offset, value] of [
      [0, nx],
      [4, ny],
      [8, nz],
      [12, 101],
    ])
      header.setInt32(offset, value, true);
    bytes.fill(255, 1024);
    const expected = [];
    for (let row = 0; row < ny * nz; row++)
      for (let x = 0; x < nx; x++) {
        const value = (row * nx + x + 1) % 15,
          p = 1024 + row * stride + (x >> 1),
          shift = (x & 1) * 4;
        expected.push(value);
        bytes[p] = (bytes[p] & ~(15 << shift)) | (value << shift);
      }
    assert.deepEqual([...parseMRC(bytes).data], expected);
    assert.throws(() => parseMRC(bytes.subarray(0, bytes.length - 1)), /truncated/);
  }
});
test('OME BigTIFF and classic TIFF, tiles and strips, LZW, deflate and Zstandard retain uint16 Z/C/T stacks', {
  timeout: 10000,
}, async () => {
  for (const big of [false, true])
    for (const codec of ['lzw', 'deflate', 'zstd']) {
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
/** Minimal little-endian classic TIFF: uncompressed 8-bit pages, one strip each, OME-XML on the first page. */
const ometiff = (xml, pages) => {
  const text = new TextEncoder().encode(xml + '\0'),
    out = [],
    u16 = (v) => [v & 255, v >> 8],
    u32 = (v) => [v & 255, (v >> 8) & 255, (v >> 16) & 255, v >>> 24];
  let size = 8 + text.length;
  const layout = pages.map((p, i) => {
    const data = size,
      bits = (size += p.data.length),
      tags = 11 + (i === 0 ? 1 : 0),
      ifd = (size += p.spp > 2 ? p.spp * 2 : 0);
    size += 2 + tags * 12 + 4;
    return { data, bits, ifd, tags };
  });
  out.push(0x49, 0x49, 42, 0, ...u32(layout[0].ifd), ...text);
  pages.forEach((p, i) => {
    const { data, bits, ifd, tags } = layout[i];
    out.push(...p.data);
    if (p.spp > 2) for (let s = 0; s < p.spp; s++) out.push(...u16(8));
    const entries = [
      [256, 3, 1, p.w],
      [257, 3, 1, p.h],
      [258, 3, p.spp, p.spp > 2 ? bits : 8],
      [259, 3, 1, 1],
      [262, 3, 1, p.spp === 3 ? 2 : 1],
      ...(i === 0 ? [[270, 2, text.length, 8]] : []),
      [273, 4, 1, data],
      [277, 3, 1, p.spp],
      [278, 3, 1, p.h],
      [279, 4, 1, p.data.length],
      [284, 3, 1, 1],
      [339, 3, 1, 1],
    ];
    assert.equal(entries.length, tags);
    out.push(...u16(tags));
    for (const [tag, type, count, value] of entries)
      out.push(...u16(tag), ...u16(type), ...u32(count), ...(type === 3 && count === 1 ? [...u16(value), 0, 0] : u32(value)));
    out.push(...u32(i + 1 < pages.length ? layout[i + 1].ifd : 0));
    assert.equal(out.length, ifd + 2 + tags * 12 + 4);
  });
  return new Uint8Array(out);
};
const ome = (pixels, inner) =>
  `<?xml version="1.0" encoding="UTF-8"?><OME xmlns="http://www.openmicroscopy.org/Schemas/OME/2016-06" UUID="urn:uuid:main"><Image ID="Image:0"><Pixels ID="Pixels:0" Type="uint8" ${pixels}>${inner}</Pixels></Image></OME>`;
test('OME Plane positions index channels, not samples, and convert to the physical size unit', { timeout: 10000 }, async () => {
  const rgb = await readOMETIFF(
    ometiff(
      ome(
        'DimensionOrder="XYCZT" SizeX="2" SizeY="1" SizeZ="1" SizeC="3" SizeT="1" PhysicalSizeX="0.5" PhysicalSizeZ="2" PhysicalSizeZUnit="nm"',
        '<Channel ID="Channel:0:0" SamplesPerPixel="3"/><TiffData/><Plane TheZ="0" TheC="0" TheT="0" PositionX="1" PositionXUnit="mm" PositionY="20" PositionZ="3" PositionZUnit="Å"/>',
      ),
      [{ w: 2, h: 1, spp: 3, data: [1, 2, 3, 4, 5, 6] }],
    ),
  );
  assert.deepEqual([...(await rgb.plane(0, 2))], [3, 6]);
  // Every sample of the RGB channel shares the channel's Plane: 1 mm is 1000 µm, 3 Å is 0.3 nm.
  for (const c of [0, 1, 2]) {
    const world = (await rgb.image(c)).world([2, 0, 1]);
    assert.ok(Math.abs(world[0] - 1001) < 1e-9 && world[1] === 20 && Math.abs(world[2] - 2.3) < 1e-12, `${c}: ${world}`);
  }
});
test('OME TiffData with neither IFD nor PlaneCount covers every IFD of the file it names', { timeout: 10000 }, async () => {
  const resolved = [],
    part = ometiff(ome('DimensionOrder="XYZCT" SizeX="1" SizeY="1" SizeZ="3" SizeC="1" SizeT="1"', ''), [
      { w: 1, h: 1, spp: 1, data: [20] },
      { w: 1, h: 1, spp: 1, data: [30] },
    ]),
    stack = await readOMETIFF(
      ometiff(
        ome(
          'DimensionOrder="XYZCT" SizeX="1" SizeY="1" SizeZ="3" SizeC="1" SizeT="1"',
          '<TiffData PlaneCount="1"><UUID>urn:uuid:main</UUID></TiffData><TiffData FirstZ="1"><UUID FileName="part.ome.tif">urn:uuid:part</UUID></TiffData>',
        ),
        [{ w: 1, h: 1, spp: 1, data: [10] }],
      ),
      {
        resolve: async (name) => {
          resolved.push(name);
          return part;
        },
      },
    );
  assert.deepEqual([(await stack.plane(0))[0], (await stack.plane(1))[0], (await stack.plane(2))[0]], [10, 20, 30]);
  assert.deepEqual(resolved, ['part.ome.tif']);
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
