// Writes the Margo-made loader fixtures in tests/fixtures: a rippled torus as PLY (ascii, both binary byte orders,
// ascii with RGBA colours), three 3MF packages (a gear set, a face-coloured prism, a corner-coloured tetrahedron),
// two PCD clouds (ascii and binary_compressed) and an XYZ helix. Every shape is procedural and every byte is
// deterministic (no clocks, seeded noise), so `node packages/loaders/scripts/make-fixtures.js` rewrites identical
// files. The tests import the shape functions below and use their arrays as the expected values.
import { writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { crc32, deflateRawSync } from 'node:zlib';
import { lzfCompress } from '../tests/lzf-compress.js';

const encoder = new TextEncoder();

/** Small deterministic generator (32-bit xorshift), so noise is the same on every run. */
function seeded(seed) {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 4294967296;
  };
}
const round = (value, digits) => {
  const scale = 10 ** digits,
    out = Math.round(value * scale) / scale;
  return out === 0 ? 0 : out; // no negative zero in the text files
};

// ------------------------------------------------------------------------------------------------ PLY torus

/** Ring and tube segment counts of the PLY torus. */
export const TORUS = { ring: 36, tube: 24 };
const TORUS_COLORS = [
  [214, 69, 65],
  [235, 151, 52],
  [222, 205, 70],
  [76, 170, 92],
  [58, 132, 196],
  [139, 92, 182],
];

/**
 * A torus whose tube radius ripples around the ring, offset from the origin so its bounds are not symmetric.
 * Positions are rounded to 3 decimals and exactly representable after float32 rounding within 1e-4.
 * @returns {{positions: number[][], triangles: number[][], colors: number[][]}} colors are 0-255 RGB per vertex.
 */
export function torus() {
  const { ring, tube } = TORUS,
    positions = [],
    colors = [],
    triangles = [];
  for (let i = 0; i < ring; i++) {
    const u = (i / ring) * Math.PI * 2;
    for (let j = 0; j < tube; j++) {
      const v = (j / tube) * Math.PI * 2,
        r = 95 + 22 * Math.sin(3 * u + v),
        reach = 330 + r * Math.cos(v);
      positions.push([
        round(reach * Math.cos(u) - 64, 3),
        round(r * Math.sin(v), 3),
        round(reach * Math.sin(u) + 187, 3),
      ]);
      const band = TORUS_COLORS[Math.floor((i * TORUS_COLORS.length) / ring)],
        shade = j < tube / 2 ? 1 : 0.7;
      colors.push(band.map((c) => Math.round(c * shade)));
    }
  }
  const at = (i, j) => (i % ring) * tube + (j % tube);
  for (let i = 0; i < ring; i++)
    for (let j = 0; j < tube; j++) {
      const a = at(i, j),
        b = at(i + 1, j),
        c = at(i + 1, j + 1),
        d = at(i, j + 1);
      triangles.push([a, d, c], [a, c, b]);
    }
  return { positions, triangles, colors };
}

function plyAscii(mesh, { colored }) {
  const lines = ['ply', 'format ascii 1.0'];
  if (colored) lines.push('comment Margo torus fixture with RGBA vertex colours');
  lines.push(`element vertex ${mesh.positions.length}`);
  const scalar = colored ? 'float' : 'float32';
  for (const axis of ['x', 'y', 'z']) lines.push(`property ${scalar} ${axis}`);
  if (colored) for (const channel of ['red', 'green', 'blue', 'alpha']) lines.push(`property uchar ${channel}`);
  lines.push(`element face ${mesh.triangles.length}`);
  lines.push(colored ? 'property list uchar int vertex_indices' : 'property list uint8 int32 vertex_indices');
  lines.push('end_header');
  mesh.positions.forEach((p, i) => lines.push(`${p.join(' ')} ${colored ? `${mesh.colors[i].join(' ')} 255 ` : ''}`));
  for (const t of mesh.triangles) lines.push(`3 ${t.join(' ')} `);
  return encoder.encode(`${lines.join('\r\n')}\r\n`);
}

function plyBinary(mesh, little) {
  const header = little
    ? 'ply\nformat binary_little_endian 1.0\ncomment little-endian copy of torus.ply\n' +
      `element vertex ${mesh.positions.length}\nproperty float32 x\nproperty float32 y\nproperty float32 z\n` +
      `element face ${mesh.triangles.length}\nproperty list uint8 uint32 vertex_indices\nend_header\n`
    : 'ply\nformat binary_big_endian 1.0\n' +
      `element vertex ${mesh.positions.length}\nproperty float x\nproperty float y\nproperty float z\n` +
      `element face ${mesh.triangles.length}\nproperty list uchar int vertex_indices\nend_header\n`;
  const head = encoder.encode(header),
    out = new Uint8Array(head.length + mesh.positions.length * 12 + mesh.triangles.length * 13),
    view = new DataView(out.buffer);
  out.set(head);
  let at = head.length;
  for (const p of mesh.positions)
    for (const v of p) {
      view.setFloat32(at, v, little);
      at += 4;
    }
  for (const t of mesh.triangles) {
    view.setUint8(at++, 3);
    for (const index of t) {
      view.setUint32(at, index, little);
      at += 4;
    }
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ 3MF

const CORE_NS = 'http://schemas.microsoft.com/3dmanufacturing/core/2015/02';
const MATERIAL_NS = 'http://schemas.microsoft.com/3dmanufacturing/material/2015/02';
const CONTENT_TYPES =
  '<?xml version="1.0" encoding="UTF-8"?>\r\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
  '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml" />' +
  '<Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml" /></Types>';
const RELS =
  '<?xml version="1.0" encoding="UTF-8"?>\r\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel" />' +
  '</Relationships>';
const fixed = (v) => round(v, 4).toFixed(4);

/** The gear set: one object per gear, each placed by a build item with a rotation about z and a translation. */
export const GEARS = Array.from({ length: 15 }, (_, k) => ({
  teeth: 12 + ((k * 5) % 15),
  radius: 14 + ((k * 7) % 11) * 1.5,
  height: 6 + (k % 4) * 2,
  layers: 8,
  angle: 0.2 + k * 0.37,
  translation: [(k % 5) * 70 - 140, Math.floor(k / 5) * 70 - 70, (k % 3) * 4 + 2],
}));

/**
 * One gear as a closed star prism: four outline points per tooth (root, rise, tip, fall), side walls split into
 * `layers` bands, and caps fanned from a centre vertex.
 * @returns {{vertices: number[][], triangles: number[][]}} millimetres, z up.
 */
export function gear({ teeth, radius, height, layers }) {
  const outline = [];
  for (let t = 0; t < teeth; t++)
    for (let s = 0; s < 4; s++) {
      const a = ((t + s / 4) / teeth) * Math.PI * 2,
        r = s === 0 || s === 3 ? radius : radius + 3.2;
      outline.push([r * Math.cos(a), r * Math.sin(a)]);
    }
  const n = outline.length,
    vertices = [],
    triangles = [];
  for (let l = 0; l <= layers; l++)
    for (const [x, y] of outline) vertices.push([round(x, 4), round(y, 4), round((height * l) / layers, 4)]);
  const bottom = vertices.length,
    top = bottom + 1;
  vertices.push([0, 0, 0], [0, 0, height]);
  for (let l = 0; l < layers; l++)
    for (let i = 0; i < n; i++) {
      const a = l * n + i,
        b = l * n + ((i + 1) % n),
        c = b + n,
        d = a + n;
      triangles.push([a, b, c], [a, c, d]);
    }
  for (let i = 0; i < n; i++) {
    triangles.push([bottom, (i + 1) % n, i]);
    triangles.push([top, layers * n + i, layers * n + ((i + 1) % n)]);
  }
  return { vertices, triangles };
}

/** 3MF row-major 3x4 transform (rotation about z, then translation), as written in `transform="..."`. */
export function gearTransform({ angle, translation }) {
  const c = round(Math.cos(angle), 6),
    s = round(Math.sin(angle), 6);
  return [c, s, 0, round(-s, 6), c, 0, 0, 0, 1, ...translation];
}

function meshXML(lines, indent, vertices, triangles, triangleAttributes = () => '') {
  lines.push(`${indent}<mesh>`, `${indent}  <vertices>`);
  for (const [x, y, z] of vertices)
    lines.push(`${indent}    <vertex x="${fixed(x)}" y="${fixed(y)}" z="${fixed(z)}" />`);
  lines.push(`${indent}  </vertices>`, `${indent}  <triangles>`);
  triangles.forEach(([a, b, c], i) =>
    lines.push(`${indent}    <triangle v1="${a}" v2="${b}" v3="${c}"${triangleAttributes(i)} />`),
  );
  lines.push(`${indent}  </triangles>`, `${indent}</mesh>`);
}

function gearsModel() {
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<model unit="millimeter" xml:lang="en-US" xmlns="${CORE_NS}">`,
    '  <metadata name="Title">Margo gear set</metadata>',
    '  <metadata name="Designer">Margo Engine fixture generator</metadata>',
    '  <resources>',
  ];
  GEARS.forEach((g, k) => {
    const { vertices, triangles } = gear(g);
    lines.push(`    <object id="${k + 1}" name="gear ${k + 1}" type="model">`);
    meshXML(lines, '      ', vertices, triangles);
    lines.push('    </object>');
  });
  lines.push('  </resources>', '  <build>');
  GEARS.forEach((g, k) => lines.push(`    <item objectid="${k + 1}" transform="${gearTransform(g).join(' ')}" />`));
  lines.push('  </build>', '</model>');
  return lines.join('\r\n');
}

/** Five `#RRGGBBAA` colours of the face-coloured prism, in colorgroup order. */
export const FACE_COLORS = ['#1F4FD0FF', '#FF8A1FFF', '#2DBE4AFF', '#D02A9AFF', '#F0E020FF'];

/**
 * An octagonal prism (z up, millimetres) whose top and bottom caps use colour 0 and whose eight sides cycle through
 * colours 1-4, so colours first appear in declaration order. Triangles are listed top cap, sides, bottom cap.
 * @returns {{vertices: number[][], triangles: number[][], colors: number[]}} colors: colour index per triangle.
 */
export function facePrism() {
  const vertices = [],
    triangles = [],
    colors = [];
  for (const z of [0, 60])
    for (let i = 0; i < 8; i++) {
      const a = ((i + 0.5) / 8) * Math.PI * 2;
      vertices.push([round(60 + 60 * Math.cos(a), 4), round(60 + 60 * Math.sin(a), 4), z]);
    }
  for (let i = 1; i < 7; i++) {
    triangles.push([8, 8 + i, 9 + i]);
    colors.push(0);
  }
  for (let i = 0; i < 8; i++) {
    const j = (i + 1) % 8;
    triangles.push([i, j, 8 + j], [i, 8 + j, 8 + i]);
    colors.push(1 + (i % 4), 1 + (i % 4));
  }
  for (let i = 1; i < 7; i++) {
    triangles.push([0, i + 1, i]);
    colors.push(0);
  }
  return { vertices, triangles, colors };
}

/** Four `#RRGGBBAA` colours of the corner-coloured tetrahedron. */
export const CORNER_COLORS = ['#FF7F00FF', '#00A0A0FF', '#8040C0FF', '#FFFFFFFF'];

/**
 * A tetrahedron with a colour index per triangle corner (`p1 p2 p3`).
 * @returns {{vertices: number[][], triangles: number[][], corners: number[][]}}
 */
export function cornerTetrahedron() {
  return {
    vertices: [
      [0, 0, 0],
      [40, 0, 0],
      [20, 34.641, 0],
      [20, 11.547, 32.66],
    ],
    triangles: [
      [0, 2, 1],
      [0, 1, 3],
      [1, 2, 3],
      [2, 0, 3],
    ],
    corners: [
      [2, 0, 3],
      [2, 1, 3],
      [1, 0, 3],
      [0, 2, 3],
    ],
  };
}

function coloredModel(colors, vertices, triangles, attributes) {
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<model unit="millimeter" xml:lang="en-US" xmlns:m="${MATERIAL_NS}" xmlns="${CORE_NS}">`,
    '  <metadata name="Designer">Margo Engine fixture generator</metadata>',
    '  <resources>',
    '    <m:colorgroup id="2">',
    ...colors.map((c) => `      <m:color color="${c}" />`),
    '    </m:colorgroup>',
    '    <object id="1" type="model">',
  ];
  meshXML(lines, '      ', vertices, triangles, attributes);
  lines.push('    </object>', '  </resources>', '  <build>', '    <item objectid="1" />', '  </build>', '</model>');
  return lines.join('\r\n');
}

// Fixed DOS time and date (2026-01-01 00:00) so archives do not depend on the clock.
const DOS_TIME = 0,
  DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1;

/**
 * Minimal ZIP writer (PKWARE APPNOTE 4.3). Entries are `{name, data}`; names ending in `/` are stored directory
 * entries. With `descriptors`, entries set general-purpose bits 3 and 11, write zero CRC and sizes in their local
 * headers and append a signed data descriptor, so readers must take sizes from the central directory.
 */
export function writeZip(entries, { descriptors = false } = {}) {
  const parts = [],
    central = [];
  let offset = 0;
  for (const { name, data = new Uint8Array(0) } of entries) {
    const nameBytes = encoder.encode(name),
      directory = name.endsWith('/'),
      method = directory ? 0 : 8,
      packed = directory ? data : new Uint8Array(deflateRawSync(data, { level: 9 })),
      crc = crc32(data) >>> 0,
      flags = descriptors ? 0x0808 : 0;
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, flags, true);
    local.setUint16(8, method, true);
    local.setUint16(10, DOS_TIME, true);
    local.setUint16(12, DOS_DATE, true);
    local.setUint32(14, descriptors ? 0 : crc, true);
    local.setUint32(18, descriptors ? 0 : packed.length, true);
    local.setUint32(22, descriptors ? 0 : data.length, true);
    local.setUint16(26, nameBytes.length, true);
    local.setUint16(28, 0, true);
    parts.push(new Uint8Array(local.buffer), nameBytes, packed);
    let size = 30 + nameBytes.length + packed.length;
    if (descriptors) {
      const tail = new DataView(new ArrayBuffer(16));
      tail.setUint32(0, 0x08074b50, true);
      tail.setUint32(4, crc, true);
      tail.setUint32(8, packed.length, true);
      tail.setUint32(12, data.length, true);
      parts.push(new Uint8Array(tail.buffer));
      size += 16;
    }
    const record = new DataView(new ArrayBuffer(46));
    record.setUint32(0, 0x02014b50, true);
    record.setUint16(4, 20, true);
    record.setUint16(6, 20, true);
    record.setUint16(8, flags, true);
    record.setUint16(10, method, true);
    record.setUint16(12, DOS_TIME, true);
    record.setUint16(14, DOS_DATE, true);
    record.setUint32(16, crc, true);
    record.setUint32(20, packed.length, true);
    record.setUint32(24, data.length, true);
    record.setUint16(28, nameBytes.length, true);
    record.setUint32(38, directory ? 0x10 : 0, true);
    record.setUint32(42, offset, true);
    central.push(new Uint8Array(record.buffer), nameBytes);
    offset += size;
  }
  const centralSize = central.reduce((n, p) => n + p.length, 0),
    end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  end.setUint32(12, centralSize, true);
  end.setUint32(16, offset, true);
  const all = [...parts, ...central, new Uint8Array(end.buffer)],
    out = new Uint8Array(all.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of all) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

function package3MF(model, options) {
  const files = [
    { name: '[Content_Types].xml', data: encoder.encode(CONTENT_TYPES) },
    { name: '_rels/.rels', data: encoder.encode(RELS) },
    { name: '3D/3dmodel.model', data: encoder.encode(model) },
  ];
  if (options.directories) files.splice(1, 0, { name: '_rels/' }), files.splice(3, 0, { name: '3D/' });
  return writeZip(files, options);
}

// ------------------------------------------------------------------------------------------------ PCD

/** Packs 0-255 RGB into the float whose bits are 0x00RRGGBB (PCL's packed rgb field). */
export function packedRGB([r, g, b]) {
  const view = new DataView(new ArrayBuffer(4));
  view.setUint32(0, (r << 16) | (g << 8) | b, true);
  return view.getFloat32(0, true);
}
/** Shortest decimal exponent form that reads back to the same float32. */
function float32Exponent(value) {
  for (let digits = 0; digits < 9; digits++) {
    const text = value.toExponential(digits);
    if (Math.fround(Number(text)) === value) return text;
  }
  return value.toExponential(9);
}

const RING_COLORS = [
  [232, 86, 52],
  [250, 200, 60],
  [140, 60, 200],
];

/** A flat three-colour rose curve of 240 points (z = 0), for the ascii PCD. Colours have red >= 128. */
export function rosePoints() {
  return Array.from({ length: 240 }, (_, i) => {
    const t = (i / 240) * Math.PI * 2,
      r = 1.5 + Math.cos(5 * t);
    return { position: [round(r * Math.cos(t), 5), round(r * Math.sin(t), 5), 0], rgb: RING_COLORS[i % 3] };
  });
}

const ARM_COLORS = [
  [255, 236, 190],
  [90, 140, 255],
  [255, 120, 80],
  [120, 230, 160],
  [200, 120, 255],
];

/** A four-armed spiral of 4,096 points (core plus arms, |coordinate| < 5), for the binary_compressed PCD. */
export function spiralPoints() {
  const random = seeded(4099);
  return Array.from({ length: 4096 }, (_, i) => {
    const arm = i % 4,
      t = (Math.floor(i / 4) / 1024) * 3.2,
      core = t < 0.35,
      angle = arm * (Math.PI / 2) + t * 2.1 + (random() - 0.5) * 0.25,
      r = 0.2 + t * 1.3 + (random() - 0.5) * 0.12;
    return {
      position: [
        Math.fround(r * Math.cos(angle)),
        Math.fround(r * Math.sin(angle)),
        Math.fround(Math.round((random() - 0.5) * 8) * 0.025),
      ],
      rgb: ARM_COLORS[core ? 0 : 1 + arm],
    };
  });
}

function pcdAscii(points) {
  const lines = [
    '# .PCD v.7 - Margo rose curve fixture',
    'VERSION .7',
    'FIELDS x y z rgb',
    'SIZE 4 4 4 4',
    'TYPE F F F F',
    'COUNT 1 1 1 1',
    `WIDTH ${points.length}`,
    'HEIGHT 1',
    'VIEWPOINT 0 0 0 1 0 0 0',
    `POINTS ${points.length}`,
    'DATA ascii',
    ...points.map((p) => `${p.position.join(' ')} ${float32Exponent(packedRGB(p.rgb))}`),
  ];
  return encoder.encode(`${lines.join('\r\n')}\r\n`);
}

function pcdCompressed(points) {
  const header =
    '# .PCD v0.7 - Margo spiral fixture\nVERSION 0.7\nFIELDS x y z rgb\nSIZE 4 4 4 4\nTYPE F F F F\nCOUNT 1 1 1 1\n' +
    `WIDTH ${points.length}\nHEIGHT 1\nVIEWPOINT 0 0 -2 0 1 0 0\nPOINTS ${points.length}\nDATA binary_compressed\n`;
  const n = points.length,
    body = new Uint8Array(n * 16),
    view = new DataView(body.buffer);
  points.forEach((p, i) => {
    for (let a = 0; a < 3; a++) view.setFloat32((a * n + i) * 4, p.position[a], true);
    view.setUint32((3 * n + i) * 4, (p.rgb[0] << 16) | (p.rgb[1] << 8) | p.rgb[2], true);
  });
  const packed = lzfCompress(body),
    head = encoder.encode(header),
    out = new Uint8Array(head.length + 8 + packed.length),
    sizes = new DataView(out.buffer, head.length, 8);
  out.set(head);
  sizes.setUint32(0, packed.length, true);
  sizes.setUint32(4, body.length, true);
  out.set(packed, head.length + 8);
  return out;
}

// ------------------------------------------------------------------------------------------------ XYZ

/** A helix of 240 points, three turns, radius 0.8, rising from z = -2.9. */
export function helixPoints() {
  return Array.from({ length: 240 }, (_, i) => {
    const t = (i / 240) * Math.PI * 6;
    return [0.8 * Math.cos(t + 0.4), 0.8 * Math.sin(t + 0.4), -2.9 + i * 0.012];
  });
}
// Small values in Fortran-style exponent form (capital E), the rest fixed point, each in a 15-wide column.
const column = (v) =>
  (Math.abs(v) < 0.1 && v !== 0
    ? v
        .toExponential(7)
        .toUpperCase()
        .replace(/E([+-])(\d)$/, 'E$10$2')
    : v.toFixed(7)
  )
    .padStart(13)
    .padEnd(15);

function xyz(points) {
  const lines = ['# helix.xyz (Margo fixture)', '#', ...points.map((p) => p.map(column).join(''))];
  return encoder.encode(`${lines.join('\r\n')}\r\n`);
}

// ------------------------------------------------------------------------------------------------ files

/** Every fixture this script writes, by file name. */
export function buildFixtures() {
  const mesh = torus(),
    prism = facePrism(),
    tetra = cornerTetrahedron();
  return {
    'torus.ply': plyAscii(mesh, { colored: false }),
    'torus_be.ply': plyBinary(mesh, false),
    'torus_le.ply': plyBinary(mesh, true),
    'torus_colored.ply': plyAscii(mesh, { colored: true }),
    'gears.3mf': package3MF(gearsModel(), { directories: true }),
    'face_colors.3mf': package3MF(
      coloredModel(FACE_COLORS, prism.vertices, prism.triangles, (i) => ` pid="2" p1="${prism.colors[i]}"`),
      { descriptors: true },
    ),
    'corner_colors.3mf': package3MF(
      coloredModel(CORNER_COLORS, tetra.vertices, tetra.triangles, (i) => {
        const [a, b, c] = tetra.corners[i];
        return ` pid="2" p1="${a}" p2="${b}" p3="${c}"`;
      }),
      { descriptors: true },
    ),
    'rose.pcd': pcdAscii(rosePoints()),
    'spiral.pcd': pcdCompressed(spiralPoints()),
    'helix.xyz': xyz(helixPoints()),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const folder = fileURLToPath(new URL('../tests/fixtures/', import.meta.url));
  for (const [name, bytes] of Object.entries(buildFixtures())) {
    writeFileSync(folder + name, bytes);
    console.log(`${name} ${bytes.length} bytes`);
  }
}
