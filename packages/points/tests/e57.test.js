import { speedBudget } from '../../../scripts/speed/budgets.mjs';
import assert from 'node:assert/strict';
import { cpuTimer } from '../../../scripts/support/cpu-budget.mjs';
import test from 'node:test';
import { crc32c, parseE57, parseXML, readE57Header, writeE57 } from '../dist/e57.js';

function scanData(n, seed = 9) {
  let s = seed;
  const random = () => (s = (s * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
  const positions = new Float64Array(n * 3),
    intensity = new Float64Array(n),
    rgb = new Uint8Array(n * 3);
  for (let i = 0; i < n; i++) {
    positions.set([random() * 40 - 20, random() * 30 - 15, random() * 8], i * 3);
    intensity[i] = random();
    rgb.set([i % 256, (i * 7) % 256, (i * 13) % 256], i * 3);
  }
  return { positions, intensity, rgb };
}
const near = (a, b, eps, what) => assert.ok(Math.abs(a - b) <= eps, `${what}: ${a} vs ${b}`);

test('CRC-32C matches the standard check value; XML parsing handles attributes, CDATA and entities', () => {
  assert.equal(crc32c(new TextEncoder().encode('123456789')), 0xe3069283);
  const xml = parseXML(
    '<?xml version="1.0"?><!-- c --><a x="1 &amp; 2"><b type="Float">3.5</b><c><![CDATA[<raw>]]></c><d/></a>',
  );
  assert.equal(xml.name, 'a');
  assert.equal(xml.attributes.x, '1 & 2');
  assert.equal(xml.children[0].text, '3.5');
  assert.equal(xml.children[1].text, '<raw>');
  assert.throws(() => parseXML('<a><b></a>'), TypeError);
});

test('E57 round trip: double, scaled-integer and spherical scans, intensity, colour, pose and invalid points', () => {
  const a = scanData(3000),
    b = scanData(2000, 4);
  const angle = Math.PI / 6,
    pose = { rotation: [Math.cos(angle / 2), 0, 0, Math.sin(angle / 2)], translation: [1000, 2000, 30] };
  const spherical = new Float64Array(300 * 3),
    invalid = new Uint8Array(300);
  for (let i = 0; i < 300; i++) {
    spherical.set([5 + i * 0.01, (i / 300) * Math.PI, 0.1], i * 3);
    invalid[i] = i % 10 === 0 ? 2 : 0;
  }
  const file = writeE57(
    [
      { name: 'double', positions: a.positions, intensity: a.intensity, rgb: a.rgb },
      { name: 'scaled', positions: b.positions, resolution: 0.0001, pose },
      { name: 'sphere', spherical, invalid },
    ],
    { packetBytes: 4096 },
  );
  assert.equal(file.length % 1024, 0);
  const header = readE57Header(file);
  assert.equal(header.pageSize, 1024);
  const e57 = parseE57(file, { origin: [0, 0, 0] });
  assert.deepEqual(
    e57.scans.map((s) => s.name),
    ['double', 'scaled', 'sphere'],
  );
  const [d, s, sp] = e57.scans;
  assert.equal(d.count, 3000);
  for (let i = 0; i < 3000; i++)
    for (let k = 0; k < 3; k++) near(d.positions[i * 3 + k], a.positions[i * 3 + k], 1e-5, 'double xyz');
  for (let i = 0; i < 50; i++) near(d.intensity[i], Math.round(a.intensity[i] * 65535) / 65535, 1e-6, 'intensity');
  assert.deepEqual([...d.colors.slice(0, 8)], [a.rgb[0], a.rgb[1], a.rgb[2], 255, a.rgb[3], a.rgb[4], a.rgb[5], 255]);
  // The scaled scan is posed: rotated 30 degrees about z, then translated.
  const c = Math.cos(angle),
    sn = Math.sin(angle);
  for (let i = 0; i < 2000; i += 97) {
    const [x, y, z] = [b.positions[i * 3], b.positions[i * 3 + 1], b.positions[i * 3 + 2]];
    near(s.positions[i * 3], c * x - sn * y + 1000, 2e-3, 'posed x');
    near(s.positions[i * 3 + 1], sn * x + c * y + 2000, 2e-3, 'posed y');
    near(s.positions[i * 3 + 2], z + 30, 2e-3, 'posed z');
  }
  assert.equal(sp.count, 270, 'invalid points dropped');
  const r0 = spherical[3];
  near(Math.hypot(sp.positions[0], sp.positions[1], sp.positions[2]), r0, 1e-4, 'spherical range');
  assert.equal(parseE57(file, { keepInvalid: true }).scans[2].count, 300);
  // Default origin: the centre of everything, so float32 keeps precision.
  const centred = parseE57(file);
  assert.ok(centred.origin[0] > 0);
});

// The file's own bytes by ASTM E2807, with no help from parseE57: pages, header, XML and the first packet of doubles.
test('the written bytes hold the pages, header, XML and packets the standard lays out', () => {
  const { positions } = scanData(300),
    file = writeE57([{ name: 'raw', positions }]),
    view = new DataView(file.buffer, file.byteOffset, file.byteLength),
    u64 = (at) => Number(view.getBigUint64(at, true)),
    pageSize = u64(40),
    payload = pageSize - 4;
  assert.equal(String.fromCharCode(...file.subarray(0, 8)), 'ASTM-E57');
  assert.deepEqual([view.getUint32(8, true), view.getUint32(12, true)], [1, 0]);
  assert.equal(u64(16), file.length);
  assert.equal(pageSize, 1024);
  for (let at = 0; at < file.length; at += pageSize)
    assert.equal(view.getUint32(at + payload), crc32c(file.subarray(at, at + payload)), `page at ${at}`);
  // Every page gives up its checksum, so a logical stream runs over the payloads.
  const logical = new Uint8Array((file.length / pageSize) * payload);
  for (let page = 0; page < file.length / pageSize; page++)
    logical.set(file.subarray(page * pageSize, page * pageSize + payload), page * payload);
  const toLogical = (physical) => Math.floor(physical / pageSize) * payload + (physical % pageSize),
    start = toLogical(u64(24)),
    xml = new TextDecoder().decode(logical.subarray(start, start + u64(32)));
  assert.match(xml, /<e57Root type="Structure"/);
  assert.match(xml, /<name type="String"><!\[CDATA\[raw\]\]><\/name>/);
  const points = xml.match(/<points type="CompressedVector" fileOffset="(\d+)" recordCount="(\d+)">/);
  assert.equal(Number(points[2]), 300);
  assert.match(xml, /<cartesianX type="Float"/);
  const logicalView = new DataView(logical.buffer),
    section = toLogical(Number(points[1]));
  assert.equal(logical[section], 1, 'a compressed vector section');
  const packet = toLogical(Number(logicalView.getBigUint64(section + 16, true)));
  assert.equal(logical[packet], 1, 'a data packet');
  const streams = logicalView.getUint16(packet + 4, true),
    bytes = logicalView.getUint16(packet + 6, true),
    data = packet + 6 + streams * 2;
  assert.equal(streams, 3, 'x, y and z');
  assert.equal(bytes % 8, 0);
  for (let i = 0; i < bytes / 8; i++)
    assert.equal(logicalView.getFloat64(data + i * 8, true), positions[i * 3], `x of ${i}`);
});

test('E57 integrity: a flipped byte fails its page checksum; truncated or corrupt files never crash or hang', () => {
  const file = writeE57([{ positions: scanData(500).positions, resolution: 0.001 }]);
  const bad = file.slice();
  bad[2000] ^= 0x10;
  assert.throws(
    () => parseE57(bad),
    (e) => e instanceof RangeError && /CRC-32C/.test(e.message),
  );
  let s = 21;
  const random = () => (s = (s * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
  const cpu = cpuTimer();
  for (let i = 0; i < 300; i++) {
    const bytes = i < 150 ? file.slice(0, Math.floor(random() * file.length)) : file.slice();
    if (i >= 150)
      for (let k = 0; k < 1 + (i % 5); k++) bytes[Math.floor(random() * bytes.length)] = Math.floor(random() * 256);
    try {
      parseE57(bytes, { verifyChecksums: false });
    } catch (error) {
      assert.ok(
        error instanceof TypeError || error instanceof RangeError || error.name === 'MargoError',
        `${error?.name}: ${error?.message}`,
      );
    }
  }
  speedBudget('points-e57', { cpu });
});
