// Tiny generators of 3D Tiles test data, written for these tests: GLB boxes, b3dm / pnts / cmpt wrappers, binary
// subtree files, explicit and implicit "city" tilesets, and an in-memory fetch that records every request. Plain
// ESM so the browser check can import it too. Nothing is downloaded.
const encoder = new TextEncoder();

const pad = (n, to = 8) => Math.ceil(n / to) * to;
function jsonChunk(value, to = 8) {
  const text = JSON.stringify(value),
    bytes = encoder.encode(text),
    out = new Uint8Array(pad(bytes.length, to)).fill(0x20);
  out.set(bytes);
  return out;
}
function concat(parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.byteLength;
  }
  return out;
}

/** A GLB with one box of the given size (y-up), centred at `center`, coloured `color` (linear rgb). */
export function boxGLB({ size = [1, 1, 1], center = [0, 0, 0], color = [0.8, 0.8, 0.8] } = {}) {
  const [hx, hy, hz] = size.map((s) => s / 2),
    [cx, cy, cz] = center;
  const faces = [
    [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ],
    [
      [-1, 0, 0],
      [0, 1, 0],
      [0, 0, -1],
    ],
    [
      [0, 1, 0],
      [0, 0, 1],
      [1, 0, 0],
    ],
    [
      [0, -1, 0],
      [0, 0, -1],
      [1, 0, 0],
    ],
    [
      [0, 0, 1],
      [1, 0, 0],
      [0, 1, 0],
    ],
    [
      [0, 0, -1],
      [-1, 0, 0],
      [0, 1, 0],
    ],
  ];
  const positions = [],
    normals = [],
    indices = [];
  for (const [n, u, v] of faces) {
    const base = positions.length / 3;
    for (const [a, b] of [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ]) {
      positions.push(
        cx + (n[0] + a * u[0] + b * v[0]) * hx,
        cy + (n[1] + a * u[1] + b * v[1]) * hy,
        cz + (n[2] + a * u[2] + b * v[2]) * hz,
      );
      normals.push(...n);
    }
    // Counter-clockwise seen from outside: u x v = n for every face above.
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  const pos = new Float32Array(positions),
    nor = new Float32Array(normals),
    idx = new Uint16Array(indices);
  const bin = new Uint8Array(pad(pos.byteLength + nor.byteLength + idx.byteLength, 4));
  bin.set(new Uint8Array(pos.buffer), 0);
  bin.set(new Uint8Array(nor.buffer), pos.byteLength);
  bin.set(new Uint8Array(idx.buffer), pos.byteLength + nor.byteLength);
  const min = [cx - hx, cy - hy, cz - hz],
    max = [cx + hx, cy + hy, cz + hz];
  const gltf = {
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1 }, indices: 2, material: 0 }] }],
    materials: [{ pbrMetallicRoughness: { baseColorFactor: [...color, 1], metallicFactor: 0, roughnessFactor: 1 } }],
    buffers: [{ byteLength: bin.byteLength }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: pos.byteLength, target: 34962 },
      { buffer: 0, byteOffset: pos.byteLength, byteLength: nor.byteLength, target: 34962 },
      { buffer: 0, byteOffset: pos.byteLength + nor.byteLength, byteLength: idx.byteLength, target: 34963 },
    ],
    accessors: [
      { bufferView: 0, componentType: 5126, count: pos.length / 3, type: 'VEC3', min, max },
      { bufferView: 1, componentType: 5126, count: nor.length / 3, type: 'VEC3' },
      { bufferView: 2, componentType: 5123, count: idx.length, type: 'SCALAR' },
    ],
  };
  const json = jsonChunk(gltf, 4),
    total = 12 + 8 + json.byteLength + 8 + bin.byteLength,
    out = new Uint8Array(total),
    view = new DataView(out.buffer);
  view.setUint32(0, 0x46546c67, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, total, true);
  view.setUint32(12, json.byteLength, true);
  view.setUint32(16, 0x4e4f534a, true);
  out.set(json, 20);
  view.setUint32(20 + json.byteLength, bin.byteLength, true);
  view.setUint32(24 + json.byteLength, 0x004e4942, true);
  out.set(bin, 28 + json.byteLength);
  return out;
}

function wrap(magic, headerLength, featureJSON, featureBinary, batchJSON, batchBinary, body, extra) {
  const ftJ = featureJSON ? jsonChunk(featureJSON) : new Uint8Array(0),
    ftB = featureBinary
      ? concat([featureBinary, new Uint8Array(pad(featureBinary.byteLength) - featureBinary.byteLength)])
      : new Uint8Array(0),
    btJ = batchJSON ? jsonChunk(batchJSON) : new Uint8Array(0),
    btB = batchBinary
      ? concat([batchBinary, new Uint8Array(pad(batchBinary.byteLength) - batchBinary.byteLength)])
      : new Uint8Array(0);
  const header = new Uint8Array(headerLength),
    view = new DataView(header.buffer);
  const total = headerLength + ftJ.byteLength + ftB.byteLength + btJ.byteLength + btB.byteLength + body.byteLength;
  for (let i = 0; i < 4; i++) header[i] = magic.charCodeAt(i);
  view.setUint32(4, 1, true);
  view.setUint32(8, total, true);
  view.setUint32(12, ftJ.byteLength, true);
  view.setUint32(16, ftB.byteLength, true);
  view.setUint32(20, btJ.byteLength, true);
  view.setUint32(24, btB.byteLength, true);
  if (extra !== undefined) view.setUint32(28, extra, true);
  return concat([header, ftJ, ftB, btJ, btB, body]);
}

/** A b3dm around a GLB, with BATCH_LENGTH, an optional RTC_CENTER and a batch table (JSON and binary properties). */
export function b3dm(glb, { rtcCenter, batch } = {}) {
  const length = batch?.length ?? 0;
  let batchJSON, batchBinary;
  if (batch) {
    const heights = new Float32Array(batch.map((b) => b.height));
    batchJSON = { name: batch.map((b) => b.name), height: { byteOffset: 0, componentType: 'FLOAT', type: 'SCALAR' } };
    batchBinary = new Uint8Array(heights.buffer);
  }
  return wrap(
    'b3dm',
    28,
    { BATCH_LENGTH: length, ...(rtcCenter ? { RTC_CENTER: rtcCenter } : {}) },
    null,
    batchJSON,
    batchBinary,
    glb,
  );
}

/** A pnts with float positions and RGB colours. */
export function pnts(positions, colors, { rtcCenter } = {}) {
  const n = positions.length / 3,
    pos = new Uint8Array(new Float32Array(positions).buffer),
    rgbOffset = pad(pos.byteLength),
    binary = new Uint8Array(rgbOffset + n * 3);
  binary.set(pos, 0);
  binary.set(colors, rgbOffset);
  return wrap(
    'pnts',
    28,
    {
      POINTS_LENGTH: n,
      POSITION: { byteOffset: 0 },
      RGB: { byteOffset: rgbOffset },
      ...(rtcCenter ? { RTC_CENTER: rtcCenter } : {}),
    },
    binary,
    null,
    null,
    new Uint8Array(0),
  );
}

/** A composite of inner tiles. */
export function cmpt(inner) {
  const header = new Uint8Array(16),
    view = new DataView(header.buffer),
    total = 16 + inner.reduce((n, t) => n + t.byteLength, 0);
  header.set([0x63, 0x6d, 0x70, 0x74]);
  view.setUint32(4, 1, true);
  view.setUint32(8, total, true);
  view.setUint32(12, inner.length, true);
  return concat([header, ...inner]);
}

/** A binary subtree file from availability bit arrays (arrays of 0/1) or constants (0 or 1). */
export function subtree({ tiles, contents, children }) {
  const views = [],
    chunks = [];
  let offset = 0;
  const avail = (bits) => {
    if (typeof bits === 'number') return { constant: bits };
    const bytes = new Uint8Array(pad(Math.ceil(bits.length / 8)));
    bits.forEach((b, i) => {
      if (b) bytes[i >> 3] |= 1 << (i & 7);
    });
    views.push({ buffer: 0, byteOffset: offset, byteLength: Math.ceil(bits.length / 8) });
    chunks.push(bytes);
    offset += bytes.byteLength;
    return { bitstream: views.length - 1 };
  };
  const json = {
    tileAvailability: avail(tiles),
    contentAvailability: [avail(contents)],
    childSubtreeAvailability: avail(children),
  };
  if (offset) {
    json.buffers = [{ byteLength: offset }];
    json.bufferViews = views;
  }
  const j = jsonChunk(json),
    bin = concat(chunks),
    header = new Uint8Array(24),
    view = new DataView(header.buffer);
  view.setUint32(0, 0x74627573, true);
  view.setUint32(4, 1, true);
  view.setBigUint64(8, BigInt(j.byteLength), true);
  view.setBigUint64(16, BigInt(bin.byteLength), true);
  return concat([header, j, bin]);
}

const WGS84_A = 6378137,
  E2 = (1 / 298.257223563) * (2 - 1 / 298.257223563);
export function ecef(lonDeg, latDeg, h = 0) {
  const lon = (lonDeg * Math.PI) / 180,
    lat = (latDeg * Math.PI) / 180,
    n = WGS84_A / Math.sqrt(1 - E2 * Math.sin(lat) ** 2);
  return [
    (n + h) * Math.cos(lat) * Math.cos(lon),
    (n + h) * Math.cos(lat) * Math.sin(lon),
    (n * (1 - E2) + h) * Math.sin(lat),
  ];
}
/** The ENU-to-ECEF matrix at a longitude/latitude (degrees), column-major. */
export function enu(lonDeg, latDeg, h = 0) {
  const lon = (lonDeg * Math.PI) / 180,
    lat = (latDeg * Math.PI) / 180,
    p = ecef(lonDeg, latDeg, h);
  const so = Math.sin(lon),
    co = Math.cos(lon),
    sa = Math.sin(lat),
    ca = Math.cos(lat);
  return [-so, co, 0, 0, -sa * co, -sa * so, ca, 0, ca * co, ca * so, sa, 0, ...p, 1];
}

/**
 * An explicit quadtree "city": `levels` levels over a square of `size` metres anchored with an ENU transform at
 * lon/lat. Leaves hold one box building per tile; inner tiles hold a coarse block. Every tile is a GLB (or b3dm when
 * `format: 'b3dm'`). Returns {files: Map<path, bytes>, tileset}.
 */
export function cityTileset({
  levels = 4,
  size = 2048,
  lon = -75.6,
  lat = 40.04,
  format = 'glb',
  refine = 'REPLACE',
  height = 40,
} = {}) {
  const files = new Map();
  const make = (level, x, y) => {
    const n = 2 ** level,
      cell = size / n,
      cx = -size / 2 + cell * (x + 0.5),
      cy = -size / 2 + cell * (y + 0.5),
      h = level === levels - 1 ? height * (0.5 + ((x * 7 + y * 13) % 10) / 10) : height;
    const path = `tiles/${level}/${x}/${y}.${format}`;
    // The box is y-up glTF; the tile frame is ENU (z up), so glTF (x, y, z) = (east, up, -north).
    const glb = boxGLB({
      size: [cell * 0.8, h, cell * 0.8],
      center: [cx, h / 2, -cy],
      color: [0.2 + 0.6 * (level / levels), 0.5, 0.8],
    });
    files.set(path, format === 'b3dm' ? b3dm(glb, { batch: [{ name: `b${level}-${x}-${y}`, height: h }] }) : glb);
    const tile = {
      boundingVolume: { box: [cx, cy, h / 2, cell / 2, 0, 0, 0, cell / 2, 0, 0, 0, Math.max(h, height) / 2 + 1] },
      geometricError: level === levels - 1 ? 0 : (size / n) * 0.05,
      content: { uri: path },
    };
    if (level < levels - 1) tile.children = [0, 1, 2, 3].map((i) => make(level + 1, 2 * x + (i & 1), 2 * y + (i >> 1)));
    return tile;
  };
  const root = make(0, 0, 0);
  root.refine = refine;
  root.transform = enu(lon, lat);
  const tileset = { asset: { version: '1.1' }, geometricError: size * 0.1, root };
  files.set('tileset.json', encoder.encode(JSON.stringify(tileset)));
  return { files, tileset };
}

/**
 * An implicit quadtree over a region: every tile available up to `levels`, subtrees of `subtreeLevels` levels,
 * content at every tile. Returns {files, tileset}.
 */
export function implicitTileset({ levels = 4, subtreeLevels = 2, lon = 0.01, lat = 0.01, span = 0.0004 } = {}) {
  const files = new Map(),
    rad = Math.PI / 180;
  const region = [(lon - span) * rad, (lat - span) * rad, (lon + span) * rad, (lat + span) * rad, 0, 50];
  const tilesPerSubtree = (4 ** subtreeLevels - 1) / 3;
  for (let level = 0; level < levels; level += subtreeLevels) {
    const n = 2 ** level;
    for (let x = 0; x < n; x++)
      for (let y = 0; y < n; y++) {
        const deeper = level + subtreeLevels < levels;
        const bits = Array.from({ length: tilesPerSubtree }, (_, i) => {
          // Tiles below `levels` are unavailable.
          let l = 0,
            first = 0;
          while (first + 4 ** l <= i) first += 4 ** l++;
          return level + l < levels ? 1 : 0;
        });
        files.set(
          `subtrees/${level}/${x}/${y}.subtree`,
          subtree({ tiles: bits, contents: bits, children: deeper ? 1 : 0 }),
        );
      }
  }
  for (let level = 0; level < levels; level++) {
    const n = 2 ** level;
    for (let x = 0; x < n; x++)
      for (let y = 0; y < n; y++) files.set(`content/${level}/${x}/${y}.glb`, boxGLB({ size: [2, 2, 2] }));
  }
  const tileset = {
    asset: { version: '1.1' },
    geometricError: 200,
    root: {
      boundingVolume: { region },
      geometricError: 100,
      refine: 'REPLACE',
      content: { uri: 'content/{level}/{x}/{y}.glb' },
      implicitTiling: {
        subdivisionScheme: 'QUADTREE',
        subtreeLevels,
        availableLevels: levels,
        subtrees: { uri: 'subtrees/{level}/{x}/{y}.subtree' },
      },
    },
  };
  files.set('tileset.json', encoder.encode(JSON.stringify(tileset)));
  return { files, tileset };
}

/**
 * A fetch over a Map of paths under `base`. Records requests; `delay` (ms) or `gate` (a promise per request) hold
 * responses; `fail` (path => status) answers errors; aborts reject with AbortError like a real fetch.
 */
export function memoryFetch(files, { base = 'https://tiles.test/', delay = 0, fail, gate } = {}) {
  const requests = [],
    aborted = [];
  const fetch = (url, init = {}) =>
    new Promise((resolve, reject) => {
      const path = String(url).startsWith(base) ? String(url).slice(base.length) : String(url);
      requests.push(path);
      const signal = init.signal;
      const abort = () => {
        aborted.push(path);
        reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
      };
      if (signal?.aborted) return abort();
      signal?.addEventListener('abort', abort, { once: true });
      const answer = () => {
        if (signal?.aborted) return;
        signal?.removeEventListener('abort', abort);
        const status = fail?.(path);
        if (status) return resolve(new Response('error', { status }));
        const bytes = files.get(path);
        resolve(bytes ? new Response(bytes) : new Response('missing', { status: 404 }));
      };
      if (gate) gate(path).then(answer);
      else if (delay) setTimeout(answer, delay);
      else queueMicrotask(answer);
    });
  return { fetch, requests, aborted, url: `${base}tileset.json` };
}

/** Lets pending fetch callbacks and their continuations run. */
export async function settle(rounds = 20) {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setTimeout(r, 0));
}

/**
 * An i3dm around a GLB (gltfFormat 1) or a glTF URI string (gltfFormat 0): float POSITION (relative to RTC_CENTER
 * when given), optional NORMAL_UP and NORMAL_RIGHT, uniform SCALE and EAST_NORTH_UP.
 */
export function i3dm(gltf, { positions, up, right, scale, rtcCenter, eastNorthUp } = {}) {
  const n = positions.length / 3,
    parts = [],
    json = { INSTANCES_LENGTH: n };
  let offset = 0;
  const add = (name, values) => {
    const bytes = new Uint8Array(new Float32Array(values).buffer);
    json[name] = { byteOffset: offset };
    parts.push(bytes);
    offset += bytes.byteLength;
  };
  add('POSITION', positions);
  if (up) add('NORMAL_UP', up);
  if (right) add('NORMAL_RIGHT', right);
  if (scale) add('SCALE', scale);
  if (rtcCenter) json.RTC_CENTER = rtcCenter;
  if (eastNorthUp) json.EAST_NORTH_UP = true;
  const body = typeof gltf === 'string' ? encoder.encode(gltf) : gltf;
  return wrap('i3dm', 32, json, concat(parts), null, null, body, typeof gltf === 'string' ? 0 : 1);
}

/**
 * A grove: one tile at lon/lat (no transform, ECEF) whose i3dm places `n` x `n` box trees `spacing` metres apart on
 * an east-north grid, standing on the ellipsoid (EAST_NORTH_UP), positions relative to RTC_CENTER. With `uri`, the
 * tree is an external GLB (gltfFormat 0). Returns {files, tileset, rtc, offsets} (offsets: east-north metres).
 */
export function groveTileset({ n = 5, spacing = 40, lon = -75.6, lat = 40.04, uri = false, height = 12 } = {}) {
  const files = new Map(),
    rtc = ecef(lon, lat),
    frame = enu(lon, lat),
    positions = [],
    offsets = [];
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++) {
      const e = (i - (n - 1) / 2) * spacing,
        north = (j - (n - 1) / 2) * spacing,
        p = [0, 1, 2].map((k) => frame[k] * e + frame[4 + k] * north + frame[12 + k] - rtc[k]);
      positions.push(...p);
      offsets.push([e, north]);
    }
  // A y-up glTF box standing on its base: the instance origin is the foot of the tree.
  const tree = boxGLB({ size: [6, height, 6], center: [0, height / 2, 0], color: [0.2, 0.7, 0.25] });
  if (uri) files.set('models/tree.glb', tree);
  files.set(
    'tiles/grove.i3dm',
    i3dm(uri ? '../models/tree.glb' : tree, { positions, rtcCenter: rtc, eastNorthUp: true }),
  );
  const radius = Math.hypot(n * spacing, height) + 10;
  const tileset = {
    asset: { version: '1.0' },
    geometricError: 100,
    root: {
      boundingVolume: { sphere: [...rtc, radius] },
      geometricError: 0,
      refine: 'ADD',
      content: { uri: 'tiles/grove.i3dm' },
    },
  };
  files.set('tileset.json', encoder.encode(JSON.stringify(tileset)));
  return { files, tileset, rtc, offsets };
}

/**
 * A pnts around a Draco point cloud (3DTILES_draco_point_compression): `properties` maps feature table semantics and
 * `batch` batch table properties to Draco attribute IDs. The Draco bytes are the caller's; this wrapper is a stand-in.
 */
export function dracoPnts(drc, { length, properties, batch, batchLength } = {}) {
  const featureJSON = {
    POINTS_LENGTH: length,
    extensions: { '3DTILES_draco_point_compression': { properties, byteOffset: 0, byteLength: drc.byteLength } },
  };
  for (const name of Object.keys(properties)) featureJSON[name] = { byteOffset: 0 };
  let batchJSON = null;
  if (batch) {
    featureJSON.BATCH_LENGTH = batchLength ?? length;
    batchJSON = { extensions: { '3DTILES_draco_point_compression': { properties: batch } } };
    for (const name of Object.keys(batch)) batchJSON[name] = { byteOffset: 0, componentType: 'FLOAT', type: 'SCALAR' };
  }
  return wrap('pnts', 28, featureJSON, drc, batchJSON, null, new Uint8Array(0));
}
