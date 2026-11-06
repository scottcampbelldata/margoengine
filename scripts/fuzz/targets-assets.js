// Fuzz targets for the asset parsers (launch gate 11a): @margoengine/loaders (PLY, PCD, OFF, XYZ, VTK, 3MF, USDA/USDZ),
// fbx, usdz (USDA, USDC, USDZ), net snapshots and the exporters round trip. Seeds are the repo's fixtures plus files the targets build;
// generators add hostile structure (zip bombs, traversal names, cycles, deep nesting, huge counts).
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { checkModel, headless } from './formats.js';
import { bytesOf, concat, isNamed, random } from './harness.js';

const root = resolve(import.meta.dirname, '../..'),
  file = (path) => new Uint8Array(readFileSync(join(root, path))),
  fixtures = (dir, pattern) =>
    readdirSync(join(root, dir))
      .filter((f) => pattern.test(f))
      .map((f) => file(join(dir, f))),
  _text = (bytes) => Buffer.from(bytes).toString('latin1');

// --- builders shared by generators -----------------------------------------------------------------------------

/** A ZIP archive: entries [{name, data, method?, size?, crc?}], 64-byte aligned when `align`. */
export function zip(entries, { align = false } = {}) {
  const parts = [],
    central = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name),
      method = e.method ?? 0,
      body = e.deflated ?? (method === 8 ? deflateRawSync(e.data) : e.data),
      crc = e.crc ?? crc32(e.data);
    let extra = Buffer.alloc(0);
    if (align) {
      const pad = (64 - ((offset + 30 + name.length) % 64)) % 64;
      extra = Buffer.alloc(pad < 4 && pad ? pad + 64 : pad);
      if (extra.length) extra.writeUInt16LE(0xcafe, 0), extra.writeUInt16LE(extra.length - 4, 2);
    }
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(e.size ?? e.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(extra.length, 28);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(method, 10);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(body.length, 20);
    cd.writeUInt32LE(e.size ?? e.data.length, 24);
    cd.writeUInt16LE(name.length, 28);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, name);
    parts.push(local, name, extra, body);
    offset += 30 + name.length + extra.length + body.length;
  }
  const cd = Buffer.concat(central),
    end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...parts, cd, end]));
}
let crcTable;
function crc32(bytes) {
  crcTable ??= Int32Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c;
  });
  let crc = -1;
  for (const b of bytes) crc = crcTable[(crc ^ b) & 255] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}

const TRAVERSAL = [
  '../../evil.model',
  '..\\..\\evil',
  '/etc/passwd',
  'C:\\x.model',
  'a/../../b',
  '3D/%2e%2e/x',
  'a\0b',
];
const hostileName = (r) => r.pick([...TRAVERSAL, 'x'.repeat(r.pick([300, 65535 - 60])), '\u202e.model', '']);

/** Deflate bomb: one entry that inflates to `size` zero bytes from a few KB. */
const bombs = new Map();
const bomb = (r) => {
  const size = r.pick([16 << 20, 64 << 20, 200 << 20]);
  if (!bombs.has(size)) bombs.set(size, deflateRawSync(new Uint8Array(size), { level: 9 }));
  return { data: new Uint8Array(0), deflated: bombs.get(size), size, crc: 0, method: 8 };
};

// --- 3MF ------------------------------------------------------------------------------------------------------------

const rels = (target = '/3D/3dmodel.model') =>
  bytesOf(
    `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="${target}" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>`,
  );
const model = (body, unit = 'millimeter') =>
  bytesOf(
    `<?xml version="1.0" encoding="UTF-8"?><model unit="${unit}" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06">${body}</model>`,
  );
const tetra =
  '<mesh><vertices><vertex x="0" y="0" z="0"/><vertex x="1" y="0" z="0"/><vertex x="0" y="1" z="0"/><vertex x="0" y="0" z="1"/></vertices><triangles><triangle v1="0" v2="2" v3="1"/><triangle v1="0" v2="1" v3="3"/><triangle v1="1" v2="2" v3="3"/><triangle v1="0" v2="3" v3="2"/></triangles></mesh>';
const threeMF = (body, extra = []) =>
  zip([{ name: '_rels/.rels', data: rels() }, { name: '3D/3dmodel.model', data: model(body), method: 8 }, ...extra]);
const threeMFGenerators = [
  function traversalEntry(r) {
    const name = hostileName(r);
    return zip([
      { name: '_rels/.rels', data: rels(r.chance(0.5) ? name : '/3D/3dmodel.model') },
      {
        name,
        data: model(`<resources><object id="1">${tetra}</object></resources><build><item objectid="1"/></build>`),
      },
      { name: '3D/3dmodel.model', data: model('<resources/><build/>') },
    ]);
  },
  function zipBomb(r) {
    const b = bomb(r);
    return zip([
      { name: '_rels/.rels', data: rels() },
      { name: '3D/3dmodel.model', ...b },
    ]);
  },
  function lyingSize(r) {
    // Declared size far above what the deflate data can produce: the reader must not trust it for allocation.
    return zip([
      { name: '_rels/.rels', data: rels() },
      { name: '3D/3dmodel.model', data: model(''), method: 8, size: r.pick([0x1fffffff, 0x20000000, 0x7fffffff]) },
    ]);
  },
  function componentExplosion(r) {
    // Every level references the next one `fan` times: fan^depth instances of an object with no triangles.
    const depth = r.pick([8, 16, 30]),
      fan = r.pick([4, 10, 64]),
      objects = [];
    for (let level = 0; level < depth; level++)
      objects.push(
        `<object id="${level + 1}"><components>${`<component objectid="${level + 2}"/>`.repeat(fan)}</components></object>`,
      );
    objects.push(`<object id="${depth + 1}">${r.chance(0.5) ? '<mesh><vertices/><triangles/></mesh>' : ''}</object>`);
    return threeMF(`<resources>${objects.join('')}</resources><build><item objectid="1"/></build>`);
  },
  function componentCycle(r) {
    const n = 1 + r.int(4),
      objects = Array.from(
        { length: n },
        (_, i) =>
          `<object id="${i + 1}"><components><component objectid="${((i + 1) % n) + 1}"/></components></object>`,
      );
    return threeMF(`<resources>${objects.join('')}</resources><build><item objectid="1"/></build>`);
  },
  function crossPartCycle(r) {
    // Production extension: two model parts that reference each other through p:path.
    const a = model(
        `<resources><object id="1"><components><component objectid="1" p:path="/3D/b.model"/></components></object></resources><build><item objectid="1"/></build>`,
      ),
      b = model(
        `<resources><object id="1"><components><component objectid="1" p:path="/3D/3dmodel.model"/></components></object></resources><build/>`,
      );
    return zip([
      { name: '_rels/.rels', data: rels() },
      { name: '3D/3dmodel.model', data: a },
      { name: '3D/b.model', data: r.chance(0.5) ? b : a },
    ]);
  },
  function deepXML(r) {
    const depth = r.pick([300, 5000, 100000]);
    return threeMF(`${'<metadata>'.repeat(depth)}${r.chance(0.5) ? '</metadata>'.repeat(depth) : ''}`);
  },
  function hugeIndices(r) {
    const v = r.pick(['4294967295', '4294967294', '-1', '1e9', 'NaN', '0x1', '1.5']);
    return threeMF(
      `<resources><basematerials id="5"><base name="a" displaycolor="#FF0000"/></basematerials><object id="1" pid="5" pindex="${r.pick(['0', v])}"><mesh><vertices><vertex x="0" y="0" z="0"/><vertex x="1" y="0" z="0"/><vertex x="0" y="1" z="0"/></vertices><triangles><triangle v1="0" v2="1" v3="${r.pick(['2', v])}" p1="${v}"/></triangles></mesh></object></resources><build><item objectid="1" transform="${r.pick(['1 0 0 0 1 0 0 0 1 0 0 0', '1e308 0 0 0 1e308 0 0 0 1e308 0 0 0', 'NaN 0 0 0 1 0 0 0 1 0 0 0'])}"/></build>`,
    );
  },
  function manyEntries(r) {
    const n = r.pick([10_001, 3000]);
    return zip(Array.from({ length: n }, (_, i) => ({ name: `f${i}`, data: new Uint8Array(0) })));
  },
];

// --- USD ------------------------------------------------------------------------------------------------------------

const usdaMesh = (points = '[(0,0,0),(1,0,0),(0,1,0)]', counts = '[3]', indices = '[0,1,2]', extra = '') =>
  `#usda 1.0\n(\n    metersPerUnit = 1\n    upAxis = "Y"\n)\n\ndef Xform "Root"\n{\n    def Mesh "Tri"\n    {\n        int[] faceVertexCounts = ${counts}\n        int[] faceVertexIndices = ${indices}\n        point3f[] points = ${points}\n        uniform token subdivisionScheme = "none"\n${extra}    }\n}\n`;
const usdaGenerators = [
  function deepPrims(r) {
    const depth = r.pick([40, 70, 2000]);
    return bytesOf(`#usda 1.0\n${'def Xform "a" {\n'.repeat(depth)}${'}\n'.repeat(depth)}`);
  },
  function deepValues(r) {
    const depth = r.pick([40, 70, 5000]),
      open = r.pick(['[', '(']);
    return bytesOf(usdaMesh(`${open.repeat(depth)}1${(open === '[' ? ']' : ')').repeat(depth)}`));
  },
  function deepDictionary(r) {
    const depth = r.pick([100, 100000]);
    return bytesOf(`#usda 1.0\n(\n    customLayerData = ${'{'.repeat(depth)}${'}'.repeat(depth)}\n)\n`);
  },
  function hugeFaces(r) {
    const n = r.pick([3, 65536, 1_000_000]);
    return bytesOf(usdaMesh(undefined, `[${n}]`, `[${Array(Math.min(n, 300_000)).fill(0).join(',')}]`));
  },
  function badIndices(r) {
    const v = r.pick(['-1', '3', '4294967296', '1e308', 'nan', '2.5']);
    return bytesOf(usdaMesh(undefined, r.pick(['[3]', `[${v}]`]), `[0,1,${v}]`));
  },
  function badStrings(r) {
    const s = r.pick(['"""doc"""', '"\\q"', '"\\u12"', '"""', '"a\nb"']);
    return bytesOf(r.chance(0.5) ? `#usda 1.0\n(\n    ${s}\n)\n` : `#usda 1.0\ndef ${s} {\n}\n`);
  },
  function assetPaths(r) {
    const path = r.pick(TRAVERSAL);
    return bytesOf(
      usdaMesh(
        undefined,
        undefined,
        undefined,
        `        rel material:binding = </Root/Mat>\n    }\n    def Material "Mat" {\n        token outputs:surface.connect = </Root/Mat/S.outputs:surface>\n        def Shader "S" {\n            uniform token info:id = "UsdPreviewSurface"\n            color3f inputs:diffuseColor.connect = </Root/Mat/T.outputs:rgb>\n        }\n        def Shader "T" {\n            uniform token info:id = "UsdUVTexture"\n            asset inputs:file = @${path}@\n        }\n`,
      ),
    );
  },
];
const usdzGenerators = [
  function usdzTraversal(r) {
    const layer = usdaGenerators[6](r);
    return zip(
      [
        { name: 'root.usda', data: layer },
        { name: hostileName(r), data: new Uint8Array(64) },
      ],
      { align: true },
    );
  },
  function usdzBomb(r) {
    return zip([{ name: 'root.usda', ...bomb(r) }], { align: true });
  },
  function usdzLyingSize(r) {
    return zip([{ name: 'root.usdc', data: new Uint8Array(100), size: r.pick([0x7fffffff, 0xfffffffe]) }], {
      align: true,
    });
  },
];

// --- PLY / PCD / VTK seeds built here ---------------------------------------------------------------------------

const plyAscii = bytesOf(
  'ply\nformat ascii 1.0\nelement vertex 4\nproperty float x\nproperty float y\nproperty float z\nproperty uchar red\nproperty uchar green\nproperty uchar blue\nelement face 2\nproperty list uchar int vertex_indices\nend_header\n0 0 0 255 0 0\n1 0 0 0 255 0\n1 1 0 0 0 255\n0 1 0 9 9 9\n3 0 1 2\n4 0 1 2 3\n',
);
function pcdBinary() {
  const header = bytesOf(
      'VERSION .7\nFIELDS x y z intensity\nSIZE 4 4 4 1\nTYPE F F F U\nCOUNT 1 1 1 1\nWIDTH 3\nHEIGHT 1\nVIEWPOINT 0 0 0 1 0 0 0\nPOINTS 3\nDATA binary\n',
    ),
    body = new DataView(new ArrayBuffer(13 * 3));
  for (let i = 0; i < 3; i++) {
    body.setFloat32(i * 13, i, true);
    body.setFloat32(i * 13 + 4, -i, true);
    body.setFloat32(i * 13 + 8, 0.5, true);
    body.setUint8(i * 13 + 12, 7 * i);
  }
  return concat(header, new Uint8Array(body.buffer));
}
function vtkBinary() {
  const head = bytesOf('# vtk DataFile Version 3.0\nbinary\nBINARY\nDATASET POLYDATA\nPOINTS 4 float\n'),
    points = new DataView(new ArrayBuffer(48));
  [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1].forEach((v, i) => points.setFloat32(i * 4, v));
  const polys = new DataView(new ArrayBuffer(32));
  [3, 0, 1, 2, 3, 0, 2, 3].forEach((v, i) => polys.setInt32(i * 4, v));
  return concat(
    head,
    new Uint8Array(points.buffer),
    bytesOf('\nPOLYGONS 2 8\n'),
    new Uint8Array(polys.buffer),
    bytesOf('\n'),
  );
}

// --- FBX ------------------------------------------------------------------------------------------------------------

const HOSTILE_VALUES = [0, -1, 2 ** 31 - 1, -(2 ** 31), 2 ** 53, 1e308, -1e308, Number.NaN, Infinity, 1.5, -0];
/** Mutates an FBX record tree ([name, props, children]) in place: values, arrays, records, connections. */
function mutateTree(r, nodes, budget = { n: 1 + r.int(4) }) {
  for (const node of nodes) {
    if (budget.n <= 0) return;
    const [, props = [], children = []] = node;
    if (props.length && r.chance(0.15)) {
      budget.n--;
      const i = r.int(props.length),
        p = props[i];
      if (p?.array) {
        const values = p.values,
          action = r.int(5);
        if (action === 0 && values.length) values[r.int(values.length)] = r.pick(HOSTILE_VALUES);
        else if (action === 1) values.length = r.int(values.length + 1);
        else if (action === 2) values.push(...values.slice(0, 1 + r.int(8)));
        else if (action === 3 && values.length) values[values.length - 1] = ~r.int(1 << 20);
        else p.array = r.pick(['d', 'f', 'i', 'l', 'b']);
      } else if (p?.L !== undefined) props[i] = { L: BigInt(r.pick([0, -1, 1, 2 ** 40, r.int(400)])) };
      else if (typeof p === 'string') props[i] = r.pick(['', 'Mesh', 'OO', 'OP', 'Model::', '::', 'x'.repeat(1000)]);
      else props[i] = r.pick([...HOSTILE_VALUES.filter(Number.isFinite), 'str', { L: 7n }]);
    }
    if (r.chance(0.05) && budget.n-- > 0) {
      const at = r.int(nodes.length + 1);
      nodes.splice(at, 0, structuredClone(r.pick(nodes)));
    }
    if (r.chance(0.04) && budget.n-- > 0) children.splice(r.int(children.length + 1), 1);
    if (node[0] === 'Connections' && r.chance(0.3) && budget.n-- > 0) {
      // Cycles and dangling ids: model a is a child of b and b of a.
      const a = { L: BigInt(r.pick([100, 200, 300, 999, 0])) },
        b = { L: BigInt(r.pick([100, 200, 300, 0])) };
      children.push(['C', ['OO', a, b]], ['C', ['OO', b, a]]);
    }
    if (children.length) mutateTree(r, children, budget);
  }
}

// --- the targets ------------------------------------------------------------------------------------------------

const loaders = () => import('@margoengine/loaders');
let L;
const loaderTarget = (name, parse, extra) => ({
  name: `loaders/${name}`,
  named: (e) => e instanceof L.LoaderError,
  async setup() {
    L = await loaders();
  },
  async run(bytes) {
    await L[parse](bytes);
  },
  ...extra,
});

export default [
  loaderTarget('ply', 'parsePLY', {
    text: true,
    seeds: () => [...fixtures('packages/loaders/tests/fixtures', /\.ply$/), plyAscii],
    generators: [
      function hugeHeaderCounts(r) {
        const n = r.pick(['8000000', '16000000', '7999999']);
        return bytesOf(
          `ply\nformat ${r.pick(['ascii', 'binary_little_endian', 'binary_big_endian'])} 1.0\nelement vertex ${n}\nproperty float x\nproperty float y\nproperty float z\nproperty float nx\nproperty float ny\nproperty float nz\nproperty uchar red\nproperty uchar green\nproperty uchar blue\nproperty float u\nproperty float v\nelement face ${r.pick(['16000000', '0', n])}\nproperty list uchar int vertex_indices\nend_header\n0 0 0\n`,
        );
      },
    ],
  }),
  loaderTarget('pcd', 'parsePCD', {
    text: true,
    seeds: () => [...fixtures('packages/loaders/tests/fixtures', /\.pcd$/), pcdBinary()],
    generators: [
      function compressedSizes(r) {
        const header = bytesOf(
            `VERSION .7\nFIELDS x y z\nSIZE 4 4 4\nTYPE F F F\nCOUNT 1 1 1\nWIDTH ${r.pick(['8000000', '1', '3'])}\nHEIGHT 1\nPOINTS ${r.pick(['8000000', '1', '3'])}\nDATA binary_compressed\n`,
          ),
          sizes = new DataView(new ArrayBuffer(8));
        sizes.setUint32(0, r.pick([4, 36, 0xffffffff, 96_000_000]), true);
        sizes.setUint32(4, r.pick([36, 96_000_000, 0x7fffffff, 0xffffffff]), true);
        return concat(
          header,
          new Uint8Array(sizes.buffer),
          Uint8Array.from({ length: 40 }, () => r.int(256)),
        );
      },
    ],
  }),
  loaderTarget('off', 'parseOFF', {
    text: true,
    seeds: () => fixtures('packages/loaders/tests/fixtures', /\.off$/),
  }),
  loaderTarget('xyz', 'parseXYZ', {
    text: true,
    seeds: () => fixtures('packages/loaders/tests/fixtures', /\.xyz$/),
  }),
  loaderTarget('vtk', 'parseVTK', {
    text: true,
    seeds: () => [...fixtures('packages/loaders/tests/fixtures', /\.vtk$/), vtkBinary()],
  }),
  loaderTarget('3mf', 'parse3MF', {
    timeMs: 4000,
    seeds: () => [
      ...fixtures('packages/loaders/tests/fixtures', /\.3mf$/).filter((b) => b.length < 100_000),
      threeMF(`<resources><object id="1">${tetra}</object></resources><build><item objectid="1"/></build>`),
    ],
    generators: threeMFGenerators,
    generatorRate: 0.3,
  }),
  loaderTarget('usda', 'parseUSDA', {
    text: true,
    nest: [
      ['[', ']'],
      ['(', ')'],
      ['{', '}'],
      ['def Xform "x" {', '}'],
    ],
    seeds: () => [file('packages/usdz/tests/fixtures/triangle.usda'), bytesOf(usdaMesh())],
    generators: usdaGenerators,
  }),
  loaderTarget('usdz', 'parseUSDZ', {
    seeds: () => [zip([{ name: 'root.usda', data: bytesOf(usdaMesh()) }], { align: true })],
    generators: usdzGenerators,
    generatorRate: 0.3,
  }),
  {
    name: 'fbx',
    timeMs: 4000,
    async setup() {
      this.F = await import('@margoengine/fbx');
      this.W = await import(`file://${join(root, 'packages/fbx/test/fixtures.js').replaceAll('\\', '/')}`);
      this.engine = await headless();
    },
    // The native converter's own errors, or gltf-pro's when the GLB it wrote is refused.
    named: (e) => /\bFBX\b|glTF|PBR/.test(e.message),
    async seeds() {
      const W = await import(`file://${join(root, 'packages/fbx/test/fixtures.js').replaceAll('\\', '/')}`),
        trees = [W.rich(), W.grid(3)];
      return [
        file('examples/package-benchmarks/fixtures/triangle.fbx'),
        file('packages/fbx/test/fixtures/blender-rig.fbx'),
        ...trees.flatMap((t) => [
          new Uint8Array(W.binary(t)),
          new Uint8Array(W.binary(t, { compress: true, version: 7500 })),
          bytesOf(W.ascii(t)),
        ]),
      ];
    },
    generators: [
      function treeMutation(r) {
        const W = this.W,
          tree = r.chance(0.7) ? W.rich({ morphAnimation: r.chance(0.5) }) : W.grid(2);
        mutateTree(r, tree);
        const form = r.int(3);
        try {
          return form === 2
            ? bytesOf(W.ascii(tree))
            : new Uint8Array(W.binary(tree, { compress: r.chance(0.5), version: form ? 7500 : 7400 }));
        } catch {
          return new Uint8Array(W.binary(W.rich())); // the test writer cannot encode this tree (0.5 in an int64 array)
        }
      },
      function asciiHugeArray(r) {
        return bytesOf(
          `; FBX 7.4.0 project file\nFBXHeaderExtension:  {\n\tFBXVersion: 7400\n}\nObjects:  {\n\tGeometry: 1, "Geometry::g", "Mesh" {\n\t\tVertices: *1 {\n\t\t\ta: ${'0,'.repeat(r.pick([1000, 8_000_000]))}0\n\t\t}\n\t}\n}\n`,
        );
      },
    ],
    generatorRate: 0.5,
    async run(bytes) {
      // parseFBX: the native converter, then gltf-pro on the GLB it wrote (as in a browser).
      const model = await this.F.parseFBX(this.engine, bytes);
      try {
        await checkModel(model);
      } finally {
        model.dispose();
      }
    },
  },
  ...['usda', 'usdc', 'usdz'].map((kind) => ({
    name: `usdz/${kind}`,
    text: kind === 'usda',
    nest: [
      ['[', ']'],
      ['def Xform "x" {', '}'],
    ],
    timeMs: 4000,
    async setup() {
      this.U = await import('@margoengine/usdz');
      this.prepare = (await import('@margoengine/gltf-pro/prepare')).prepareAsset;
      this.Asset = (await import('@margoengine/gltf-pro/asset')).GLTFAsset;
    },
    named: (e) => /\bUSD\b|^ZIP:|LoaderError/.test(`${e.name}: ${e.message}`),
    async seeds() {
      const usda = file('packages/usdz/tests/fixtures/triangle.usda'),
        usdc = file('packages/usdz/tests/fixtures/triangle.usdc');
      if (kind === 'usda') return [usda, bytesOf(usdaMesh())];
      if (kind === 'usdc') return [usdc, ...(await crateSeeds())];
      return [
        zip([{ name: 'triangle.usdc', data: usdc }], { align: true }),
        zip([{ name: 'triangle.usda', data: usda }], { align: true }),
      ];
    },
    generators:
      kind === 'usda'
        ? usdaGenerators
        : kind === 'usdz'
          ? usdzGenerators
          : [
              async function crateJumps(r) {
                return crateWithJumps(r);
              },
            ],
    async run(bytes) {
      const asset =
        kind === 'usdz'
          ? await this.U.parseUSDZ(bytes)
          : kind === 'usdc'
            ? this.U.parseUSDC(bytes)
            : this.U.parseUSDA(bytes);
      await this.prepare(new this.Asset(asset.document, asset.buffers), []);
    },
  })),
  {
    name: 'net/snapshot',
    seeds: () => [new Uint8Array(256).map((_, i) => i * 7), new Uint8Array(512)],
    async setup() {
      this.N = await import('@margoengine/net');
    },
    async run(bytes) {
      // Bytes are packets from the network: time, position, rotation, velocity as float64 (hostile values included).
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
        buffer = new this.N.SnapshotBuffer(2 + ((bytes[0] ?? 0) % 40), ((bytes[1] ?? 0) % 11) / 4),
        f = (i) => (i * 8 + 8 <= bytes.length ? view.getFloat64(i * 8, true) : (i % 7) - 3);
      let bounded = true;
      for (let i = 0; i + 11 <= bytes.length / 8; i += 11) {
        const values = Array.from({ length: 11 }, (_, k) => f(i + k));
        try {
          buffer.push(values[0], values.slice(1, 4), values.slice(4, 8), values.slice(8, 11));
          if (values.some((v) => Math.abs(v) > 1e100)) bounded = false;
        } catch (error) {
          if (!(error instanceof RangeError || error instanceof TypeError)) throw error;
          if (ENGINE_NET.test(error.message)) throw error;
        }
      }
      for (let i = 0; i < 8; i++) {
        const out = buffer.sample(f(i) / (1 + Math.abs(f(i + 1))));
        if (bounded && out && [...out.position, ...out.rotation, ...out.velocity].some((v) => !Number.isFinite(v)))
          throw new RangeError('net snapshot: finite bounded packets sampled to a non-finite state');
      }
    },
  },
  {
    name: 'exporters/roundtrip',
    timeMs: 4000,
    async setup() {
      this.E = await import('@margoengine/exporters');
      L = await loaders();
      this.U = await import('@margoengine/usdz');
    },
    named: (e) => !/round trip/.test(e.message),
    seeds: () => [new Uint8Array(32).fill(3), Uint8Array.from({ length: 64 }, (_, i) => i * 31)],
    async run(bytes) {
      const r = random(bytes.reduce((h, b) => Math.imul(h ^ b, 16777619), 2166136261)),
        scene = randomScene(r);
      // Export: validation errors (TypeError/RangeError with the exporter's message) are fine.
      let stl, obj, ply, usdz;
      try {
        stl = this.E.exportSTL(scene, { binary: r.chance(0.5) });
        obj = this.E.exportOBJ(scene).obj;
        ply = this.E.exportPLY(scene, { binary: r.chance(0.5) });
        usdz = this.E.exportUSDZ(scene);
      } catch (error) {
        if (!(error instanceof RangeError || error instanceof TypeError)) throw error;
        return;
      }
      // Re-import what was written: every file the exporters produce must load again (or fail with a named error).
      const back = async (label, step) => {
        try {
          await step();
        } catch (error) {
          throw new Error(`round trip ${label}: ${error?.name}: ${error?.message}`);
        }
      };
      const ply2 = await (async () => L.parsePLY(typeof ply === 'string' ? bytesOf(ply) : ply))().catch((e) => e);
      if (!(ply2 instanceof L.LoaderError) && ply2 instanceof Error) throw new Error(`round trip PLY: ${ply2.message}`);
      await back('USDZ (usdz)', () => this.U.parseUSDZ(usdz));
      await back('USDZ (loaders)', () =>
        L.parseUSDZ(usdz).catch((e) => {
          if (!(e instanceof L.LoaderError && e.code === 'unsupported')) throw e;
        }),
      );
      // The STL and OBJ files load again with @margoengine/loaders; a LoaderError is named, only engine errors are findings.
      for (const [format, parse, data] of [
        ['stl', (d) => L.parseSTL(d), typeof stl === 'string' ? bytesOf(stl) : stl],
        ['obj', (d) => L.parseOBJ(d), bytesOf(obj)],
      ])
        await (async () => parse(data))().catch((e) => {
          if (!isNamed(e, {})) throw new Error(`round trip ${format}: ${e.message}`);
        });
    },
  },
];

const ENGINE_NET = /Cannot read|is not|undefined/;

function randomScene(r) {
  const finite = () => r.pick([0, 1, -1, 0.5, 1e-30, 1e30, 3.4e38, r.next() * 10 - 5]),
    value = () => (r.chance(0.95) ? finite() : r.pick([Number.NaN, Infinity, 1e39, -0])),
    nodes = [];
  const geometry = () => {
    const count = 3 * (1 + r.int(4)),
      positions = Array.from({ length: count * 3 }, value),
      normals = Array.from({ length: count * 3 }, () => (r.chance(0.8) ? r.pick([0, 1]) : value()));
    const g = { positions, normals };
    if (r.chance(0.5))
      g.indices = Array.from({ length: count }, () => (r.chance(0.97) ? r.int(count) : r.pick([-1, count, 1.5])));
    if (r.chance(0.3)) g.uvs = Array.from({ length: count * 2 }, value);
    if (r.chance(0.3)) g.colors = Array.from({ length: count * 4 }, () => r.next());
    return g;
  };
  const node = (depth) => {
    const n = {
      name: r.pick([undefined, 'a', 'a b', '../x', 'line\nbreak', '#hash', '"q"', 'é', '\u0000', 'x'.repeat(300)]),
      translation: r.chance(0.5) ? [value(), value(), value()] : undefined,
      scale: r.chance(0.3) ? [value(), value(), value()] : undefined,
      rotation: r.chance(0.3) ? [value(), value(), value(), value()] : undefined,
      geometry: r.chance(0.7) ? geometry() : undefined,
    };
    if (n.geometry && r.chance(0.5)) n.material = { color: [r.next(), r.next(), r.next(), 1], name: n.name };
    if (depth < 3 && r.chance(0.3)) n.children = Array.from({ length: 1 + r.int(2) }, () => node(depth + 1));
    return n;
  };
  for (let i = 1 + r.int(3); i--; ) nodes.push(node(0));
  return { nodes };
}

// Crate files built with the usdz test writer, and ones whose path jump table revisits entries.
let crateWriter;
async function crateSeeds() {
  crateWriter ??= await import(`file://${join(root, 'packages/usdz/tests/crate-writer.js').replaceAll('\\', '/')}`);
  const { writeCrate, V } = crateWriter;
  return [new Uint8Array(writeCrate(crateSpecs(V)))];
}
const crateSpecs = (V) => [
  { path: '/', type: 7, fields: { upAxis: V.token('Y') } },
  { path: '/Tri', type: 6, fields: { typeName: V.token('Mesh'), specifier: V.specifier(0) } },
  { path: '/Tri.points', type: 1, fields: { default: V.vec3fArray([0, 0, 0, 1, 0, 0, 0, 1, 0]) } },
  { path: '/Tri.faceVertexCounts', type: 1, fields: { default: V.intArray([3]) } },
  { path: '/Tri.faceVertexIndices', type: 1, fields: { default: V.intArray([0, 1, 2]) } },
];
async function crateWithJumps(r) {
  await crateSeeds();
  const { writeCrate } = crateWriter,
    depth = r.pick([24, 40, 2000]),
    specs = [{ path: '/', type: 7, fields: {} }];
  let path = '';
  for (let i = 0; i < depth; i++) specs.push({ path: (path += `/p${i % 3}`), type: 6, fields: {} });
  return new Uint8Array(
    writeCrate(specs, {
      // Every entry claims a child and a sibling one entry ahead: each subtree is walked again from every entry.
      jumps: (jumps) => (r.chance(0.7) ? jumps.map((j, i) => (i < jumps.length - 1 ? 1 : j)) : jumps),
    }),
  );
}
