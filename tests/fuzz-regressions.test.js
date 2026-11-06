// Launch gate 11a: one regression per fuzzer finding in the asset parsers (scripts/fuzz/targets-assets.js).
// Each hostile input, minimized, must now end in a named error
// quickly (a generous 10 s bound: these were hangs) and without allocating far beyond its size; valid inputs nearby still parse.
import test from 'node:test';
import assert from 'node:assert/strict';
import { cpuTimer } from '../scripts/support/cpu-budget.mjs';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { deflateSync } from 'node:zlib';
import {
  LoaderError,
  parse3MF,
  parseOFF,
  parsePCD,
  parsePLY,
  parseUSDA,
  readZipDirectory,
  readZipEntry,
} from '../packages/loaders/dist/index.js';
import { convertFBX } from '../packages/fbx/dist/index.js';
import { parseUSDA as usdzUSDA, parseUSDC, parseUSDZ } from '../packages/usdz/dist/index.js';
import { V, writeCrate } from '../packages/usdz/tests/crate-writer.js';
import { zip } from '../scripts/fuzz/targets-assets.js';

const root = resolve(import.meta.dirname, '..'),
  text = (s) => new TextEncoder().encode(s);
/** Throws a LoaderError with `code`, and allocates at most `maxMiB` while doing it. */
async function loaderError(run, code, maxMiB = 16) {
  globalThis.gc?.();
  const before = process.memoryUsage().arrayBuffers;
  await assert.rejects(
    async () => run(),
    (e) => e instanceof LoaderError && e.code === code,
  );
  assert.ok(process.memoryUsage().arrayBuffers - before < maxMiB * 2 ** 20, 'allocated before validating');
}
const quick = async (label, run, ms = 600) => {
  const cpu = cpuTimer();
  await run();
  const took = cpu();
  assert.ok(took < ms, `${label} took ${took} ms of CPU`);
};

test('PLY and OFF: a short body cannot claim millions of elements (allocation before validation)', async () => {
  // Found: 336 MiB allocated for a 314 B header claiming 8,000,000 vertices with normals, colors and UVs.
  const header = (format) =>
    `ply\nformat ${format} 1.0\nelement vertex 8000000\nproperty float x\nproperty float y\nproperty float z\nproperty float nx\nproperty float ny\nproperty float nz\nelement face 16000000\nproperty list uchar int vertex_indices\nend_header\n0 0 0\n`;
  for (const format of ['ascii', 'binary_little_endian', 'binary_big_endian'])
    await loaderError(() => parsePLY(text(header(format))), 'truncated');
  await loaderError(() => parseOFF(text('OFF\n8000000 16000000 0\n0 0 0\n')), 'truncated');
  assert.equal(
    parsePLY(
      text(
        header('ascii')
          .replace(/8000000|16000000/g, '1')
          .replace('0 0 0\n', '0 0 0 0 0 1\n0 0 0\n'),
      ),
    ).positions.length,
    3,
  );
});

test('PCD: POINTS and LZF sizes are checked against the body before allocating', async () => {
  // Found: 183 MiB for a 167 B binary_compressed file (8,000,000 points, a tiny LZF stream).
  const pcd = (data, points, sizes) => {
    const head = text(
      `VERSION .7\nFIELDS x y z\nSIZE 4 4 4\nTYPE F F F\nCOUNT 1 1 1\nWIDTH ${points}\nHEIGHT 1\nPOINTS ${points}\nDATA ${data}\n`,
    );
    const out = new Uint8Array(head.length + 48);
    out.set(head);
    if (sizes) new DataView(out.buffer).setUint32(head.length, sizes[0], true);
    if (sizes) new DataView(out.buffer).setUint32(head.length + 4, sizes[1], true);
    return out;
  };
  await loaderError(() => parsePCD(pcd('binary_compressed', 8_000_000, [36, 96_000_000])), 'truncated');
  await loaderError(() => parsePCD(pcd('binary_compressed', 3, [0, 36])), 'range'); // 0 LZF bytes cannot make 36
  await loaderError(() => parsePCD(pcd('binary', 8_000_000)), 'truncated');
  await loaderError(() => parsePCD(pcd('ascii', 8_000_000)), 'truncated');
});

test('USDA: bad string escapes are LoaderError syntax errors, not JSON SyntaxErrors', async () => {
  // Found: SyntaxError from JSON.parse for `( """doc""" )` metadata and quoted prim names with bad escapes.
  for (const usda of [
    '#usda 1.0\n(\n    """doc"""\n)\n',
    '#usda 1.0\n(\n    "\\q"\n)\n',
    '#usda 1.0\ndef "\\u12" {\n}\n',
  ])
    await loaderError(() => parseUSDA(text(usda)), /"""doc"""/.test(usda) ? 'unsupported' : 'syntax');
  assert.throws(() => usdzUSDA(text('#usda 1.0\ndef "\\q" {\n}\n')), /USD: invalid string escape|LoaderError|syntax/);
});

test('3MF: component fan-out is bounded in instances, not only in depth', async () => {
  // Found: hang. 30 levels that each reference the next object 64 times expand to 64^30 empty instances.
  const objects = Array.from(
    { length: 30 },
    (_, level) =>
      `<object id="${level + 1}"><components>${`<component objectid="${level + 2}"/>`.repeat(64)}</components></object>`,
  );
  const model = `<?xml version="1.0"?><model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources>${objects.join('')}<object id="31"><mesh><vertices/><triangles/></mesh></object></resources><build><item objectid="1"/></build></model>`;
  await quick('3MF fan-out', () =>
    loaderError(() => parse3MF(zip([{ name: '3D/3dmodel.model', data: text(model), method: 8 }])), 'limit'),
  );
});

test('ZIP: a deflate bomb or a lying declared size is refused before inflating', async () => {
  // Found: 76 MiB for a 65 KB USDZ (64 MiB of zeros deflated) and 512 MiB declared sizes allocated up front.
  const bomb = zip([{ name: '3D/3dmodel.model', data: new Uint8Array(64 << 20), method: 8 }]);
  await loaderError(() => parse3MF(bomb), 'limit', 8);
  await assert.rejects(parseUSDZ(bomb), (e) => e instanceof LoaderError && e.code === 'limit');
  const lying = zip([{ name: 'a', data: text('x'), method: 8, size: 0x1fffffff }]);
  await loaderError(() => readZipEntry(lying, readZipDirectory(lying)[0]), 'limit', 8);
  // A big entry that compresses 10x (packages/loaders/tests/fixtures/gears.3mf) still reads; maxRatio raises the limit.
  const plain = zip([{ name: 'a', data: new Uint8Array(4 << 20), method: 8 }]);
  assert.equal((await readZipEntry(plain, readZipDirectory(plain)[0], { maxRatio: 10_000 })).length, 4 << 20);
});

test('FBX: truncated scalar properties and corrupt zlib arrays are FBX errors (no unhandled rejection)', async () => {
  // Found: a 'Y' (int16) property read past the end ("Offset is outside the bounds of the DataView") and
  // DecompressionStream's own TypeError, raised unhandled when a later record failed first.
  const head = new Uint8Array(27);
  head.set(text('Kaydara FBX Binary  \0\x1a\0'));
  new DataView(head.buffer).setUint32(23, 7400, true);
  const record = (props, end) => {
    const out = new Uint8Array(13 + 1 + props.length);
    const view = new DataView(out.buffer);
    view.setUint32(0, end, true);
    view.setUint32(4, 1, true);
    view.setUint32(8, props.length, true);
    out[12] = 1;
    out[13] = 65;
    out.set(props, 14);
    return out;
  };
  // The file ends right after the 'Y' type code: its two value bytes are missing.
  await assert.rejects(convertFBX(new Uint8Array([...head, ...record([89], 27 + 15)])), /FBX.*truncated/);
  const pad = new Uint8Array(32);
  // 'd' array, zlib-encoded, with garbage instead of zlib data.
  const array = new Uint8Array(1 + 12 + 8);
  array[0] = 100;
  new DataView(array.buffer).setUint32(1, 1, true);
  new DataView(array.buffer).setUint32(5, 1, true);
  new DataView(array.buffer).setUint32(9, 8, true);
  array.fill(0xab, 13);
  const corrupt = new Uint8Array([...head, ...record(array, 27 + 13 + 1 + array.length), ...pad]);
  let unhandled = null;
  const listener = (e) => (unhandled = e);
  process.on('unhandledRejection', listener);
  await assert.rejects(convertFBX(corrupt), /FBX.*(compressed|[Dd]eflate|corrupt)/);
  // fixed-wait: an unhandled rejection, if any, is reported within this time; this checks that none comes
  await new Promise((r) => setTimeout(r, 50));
  process.off('unhandledRejection', listener);
  assert.equal(unhandled, null);
  // A valid zlib array still decodes.
  const values = new Uint8Array(new Float64Array([1, 2, 3]).buffer),
    packed = deflateSync(values),
    good = new Uint8Array(13 + packed.length);
  good[0] = 100;
  new DataView(good.buffer).setUint32(1, 3, true);
  new DataView(good.buffer).setUint32(5, 1, true);
  new DataView(good.buffer).setUint32(9, packed.length, true);
  good.set(packed, 13);
  await assert.rejects(
    convertFBX(new Uint8Array([...head, ...record(good, 27 + 14 + good.length), ...pad])),
    /FBX has no mesh geometry/,
  );
});

test('FBX ASCII: large arrays parse in linear time under the decoded budget', async () => {
  // Found: 4.6 s for a 16 MB "a: 0,0,0,..." array (split + map of 8 million strings).
  const values = '0,'.repeat(4_000_000);
  const fbx = text(
    `; FBX 7.4.0 project file\nFBXHeaderExtension:  {\n\tFBXVersion: 7400\n}\nObjects:  {\n\tGeometry: 1, "Geometry::g", "Mesh" {\n\t\tVertices: *1 {\n\t\t\ta: ${values}0\n\t\t}\n\t}\n}\n`,
  );
  await quick('ASCII FBX array', () => assert.rejects(convertFBX(fbx), /FBX/));
});

test('USDC: hostile path jump tables, deep paths and non-UTF-8 USDA are USD errors', async () => {
  // Found by review, confirmed by the crate generator: jumps that revisit entries walk subtrees 2^n times.
  const specs = [{ path: '/', type: 7, fields: {} }];
  let path = '';
  for (let i = 0; i < 40; i++) specs.push({ path: (path += `/p${i % 3}`), type: 6, fields: {} });
  const exponential = writeCrate(specs, { jumps: (jumps) => jumps.map((j, i) => (i < jumps.length - 1 ? 1 : j)) });
  await quick('crate path jumps', () =>
    assert.throws(() => parseUSDC(exponential, { maxDepth: 64 }), /USD: path jumps revisit entries/),
  );
  assert.throws(() => parseUSDC(writeCrate(specs)), /USD: hierarchy exceeds depth limit/);
  assert.throws(
    () => usdzUSDA(new Uint8Array([0x23, 0x75, 0xff, 0xfe])),
    /^LoaderError: USD: USDA layer is not UTF-8 text$/,
  );
  // Found (fuzzer, iteration 1316 of seed 1): "n is not iterable" for an xformOpOrder stored as a Crate int; a
  // connection stored as an int array reached String.prototype.split.
  const mesh = [
    { path: '/', type: 7, fields: {} },
    { path: '/M', type: 6, fields: { typeName: V.token('Mesh'), xformOpOrder: V.specifier(5) } },
  ];
  assert.throws(() => parseUSDC(writeCrate(mesh)), /^LoaderError: USD: invalid xformOpOrder$/);
  const shader = [
    { path: '/', type: 7, fields: {} },
    { path: '/M', type: 6, fields: { typeName: V.token('Material') } },
    { path: '/M.outputs:surface', type: 1, fields: { connectionPaths: V.intArray([1]) } },
    { path: '/P', type: 6, fields: { typeName: V.token('Mesh') } },
    { path: '/P.material:binding', type: 1, fields: { targetPaths: V.pathList(['/M']) } },
    { path: '/P.points', type: 1, fields: { default: V.vec3fArray([0, 0, 0, 1, 0, 0, 0, 1, 0]) } },
    { path: '/P.faceVertexCounts', type: 1, fields: { default: V.intArray([3]) } },
    { path: '/P.faceVertexIndices', type: 1, fields: { default: V.intArray([0, 1, 2]) } },
    { path: '/P.subdivisionScheme', type: 1, fields: { default: V.token('none') } },
  ];
  assert.throws(() => parseUSDC(writeCrate(shader)), /^LoaderError: USD: invalid relationship target$/);
});

test('USDC: counts read from the file are never preallocated (fuzzer reproducers, 1,706 B each)', async () => {
  // Found (fuzzer, seed 2): 128 MiB and 109 MiB allocated for path, string and LZ4 buffers sized by corrupt counts.
  for (const name of ['usdc-count-128mib.usdc', 'usdc-count-109mib.usdc']) {
    const data = new Uint8Array(readFileSync(join(root, 'tests/fixtures/fuzz', name)));
    globalThis.gc?.();
    const before = process.memoryUsage().heapUsed + process.memoryUsage().arrayBuffers;
    assert.throws(() => parseUSDC(data), /^LoaderError: USD: /);
    const grown = process.memoryUsage().heapUsed + process.memoryUsage().arrayBuffers - before;
    assert.ok(grown < 32 * 2 ** 20, `${name}: ${grown} bytes`);
  }
});

test('USD meshes: the convex polygon check has a total work budget', async () => {
  // Found by review, then measured: 320 faces of 1024 corners (1.3 MB of USDA) took 6.3 s in the quadratic check.
  const n = 1024,
    points = Array.from(
      { length: n },
      (_, i) => `(${Math.cos((2 * Math.PI * i) / n)},${Math.sin((2 * Math.PI * i) / n)},0)`,
    ),
    face = Array.from({ length: n }, (_, i) => i).join(',');
  const usda = `#usda 1.0\ndef Mesh "M" {\n int[] faceVertexCounts = [${Array(320).fill(n).join(',')}]\n int[] faceVertexIndices = [${Array(320).fill(face).join(',')}]\n point3f[] points = [${points.join(',')}]\n uniform token subdivisionScheme = "none"\n}\n`;
  await quick(
    'USD n-gons',
    () => assert.throws(() => usdzUSDA(usda), /USD: polygon validation work exceeds limit/),
    4000,
  );
  assert.equal(
    usdzUSDA(
      usda
        .replace(/\[(1024,){319}1024\]/, '[1024]')
        .replace(/faceVertexIndices = \[.*\]/, `faceVertexIndices = [${face}]`),
    ).meshes.length,
    1,
  );
});

test('FBX: polygon corner count, triangulation work and the vertex budget bound the conversion', async () => {
  // Found by review, then measured: one 100,000-corner polygon ran for over 5 minutes (ear clipping is quadratic:
  // 16,384 corners took 0.76 s), and 3,000,000 faces (here 400,000, still over the 1,000,000-vertex budget) filled the corner lists before the vertex budget was checked.
  const { binary, L } = await import('../packages/fbx/test/fixtures.js');
  const fbx = (n, faces) => {
    const vertices = Array.from({ length: n }, (_, i) => [
      Math.cos((2 * Math.PI * i) / n),
      Math.sin((2 * Math.PI * i) / n),
      0,
    ]).flat();
    const ring = Array.from({ length: n }, (_, i) => (i === n - 1 ? ~i : i));
    const geometry = [
      ['Vertices', [{ array: 'd', values: vertices }]],
      ['PolygonVertexIndex', [{ array: 'i', values: Array(faces).fill(ring).flat() }]],
    ];
    const objects = [
      ['Geometry', [L(1), 'Geometry::G', 'Mesh'], geometry],
      ['Model', [L(2), 'Model::M', 'Mesh']],
    ];
    const connections = [
      ['C', ['OO', L(1), L(2)]],
      ['C', ['OO', L(2), L(0)]],
    ];
    return new Uint8Array(
      binary(
        [
          ['Objects', [], objects],
          ['Connections', [], connections],
        ],
        { compress: true },
      ),
    );
  };
  await quick('FBX 4097-gon', () => assert.rejects(convertFBX(fbx(4097, 1)), /FBX geometry budget exceeded/));
  await quick('FBX n-gons', () => assert.rejects(convertFBX(fbx(4096, 30)), /FBX scene work budget exceeded/));
  await quick('FBX faces', () => assert.rejects(convertFBX(fbx(3, 400_000)), /FBX scene allocation budget exceeded/));
  assert.ok((await convertFBX(fbx(4096, 1))).byteLength > 0);
});
