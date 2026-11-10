// Voxel file readers and writers, against bytes built here from the formats' public descriptions.
import assert from 'node:assert/strict';
import test from 'node:test';
import { cellIndex } from '../dist/index.js';
import { parseBinvox, parseKVX, parseQB, parseQEF, parseVXL, writeQB, writeQEF } from '../dist/formats.js';

const u32s = (...values) => new Uint8Array(Uint32Array.from(values.map((v) => v >>> 0)).buffer);
const join = (...parts) => {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
};
const paint = (r, g, b, a = 255) => r + g * 256 + b * 65536 + a * 16777216;
const colorAt = (file, model, x, y, z) => {
  const { grid } = file.models[model],
    index = grid.voxels[cellIndex(grid.size, x, y, z)];
  return [...file.palette.subarray(index * 4, index * 4 + 4)];
};
const qbHead = ({ format = 0, z = 1, compressed = 0, mask = 0, count = 1 } = {}) =>
  join(u32s(0x101, format, z, compressed, mask, count));
const matrix = (name, size, position) =>
  join(Uint8Array.of(name.length), new TextEncoder().encode(name), u32s(...size, ...position));

test('QB: cells land where the layout says, in a right-handed file', () => {
  const size = [2, 3, 4],
    cells = new Uint32Array(24);
  // file order: z slowest, then y, then x.
  cells[1 + 2 * 2 + 3 * 2 * 3] = paint(10, 20, 30);
  const file = parseQB(join(qbHead(), matrix('Arm', size, [5, 6, 7]), new Uint8Array(cells.buffer)));
  assert.equal(file.models[0].name, 'Arm');
  assert.deepEqual(file.models[0].position, [5, 6, 7]);
  assert.deepEqual(file.models[0].grid.size, [2, 3, 4]);
  assert.deepEqual(colorAt(file, 0, 1, 2, 3), [10, 20, 30, 255]);
  assert.equal(file.models[0].grid.voxels.filter(Boolean).length, 1);
  assert.equal(file.colorsReduced, false);
});

test('QB: a left-handed file mirrors z, cells and position', () => {
  const cells = new Uint32Array(24);
  cells[1 + 2 * 2 + 3 * 2 * 3] = paint(10, 20, 30);
  const file = parseQB(join(qbHead({ z: 0 }), matrix('M', [2, 3, 4], [0, 0, 1]), new Uint8Array(cells.buffer)));
  assert.deepEqual(colorAt(file, 0, 1, 2, 0), [10, 20, 30, 255]);
  assert.deepEqual(file.models[0].position, [0, 0, -5]);
});

test('QB: BGRA byte order and the visibility mask', () => {
  const cells = u32s(paint(30, 20, 10, 255), paint(1, 2, 3, 0), paint(30, 20, 10, 66));
  const file = parseQB(join(qbHead({ format: 1, mask: 1 }), matrix('M', [3, 1, 1], [0, 0, 0]), cells));
  assert.deepEqual(colorAt(file, 0, 0, 0, 0), [10, 20, 30, 255]);
  assert.equal(file.models[0].grid.voxels[1], 0, 'mask 0 is hidden');
  assert.deepEqual(colorAt(file, 0, 2, 0, 0), [10, 20, 30, 255], 'any other mask shows the colour');
});

test('QB: RLE slices decode, runs and single values alike', () => {
  const red = paint(255, 0, 0),
    blue = paint(0, 0, 255);
  const words = u32s(2, 3, red, blue, 6, /* second slice */ blue, 2, 3, red, 6);
  const file = parseQB(join(qbHead({ compressed: 1 }), matrix('M', [2, 2, 2], [0, 0, 0]), words));
  assert.deepEqual(colorAt(file, 0, 1, 1, 0), [0, 0, 255, 255]);
  assert.deepEqual(colorAt(file, 0, 0, 0, 0), [255, 0, 0, 255]);
  assert.deepEqual(colorAt(file, 0, 0, 0, 1), [0, 0, 255, 255]);
  assert.deepEqual(colorAt(file, 0, 1, 1, 1), [255, 0, 0, 255]);
});

test('QB round trip keeps every voxel colour, in every option', () => {
  const palette = new Uint8Array(1024);
  palette.set([200, 100, 50, 255], 4);
  palette.set([1, 2, 3, 128], 8);
  const voxels = new Uint8Array(24);
  voxels[cellIndex([2, 3, 4], 1, 2, 3)] = 1;
  voxels[cellIndex([2, 3, 4], 0, 0, 0)] = 2;
  voxels[cellIndex([2, 3, 4], 1, 0, 0)] = 2;
  const model = { name: 'Body', position: [1, 2, 3], grid: { size: [2, 3, 4], voxels } };
  for (const colorFormat of ['rgba', 'bgra'])
    for (const zAxis of ['left', 'right'])
      for (const compressed of [false, true]) {
        const file = parseQB(writeQB(model, palette, { colorFormat, zAxis, compressed })),
          out = file.models[0];
        assert.equal(out.name, 'Body');
        assert.deepEqual(out.position, [1, 2, 3], `${colorFormat} ${zAxis} ${compressed}`);
        assert.deepEqual(out.grid.size, [2, 3, 4]);
        assert.deepEqual(colorAt(file, 0, 1, 2, 3), [200, 100, 50, 255]);
        assert.deepEqual(colorAt(file, 0, 0, 0, 0), [1, 2, 3, 128]);
        assert.equal(out.grid.voxels.filter(Boolean).length, 3);
      }
});

test('QB: over 255 colours coarsen the palette and say so', () => {
  const cells = new Uint32Array(300);
  for (let i = 0; i < 300; i++) cells[i] = paint(i & 255, i >> 8, 7);
  const file = parseQB(join(qbHead(), matrix('M', [300, 1, 1], [0, 0, 0]), new Uint8Array(cells.buffer)));
  assert.equal(file.colorsReduced, true);
  assert.ok(file.models[0].grid.voxels.every(Boolean), 'no cell lost');
  const [r] = colorAt(file, 0, 10, 0, 0);
  assert.ok(Math.abs(r - 10) <= 4, `red ${r} stays near 10`);
});

test('QB limits: cut-off files, slices that overrun, cell and matrix budgets', () => {
  const whole = join(qbHead(), matrix('M', [2, 2, 2], [0, 0, 0]), new Uint8Array(32));
  assert.throws(() => parseQB(whole.subarray(0, whole.length - 1)), /ends early/);
  assert.throws(() => parseQB(whole.subarray(0, 10)), /ends early/);
  assert.throws(() => parseQB(whole, { maxCells: 7 }), /maxCells/);
  assert.throws(() => parseQB(qbHead({ count: 5000 })), /over 4096/);
  assert.throws(
    () => parseQB(join(qbHead({ compressed: 1 }), matrix('M', [1, 1, 1], [0, 0, 0]), u32s(2, 2, paint(1, 1, 1), 6))),
    /past its slice/,
  );
  assert.throws(() => parseQB('nope'), TypeError);
  const palette = new Uint8Array(1024);
  assert.throws(
    () => writeQB({ position: [0, 0, 0], grid: { size: [1, 1, 1], voxels: new Uint8Array(1) } }, new Uint8Array(4)),
    /1024/,
  );
  assert.throws(
    () => writeQB({ position: [0, 0, 0], grid: { size: [1, 1, 1], voxels: Uint8Array.of(9) } }, palette),
    /alpha 0/,
  );
});

test('QEF: reads colours, voxels and masks, as the format lists them', () => {
  const text = [
    'Qubicle Exchange Format',
    'Version 0.2',
    'www.minddesk.com',
    '2 3 4',
    '2',
    '1 0 0',
    '0 0.2 1',
    '1 2 3 0 126',
    '0 0 0 1 1',
    '1 0 0 1 0',
  ].join('\r\n');
  const file = parseQEF(text);
  assert.deepEqual(file.models[0].grid.size, [2, 3, 4]);
  assert.deepEqual(colorAt(file, 0, 1, 2, 3), [255, 0, 0, 255]);
  assert.deepEqual(colorAt(file, 0, 0, 0, 0), [0, 51, 255, 255]);
  assert.equal(file.models[0].grid.voxels[cellIndex([2, 3, 4], 1, 0, 0)], 0, 'mask 0 is hidden');
  assert.deepEqual(parseQEF(new TextEncoder().encode(text)).models[0].grid.size, [2, 3, 4]);
});

test('QEF round trip keeps every voxel colour', () => {
  const palette = new Uint8Array(1024);
  palette.set([200, 100, 50, 255], 4 * 7);
  palette.set([0, 255, 1, 255], 4 * 200);
  const size = [3, 2, 2],
    voxels = new Uint8Array(12);
  voxels[cellIndex(size, 2, 1, 1)] = 7;
  voxels[cellIndex(size, 0, 0, 1)] = 200;
  voxels[cellIndex(size, 1, 0, 1)] = 7;
  const text = writeQEF({ size, voxels }, palette),
    file = parseQEF(text);
  assert.match(text, /^Qubicle Exchange Format\nVersion 0\.2\n/);
  assert.deepEqual(file.models[0].grid.size, size);
  assert.deepEqual(colorAt(file, 0, 2, 1, 1), [200, 100, 50, 255]);
  assert.deepEqual(colorAt(file, 0, 0, 0, 1), [0, 255, 1, 255]);
  assert.deepEqual(colorAt(file, 0, 1, 0, 1), [200, 100, 50, 255]);
  assert.equal(file.models[0].grid.voxels.filter(Boolean).length, 3);
});

test('QEF limits', () => {
  const head = ['Qubicle Exchange Format', 'Version 0.2', 'x', '1 1 1', '1', '1 1 1'];
  assert.throws(() => parseQEF('hello'), TypeError);
  assert.throws(() => parseQEF([...head, '4 0 0 0 1'].join('\n')), /outside/);
  assert.throws(() => parseQEF([...head, '0 0 0 3 1'].join('\n')), /outside/);
  assert.throws(() => parseQEF([...head.slice(0, 3), 'a b c'].join('\n')), /damaged/);
  assert.throws(() => parseQEF([...head.slice(0, 3), '4 4 4', '0'].join('\n'), { maxCells: 8 }), /maxCells/);
  assert.throws(() => parseQEF([...head.slice(0, 4), '99999', '1 1 1'].join('\n')), /colour count/);
});

test('binvox: order is x slowest, then z, y fastest, on a box of three different sizes', () => {
  const size = [2, 3, 4],
    want = [
      [0, 0, 0],
      [1, 2, 3],
    ];
  // Index of (x, y, z) in file order, y fastest: x * (sz * sy) + z * sy + y.
  const order = (x, y, z) => x * (4 * 3) + z * 3 + y;
  const header = '#binvox 1\ndim 2 3 4\ntranslate 1 2 3\nscale 0.5\ndata\n',
    runs = [1, 1, 0, order(1, 2, 3) - 1, 1, 1];
  assert.equal(order(1, 2, 3), 23);
  const file = parseBinvox(join(new TextEncoder().encode(header), Uint8Array.from(runs)));
  assert.deepEqual(file.models[0].grid.size, size);
  assert.deepEqual(file.translate, [1, 2, 3]);
  assert.equal(file.scale, 0.5);
  for (const [x, y, z] of want) assert.deepEqual(colorAt(file, 0, x, y, z), [255, 255, 255, 255]);
  assert.equal(file.models[0].grid.voxels.filter(Boolean).length, 2);
});

test('binvox limits', () => {
  const head = new TextEncoder().encode('#binvox 1\ndim 2 2 2\ndata\n');
  assert.throws(() => parseBinvox(new TextEncoder().encode('# nope\n')), TypeError);
  assert.throws(() => parseBinvox(new TextEncoder().encode('#binvox 1\n')), /ends early/);
  assert.throws(() => parseBinvox(new TextEncoder().encode('#binvox 1\ndata\n')), /dim/);
  assert.throws(() => parseBinvox(join(head, Uint8Array.of(1, 4))), /ends early/);
  assert.throws(() => parseBinvox(join(head, Uint8Array.of(1, 9))), /run outside/);
  assert.throws(() => parseBinvox(join(head, Uint8Array.of(1, 0))), /run outside/);
  assert.throws(() => parseBinvox(join(head, Uint8Array.of(1, 8)), { maxCells: 7 }), /maxCells/);
});

test('binvox version 2 (binvox_merge): voxel values 1 to 255 are kept as palette indices, not refused', () => {
  // Batch 132 audit: the spec lets a version 2 file store any value above 0 up to 255; the reader threw on 2 and up.
  const head = new TextEncoder().encode('#binvox 2\ndim 2 2 2\ndata\n');
  const file = parseBinvox(join(head, Uint8Array.of(0, 2, 2, 3, 255, 2, 1, 1)));
  assert.deepEqual([...file.models[0].grid.voxels].sort((a, b) => a - b), [0, 0, 1, 2, 2, 2, 255, 255]);
  assert.deepEqual([...file.palette.subarray(255 * 4, 256 * 4)], [255, 255, 255, 255]);
  assert.deepEqual([...file.palette.subarray(0, 4)], [0, 0, 0, 0], 'index 0 stays air');
});

/** A KVX with one slab per listed column: [x, y, top, colors]. */
function kvx(size, slabs, pivot = [0, 0, 0]) {
  const [sx, sy, sz] = size,
    columns = Array.from({ length: sx }, (_, x) =>
      Array.from({ length: sy }, (_, y) => slabs.filter((s) => s[0] === x && s[1] === y)),
    ),
    xyBytes = sx * (sy + 1) * 2,
    offsets = [],
    xy = new Uint16Array(sx * (sy + 1)),
    body = [];
  let base = (sx + 1) * 4 + xyBytes;
  for (let x = 0; x < sx; x++) {
    offsets.push(base);
    let inColumn = 0;
    for (let y = 0; y < sy; y++) {
      xy[x * (sy + 1) + y] = inColumn;
      for (const [, , top, colors] of columns[x][y]) {
        body.push(top, colors.length, 0, ...colors);
        inColumn += 3 + colors.length;
      }
    }
    xy[x * (sy + 1) + sy] = inColumn;
    base += inColumn;
  }
  offsets.push(base);
  const rest = join(
      u32s(sx, sy, sz, pivot[0] * 256, pivot[1] * 256, pivot[2] * 256),
      u32s(...offsets),
      new Uint8Array(xy.buffer),
      Uint8Array.from(body),
    ),
    palette = new Uint8Array(768);
  palette.set([63, 0, 0], 5 * 3);
  palette.set([0, 63, 21], 6 * 3);
  return join(u32s(rest.length), rest, palette);
}

test('KVX: slabs land by the format layout: z down becomes Y up, y becomes z, colours from 6 bit', () => {
  const file = parseKVX(kvx([2, 3, 4], [[1, 2, 0, [5, 6]]], [1, 0.5, 2]));
  assert.deepEqual(file.models[0].grid.size, [2, 4, 3]);
  assert.deepEqual(colorAt(file, 0, 1, 3, 2), [255, 0, 0, 255], 'top of the slab, z 0, is the highest cell');
  assert.deepEqual(colorAt(file, 0, 1, 2, 2), [0, 255, 85, 255]);
  assert.equal(file.models[0].grid.voxels.filter(Boolean).length, 2);
  assert.deepEqual(file.pivot, [1, 2, 0.5]);
});

test('KVX: colour 255, the transparent one, is air; several slabs per column', () => {
  const file = parseKVX(
    kvx(
      [1, 1, 8],
      [
        [0, 0, 0, [255, 5]],
        [0, 0, 5, [6]],
      ],
    ),
  );
  assert.equal(file.models[0].grid.voxels.filter(Boolean).length, 2);
  assert.deepEqual(colorAt(file, 0, 0, 6, 0), [255, 0, 0, 255]);
  assert.deepEqual(colorAt(file, 0, 0, 2, 0), [0, 255, 85, 255]);
});

test('KVX limits', () => {
  const whole = kvx([2, 2, 2], [[0, 0, 0, [1]]]);
  assert.throws(() => parseKVX(whole.subarray(0, 100)), /ends early|damaged/);
  assert.throws(() => parseKVX(whole, { maxCells: 7 }), /maxCells/);
  assert.throws(() => parseKVX(kvx([1, 1, 1], [[0, 0, 0, [1, 2]]])), /outside its column/);
  const bad = whole.slice();
  new DataView(bad.buffer).setInt32(4, 0, true);
  assert.throws(() => parseKVX(bad), /damaged/);
});

/** One VXL span: next-span length, top start, top end, air start, then BGRA colours. */
const span = (next, start, end, air, colors = []) => Uint8Array.from([next, start, end, air, ...colors.flat()]);
const bgr = (r, g, b) => [b, g, r, 255];

test('VXL: a bare column list: air, top colours, unseen solid cells, bottom colours, a gap, ground', () => {
  const red = bgr(255, 0, 0),
    green = bgr(0, 255, 0),
    blue = bgr(0, 0, 255),
    grey = bgr(9, 9, 9),
    // Column (1, 0): air 0-1, red at 2, solid 3, green at 4, air 5-6, blue at 7 then solid down to 9.
    target = join(span(3, 2, 2, 0, [red, green]), span(0, 7, 7, 5, [blue])),
    // Every other column: all ground, a colour on top.
    plain = span(0, 0, 0, 0, [grey]),
    file = parseVXL(join(plain, target), { size: [2, 1, 10] }),
    { grid } = file.models[0],
    at = (z) => colorAt(file, 0, 1, 9 - z, 0);
  assert.deepEqual(grid.size, [2, 10, 1]);
  assert.equal(grid.voxels[cellIndex(grid.size, 1, 9, 0)], 0, 'z 0 is air');
  assert.equal(grid.voxels[cellIndex(grid.size, 1, 8, 0)], 0, 'z 1 is air');
  assert.deepEqual(at(2), [255, 0, 0, 255]);
  assert.deepEqual(at(3), [255, 0, 0, 255], 'unseen solid takes the colour above');
  assert.deepEqual(at(4), [0, 255, 0, 255]);
  assert.equal(grid.voxels[cellIndex(grid.size, 1, 4, 0)], 0, 'z 5 is air');
  assert.equal(grid.voxels[cellIndex(grid.size, 1, 3, 0)], 0, 'z 6 is air');
  assert.deepEqual(at(7), [0, 0, 255, 255]);
  assert.deepEqual(at(9), [0, 0, 255, 255], 'solid down to the bottom');
  assert.deepEqual(colorAt(file, 0, 0, 9, 0), [9, 9, 9, 255]);
});

test('VXL: the headed form takes its size from the file', () => {
  const head = new Uint8Array(112);
  new DataView(head.buffer).setUint32(0, 0x09072000, true);
  head.set(u32s(1, 1, 2), 4);
  const file = parseVXL(join(head, span(0, 1, 1, 0, [bgr(1, 2, 3)]), new Uint8Array(40)));
  assert.deepEqual(file.models[0].grid.size, [1, 2, 1]);
  assert.deepEqual(colorAt(file, 0, 0, 0, 0), [1, 2, 3, 255]);
  assert.equal(file.models[0].grid.voxels[cellIndex([1, 2, 1], 0, 1, 0)], 0);
});

test('VXL limits: cut off, wrong size, cells outside, budget', () => {
  const one = span(0, 0, 0, 0, [bgr(1, 2, 3)]);
  assert.throws(() => parseVXL(one, { size: [2, 1, 1] }), /ends early/);
  assert.throws(() => parseVXL(join(one, one), { size: [1, 1, 1] }), /does not fit/);
  assert.throws(() => parseVXL(span(0, 3, 3, 0, [bgr(1, 2, 3)]), { size: [1, 1, 2] }), /outside the model/);
  assert.throws(() => parseVXL(span(0, 3, 1, 0), { size: [1, 1, 8] }), /ends before it starts/);
  assert.throws(() => parseVXL(one), /ends early/, 'default size is the full 512 x 512 x 64 map');
  assert.throws(() => parseVXL(one, { size: [64, 64, 64], maxCells: 8 }), /maxCells/);
});
