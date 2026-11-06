// Real files, against what real decoders say. fixtures/laz holds public files from other tools and files LASzip itself
// compressed from real points (fixtures/NOTICE.md); records.json holds what LASzip and lazrs decode from each, as
// SHA-256 digests made once outside this repository. Nothing here comes from Margo's own test encoder. This is the check
// that found how the layered items really follow the scanner channel, which the LAZ specification does not spell out.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { lasCrs, lasExtraBytes, lasWaveDescriptors, lasWaveform, parseLAS, readLASHeader } from '../dist/las.js';
import { lazChunks, lazInfo } from '../dist/laz.js';

const folder = new URL('./fixtures/laz/', import.meta.url);
const expected = JSON.parse(readFileSync(new URL('records.json', folder)));
const USGS = 'USGS_LPC_MT_Statewide_Phase3_2021_B21_568232.laz';
const read = (name) =>
  new Uint8Array(readFileSync(new URL(name === USGS ? `../${name}` : name, folder)));
const digest = (array) =>
  createHash('sha256')
    .update(new Uint8Array(array.buffer, array.byteOffset, array.byteLength))
    .digest('hex')
    .slice(0, 32);

/** Every field of a parsed file as records.json names them. */
export function fieldsOf(las) {
  const wave = las.wavePackets;
  return {
    positions: las.positions,
    intensity: las.intensity,
    returnNumber: las.returnNumber,
    numberOfReturns: las.numberOfReturns,
    classification: las.classification,
    classificationFlags: las.classificationFlags,
    scanDirection: las.scanDirection,
    edgeOfFlightLine: las.edgeOfFlightLine,
    scanAngle: las.scanAngle,
    scannerChannel: las.scannerChannel,
    userData: las.userData,
    pointSourceId: las.pointSourceId,
    gpsTime: las.gpsTime,
    rgb: las.rgb,
    nir: las.nir,
    waveDescriptor: wave?.descriptor,
    waveOffset: wave?.offset,
    waveSize: wave?.size,
    waveLocation: wave?.location,
    waveDirection: wave?.direction,
  };
}

for (const [name, want] of Object.entries(expected)) {
  test(`${name}: format ${want.format}, ${want.points} points, every field as the reference decoders read it`, async () => {
    const bytes = read(name),
      { header, records } = readLASHeader(bytes);
    assert.equal(header.pointFormat, want.format);
    assert.equal(header.pointCount, want.points);
    if (want.records && lazInfo(records).items[0].version !== 1) {
      const whole = createHash('sha256');
      for await (const block of lazChunks(bytes, header, records)) whole.update(block);
      assert.equal(whole.digest('hex'), want.records, 'the record bytes');
    }
    if (name === 'point-version-1-point-wise.laz') return;
    const las = await parseLAS(bytes, { origin: header.min }),
      fields = fieldsOf(las);
    assert.equal(las.count, want.points);
    for (const [field, value] of Object.entries(want.fields)) {
      if (field === 'extra') continue;
      assert.ok(fields[field], `${field} is present`);
      assert.equal(digest(fields[field]), value, field);
    }
    for (const field of Object.keys(fields))
      if (fields[field]) assert.ok(want.fields[field], `${field} is in the file's format`);
    assert.deepEqual(Object.keys(las.extra).sort(), Object.keys(want.fields.extra ?? {}).sort(), 'the extra bytes');
    for (const [field, value] of Object.entries(want.fields.extra ?? {}))
      assert.equal(digest(las.extra[field]), value, `extra bytes ${field}`);
  });
}

test('each pair of a real LAS file and its LAZ gives the same cloud', async () => {
  for (const name of ['point10', 'point-time', 'point-color', 'point-time-color']) {
    const plain = await parseLAS(read(`${name}.las`)),
      packed = await parseLAS(read(`${name}.laz`));
    for (const [field, value] of Object.entries(fieldsOf(plain)))
      if (value) assert.deepEqual(fieldsOf(packed)[field], value, `${name} ${field}`);
  }
});

test('the real samples cover what they claim: compressors, items, and channels that switch', async () => {
  const items = (name) => {
    const info = lazInfo(readLASHeader(read(name)).records);
    return `${info.compressor}: ${info.items.map((i) => `${i.name}:${i.version}`).join(' ')}`;
  };
  assert.equal(items('point10.laz'), '2: POINT10:2');
  assert.equal(items('point-time.laz'), '2: POINT10:2 GPSTIME11:2');
  assert.equal(items('point-color.laz'), '2: POINT10:2 RGB12:2');
  assert.equal(items('point-time-color.laz'), '2: POINT10:2 GPSTIME11:2 RGB12:2');
  assert.equal(items('extra-bytes.laz'), '2: POINT10:2 GPSTIME11:2 RGB12:2 BYTE:2');
  assert.equal(items('simple.copc.laz'), '3: POINT14:3 RGB14:3');
  assert.equal(items('append-bug.laz'), '3: POINT14:3 RGBNIR14:3 BYTE14:3');
  assert.equal(items('fullwave.laz'), '3: POINT14:3 RGBNIR14:3 WAVEPACKET14:3');
  assert.equal(items('laszip-format4.laz'), '2: POINT10:2 GPSTIME11:2 WAVEPACKET13:1');
  assert.equal(items('laszip-format5.laz'), '2: POINT10:2 GPSTIME11:2 RGB12:2 WAVEPACKET13:1');
  assert.equal(items('laszip-channels-format10.laz'), '3: POINT14:3 RGBNIR14:3 WAVEPACKET14:3 BYTE14:3');
  const channels = (await parseLAS(read('laszip-channels-format10.laz'))).scannerChannel;
  assert.equal(new Set(channels).size, 4);
  assert.equal(channels[0], 3, 'the chunk starts on a channel other than 0');
});

test('LASzip 1.0 item coding stays refused by name: no published text describes it', async () => {
  await assert.rejects(
    parseLAS(read('point-version-1-point-wise.laz')),
    (e) => e.code === 'unsupported' && /POINT10 version 1 .*neither the LAZ specification/.test(e.message),
  );
});

test('a real format 4 file: wave packets and their descriptor', async () => {
  const las = await parseLAS(read('simple1_3.las')),
    { wavePackets: wave } = las,
    descriptor = lasWaveDescriptors(las.records).get(1);
  assert.equal(wave.descriptor.length, 999);
  assert.deepEqual([descriptor.compression, descriptor.bitsPerSample > 0, descriptor.samples > 0], [0, true, true]);
  assert.ok(wave.size.every((size) => size === 0 || size === descriptor.samples * (descriptor.bitsPerSample / 8)));
});

test('lasWaveform reads samples from inside the file and from a .wdp, and refuses what it cannot', () => {
  const descriptor = new Uint8Array(26),
    v = new DataView(descriptor.buffer);
  descriptor[0] = 16;
  v.setUint32(2, 3, true);
  v.setUint32(6, 1000, true);
  v.setFloat64(10, 0.5, true);
  v.setFloat64(18, 2, true);
  const las = (globalEncoding, waveformDataOffset, bits = 16) => ({
    header: { globalEncoding, waveformDataOffset },
    records: [{ userId: 'LASF_Spec', recordId: 100, data: Object.assign(descriptor.slice(), { 0: bits }) }],
    wavePackets: {
      descriptor: Uint8Array.of(1, 0),
      offset: Float64Array.of(60, 0),
      size: Uint32Array.of(6, 0),
      location: new Float32Array(2),
      direction: new Float32Array(6),
    },
  });
  const source = new Uint8Array(200);
  new DataView(source.buffer).setUint16(160, 7, true);
  new DataView(source.buffer).setUint16(164, 300, true);
  const inside = lasWaveform(las(2, 100), 0, source);
  assert.deepEqual([...inside.raw], [7, 0, 300]);
  assert.deepEqual([...inside.volts], [5.5, 2, 152]);
  assert.equal(inside.spacing, 1000);
  assert.equal(lasWaveform(las(2, 100), 1, source), undefined, 'a point with no waveform');
  const beside = new Uint8Array(66);
  new DataView(beside.buffer).setUint16(62, 9, true);
  assert.deepEqual([...lasWaveform(las(4, 0), 0, beside).raw], [0, 9, 0], 'offsets count from the start of a .wdp');
  assert.throws(() => lasWaveform(las(4, 0), 0, new Uint8Array(10)), (e) => e.code === 'truncated');
  assert.throws(() => lasWaveform(las(4, 0, 12), 0, beside), (e) => e.code === 'unsupported');
});

test('extra bytes described by several records all read, in record order', async () => {
  const { header, records } = readLASHeader(read('append-bug.laz')),
    extra = lasExtraBytes(records, header);
  assert.equal(records.filter((r) => r.userId === 'LASF_Spec' && r.recordId === 4).length, 2);
  assert.equal(extra.length, 2);
  assert.deepEqual(extra.map((e) => [e.name, e.offset]), [['Deviation', 0], ['confidence', 2]]);
  assert.match(lasCrs(records).wkt, /Lambert-93/);
});

test('deprecated pairs and triples of extra bytes read as one field per element, as a real file has them', () => {
  const { header, records } = readLASHeader(read('extra-bytes.laz'));
  assert.deepEqual(
    lasExtraBytes(records, header).map((e) => `${e.name}:${e.dataType}:${e.offset}`),
    ['Colors[0]:3:0', 'Colors[1]:3:2', 'Colors[2]:3:4', 'Reserved:0:6', 'Flags[0]:2:13', 'Flags[1]:2:14', 'Intensity:5:15', 'Time:7:19'],
  );
});
