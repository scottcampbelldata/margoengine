import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync, readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {createServer} from 'node:http';
import {deflateRawSync, inflateRawSync} from 'node:zlib';
import {fileURLToPath} from 'node:url';
import {
  LoaderError, parsePLY, parsePLYHeader, parse3MF, parsePCD, parsePCDHeader, parseOFF, parseXYZ, parseVTK, decompressLZF,
  readZipDirectory, readZipEntry, crc32, computeVertexNormals, toGeometry, pointsToGeometry, createMeshes, fetchBytes, load,
  detectFormat, parseAny, THREEMF_UNITS,
} from '../dist/index.js';

const fixtures = fileURLToPath(new URL('./fixtures/', import.meta.url));
const fixture = name => existsSync(fixtures + name) ? new Uint8Array(readFileSync(fixtures + name)) : null;
const text = value => new TextEncoder().encode(value);
const close = (actual, expected, epsilon = 1e-5, label = 'value') => assert.ok(Math.abs(actual - expected) <= epsilon * Math.max(1, Math.abs(expected)), `${label}: ${actual} != ${expected}`);
const closeArray = (actual, expected, epsilon = 1e-5, label = 'array') => {
  assert.equal(actual.length, expected.length, `${label} length`);
  for (let i = 0; i < expected.length; i++) close(actual[i], expected[i], epsilon, `${label}[${i}]`);
};
const rejects = (fn, code, pattern) => assert.throws(fn, error => error instanceof LoaderError && error.code === code && (!pattern || pattern.test(error.message)));
const rejectsAsync = (promise, code, pattern) => assert.rejects(promise, error => error instanceof LoaderError && error.code === code && (!pattern || pattern.test(error.message)));
const bounds = positions => {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) for (let a = 0; a < 3; a++) {min[a] = Math.min(min[a], positions[i + a]); max[a] = Math.max(max[a], positions[i + a]);}
  return {min, max};
};

// ---------------------------------------------------------------- PLY fixtures

const SIZES = {char: 1, uchar: 1, short: 2, ushort: 2, int: 4, uint: 4, float: 4, double: 8};
function writeScalar(view, offset, type, value, little) {
  switch (type) {
    case 'char': view.setInt8(offset, value); break;
    case 'uchar': view.setUint8(offset, value); break;
    case 'short': view.setInt16(offset, value, little); break;
    case 'ushort': view.setUint16(offset, value, little); break;
    case 'int': view.setInt32(offset, value, little); break;
    case 'uint': view.setUint32(offset, value, little); break;
    case 'float': view.setFloat32(offset, value, little); break;
    case 'double': view.setFloat64(offset, value, little); break;
  }
  return offset + SIZES[type];
}
/** elements: [{name, properties: [{name, type} | {name, list: [countType, itemType]}], rows: [[values... or arrays]]}] */
function writePLY(format, elements, comments = []) {
  let header = `ply\nformat ${format} 1.0\n${comments.map(c => `comment ${c}\n`).join('')}`;
  for (const element of elements) {
    header += `element ${element.name} ${element.rows.length}\n`;
    for (const p of element.properties) header += p.list ? `property list ${p.list[0]} ${p.list[1]} ${p.name}\n` : `property ${p.type} ${p.name}\n`;
  }
  header += 'end_header\n';
  if (format === 'ascii') return text(header + elements.map(e => e.rows.map(row => row.map(v => Array.isArray(v) ? `${v.length} ${v.join(' ')}` : String(v)).join(' ') + '\n').join('')).join(''));
  const little = format === 'binary_little_endian';
  let size = 0;
  for (const e of elements) for (const row of e.rows) e.properties.forEach((p, i) => {size += p.list ? SIZES[p.list[0]] + row[i].length * SIZES[p.list[1]] : SIZES[p.type];});
  const head = text(header), out = new Uint8Array(head.length + size), view = new DataView(out.buffer);
  out.set(head);
  let offset = head.length;
  for (const e of elements) for (const row of e.rows) e.properties.forEach((p, i) => {
    if (!p.list) {offset = writeScalar(view, offset, p.type, row[i], little); return;}
    offset = writeScalar(view, offset, p.list[0], row[i].length, little);
    for (const item of row[i]) offset = writeScalar(view, offset, p.list[1], item, little);
  });
  return out;
}
// A unit cube made of 6 quads with every vertex attribute; vertex k has distinct values derivable from k.
const cubeCorners = [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0], [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]];
const cubeQuads = [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [2, 3, 7, 6], [0, 4, 7, 3], [1, 2, 6, 5]];
function plyCube({uv = ['s', 't'], colorType = 'uchar', faces = true, extra = true} = {}) {
  const vertexProps = [
    {name: 'x', type: 'float'}, {name: 'y', type: 'float'}, {name: 'z', type: 'float'},
    {name: 'nx', type: 'float'}, {name: 'ny', type: 'float'}, {name: 'nz', type: 'float'},
    {name: 'red', type: colorType}, {name: 'green', type: colorType}, {name: 'blue', type: colorType},
    {name: uv[0], type: 'float'}, {name: uv[1], type: 'float'},
    {name: 'confidence', type: 'double'},
  ];
  const color = (k, a) => colorType === 'uchar' ? (k * 30 + a * 7) % 256 : ((k * 30 + a * 7) % 256) / 255;
  const vertexRows = cubeCorners.map((p, k) => {
    const n = p.map(v => v - 0.5), length = Math.hypot(...n);
    return [...p, ...n.map(v => v / length), color(k, 0), color(k, 1), color(k, 2), k / 8, 1 - k / 8, k * 0.5];
  });
  const elements = [];
  if (extra) elements.push({name: 'material', properties: [{name: 'id', type: 'int'}, {name: 'tags', list: ['uchar', 'short']}], rows: [[7, [1, 2, 3]], [8, []]]});
  elements.push({name: 'vertex', properties: vertexProps, rows: vertexRows});
  if (faces) elements.push({name: 'face', properties: [{name: 'vertex_indices', list: ['uchar', 'int']}, {name: 'flags', type: 'ushort'}], rows: [...cubeQuads.map(q => [q, 1]), [[0, 1, 2, 3, 4], 2]]});
  return {elements, vertexRows, color};
}
function checkPLYCube(result, {colorType = 'uchar', faces = true} = {}) {
  assert.equal(result.positions.length, 24);
  closeArray(result.positions, cubeCorners.flat(), 0, 'positions');
  for (let k = 0; k < 8; k++) {
    const n = cubeCorners[k].map(v => v - 0.5), length = Math.hypot(...n);
    closeArray(result.normals.subarray(k * 3, k * 3 + 3), n.map(v => v / length), 1e-6, 'normal');
    for (let a = 0; a < 3; a++) close(result.colors[k * 3 + a], ((k * 30 + a * 7) % 256) / 255, 1e-6, 'color');
    close(result.uvs[k * 2], k / 8, 1e-6); close(result.uvs[k * 2 + 1], 1 - k / 8, 1e-6);
  }
  for (const value of result.colors) assert.ok(value >= 0 && value <= 1);
  if (!faces) {assert.equal(result.kind, 'points'); assert.equal(result.indices, undefined); return;}
  assert.equal(result.kind, 'mesh');
  // 6 quads -> 12 triangles, 1 pentagon -> 3 triangles, fan from the first corner.
  assert.equal(result.indices.length, 45);
  assert.deepEqual([...result.indices.subarray(0, 6)], [0, 3, 2, 0, 2, 1]);
  assert.deepEqual([...result.indices.subarray(36)], [0, 1, 2, 0, 2, 3, 0, 3, 4]);
  void colorType;
}

test('PLY: ascii, binary little-endian and big-endian give identical cubes with all attributes', () => {
  for (const format of ['ascii', 'binary_little_endian', 'binary_big_endian']) {
    const {elements} = plyCube();
    const result = parsePLY(writePLY(format, elements, ['made by tests']));
    checkPLYCube(result);
    assert.equal(parsePLYHeader(writePLY(format, elements, ['made by tests'])).comments[0], 'made by tests');
  }
});

test('PLY: float colors, u/v and texture_u/texture_v names, CRLF header, ArrayBuffer input', () => {
  for (const uv of [['u', 'v'], ['texture_u', 'texture_v'], ['s', 't']]) for (const format of ['ascii', 'binary_little_endian']) {
    const {elements} = plyCube({uv, colorType: 'float'});
    checkPLYCube(parsePLY(writePLY(format, elements).buffer.slice(0)), {colorType: 'float'});
  }
  const crlf = text('ply\r\nformat ascii 1.0\r\nelement vertex 3\r\nproperty float x\r\nproperty float y\r\nproperty float z\r\nelement face 1\r\nproperty list uchar uint vertex_indices\r\nend_header\r\n0 0 0\r\n1 0 0\r\n0 1 0\r\n3 0 1 2\r\n');
  const result = parsePLY(crlf);
  assert.deepEqual([...result.indices], [0, 1, 2]);
  // A Uint8Array view with a non-zero offset into a larger buffer.
  const padded = new Uint8Array(crlf.length + 10); padded.set(crlf, 5);
  assert.deepEqual([...parsePLY(padded.subarray(5, 5 + crlf.length)).positions], [0, 0, 0, 1, 0, 0, 0, 1, 0]);
});

test('PLY: point clouds without faces in every encoding', () => {
  for (const format of ['ascii', 'binary_little_endian', 'binary_big_endian']) {
    const {elements} = plyCube({faces: false, extra: false});
    checkPLYCube(parsePLY(writePLY(format, elements)), {faces: false});
  }
});

test('PLY: malformed headers, truncated data and limits', () => {
  const {elements} = plyCube();
  const good = writePLY('binary_little_endian', elements);
  rejects(() => parsePLY(text('plx\nformat ascii 1.0\nend_header\n')), 'header', /magic/);
  rejects(() => parsePLY(text('ply\nformat ascii 1.0\nelement vertex 1\nproperty float x\n')), 'truncated', /end_header/);
  rejects(() => parsePLY(text('ply\nformat ascii 2.0\nend_header\n')), 'unsupported');
  rejects(() => parsePLY(text('ply\nformat foo 1.0\nend_header\n')), 'unsupported');
  rejects(() => parsePLY(text('ply\nformat ascii 1.0\nproperty float x\nend_header\n')), 'header', /before any element/);
  rejects(() => parsePLY(text('ply\nformat ascii 1.0\nelement vertex -3\nend_header\n')), 'header');
  rejects(() => parsePLY(text('ply\nformat ascii 1.0\nelement vertex 1\nproperty quad x\nend_header\n')), 'header');
  rejects(() => parsePLY(text('ply\nformat ascii 1.0\nelement vertex 1\nproperty float x\nend_header\n1\n')), 'header', /x, y and z/);
  rejects(() => parsePLY(text('ply\nformat ascii 1.0\nelement vertex 1\nproperty float x\nproperty float y\nproperty float z\nend_header\n1 2\n')), 'truncated');
  rejects(() => parsePLY(text('ply\nformat ascii 1.0\nelement vertex 1\nproperty float x\nproperty float y\nproperty float z\nend_header\n1 2 abc\n')), 'syntax');
  rejects(() => parsePLY(good.subarray(0, good.length - 3)), 'truncated');
  rejects(() => parsePLY(good.subarray(0, good.length - 60)), 'truncated');
  const badIndex = writePLY('ascii', [{name: 'vertex', properties: elements[1].properties, rows: elements[1].rows}, {name: 'face', properties: [{name: 'vertex_indices', list: ['uchar', 'int']}], rows: [[[0, 1, 8]]]}]);
  rejects(() => parsePLY(badIndex), 'range', /outside 0\.\.7/);
  const negative = writePLY('binary_big_endian', [{name: 'vertex', properties: elements[1].properties, rows: elements[1].rows}, {name: 'face', properties: [{name: 'vertex_indices', list: ['uchar', 'int']}], rows: [[[0, -1, 2]]]}]);
  rejects(() => parsePLY(negative), 'range');
  rejects(() => parsePLY(good, {maxVertices: 7}), 'limit', /vertex count 8/);
  rejects(() => parsePLY(good, {maxTriangles: 14}), 'limit');
  rejects(() => parsePLY(text('ply\nformat binary_little_endian 1.0\nelement vertex 999999999\nproperty float x\nproperty float y\nproperty float z\nend_header\n')), 'limit');
  rejects(() => parsePLY(text('ply\nformat binary_little_endian 1.0\nelement vertex 100\nproperty float x\nproperty float y\nproperty float z\nend_header\n\0\0\0\0')), 'truncated');
  rejects(() => parsePLY('not bytes'), 'range');
});

test('PLY: real three.js dolphins (ascii, big-endian binary, colored) agree with an independent read', t => {
  const ascii = fixture('dolphins.ply'), big = fixture('dolphins_be.ply'), colored = fixture('dolphins_colored.ply');
  if (!ascii || !big || !colored) return t.skip('fixtures missing');
  const a = parsePLY(ascii), b = parsePLY(big), c = parsePLY(colored);
  assert.equal(a.positions.length / 3, 855); assert.equal(a.indices.length / 3, 1689);
  // Independent read of the ascii body.
  const lines = new TextDecoder().decode(ascii).split(/\r?\n/), start = lines.indexOf('end_header') + 1;
  const expected = lines.slice(start, start + 855).flatMap(line => line.trim().split(/\s+/).map(Number));
  closeArray(a.positions, expected, 1e-6, 'dolphins ascii');
  const faces = lines.slice(start + 855, start + 855 + 1689).flatMap(line => line.trim().split(/\s+/).slice(1).map(Number));
  assert.deepEqual([...a.indices], faces);
  closeArray(b.positions, a.positions, 1e-6, 'big-endian vs ascii');
  assert.deepEqual([...b.indices], [...a.indices]);
  closeArray(c.positions, a.positions, 1e-6, 'colored positions');
  const coloredLines = new TextDecoder().decode(colored).split(/\r?\n/), colorStart = coloredLines.indexOf('end_header') + 1;
  const expectedColors = coloredLines.slice(colorStart, colorStart + 855).flatMap(line => line.trim().split(/\s+/).slice(3, 6).map(v => Number(v) / 255));
  closeArray(c.colors, expectedColors, 1e-6, 'dolphin colors');
  assert.ok(new Set(expectedColors).size > 2, 'fixture has several colors');
  const geometry = toGeometry(a), box = bounds(a.positions);
  closeArray(geometry.bounds.subarray(0, 3), box.min.map((v, i) => (v + box.max[i]) / 2), 1e-5, 'bounds center');
});

// ---------------------------------------------------------------- OFF, XYZ

test('OFF: plain, COFF with 0-255 colors, NOFF, STOFF, comments and counts on the keyword line', () => {
  const plain = parseOFF(text('# comment\nOFF\n4 2 0\n0 0 0\n1 0 0  # trailing\n1 1 0\n\n0 1 0\n4 0 1 2 3\n3 0 2 3\n'));
  assert.equal(plain.positions.length, 12);
  assert.deepEqual([...plain.indices], [0, 1, 2, 0, 2, 3, 0, 2, 3]);
  const colored = parseOFF(text('COFF 3 1 0\n0 0 0 255 0 0 255\n1 0 0 0 255 0 255\n0 1 0 0 0 255 255\n3 0 1 2 10 20 30\n'));
  assert.deepEqual([...colored.colors], [1, 0, 0, 0, 1, 0, 0, 0, 1]);
  const floatColors = parseOFF(text('COFF\n3 1 0\n0 0 0 0.5 0.25 1\n1 0 0 0 0 0\n0 1 0 1 1 1\n3 0 1 2\n'));
  assert.deepEqual([...floatColors.colors], [0.5, 0.25, 1, 0, 0, 0, 1, 1, 1]);
  const normal = parseOFF(text('NOFF\n3 1 0\n0 0 0 0 0 1\n1 0 0 0 0 1\n0 1 0 0 0 1\n3 0 1 2\n'));
  assert.deepEqual([...normal.normals], [0, 0, 1, 0, 0, 1, 0, 0, 1]);
  const all = parseOFF(text('STCNOFF\n3 1 0\n0 0 0 0 0 1 1 0 0 1 0.1 0.2\n1 0 0 0 0 1 0 1 0 1 0.3 0.4\n0 1 0 0 0 1 0 0 1 1 0.5 0.6\n3 0 1 2\n'));
  closeArray(all.uvs, [0.1, 0.2, 0.3, 0.4, 0.5, 0.6], 1e-6);
  closeArray(all.colors, [1, 0, 0, 0, 1, 0, 0, 0, 1], 0);
  const points = parseOFF(text('OFF\n2 0 0\n0 0 0\n1 1 1\n'));
  assert.equal(points.kind, 'points');
});

test('OFF: errors and real libigl files', t => {
  rejects(() => parseOFF(text('PLY\n')), 'header');
  rejects(() => parseOFF(text('OFF BINARY\n')), 'unsupported');
  rejects(() => parseOFF(text('4OFF\n')), 'unsupported');
  rejects(() => parseOFF(text('OFF\n3 1 0\n0 0 0\n1 0 0\n')), 'truncated');
  rejects(() => parseOFF(text('OFF\n3 1 0\n0 0 0\n1 0 0\n0 1 0\n3 0 1 3\n')), 'range');
  rejects(() => parseOFF(text('OFF\n3 1 0\n0 0 0\n1 0\n0 1 0\n3 0 1 2\n')), 'syntax');
  rejects(() => parseOFF(text('OFF\n3 1 0\n0 0 0\n1 0 0\n0 1 0\n4 0 1 2\n')), 'syntax');
  rejects(() => parseOFF(text('OFF\n3 1 0\n0 0 0\n1 0 x\n0 1 0\n3 0 1 2\n')), 'syntax');
  rejects(() => parseOFF(text('OFF\n3000000000 1 0\n')), 'limit');
  const cube = fixture('cube.off'), knight = fixture('decimated-knight.off');
  if (!cube || !knight) return t.skip('fixtures missing');
  const c = parseOFF(cube);
  assert.equal(c.positions.length / 3, 8); assert.equal(c.indices.length / 3, 12);
  assert.deepEqual(bounds(c.positions), {min: [-1, -1, -1], max: [1, 1, 1]});
  const k = parseOFF(knight), lines = new TextDecoder().decode(knight).trim().split('\n');
  assert.equal(k.positions.length / 3, 502); assert.equal(k.indices.length / 3, 1000);
  closeArray(k.positions, lines.slice(2, 504).flatMap(l => l.trim().split(/\s+/).map(Number)), 1e-6, 'knight');
  assert.deepEqual([...k.indices], lines.slice(504, 1504).flatMap(l => l.trim().split(/\s+/).slice(1).map(Number)));
});

test('XYZ: layouts, separators, labels, count lines and errors', t => {
  const xyz = parseXYZ(text('# points\n1 2 3\n4,5,6\n7;8;9\n'));
  assert.deepEqual([...xyz.positions], [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.equal(xyz.kind, 'points');
  const rgb = parseXYZ(text('0 0 0 255 0 0\n1 1 1 0 128 255\n'));
  closeArray(rgb.colors, [1, 0, 0, 0, 128 / 255, 1], 1e-6);
  const normal = parseXYZ(text('0 0 0 0 0 -1\n1 1 1 0 1 0\n'));
  assert.deepEqual([...normal.normals], [0, 0, -1, 0, 1, 0]);
  assert.equal(normal.colors, undefined);
  const forced = parseXYZ(text('0 0 0 0 0 1\n'), {layout: 'xyz-normal'});
  assert.deepEqual([...forced.normals], [0, 0, 1]);
  const nine = parseXYZ(text('0 0 0 0 0 1 0.5 0.5 0.5\n'));
  assert.deepEqual([...nine.normals], [0, 0, 1]); assert.deepEqual([...nine.colors], [0.5, 0.5, 0.5]);
  const pts = parseXYZ(text('2\n1 2 3 -500 10 20 30\n4 5 6 200 40 50 60\n'));
  assert.deepEqual([...pts.positions], [1, 2, 3, 4, 5, 6]); assert.deepEqual([...pts.attributes.intensity], [-500, 200]);
  closeArray(pts.colors, [10, 20, 30, 40, 50, 60].map(v => v / 255), 1e-6);
  const chemistry = parseXYZ(text('3\nwater molecule\nO 0.0 0.0 0.1\nH 0.75 0.0 -0.5\nH -0.75 0.0 -0.5\n'));
  closeArray(chemistry.positions, [0, 0, 0.1, 0.75, 0, -0.5, -0.75, 0, -0.5], 1e-6);
  rejects(() => parseXYZ(text('1 2 3\n1 2\n')), 'syntax', /line 2/);
  rejects(() => parseXYZ(text('1 2\n')), 'syntax');
  rejects(() => parseXYZ(text('1 2 x\n')), 'syntax');
  rejects(() => parseXYZ(text('# nothing\n')), 'syntax');
  rejects(() => parseXYZ(text('1 2 3\n4 5 6\n'), {maxVertices: 1}), 'limit');
  rejects(() => parseXYZ(text('1 2 3\n'), {layout: 'xyz-rgb'}), 'syntax');
  const helix = fixture('helix_201.xyz');
  if (!helix) return t.skip('fixture missing');
  const h = parseXYZ(helix), rows = new TextDecoder().decode(helix).split('\n').filter(l => l.trim() && !l.startsWith('#'));
  assert.equal(h.positions.length / 3, 201);
  closeArray(h.positions, rows.flatMap(l => l.trim().split(/\s+/).map(Number)), 1e-6, 'helix');
});

// ---------------------------------------------------------------- PCD and LZF

function lzfCompress(input) {
  const out = [], hash = new Map(), literal = [];
  const flush = () => {while (literal.length) {const n = Math.min(32, literal.length); out.push(n - 1, ...literal.splice(0, n));}};
  let i = 0;
  while (i < input.length) {
    if (i + 2 < input.length) {
      const key = input[i] | input[i + 1] << 8 | input[i + 2] << 16, reference = hash.get(key);
      hash.set(key, i);
      if (reference !== undefined && i - reference - 1 < 8192) {
        let length = 0;
        const max = Math.min(264, input.length - i);
        while (length < max && input[reference + length] === input[i + length]) length++;
        if (length >= 3) {
          flush();
          const offset = i - reference - 1, l = length - 2;
          if (l < 7) out.push(l << 5 | offset >> 8, offset & 255); else out.push(7 << 5 | offset >> 8, l - 7, offset & 255);
          i += length; continue;
        }
      }
    }
    literal.push(input[i++]);
  }
  flush();
  return Uint8Array.from(out);
}

test('LZF: round trips literal runs, short and long back references; rejects corrupt streams', () => {
  const random = new Uint8Array(5000); let seed = 7;
  for (let i = 0; i < random.length; i++) {seed = seed * 1103515245 + 12345 >>> 0; random[i] = seed >>> 16;}
  const repetitive = new Uint8Array(20000).map((_, i) => (i % 97) < 50 ? 1 : i % 7);
  for (const input of [random, repetitive, new Uint8Array(0), Uint8Array.of(9)]) {
    const packed = lzfCompress(input);
    assert.deepEqual(decompressLZF(packed, input.length), input);
  }
  assert.ok(lzfCompress(repetitive).length < repetitive.length / 4, 'test compressor emitted back references');
  rejects(() => decompressLZF(Uint8Array.of(1 << 5, 0), 3), 'range', /before the output/);
  rejects(() => decompressLZF(Uint8Array.of(4, 1, 2), 5), 'truncated');
  rejects(() => decompressLZF(Uint8Array.of(0, 1, 1 << 5, 0), 2), 'range', /overflows the output/);
  rejects(() => decompressLZF(Uint8Array.of(0, 1, 7 << 5), 10), 'truncated');
  rejects(() => decompressLZF(Uint8Array.of(0, 1), 4), 'truncated', /expected 4/);
});

const packRGB = (r, g, b) => {const view = new DataView(new ArrayBuffer(4)); view.setUint32(0, r << 16 | g << 8 | b, true); return view.getFloat32(0, true);};
function pcdPoints(count) {
  return Array.from({length: count}, (_, i) => ({
    x: i * 0.5, y: -i, z: i % 3 === 1 ? NaN : i * i * 0.25, nx: 0, ny: 1, nz: 0, rgb: [i * 20 % 256, i * 7 % 256, 7], intensity: i * 1.5, pad: [i, i + 1],
  }));
}
function writePCD(data, points) {
  const header = `# .PCD v0.7\nVERSION 0.7\nFIELDS x y z normal_x normal_y normal_z rgb intensity _\nSIZE 4 4 4 4 4 4 4 4 2\nTYPE F F F F F F F F U\nCOUNT 1 1 1 1 1 1 1 1 2\nWIDTH ${points.length}\nHEIGHT 1\nVIEWPOINT 0 0 0 1 0 0 0\nPOINTS ${points.length}\nDATA ${data}\n`;
  const fields = [['x', 4], ['y', 4], ['z', 4], ['nx', 4], ['ny', 4], ['nz', 4], ['rgb', 4], ['intensity', 4], ['pad', 4]];
  if (data === 'ascii') return text(header + points.map(p => [p.x, p.y, p.z, p.nx, p.ny, p.nz, packRGB(...p.rgb), p.intensity, ...p.pad].map(v => Number.isNaN(v) ? 'nan' : String(v)).join(' ')).join('\n') + '\n');
  const rowSize = 36, body = new Uint8Array(points.length * rowSize), view = new DataView(body.buffer);
  const write = (offset, name, p) => {
    if (name === 'rgb') view.setUint32(offset, p.rgb[0] << 16 | p.rgb[1] << 8 | p.rgb[2], true);
    else if (name === 'pad') {view.setUint16(offset, p.pad[0], true); view.setUint16(offset + 2, p.pad[1], true);}
    else view.setFloat32(offset, p[name], true);
  };
  if (data === 'binary') points.forEach((p, i) => {let offset = i * rowSize; for (const [name, size] of fields) {write(offset, name, p); offset += size;}});
  else {let offset = 0; for (const [name, size] of fields) for (const p of points) {write(offset, name, p); offset += size;}}
  const head = text(header);
  if (data === 'binary') {const out = new Uint8Array(head.length + body.length); out.set(head); out.set(body, head.length); return out;}
  const packed = lzfCompress(body), out = new Uint8Array(head.length + 8 + packed.length), sizes = new DataView(out.buffer, head.length, 8);
  out.set(head); sizes.setUint32(0, packed.length, true); sizes.setUint32(4, body.length, true); out.set(packed, head.length + 8);
  return out;
}
function checkPCD(result, points) {
  const kept = points.filter(p => !Number.isNaN(p.z));
  assert.equal(result.kind, 'points');
  assert.equal(result.positions.length / 3, kept.length);
  closeArray(result.positions, kept.flatMap(p => [p.x, p.y, p.z]), 1e-6, 'pcd positions');
  closeArray(result.normals, kept.flatMap(() => [0, 1, 0]), 0, 'pcd normals');
  closeArray(result.colors, kept.flatMap(p => p.rgb.map(v => v / 255)), 1e-7, 'pcd colors');
  closeArray(result.attributes.intensity, kept.map(p => p.intensity), 1e-6, 'pcd intensity');
}

test('PCD: ascii, binary and binary_compressed agree; NaN holes dropped unless keepInvalid', () => {
  const points = pcdPoints(300);
  for (const data of ['ascii', 'binary', 'binary_compressed']) {
    const bytes = writePCD(data, points);
    checkPCD(parsePCD(bytes), points);
    const all = parsePCD(bytes, {keepInvalid: true});
    assert.equal(all.positions.length / 3, 300);
    assert.ok(Number.isNaN(all.positions[1 * 3 + 2]));
    const header = parsePCDHeader(bytes);
    assert.equal(header.data, data); assert.equal(header.rowSize, 36); assert.equal(header.fields.at(-1).count, 2);
  }
  const compressed = writePCD('binary_compressed', points);
  assert.ok(compressed.length < writePCD('binary', points).length, 'fixture is actually compressed');
});

test('PCD: malformed headers, truncated and corrupt data, limits', () => {
  const points = pcdPoints(20), binary = writePCD('binary', points), compressed = writePCD('binary_compressed', points);
  rejects(() => parsePCD(text('VERSION 0.7\nFIELDS x y z\n')), 'truncated', /DATA/);
  rejects(() => parsePCD(text('VERSION 0.7\nFIELDS x y z\nSIZE 4 4\nTYPE F F F\nWIDTH 1\nPOINTS 1\nDATA ascii\n1 2 3\n')), 'header');
  rejects(() => parsePCD(text('FIELDS x y z\nSIZE 4 4 4\nTYPE F F Q\nWIDTH 1\nPOINTS 1\nDATA ascii\n1 2 3\n')), 'header');
  rejects(() => parsePCD(text('FIELDS x y z\nSIZE 4 4 3\nTYPE F F F\nWIDTH 1\nPOINTS 1\nDATA ascii\n1 2 3\n')), 'header');
  rejects(() => parsePCD(text('FIELDS x y w\nSIZE 4 4 4\nTYPE F F F\nWIDTH 1\nPOINTS 1\nDATA ascii\n1 2 3\n')), 'header', /x, y and z/);
  rejects(() => parsePCD(text('FIELDS x y z\nSIZE 4 4 4\nTYPE F F F\nWIDTH 2\nPOINTS 1\nDATA ascii\n1 2 3\n')), 'header', /does not match/);
  rejects(() => parsePCD(text('FIELDS x y z\nSIZE 4 4 4\nTYPE F F F\nWIDTH 1\nPOINTS 1\nDATA lzma\n')), 'unsupported');
  rejects(() => parsePCD(text('FIELDS x y z\nSIZE 4 4 4\nTYPE F F F\nWIDTH 2\nPOINTS 2\nDATA ascii\n1 2 3\n')), 'truncated');
  rejects(() => parsePCD(text('FIELDS x y z\nSIZE 4 4 4\nTYPE F F F\nWIDTH 1\nPOINTS 1\nDATA ascii\n1 2\n')), 'syntax');
  rejects(() => parsePCD(text('BOGUS 1\nDATA ascii\n')), 'header');
  rejects(() => parsePCD(binary.subarray(0, binary.length - 1)), 'truncated');
  rejects(() => parsePCD(compressed.subarray(0, compressed.length - 1)), 'truncated');
  const sizeAt = new TextDecoder('latin1').decode(compressed).indexOf('DATA binary_compressed\n') + 'DATA binary_compressed\n'.length;
  const wrongSize = compressed.slice(); new DataView(wrongSize.buffer).setUint32(sizeAt + 4, 999, true);
  rejects(() => parsePCD(wrongSize), 'header', /uncompressed size/);
  const corrupt = compressed.slice(); corrupt[sizeAt + 8] = 0xff; corrupt[sizeAt + 9] = 0xff;
  assert.throws(() => parsePCD(corrupt), LoaderError);
  rejects(() => parsePCD(binary, {maxVertices: 19}), 'limit');
});

test('PCD: real PCL and three.js clouds (ascii packed rgb, binary_compressed)', t => {
  const simple = fixture('simple.pcd'), logo = fixture('pcl_logo.pcd'), bunny = fixture('bunny.pcd');
  if (!simple || !logo || !bunny) return t.skip('fixtures missing');
  const s = parsePCD(simple);
  assert.equal(s.positions.length / 3, 213);
  const packed = new DataView(new ArrayBuffer(4)); packed.setFloat32(0, 4.2108e+06, true);
  const value = packed.getUint32(0, true);
  closeArray(s.colors.subarray(0, 3), [(value >>> 16 & 255) / 255, (value >>> 8 & 255) / 255, (value & 255) / 255], 1e-7, 'simple rgb');
  const b = parsePCD(bunny), rows = new TextDecoder().decode(bunny).split('\n');
  const start = rows.findIndex(r => r.startsWith('DATA')) + 1;
  closeArray(b.positions, rows.slice(start).filter(r => r.trim()).flatMap(r => r.trim().split(/\s+/).map(Number)), 1e-6, 'bunny');
  const l = parsePCD(logo);
  assert.equal(parsePCDHeader(logo).data, 'binary_compressed');
  assert.equal(l.positions.length / 3, 12909);
  for (const v of l.positions) assert.ok(Number.isFinite(v) && Math.abs(v) < 10);
  for (const v of l.colors) assert.ok(v >= 0 && v <= 1);
  const distinct = new Set(); for (let i = 0; i < l.colors.length; i += 3) distinct.add(l.colors.slice(i, i + 3).join());
  assert.ok(distinct.size > 1, 'logo has several colors');
});

// ---------------------------------------------------------------- VTK

const strip = '4 0 1 3 2';
function vtkAscii(version = '3.0') {
  const points = '0 0 0 1 0 0 1 1 0 0 1 0 0 0 1 1 0 1';
  const cells = version.startsWith('5')
    ? 'POLYGONS 3 7\nOFFSETS vtktypeint64\n0 4 7\nCONNECTIVITY vtktypeint64\n0 1 2 3 4 5 1\nTRIANGLE_STRIPS 2 4\nOFFSETS vtktypeint64\n0 4\nCONNECTIVITY vtktypeint64\n0 1 3 2\n'
    : `POLYGONS 2 9\n4 0 1 2 3\n3 4 5 1\nTRIANGLE_STRIPS 1 5\n${strip}\nLINES 1 3\n2 0 4\n`;
  return text(`# vtk DataFile Version ${version}\ntest polydata\nASCII\nDATASET POLYDATA\nPOINTS 6 float\n${points}\n${cells}\nCELL_DATA 3\nSCALARS cell_ids int 1\nLOOKUP_TABLE default\n0 1 2\nPOINT_DATA 6\nSCALARS temperature float\nLOOKUP_TABLE default\n10 11 12 13 14 15\nNORMALS normals float\n0 0 1 0 0 1 0 0 1 0 0 1 0 0 1 0 0 1\nCOLOR_SCALARS colors 3\n1 0 0 0 1 0 0 0 1 1 1 0 0 1 1 1 0 1\nTEXTURE_COORDINATES uv 2 float\n0 0 1 0 1 1 0 1 0.5 0.5 0.25 0.75\nFIELD extras 1\nweights 2 6 double\n1 2 3 4 5 6 7 8 9 10 11 12\n`);
}
function vtkBinary() {
  const chunks = [], push = value => chunks.push(typeof value === 'string' ? text(value) : value);
  const big = (type, values) => {
    const size = {float: 4, int: 4, unsigned_char: 1, double: 8}[type], out = new Uint8Array(values.length * size), view = new DataView(out.buffer);
    values.forEach((v, i) => type === 'float' ? view.setFloat32(i * 4, v) : type === 'int' ? view.setInt32(i * 4, v) : type === 'double' ? view.setFloat64(i * 8, v) : view.setUint8(i, v));
    return out;
  };
  push('# vtk DataFile Version 3.0\nbinary polydata\nBINARY\nDATASET POLYDATA\nPOINTS 6 float\n');
  push(big('float', [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 0, 0, 1, 1, 0, 1])); push('\nPOLYGONS 2 9\n');
  push(big('int', [4, 0, 1, 2, 3, 3, 4, 5, 1])); push('\nTRIANGLE_STRIPS 1 5\n');
  push(big('int', [4, 0, 1, 3, 2])); push('\nPOINT_DATA 6\nSCALARS temperature float 1\nLOOKUP_TABLE default\n');
  push(big('float', [10, 11, 12, 13, 14, 15])); push('\nNORMALS normals float\n');
  push(big('float', Array.from({length: 6}, () => [0, 0, 1]).flat())); push('\nCOLOR_SCALARS colors 3\n');
  push(big('unsigned_char', [255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 0, 0, 255, 255, 255, 0, 255])); push('\nTEXTURE_COORDINATES uv 2 double\n');
  push(big('double', [0, 0, 1, 0, 1, 1, 0, 1, 0.5, 0.5, 0.25, 0.75])); push('\n');
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0)); let o = 0;
  for (const c of chunks) {out.set(c, o); o += c.length;}
  return out;
}
function checkVTK(result) {
  assert.equal(result.kind, 'mesh');
  assert.deepEqual([...result.positions], [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 0, 0, 1, 1, 0, 1]);
  // Quad fan (2 triangles), triangle (1), strip 0 1 3 2 -> (0 1 3) and (3 1 2) with alternating winding.
  assert.equal(result.indices.length, 15);
  assert.deepEqual([...result.indices.subarray(0, 9)], [0, 1, 2, 0, 2, 3, 4, 5, 1]);
  assert.deepEqual([...result.indices.subarray(9)], [0, 1, 3, 3, 1, 2]);
  assert.deepEqual([...result.normals], Array.from({length: 6}, () => [0, 0, 1]).flat());
  closeArray(result.colors, [1, 0, 0, 0, 1, 0, 0, 0, 1, 1, 1, 0, 0, 1, 1, 1, 0, 1], 1e-7, 'vtk colors');
  closeArray(result.uvs, [0, 0, 1, 0, 1, 1, 0, 1, 0.5, 0.5, 0.25, 0.75], 1e-7, 'vtk uvs');
  assert.deepEqual([...result.attributes.temperature], [10, 11, 12, 13, 14, 15]);
}

test('VTK: legacy ASCII, BINARY (big-endian) and 5.1 OFFSETS/CONNECTIVITY polydata', () => {
  checkVTK(parseVTK(vtkAscii()));
  checkVTK(parseVTK(vtkBinary()));
  checkVTK(parseVTK(vtkAscii('5.1')));
  // A strip's triangles keep a consistent facing: all normals of this flat strip point the same way.
  const strips = parseVTK(text('# vtk DataFile Version 3.0\nstrip\nASCII\nDATASET POLYDATA\nPOINTS 5 float\n0 0 0 0 1 0 1 0 0 1 1 0 2 0 0\nTRIANGLE_STRIPS 1 6\n5 0 1 2 3 4\n'));
  const normals = [];
  for (let t = 0; t < strips.indices.length; t += 3) {
    const [a, b, c] = [...strips.indices.subarray(t, t + 3)].map(i => [...strips.positions.subarray(i * 3, i * 3 + 3)]);
    normals.push(Math.sign((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])));
  }
  assert.deepEqual(normals, [-1, -1, -1]);
  const points = parseVTK(text('# vtk DataFile Version 2.0\npoints\nASCII\nDATASET POLYDATA\nPOINTS 2 double\n0 0 0 1 2 3\nVERTICES 2 4\n1 0\n1 1\n'));
  assert.equal(points.kind, 'points');
});

test('VTK: errors', () => {
  const header = '# vtk DataFile Version 3.0\nx\nASCII\n';
  rejects(() => parseVTK(text('hello\n')), 'header');
  rejects(() => parseVTK(text('# vtk DataFile Version 3.0\nx\nTEXT\n')), 'header');
  rejects(() => parseVTK(text(header + 'DATASET STRUCTURED_POINTS\n')), 'unsupported');
  rejects(() => parseVTK(text(header + 'DATASET POLYDATA\nPOINTS 3 float\n0 0 0 1 0 0\n')), 'truncated');
  rejects(() => parseVTK(text(header + 'DATASET POLYDATA\nPOINTS 3 float\n0 0 0 1 0 0 0 1 0\nPOLYGONS 1 4\n3 0 1 7\n')), 'range');
  rejects(() => parseVTK(text(header + 'DATASET POLYDATA\nPOINTS 3 float\n0 0 0 1 0 0 0 1 0\nPOLYGONS 1 4\n5 0 1 2\n')), 'range');
  rejects(() => parseVTK(text(header + 'DATASET POLYDATA\nPOINTS 3 float\n0 0 0 1 0 0 0 1 0\nPOLYGONS 2 4\n3 0 1 2\n')), 'range');
  rejects(() => parseVTK(text(header + 'DATASET POLYDATA\nPOINTS 3 quaternion\n')), 'unsupported');
  rejects(() => parseVTK(text(header + 'DATASET POLYDATA\nPOINTS 3 float\n0 0 0 1 0 0 0 1 0\nBANANAS 3\n')), 'syntax');
  rejects(() => parseVTK(text(header + 'DATASET POLYDATA\nPOINTS 99999999999 float\n')), 'limit');
  rejects(() => parseVTK(text(header + 'POINTS 3 float\n0 0 0 1 0 0 0 1 0\n')), 'header', /DATASET/);
  const binary = vtkBinary();
  rejects(() => parseVTK(binary.subarray(0, 120)), 'truncated');
});

test('VTK: real pyvista polydata files', t => {
  const fran = fixture('fran_cut.vtk'), cube = fixture('polyEx.vtk');
  if (!fran || !cube) return t.skip('fixtures missing');
  const f = parseVTK(fran), source = new TextDecoder().decode(fran);
  const pointCount = Number(/POINTS (\d+)/.exec(source)[1]), polygons = /POLYGONS (\d+) (\d+)/.exec(source);
  assert.equal(f.positions.length / 3, pointCount);
  const tokens = source.slice(polygons.index + polygons[0].length).trim().split(/\s+/).map(Number);
  let triangles = 0;
  for (let c = 0, p = 0; c < Number(polygons[1]); c++) {triangles += tokens[p] - 2; p += tokens[p] + 1;}
  assert.equal(f.indices.length / 3, triangles);
  const values = source.slice(source.indexOf('\n', source.indexOf('POINTS')) + 1, polygons.index).trim().split(/\s+/).map(Number);
  assert.deepEqual(bounds(f.positions), bounds(Float32Array.from(values)));
  const c = parseVTK(cube);
  assert.equal(c.positions.length / 3, 8); assert.equal(c.indices.length / 3, 12);
  assert.deepEqual(bounds(c.positions), {min: [0, 0, 0], max: [1, 1, 1]});
  assert.ok(c.attributes.my_scalars);
  const geometry = toGeometry(c);
  closeArray(geometry.bounds, [0.5, 0.5, 0.5, Math.sqrt(3) / 2], 1e-6, 'cube bounds');
});

// ---------------------------------------------------------------- ZIP and 3MF

function crcReference(bytes) {
  let crc = ~0;
  for (const byte of bytes) {crc ^= byte; for (let k = 0; k < 8; k++) crc = crc >>> 1 ^ (crc & 1 ? 0xedb88320 : 0);}
  return ~crc >>> 0;
}
/** entries: [{name, data: string | Uint8Array, method: 0 | 8, flags?, crc?, size?}] */
function writeZip(entries) {
  const locals = [], centrals = [];
  let offset = 0;
  for (const entry of entries) {
    const data = typeof entry.data === 'string' ? text(entry.data) : entry.data;
    const stored = entry.method === 8 ? deflateRawSync(data) : entry.method === 0 ? data : entry.payload;
    const name = text(entry.name), crc = entry.crc ?? crcReference(data), size = entry.size ?? data.length;
    const local = new Uint8Array(30 + name.length + stored.length), lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true); lv.setUint16(4, 20, true); lv.setUint16(6, entry.flags ?? 0, true); lv.setUint16(8, entry.method, true);
    lv.setUint32(14, crc, true); lv.setUint32(18, stored.length, true); lv.setUint32(22, size, true); lv.setUint16(26, name.length, true);
    local.set(name, 30); local.set(stored, 30 + name.length);
    const central = new Uint8Array(46 + name.length), cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, 20, true); cv.setUint16(6, 20, true); cv.setUint16(8, entry.flags ?? 0, true); cv.setUint16(10, entry.method, true);
    cv.setUint32(16, crc, true); cv.setUint32(20, stored.length, true); cv.setUint32(24, size, true); cv.setUint16(28, name.length, true); cv.setUint32(42, offset, true);
    central.set(name, 46);
    locals.push(local); centrals.push(central); offset += local.length;
  }
  const cdSize = centrals.reduce((n, c) => n + c.length, 0), end = new Uint8Array(22), ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true); ev.setUint16(8, entries.length, true); ev.setUint16(10, entries.length, true); ev.setUint32(12, cdSize, true); ev.setUint32(16, offset, true);
  const out = new Uint8Array(offset + cdSize + 22); let o = 0;
  for (const part of [...locals, ...centrals, end]) {out.set(part, o); o += part.length;}
  return out;
}

test('ZIP: stored and deflate entries, CRC-32, corrupt and hostile archives', async () => {
  const big = 'abc'.repeat(5000);
  const archive = writeZip([{name: 'a.txt', data: 'hello stored', method: 0}, {name: 'dir/b.txt', data: big, method: 8}]);
  const entries = readZipDirectory(archive);
  assert.deepEqual(entries.map(e => [e.name, e.method, e.size]), [['a.txt', 0, 12], ['dir/b.txt', 8, 15000]]);
  assert.ok(entries[1].compressedSize < 200);
  assert.equal(new TextDecoder().decode(await readZipEntry(archive, entries[0])), 'hello stored');
  assert.equal(new TextDecoder().decode(await readZipEntry(archive, entries[1])), big);
  assert.equal(crc32(text(big)), crcReference(text(big)));
  rejects(() => readZipDirectory(text('not a zip archive at all, sorry')), 'zip');
  rejects(() => readZipDirectory(new Uint8Array(4)), 'truncated');
  rejects(() => readZipDirectory(archive, {maxEntries: 1}), 'limit');
  rejects(() => readZipDirectory(writeZip([{name: 'x', data: 'x', method: 0, flags: 1}])), 'unsupported', /encrypted/);
  const badCrc = writeZip([{name: 'x', data: 'payload', method: 8, crc: 1234}]);
  await rejectsAsync(readZipEntry(badCrc, readZipDirectory(badCrc)[0]), 'zip', /CRC/);
  const bomb = writeZip([{name: 'x', data: 'a'.repeat(100000), method: 8, size: 1000}]);
  await rejectsAsync(readZipEntry(bomb, readZipDirectory(bomb)[0]), 'zip', /past its declared size/);
  await rejectsAsync(readZipEntry(archive, entries[1], {maxEntryBytes: 1000}), 'limit');
  const lzma = writeZip([{name: 'x', data: 'x', method: 14, payload: text('x')}]);
  await rejectsAsync(readZipEntry(lzma, readZipDirectory(lzma)[0]), 'unsupported', /method 14/);
  const garbage = writeZip([{name: 'x', data: 'x', method: 8, size: 5}]);
  const directory = readZipDirectory(garbage), corrupt = garbage.slice();
  corrupt[30 + 1] = 0xff; corrupt[30] = 0xff;
  await rejectsAsync(readZipEntry(corrupt, directory[0]), 'zip');
  const truncated = archive.slice(0, 40);
  rejects(() => readZipDirectory(truncated), 'zip');
});

const CONTENT_TYPES = '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>';
const rels = target => `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="${target}" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>`;
const tetra = '<vertices><vertex x="0" y="0" z="0"/><vertex x="10" y="0" z="0"/><vertex x="0" y="10" z="0"/><vertex x="0" y="0" z="10"/></vertices>';
function modelXML({unit = 'millimeter', items, extra = ''}) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!-- generated by the loaders tests -->
<model unit="${unit}" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:m="http://schemas.microsoft.com/3dmanufacturing/material/2015/02" xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06">
  <metadata name="Title">Test &amp; model</metadata>
  <resources>
    <basematerials id="10"><base name="red" displaycolor="#FF0000"/><base name="blue" displaycolor="#0000FFFF"/></basematerials>
    <m:colorgroup id="20"><m:color color="#00FF00FF"/><m:color color="#FFFFFF80"/></m:colorgroup>
    <object id="1" name="plain" type="model"><mesh>${tetra}<triangles><triangle v1="0" v2="2" v3="1"/><triangle v1="0" v2="1" v3="3"/><triangle v1="0" v2="3" v3="2"/><triangle v1="1" v2="2" v3="3"/></triangles></mesh></object>
    <object id="2" name="colored" pid="10" pindex="0"><mesh>${tetra}<triangles><triangle v1="0" v2="2" v3="1"/><triangle v1="0" v2="1" v3="3" pid="10" p1="1"/><triangle v1="0" v2="3" v3="2" pid="20" p1="0"/><triangle v1="1" v2="2" v3="3"/></triangles></mesh></object>
    <object id="3" name="assembly"><components><component objectid="1" transform="1 0 0 0 1 0 0 0 1 100 0 0"/><component objectid="2" transform="-1 0 0 0 1 0 0 0 1 0 50 0"/></components></object>
    ${extra}
  </resources>
  <build>${items}</build>
</model>`;
}
const package3MF = (model, {method = 8, modelPath = '3D/3dmodel.model', more = []} = {}) => writeZip([
  {name: '[Content_Types].xml', data: CONTENT_TYPES, method: 0},
  {name: '_rels/.rels', data: rels('/' + modelPath), method},
  {name: modelPath, data: model, method},
  ...more,
]);

/** Independent transform application: row-vector 3x4 matrices, apply a then b. */
const applyRow = (m, [x, y, z]) => [x * m[0] + y * m[3] + z * m[6] + m[9], x * m[1] + y * m[4] + z * m[7] + m[10], x * m[2] + y * m[5] + z * m[8] + m[11]];
const signedVolume = (positions, indices, start, count) => {
  let volume = 0;
  for (let t = start; t < start + count; t += 3) {
    const [a, b, c] = [0, 1, 2].map(k => [...positions.subarray(indices[t + k] * 3, indices[t + k] * 3 + 3)]);
    volume += (a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0])) / 6;
  }
  return volume;
};

test('3MF: objects, components, build transforms, mirroring, colors and unit conversion (stored and deflate)', async () => {
  const items = '<item objectid="1"/><item objectid="3" transform="1 0 0 0 1 0 0 0 1 0 0 20"/>';
  for (const method of [0, 8]) {
    const result = await parse3MF(package3MF(modelXML({items}), {method}));
    assert.equal(result.kind, 'mesh'); assert.equal(result.unit, 'millimeter'); assert.equal(result.metadata.Title, 'Test & model');
    // Items: plain (4 tris), assembly -> plain at +100x (4) and colored mirrored (4 tris in 3 color groups).
    assert.equal(result.indices.length / 3, 12); assert.equal(result.positions.length / 3, 12);
    assert.deepEqual(result.groups.map(g => [g.objectId, g.count, g.color?.map(v => +v.toFixed(3)).join(',')]), [
      ['1', 12, undefined], ['1', 12, undefined],
      ['2', 6, '1,0,0,1'], ['2', 3, '0,0,1,1'], ['2', 3, '0,1,0,1'],
    ]);
    assert.equal(result.colors, undefined, 'uniform triangle colors need no vertex colors');
    const tetraPoints = [[0, 0, 0], [10, 0, 0], [0, 10, 0], [0, 0, 10]];
    const expectedPositions = [
      ...tetraPoints.map(p => p.map(v => v * 1e-3)),
      ...tetraPoints.map(p => applyRow([1, 0, 0, 0, 1, 0, 0, 0, 1, 100, 0, 20], p).map(v => v * 1e-3)),
      ...tetraPoints.map(p => applyRow([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 20], applyRow([-1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 50, 0], p)).map(v => v * 1e-3)),
    ];
    closeArray(result.positions, expectedPositions.flat(), 1e-6, '3mf positions');
    // The source tetrahedron winds outward (positive volume); the mirrored copy must keep that after the flip.
    const plain = signedVolume(result.positions, result.indices, 0, 12), mirrored = signedVolume(result.positions, result.indices, 24, 12);
    assert.ok(plain > 0 && mirrored > 0, `winding: ${plain} ${mirrored}`);
    close(mirrored, plain, 1e-6, 'mirrored volume');
  }
  const inches = await parse3MF(package3MF(modelXML({unit: 'inch', items: '<item objectid="1"/>'})));
  close(bounds(inches.positions).max[0], 10 * 0.0254, 1e-6);
  const native = await parse3MF(package3MF(modelXML({unit: 'inch', items: '<item objectid="1"/>'})), {units: 'file'});
  close(bounds(native.positions).max[0], 10, 1e-6);
  assert.equal(THREEMF_UNITS.micron, 1e-6);
});

test('3MF: per-corner colorgroup colors produce vertex colors; production p:path parts; no rels fallback', async () => {
  const extra = '<object id="4" name="gradient"><mesh>' + tetra + '<triangles><triangle v1="0" v2="2" v3="1" pid="20" p1="0" p2="1" p3="0"/><triangle v1="0" v2="1" v3="3"/></triangles></mesh></object>';
  const result = await parse3MF(package3MF(modelXML({items: '<item objectid="4"/><item objectid="1"/>', extra})));
  assert.ok(result.colors);
  assert.equal(result.positions.length / 3, 6 + 4, 'colored object unwelded, plain object indexed');
  closeArray(result.colors.subarray(0, 9), [0, 1, 0, 1, 1, 1, 0, 1, 0], 1e-6, 'corner colors');
  closeArray(result.colors.subarray(9, 18), [1, 1, 1, 1, 1, 1, 1, 1, 1], 0, 'uncolored triangle');
  assert.deepEqual(result.groups[0].color.map(v => +v.toFixed(3)), [0, 1, 0, 1]);
  const part = `<?xml version="1.0"?><model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources><object id="7" name="external"><mesh>${tetra}<triangles><triangle v1="0" v2="2" v3="1"/></triangles></mesh></object></resources><build/></model>`;
  const production = await parse3MF(package3MF(modelXML({items: '<item objectid="5"/>', extra: '<object id="5"><components><component p:path="/3D/Objects/part.model" objectid="7" transform="2 0 0 0 2 0 0 0 2 0 0 0"/></components></object>'}), {more: [{name: '3D/Objects/part.model', data: part, method: 8}]}));
  assert.equal(production.indices.length, 3);
  close(bounds(production.positions).max[1], 0.02, 1e-6);
  assert.equal(production.groups[0].name, 'external');
  const noRels = writeZip([{name: '3D/3dmodel.model', data: modelXML({items: '<item objectid="1"/>'}), method: 8}]);
  assert.equal((await parse3MF(noRels)).indices.length, 12);
});

test('3MF: malformed packages and models are rejected with clear errors', async () => {
  const wrap = (items, extra = '') => package3MF(modelXML({items, extra}));
  await rejectsAsync(parse3MF(text('PK not really a zip archive, just text')), 'zip');
  await rejectsAsync(parse3MF(text('solid ascii')), 'header');
  await rejectsAsync(parse3MF(wrap('<item objectid="99"/>')), 'syntax', /object 99/);
  await rejectsAsync(parse3MF(wrap('<item objectid="8"/>', '<object id="8"><components><component objectid="8"/></components></object>')), 'syntax', /itself/);
  await rejectsAsync(parse3MF(wrap('<item objectid="8"/>', '<object id="8"><mesh>' + tetra + '<triangles><triangle v1="0" v2="1" v3="9"/></triangles></mesh></object>')), 'range', /outside 0\.\.3/);
  await rejectsAsync(parse3MF(wrap('<item objectid="8"/>', '<object id="8"><mesh><vertices><vertex x="a" y="0" z="0"/></vertices></mesh></object>')), 'syntax');
  await rejectsAsync(parse3MF(wrap('<item objectid="8"/>', '<object id="8" pid="10" pindex="5"><mesh>' + tetra + '<triangles><triangle v1="0" v2="1" v3="2"/></triangles></mesh></object>')), 'range', /property index 5/);
  await rejectsAsync(parse3MF(wrap('<item objectid="1" transform="1 0 0"/>')), 'syntax', /transform/);
  await rejectsAsync(parse3MF(wrap('<item objectid="1"/><item objectid="1"/>'), {maxTriangles: 6}), 'limit');
  await rejectsAsync(parse3MF(wrap('<item objectid="1"/>'), {maxVertices: 3}), 'limit');
  await rejectsAsync(parse3MF(package3MF(modelXML({items: '<item objectid="1"/>'}).replace('</model>', ''))), 'truncated');
  await rejectsAsync(parse3MF(package3MF(modelXML({items: '<item objectid="1"/>'}).replace('</build>', '</resources>'))), 'syntax');
  await rejectsAsync(parse3MF(package3MF(modelXML({unit: 'furlong', items: '<item objectid="1"/>'}))), 'unsupported');
  await rejectsAsync(parse3MF(package3MF(modelXML({items: ''}))), 'syntax', /no triangles/);
  await rejectsAsync(parse3MF(writeZip([{name: '_rels/.rels', data: rels('/3D/missing.model'), method: 0}])), 'syntax', /missing/);
  const deep = Array.from({length: 40}, (_, i) => `<object id="${100 + i}"><components><component objectid="${i === 39 ? 1 : 101 + i}"/></components></object>`).join('');
  await rejectsAsync(parse3MF(wrap('<item objectid="100"/>', deep)), 'limit', /deeper/);
  const controller = new AbortController(); controller.abort();
  await rejectsAsync(parse3MF(wrap('<item objectid="1"/>'), {signal: controller.signal}), 'aborted');
});

test('3MF: real three.js packages agree with an independent zlib + regex read', async t => {
  const gears = fixture('cube_gears.3mf'), faces = fixture('facecolors.3mf'), vertex = fixture('vertexcolors.3mf');
  if (!gears || !faces || !vertex) return t.skip('fixtures missing');
  const readModel = bytes => {
    const entry = readZipDirectory(bytes).find(e => e.name.endsWith('.model'));
    const view = new DataView(bytes.buffer, bytes.byteOffset), start = entry.headerOffset + 30 + view.getUint16(entry.headerOffset + 26, true) + view.getUint16(entry.headerOffset + 28, true);
    return new TextDecoder().decode(inflateRawSync(bytes.subarray(start, start + entry.compressedSize)));
  };
  const xml = readModel(gears), result = await parse3MF(gears);
  // Independent expectation: walk build items, count instanced vertices and triangles per object.
  const objects = new Map();
  for (const match of xml.matchAll(/<object id="(\d+)"[\s\S]*?<\/object>/g)) objects.set(match[1], {vertices: [...match[0].matchAll(/<vertex x="([^"]+)" y="([^"]+)" z="([^"]+)"/g)].map(m => [+m[1], +m[2], +m[3]]), triangles: (match[0].match(/<triangle /g) ?? []).length});
  const items = [...xml.matchAll(/<item objectid="(\d+)"(?: transform="([^"]+)")?/g)];
  assert.ok(items.length > 1);
  let vertices = 0, triangles = 0;
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (const [, id, transform] of items) {
    const object = objects.get(id), m = transform ? transform.split(' ').map(Number) : [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];
    vertices += object.vertices.length; triangles += object.triangles;
    for (const p of object.vertices) applyRow(m, p).forEach((v, a) => {min[a] = Math.min(min[a], v * 1e-3); max[a] = Math.max(max[a], v * 1e-3);});
  }
  assert.equal(result.positions.length / 3, vertices); assert.equal(result.indices.length / 3, triangles);
  const box = bounds(result.positions);
  closeArray(box.min, min, 1e-5, 'gears min'); closeArray(box.max, max, 1e-5, 'gears max');
  assert.equal(result.groups.length, items.length);
  const f = await parse3MF(faces), colorsXML = [...readModel(faces).matchAll(/<m:color color="#(\w{8})"/g)].map(m => m[1].toLowerCase());
  assert.equal(f.groups.length, 5);
  assert.deepEqual(f.groups.map(g => g.color.map(v => Math.round(v * 255).toString(16).padStart(2, '0')).join('')), colorsXML);
  assert.equal(f.groups.reduce((n, g) => n + g.count, 0), f.indices.length);
  const v = await parse3MF(vertex);
  assert.ok(v.colors);
  assert.equal(v.positions.length / 3, 12);
  closeArray(v.colors.subarray(0, 9), [1, 0, 0, 0, 0, 1, 0, 1, 0], 1e-6, 'vertexcolors.3mf first triangle');
});

// ---------------------------------------------------------------- geometry, detection, fetch

test('toGeometry: smooth, flat, file normals, groups, compaction and errors', () => {
  const quad = {kind: 'mesh', positions: Float32Array.of(0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 5, 5, 5), indices: Uint32Array.of(0, 1, 2, 0, 2, 3)};
  const smooth = toGeometry(quad);
  assert.equal(smooth.vertices.length / 6, 4, 'unused vertex compacted');
  for (let v = 0; v < 4; v++) assert.deepEqual([...smooth.vertices.subarray(v * 6 + 3, v * 6 + 6)], [0, 0, 1]);
  closeArray(smooth.bounds, [0.5, 0.5, 0, Math.SQRT1_2], 1e-6);
  const flat = toGeometry(quad, {normals: 'flat'});
  assert.equal(flat.vertices.length / 6, 6); assert.deepEqual([...flat.indices], [0, 1, 2, 3, 4, 5]);
  const tilted = {...quad, normals: Float32Array.of(0, 0, 2, 0, 0, 2, 0, 0, 0, 0, 3, 0, 0, 0, 0)};
  const auto = toGeometry(tilted);
  assert.deepEqual([...auto.vertices.subarray(3, 6)], [0, 0, 1]);
  assert.deepEqual([...auto.vertices.subarray(15, 18)], [0, 0, 1], 'zero file normal replaced by smooth');
  assert.deepEqual([...auto.vertices.subarray(21, 24)], [0, 1, 0]);
  const group = toGeometry({...quad, groups: [{start: 0, count: 3}, {start: 3, count: 3}]}, {group: 1});
  assert.equal(group.indices.length, 3); assert.equal(group.vertices.length / 6, 3);
  rejects(() => toGeometry({...quad, groups: [{start: 1, count: 3}]}, {group: 0}), 'range');
  rejects(() => toGeometry(quad, {group: 4}), 'range');
  rejects(() => toGeometry({kind: 'points', positions: new Float32Array(9)}), 'unsupported', /pointsToGeometry/);
  rejects(() => toGeometry({...quad, indices: Uint32Array.of(0, 1, 9)}), 'range');
  rejects(() => toGeometry({...quad, positions: Float32Array.of(0, 0, NaN, 1, 0, 0, 1, 1, 0, 0, 1, 0)}), 'range', /non-finite/);
  rejects(() => toGeometry(quad, {normals: 'bumpy'}), 'range');
  const normals = computeVertexNormals(Float32Array.of(0, 0, 0, 1, 0, 0, 0, 1, 0, 9, 9, 9), Uint32Array.of(0, 1, 2));
  assert.deepEqual([...normals], [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]);
});

test('pointsToGeometry: octahedron markers, subsampling and outward winding', () => {
  const cloud = {kind: 'points', positions: Float32Array.of(0, 0, 0, 10, 0, 0, NaN, 0, 0, 0, 10, 0)};
  const geometry = pointsToGeometry(cloud, {size: 0.5});
  assert.equal(geometry.vertices.length / 6, 18); assert.equal(geometry.indices.length / 3, 24);
  for (let t = 0; t < 8; t++) {
    const corner = k => [...geometry.vertices.subarray(geometry.indices[t * 3 + k] * 6, geometry.indices[t * 3 + k] * 6 + 3)];
    const [a, b, c] = [corner(0), corner(1), corner(2)];
    const n = [(b[1] - a[1]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[1] - a[1]), (b[2] - a[2]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[2] - a[2]), (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])];
    const centroid = [0, 1, 2].map(i => (a[i] + b[i] + c[i]) / 3);
    assert.ok(n[0] * centroid[0] + n[1] * centroid[1] + n[2] * centroid[2] > 0, `triangle ${t} faces outward`);
  }
  assert.equal(pointsToGeometry(cloud, {maxPoints: 2}).vertices.length / 6, 12);
  rejects(() => pointsToGeometry(cloud, {maxPoints: 0}), 'range');
  rejects(() => pointsToGeometry({kind: 'points', positions: Float32Array.of(NaN, 0, 0)}), 'range');
});

test('createMeshes: one mesh per colored group with shared PbrMaterials (mock engine)', async () => {
  const created = [];
  const engine = {createMesh(parent) {const mesh = {parent, name: '', disposed: false, setGeometry(g) {this.geometry = g; return this;}, setMaterial(m) {this.material = m; return this;}, dispose() {this.disposed = true;}}; created.push(mesh); return mesh;}};
  const items = '<item objectid="2"/><item objectid="1"/>';
  const result = await parse3MF(package3MF(modelXML({items})));
  const meshes = createMeshes(engine, result, {color: '#808080'});
  assert.equal(meshes.meshes.length, 4);
  assert.equal(meshes.materials.length, 4);
  const linear = v => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  closeArray(meshes.meshes[0].material.data.subarray(0, 3), [1, 0, 0], 1e-6, 'red');
  closeArray(meshes.meshes[3].material.data.subarray(0, 3), [0x80, 0x80, 0x80].map(v => linear(v / 255)), 1e-6, 'fallback');
  assert.equal(meshes.meshes[0].name, 'colored');
  const merged = createMeshes(engine, result, {merge: true});
  assert.equal(merged.meshes.length, 1); assert.equal(merged.geometries[0].indices.length, result.indices.length);
  const cube = parsePLY(writePLY('ascii', plyCube().elements)), colored = createMeshes(engine, cube);
  const expected = [0, 1, 2].map(a => [...cube.indices].reduce((sum, i) => sum + linear(((i * 30 + a * 7) % 256) / 255), 0) / cube.indices.length);
  closeArray(colored.meshes[0].material.data.subarray(0, 3), expected, 1e-5, 'average vertex color');
  const cloud = createMeshes(engine, parseXYZ(text('0 0 0\n1 1 1\n')), {size: 0.1});
  assert.equal(cloud.geometries[0].vertices.length / 6, 12);
  meshes.dispose();
  assert.ok(meshes.meshes.every(m => m.disposed));
  assert.throws(() => createMeshes({}, result), LoaderError);
});

test('detectFormat and parseAny', async () => {
  assert.equal(detectFormat(writePLY('ascii', plyCube().elements)), 'ply');
  assert.equal(detectFormat(package3MF(modelXML({items: '<item objectid="1"/>'}))), '3mf');
  assert.equal(detectFormat(writePCD('binary', pcdPoints(3))), 'pcd');
  assert.equal(detectFormat(vtkAscii()), 'vtk');
  assert.equal(detectFormat(text('# x\nCOFF\n')), 'off');
  assert.equal(detectFormat(text('1 2 3\n')), 'xyz');
  assert.equal(detectFormat(text('hello'), 'scan.PTS'), 'xyz');
  assert.equal(detectFormat(text('\0\0garbage')), null);
  assert.equal((await parseAny(vtkBinary())).indices.length, 15);
  assert.equal((await parseAny(package3MF(modelXML({items: '<item objectid="1"/>'})))).indices.length, 12);
  await rejectsAsync(parseAny(text('\0\0garbage'), {name: 'x.bin'}), 'unsupported');
});

test('fetchBytes and load: size limits (declared and streamed), abort, HTTP errors', async () => {
  const body = writePLY('binary_little_endian', plyCube().elements);
  const server = createServer((request, response) => {
    if (request.url === '/cube.ply') {response.writeHead(200, {'content-length': body.length}); response.end(body); return;}
    if (request.url === '/chunked') {response.writeHead(200); response.write(new Uint8Array(4000)); response.write(new Uint8Array(4000)); response.end(); return;}
    if (request.url === '/slow') {response.writeHead(200); response.write(new Uint8Array(10)); return;}
    response.writeHead(404); response.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    checkPLYCube(await load(`${base}/cube.ply`, parsePLY));
    assert.equal((await fetchBytes(`${base}/chunked`)).length, 8000);
    await rejectsAsync(fetchBytes(`${base}/cube.ply`, {maxBytes: 100}), 'limit', /response is/);
    await rejectsAsync(fetchBytes(`${base}/chunked`, {maxBytes: 5000}), 'limit', /exceeds/);
    await rejectsAsync(load(`${base}/cube.ply`, parsePLY, {maxVertices: 2}), 'limit');
    await rejectsAsync(fetchBytes(`${base}/missing`), 'fetch', /404/);
    const controller = new AbortController();
    const pending = fetchBytes(`${base}/slow`, {signal: controller.signal});
    setTimeout(() => controller.abort(), 50);
    await rejectsAsync(pending, 'aborted');
    const aborted = new AbortController(); aborted.abort();
    await rejectsAsync(fetchBytes(`${base}/cube.ply`, {signal: aborted.signal}), 'aborted');
    await rejectsAsync(fetchBytes('http://127.0.0.1:1/nothing'), 'fetch');
  } finally {
    server.closeAllConnections(); server.close();
  }
});

test('SSR safety: importing and parsing never touches window, document, navigator or Worker', () => {
  const script = `
    for (const name of ['window', 'document', 'navigator', 'Worker', 'self', 'requestAnimationFrame'])
      Object.defineProperty(globalThis, name, {configurable: true, get() {throw new Error('touched ' + name);}});
    const loaders = await import(${JSON.stringify(new URL('../dist/index.js', import.meta.url).href)});
    const result = loaders.parseOFF(new TextEncoder().encode('OFF\\n3 1 0\\n0 0 0\\n1 0 0\\n0 1 0\\n3 0 1 2\\n'));
    loaders.toGeometry(result);
    console.log('ok', Object.keys(loaders).length);`;
  const output = execFileSync(process.execPath, ['--input-type=module', '-e', script], {encoding: 'utf8'});
  assert.match(output, /^ok \d+/);
});
