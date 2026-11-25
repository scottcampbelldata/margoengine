// GAP-FILM-GLTFREPORT: @margoengine/gltf/report reads a GLB without a GPU: counts, world bounds of what the default
// scene draws, extensions, image sizes, problems, and the drawn bounds of cut-out cards by texture alpha. The GLBs are
// written here from the glTF 2.0 layout, so every expected number is worked out from the test's own arrays.
import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { reportGLTF, imageHeader } from '@margoengine/gltf/report';

// A PNG of RGBA8 rows (PNG 2003: signature, IHDR, one IDAT, IEND; CRC-32 per chunk).
function png(width, height, pixel) {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (bytes) => {
    let c = 0xffffffff;
    for (const b of bytes) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    out.write(type, 4, 'latin1');
    data.copy(out, 8);
    out.writeUInt32BE(crc(out.subarray(4, 8 + data.length)), 8 + data.length);
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, 6, 0, 0, 0], 8);
  const raw = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) raw.set(pixel(x, y), y * (1 + width * 4) + 1 + x * 4);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
// A GLB from a document whose accessors and images name `arrays` (typed arrays, or PNG buffers for images).
function glb(doc, arrays) {
  const parts = [],
    views = [];
  let length = 0;
  for (const a of arrays) {
    const bytes = Buffer.from(a.buffer, a.byteOffset, a.byteLength);
    views.push({ buffer: 0, byteOffset: length, byteLength: bytes.length });
    parts.push(bytes, Buffer.alloc((4 - (bytes.length % 4)) % 4));
    length += bytes.length + ((4 - (bytes.length % 4)) % 4);
  }
  const bin = Buffer.concat(parts),
    json = Buffer.from(
      JSON.stringify({ asset: { version: '2.0' }, ...doc, bufferViews: views, buffers: [{ byteLength: bin.length }] }),
    ),
    jsonPad = Buffer.concat([json, Buffer.alloc((4 - (json.length % 4)) % 4, 0x20)]),
    out = Buffer.alloc(12 + 8 + jsonPad.length + 8 + bin.length);
  out.writeUInt32LE(0x46546c67, 0);
  out.writeUInt32LE(2, 4);
  out.writeUInt32LE(out.length, 8);
  out.writeUInt32LE(jsonPad.length, 12);
  out.writeUInt32LE(0x4e4f534a, 16);
  jsonPad.copy(out, 20);
  out.writeUInt32LE(bin.length, 20 + jsonPad.length);
  out.writeUInt32LE(0x004e4942, 24 + jsonPad.length);
  bin.copy(out, 28 + jsonPad.length);
  return new Uint8Array(out);
}
// A unit cube centred on the origin, 24 vertices (flat normals), 12 triangles wound outward (or inward).
function cube(inward = false) {
  const positions = [],
    normals = [],
    indices = [];
  for (const [axis, sign] of [
    [0, 1],
    [0, -1],
    [1, 1],
    [1, -1],
    [2, 1],
    [2, -1],
  ]) {
    const u = (axis + 1) % 3,
      v = (axis + 2) % 3,
      base = positions.length / 3;
    for (const [a, b] of [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ]) {
      const p = [0, 0, 0];
      p[axis] = sign * 0.5;
      p[u] = a * 0.5 * sign;
      p[v] = b * 0.5;
      positions.push(...p);
      const n = [0, 0, 0];
      n[axis] = sign;
      normals.push(...n);
    }
    const quad = [base, base + 1, base + 2, base, base + 2, base + 3];
    indices.push(...(inward ? [quad[0], quad[2], quad[1], quad[3], quad[5], quad[4]] : quad));
  }
  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    indices: new Uint16Array(indices),
  };
}
const accessor = (bufferView, componentType, count, type, extra = {}) => ({
  bufferView,
  componentType,
  count,
  type,
  ...extra,
});

test('a cube drawn by two nodes: counts, world bounds and no problems', async () => {
  const c = cube();
  const bytes = glb(
    {
      scene: 0,
      scenes: [{ nodes: [0, 1] }],
      nodes: [
        { mesh: 0, translation: [0, 0.5, 0] },
        { mesh: 0, translation: [3, 0.5, 0], scale: [2, 2, 2] },
      ],
      meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1 }, indices: 2, material: 0 }] }],
      materials: [{ pbrMetallicRoughness: { baseColorFactor: [1, 0, 0, 1] } }],
      accessors: [
        accessor(0, 5126, 24, 'VEC3', { min: [-0.5, -0.5, -0.5], max: [0.5, 0.5, 0.5] }),
        accessor(1, 5126, 24, 'VEC3'),
        accessor(2, 5123, 36, 'SCALAR'),
      ],
    },
    [c.positions, c.normals, c.indices],
  );
  const r = await reportGLTF(bytes);
  assert.deepEqual(r.problems, []);
  assert.equal(r.ok, true);
  assert.deepEqual(
    [r.counts.triangles, r.counts.vertices, r.counts.primitives, r.counts.meshes, r.counts.nodes, r.counts.materials],
    [24, 48, 2, 1, 2, 1],
  );
  assert.deepEqual(r.bounds.min, [-0.5, -0.5, -1]);
  assert.deepEqual(r.bounds.max, [4, 1.5, 1]);
  assert.deepEqual(r.bounds.size, [4.5, 2, 2]);
});

test('problems: inside-out, no normals, an unsupported required extension, not a glTF', async () => {
  const c = cube(true);
  const bytes = glb(
    {
      extensionsUsed: ['EXT_made_up'],
      extensionsRequired: ['EXT_made_up'],
      nodes: [{ mesh: 0, name: 'box' }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1, material: 0 }] }],
      materials: [{}],
      accessors: [
        accessor(0, 5126, 24, 'VEC3', { min: [-0.5, -0.5, -0.5], max: [0.5, 0.5, 0.5] }),
        accessor(1, 5123, 36, 'SCALAR'),
      ],
    },
    [c.positions, c.indices],
  );
  const r = await reportGLTF(bytes);
  assert.deepEqual(r.extensions, { used: ['EXT_made_up'], required: ['EXT_made_up'], unsupported: ['EXT_made_up'] });
  assert.deepEqual(r.problems.map((p) => p.code).sort(), ['extension', 'inside-out', 'no-normals']);
  assert.equal(r.problems.find((p) => p.code === 'inside-out').where, 'box');
  assert.equal(r.counts.triangles, 12, 'the rest of the file is still read');
  const bad = await reportGLTF(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]));
  assert.equal(bad.ok, false);
  assert.equal(bad.problems[0].code, 'not-gltf');
});

test('a cut-out card: image size from its header, drawn bounds by texture alpha', async () => {
  // A 2 x 2 m card in the XY plane, uv 0..1 across it; only texels with 16 <= x < 48 of 64 are opaque.
  const image = png(64, 32, (x) => [255, 255, 255, x >= 16 && x < 48 ? 255 : 0]);
  const positions = new Float32Array([-1, 0, 0, 1, 0, 0, 1, 2, 0, -1, 2, 0]),
    normals = new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
    uvs = new Float32Array([0, 1, 1, 1, 1, 0, 0, 0]),
    indices = new Uint16Array([0, 1, 2, 0, 2, 3]);
  const bytes = glb(
    {
      nodes: [{ mesh: 0 }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1, TEXCOORD_0: 2 }, indices: 3, material: 0 }] }],
      materials: [{ alphaMode: 'MASK', pbrMetallicRoughness: { baseColorTexture: { index: 0 } }, doubleSided: true }],
      textures: [{ source: 0 }],
      images: [{ bufferView: 4, mimeType: 'image/png' }],
      accessors: [
        accessor(0, 5126, 4, 'VEC3', { min: [-1, 0, 0], max: [1, 2, 0] }),
        accessor(1, 5126, 4, 'VEC3'),
        accessor(2, 5126, 4, 'VEC2'),
        accessor(3, 5123, 6, 'SCALAR'),
      ],
    },
    [positions, normals, uvs, indices, image],
  );
  const plain = await reportGLTF(bytes);
  assert.equal(plain.cutouts, undefined, 'alpha is read only when asked');
  assert.deepEqual(plain.images, [{ index: 0, name: undefined, format: 'png', width: 64, height: 32 }]);
  assert.deepEqual([plain.counts.texturePixels, plain.counts.largestTexture, plain.counts.rgbaBytes], [2048, 64, 8192]);
  const r = await reportGLTF(bytes, { alpha: true });
  assert.deepEqual(r.bounds.min, [-1, 0, 0]);
  assert.equal(r.cutouts.primitives, 1);
  // Opaque texels span u 0.25..0.75, x = -0.5..0.5; samples land within one texel (2 / 64 m) of each edge.
  assert.ok(Math.abs(r.cutouts.bounds.min[0] + 0.5) <= 2 / 64, `min x ${r.cutouts.bounds.min[0]}`);
  assert.ok(Math.abs(r.cutouts.bounds.max[0] - 0.5) <= 2 / 64, `max x ${r.cutouts.bounds.max[0]}`);
  assert.deepEqual([r.cutouts.bounds.min[1], r.cutouts.bounds.max[1]], [0, 2]);
});

test('imageHeader reads PNG, JPEG, WebP and KTX2 sizes', async () => {
  assert.deepEqual(imageHeader(new Uint8Array(png(5, 7, () => [0, 0, 0, 255]))), {
    format: 'png',
    width: 5,
    height: 7,
  });
  // A JPEG start: SOI, APP0 of length 16, SOF0 (precision 8, height 300, width 400).
  const jpeg = new Uint8Array([
    0xff,
    0xd8,
    0xff,
    0xe0,
    0,
    16,
    ...new Array(14).fill(0),
    0xff,
    0xc0,
    0,
    17,
    8,
    1,
    44,
    1,
    144,
    3,
  ]);
  assert.deepEqual(imageHeader(jpeg), { format: 'jpeg', width: 400, height: 300 });
  const vp8x = new Uint8Array(30);
  vp8x.set([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x58]);
  vp8x.set([99, 0, 0, 49, 0, 0], 24);
  assert.deepEqual(imageHeader(vp8x), { format: 'webp', width: 100, height: 50 });
  assert.equal(imageHeader(new Uint8Array(32)), undefined);
});

test('a real file: FourUV.glb reads without a GPU', async () => {
  const bytes = new Uint8Array(await readFile(new URL('./fixtures/uv/FourUV.glb', import.meta.url)));
  const r = await reportGLTF(bytes);
  assert.ok(r.counts.triangles > 0);
  assert.ok(r.bounds && r.bounds.size.every((v) => v >= 0));
  assert.deepEqual(
    r.problems.filter((p) => p.code === 'accessor' || p.code === 'json'),
    [],
  );
});

// KB-GLTFREPORT-MIRROR1, KB-GLTFREPORT-NAN1, GAP-FILM-GLTFREPORT2.
const cubeGlb = (c, nodes, extra = {}) =>
  glb(
    {
      nodes,
      meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1 }, indices: 2, material: 0 }] }],
      materials: [{}],
      accessors: [
        accessor(0, 5126, 24, 'VEC3', { min: [-0.5, -0.5, -0.5], max: [0.5, 0.5, 0.5] }),
        accessor(1, 5126, 24, 'VEC3'),
        accessor(2, 5123, 36, 'SCALAR'),
      ],
      ...extra,
    },
    [c.positions, c.normals, c.indices],
  );

test('a mirroring node (negative determinant) turns the front face too, so an outward box stays outward (glTF 3.7.4)', async () => {
  for (const scale of [
    [-1, 1, 1],
    [1, -1, 1],
    [-1, -1, -1],
  ]) {
    const out = await reportGLTF(cubeGlb(cube(), [{ mesh: 0, name: 'mirrored', scale }]));
    assert.deepEqual(out.problems, [], `outward under scale ${scale}`);
    const inward = await reportGLTF(cubeGlb(cube(true), [{ mesh: 0, name: 'mirrored', scale }]));
    assert.deepEqual(
      inward.problems.map((p) => p.code),
      ['inside-out'],
      `inward under scale ${scale}`,
    );
  }
});

test('a NaN in POSITION is not-finite, naming the primitive and attribute, and the rest is still counted', async () => {
  const c = cube();
  c.positions[0] = NaN;
  const r = await reportGLTF(cubeGlb(c, [{ mesh: 0, name: 'box' }]));
  assert.deepEqual(
    r.problems.map((p) => p.code),
    ['not-finite'],
  );
  assert.equal(r.problems[0].where, 'box');
  assert.match(r.problems[0].detail, /primitive 0 POSITION holds NaN/);
  assert.deepEqual([r.counts.triangles, r.counts.vertices], [12, 24]);
  assert.deepEqual(
    [r.bounds.min, r.bounds.max],
    [
      [-0.5, -0.5, -0.5],
      [0.5, 0.5, 0.5],
    ],
    'the finite vertices still bound it',
  );
});

test('zero-area triangles are listed per scene node with their mesh, not only counted for the file', async () => {
  const flat = cube();
  for (let i = 0; i < 4; i++) flat.positions[i * 3 + 1] = 0; // Face 0 (+x): every corner at y 0, so its 2 triangles have no area.
  const r = await reportGLTF(
    cubeGlb(flat, [
      { mesh: 0, name: 'a' },
      { mesh: 0, name: 'b', translation: [3, 0, 0] },
      { mesh: 0, name: 'c', scale: [2, 2, 2] },
    ]),
  );
  assert.equal(r.counts.zeroArea, 6);
  assert.deepEqual(r.zeroAreaByNode, [
    { node: 0, mesh: 0, where: 'a', zeroArea: 2, triangles: 12 },
    { node: 1, mesh: 0, where: 'b', zeroArea: 2, triangles: 12 },
    { node: 2, mesh: 0, where: 'c', zeroArea: 2, triangles: 12 },
  ]);
  const clean = await reportGLTF(cubeGlb(cube(), [{ mesh: 0 }]));
  assert.deepEqual(clean.zeroAreaByNode, []);
});

// KB-GLTFREPORT-DECODERS: the report built its reader without any way to the Draco decoder, so a Draco file got a
// `decode` problem and its counts and bounds came from the declared accessors.
function dracoBox() {
  const fixture = (name) => readFileSync(new URL(`../../decoders/tests/fixtures/${name}`, import.meta.url));
  const doc = JSON.parse(fixture('Box.gltf').toString('utf8'));
  doc.buffers[0].uri = `data:application/octet-stream;base64,${fixture('Box.bin').toString('base64')}`;
  return JSON.stringify(doc);
}

test('a Draco file is decoded where the report runs, so its bounds come from the vertices', async () => {
  const report = await reportGLTF(dracoBox());
  assert.deepEqual(
    report.problems.filter((p) => p.code === 'decode' || p.code === 'accessor'),
    [],
  );
  assert.equal(report.counts.triangles, 12);
  assert.equal(report.counts.vertices, 24);
  // The accessors declare +-0.5004885; the decoded cube is +-0.5.
  for (const side of report.bounds.size) assert.ok(Math.abs(side - 1) < 1e-4, `side ${side}`);
});

test('the report takes decoder hooks, and a failing one is the decode problem', async () => {
  let calls = 0;
  const report = await reportGLTF(dracoBox(), {
    decoders: {
      draco: {
        decode: async () => {
          calls++;
          throw new Error('no decoder in this host');
        },
      },
    },
  });
  assert.equal(calls, 1);
  assert.ok(report.problems.some((p) => p.code === 'decode' && p.detail.includes('no decoder in this host')));
  assert.equal(report.counts.triangles, 12);
});
