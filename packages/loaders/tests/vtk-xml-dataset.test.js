import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { openVTKXMLDataset, parseVTKXML } from '@margoengine/loaders/vtk-xml';

const xml = (body, attrs = '', tail = '') =>
  Buffer.from(
    `<VTKFile type="ImageData" ${attrs}><ImageData WholeExtent="0 1 0 0 0 0"><Piece Extent="0 1 0 0 0 0"><PointData>${body}</PointData></Piece></ImageData>${tail}</VTKFile>`,
  );
const values = Buffer.from(new Float32Array([1.25, -3.5]).buffer);
const u32 = (...n) => Buffer.from(new Uint32Array(n).buffer);
const tag = (format, data = '', attrs = '') =>
  `<DataArray type="Float32" Name="s" format="${format}" ${attrs}>${data}</DataArray>`;

test('lazy datasets use the existing ASCII, inline and base64-appended decoders', async () => {
  const binary = Buffer.concat([u32(8), values]).toString('base64');
  for (const bytes of [
    xml(tag('ascii', '1.25 -3.5')),
    xml(tag('binary', binary)),
    xml(tag('appended', '', 'offset="0"'), '', `<AppendedData encoding="base64">_${binary}</AppendedData>`),
  ]) {
    const dataset = openVTKXMLDataset(bytes);
    assert.equal(dataset.type, 'ImageData');
    assert.deepEqual([...(await dataset.pieces[0].pointData.s.read())], [1.25, -3.5]);
  }
});

test('raw appended Range callback reads only the chosen compressed block, little/big endian, UInt32/64', async () => {
  for (const width of [4, 8])
    for (const little of [true, false]) {
      const raw = little ? values : Buffer.from(values).swap32(),
        compressed = deflateSync(raw);
      const h = Buffer.alloc(4 * width);
      [1, 8, 8, compressed.length].forEach((n, i) =>
        width === 8
          ? little
            ? h.writeBigUInt64LE(BigInt(n), i * width)
            : h.writeBigUInt64BE(BigInt(n), i * width)
          : little
            ? h.writeUInt32LE(n, i * width)
            : h.writeUInt32BE(n, i * width),
      );
      const payload = Buffer.concat([Buffer.alloc(19), h, compressed]),
        reads = [];
      const dataset = openVTKXMLDataset(
        xml(
          tag('appended', '', 'offset="19"'),
          `header_type="UInt${width * 8}" byte_order="${little ? 'LittleEndian' : 'BigEndian'}" compressor="vtkZLibDataCompressor"`,
          '<AppendedData encoding="raw">_</AppendedData>',
        ),
        {
          async readAppended(offset, length) {
            reads.push([offset, length]);
            return payload.subarray(offset, offset + length);
          },
        },
      );
      assert.deepEqual(reads, []);
      const first = await dataset.pieces[0].pointData.s.read();
      assert.deepEqual([...first], [1.25, -3.5]);
      assert(reads.every(([o, n]) => o >= 19 && o + n <= payload.length));
      first.fill(0);
      assert.deepEqual([...(await dataset.pieces[0].pointData.s.read())], [1.25, -3.5]);
    }
});

test('invalid endian declarations reject in the owning reader instead of silently assuming little endian', async () => {
  const bytes = Buffer.from('<VTKFile type="PolyData" byte_order="MiddleEndian"><PolyData/></VTKFile>');
  assert.throws(() => openVTKXMLDataset(bytes), /byte_order/);
  await assert.rejects(parseVTKXML(bytes), /byte_order/);
});

test('64-bit integers never silently round a point id or scientific integer', async () => {
  const bytes = Buffer.alloc(12);
  bytes.writeUInt32LE(8);
  bytes.writeBigUInt64LE(9007199254740993n, 4);
  const file = openVTKXMLDataset(
    xml(`<DataArray type="UInt64" Name="id" format="binary">${bytes.toString('base64')}</DataArray>`),
  );
  await assert.rejects(file.pieces[0].pointData.id.read(), /exact JavaScript number precision/);
});

test('lazy reads reject truncation, decoded output bounds and cancellation', async () => {
  const bytes = xml(tag('appended', '', 'offset="0"'), '', '<AppendedData encoding="raw">_</AppendedData>');
  const file = openVTKXMLDataset(bytes, {
    async readAppended() {
      return new Uint8Array();
    },
  });
  await assert.rejects(file.pieces[0].pointData.s.read(), /ends early/);
  await assert.rejects(
    openVTKXMLDataset(xml(tag('ascii', '1 2 3')), { maxBytes: 16 }).pieces[0].pointData.s.read(),
    /exceeds maxBytes/,
  );
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    openVTKXMLDataset(xml(tag('ascii', '1'))).pieces[0].pointData.s.read(controller.signal),
    (e) => e.code === 'aborted',
  );
});
