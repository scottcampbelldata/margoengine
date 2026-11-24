// Test-only writers of Potree folders, from the public descriptions of the formats, and a fetch that serves them from
// memory. A folder is a Map of path to bytes.
const SCALE = 0.001;

/** Splits points into nodes: each keeps `capacity` points, the rest go to the children, indexed x = 4, y = 2, z = 1. */
function tree(cloud) {
  const n = cloud.positions.length / 3,
    p = cloud.positions,
    min = [Infinity, Infinity, Infinity],
    max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < n * 3; i++) {
    min[i % 3] = Math.min(min[i % 3], p[i]);
    max[i % 3] = Math.max(max[i % 3], p[i]);
  }
  const side = Math.max(max[0] - min[0], max[1] - min[1], max[2] - min[2]) + SCALE * 4,
    capacity = cloud.capacity ?? 500;
  const split = (points, corner, size, name) => {
    const node = { name, corner, size, points: points.slice(0, capacity), children: new Array(8).fill(null) },
      rest = new Array(8).fill(0).map(() => []),
      half = size / 2;
    for (const i of points.slice(capacity)) {
      const index =
        (p[i * 3] >= corner[0] + half ? 4 : 0) |
        (p[i * 3 + 1] >= corner[1] + half ? 2 : 0) |
        (p[i * 3 + 2] >= corner[2] + half ? 1 : 0);
      rest[index].push(i);
    }
    for (let index = 0; index < 8; index++)
      if (rest[index].length)
        node.children[index] = split(
          rest[index],
          [
            corner[0] + (index & 4 ? half : 0),
            corner[1] + (index & 2 ? half : 0),
            corner[2] + (index & 1 ? half : 0),
          ],
          half,
          name + index,
        );
    return node;
  };
  // A seeded shuffle, so a node's points are an even sample of its cube.
  const order = [...Array(n).keys()];
  for (let i = n - 1, seed = 9; i > 0; i--) {
    seed = (seed * 1103515245 + 12345) % 2 ** 31;
    const j = seed % (i + 1);
    [order[i], order[j]] = [order[j], order[i]];
  }
  const root = split(order, min, side, 'r');
  return { root, min, max: min.map((v) => v + side), spacing: side / 128 };
}
const maskOf = (node) => node.children.reduce((mask, child, i) => mask | (child ? 1 << i : 0), 0);
const kids = (node) => node.children.filter(Boolean);
const bytesOf = (text) => new TextEncoder().encode(text);

/** Spreads 16 bits of one axis into a 48-bit Morton code: bit k goes to bit 3k + axis. */
function spread(value, axis) {
  let out = 0n;
  for (let k = 0; k < 16; k++) if ((value >>> k) & 1) out |= 1n << BigInt(3 * k + axis);
  return out;
}

/**
 * A Potree 2.0 folder: position int32, intensity uint16, rgb uint16 (`cloud.wideColors`: values times 257). Hierarchy
 * chunks hold `step` levels, joined by proxy records. With encoding `BROTLI` and `compress`, each node is a block per
 * attribute in the layout measured on real folders (positions as two Morton codes, colours as one), compressed alone.
 */
export function writePotree2(cloud, { step = 2, encoding = 'DEFAULT', version = '2.0', compress } = {}) {
  const { root, min, max, spacing } = tree(cloud),
    stride = 12 + 2 + 6,
    all = [];
  const walk = (node) => {
    all.push(node);
    kids(node).forEach(walk);
  };
  walk(root);
  let octree = new Uint8Array(all.reduce((sum, node) => sum + node.points.length * stride, 0));
  const view = new DataView(octree.buffer),
    wide = cloud.wideColors ? 257 : 1,
    intensityOf = (i) => cloud.intensity?.[i] ?? 7;
  let at = 0;
  if (encoding === 'BROTLI' && compress) {
    const parts = [];
    for (const node of all) {
      const n = node.points.length,
        plain = new Uint8Array(n * (16 + 2 + 8)),
        data = new DataView(plain.buffer);
      node.points.forEach((i, k) => {
        let high = 0n,
          low = 0n,
          colour = 0n;
        for (let a = 0; a < 3; a++) {
          const value = Math.round((cloud.positions[i * 3 + a] - min[a]) / SCALE);
          high |= spread(value >>> 16, a);
          low |= spread(value & 0xffff, a);
          colour |= spread((cloud.colors?.[i * 3 + a] ?? 0) * wide, a);
        }
        data.setBigUint64(k * 16, high, true);
        data.setBigUint64(k * 16 + 8, low, true);
        data.setUint16(n * 16 + k * 2, intensityOf(i), true);
        data.setBigUint64(n * 18 + k * 8, colour, true);
      });
      const packed = compress(plain);
      node.offset = at;
      node.bytes = packed.length;
      at += packed.length;
      parts.push(packed);
    }
    octree = new Uint8Array(at);
    for (let i = 0, o = 0; i < parts.length; o += parts[i++].length) octree.set(parts[i], o);
  } else
    for (const node of all) {
      node.offset = at;
      for (const i of node.points) {
        for (let a = 0; a < 3; a++)
          view.setInt32(at + a * 4, Math.round((cloud.positions[i * 3 + a] - min[a]) / SCALE), true);
        view.setUint16(at + 12, intensityOf(i), true);
        for (let c = 0; c < 3; c++) view.setUint16(at + 14 + c * 2, (cloud.colors?.[i * 3 + c] ?? 0) * wide, true);
        at += stride;
      }
      node.bytes = at - node.offset;
    }
  // Chunks: breadth first from each top; a node `step` levels down with children is a proxy to its own chunk.
  const chunks = [{ top: root, nodes: [] }];
  for (let c = 0; c < chunks.length; c++) {
    const chunk = chunks[c],
      queue = [{ node: chunk.top, depth: 0 }];
    for (let i = 0; i < queue.length; i++) {
      const { node, depth } = queue[i],
        proxy = depth >= step && kids(node).length > 0;
      chunk.nodes.push({ node, proxy });
      if (proxy) chunks.push({ top: node, nodes: [] });
      else for (const next of kids(node)) queue.push({ node: next, depth: depth + 1 });
    }
  }
  let offset = 0;
  for (const chunk of chunks) {
    chunk.offset = offset;
    chunk.size = chunk.nodes.length * 22;
    offset += chunk.size;
  }
  const hierarchy = new Uint8Array(offset),
    records = new DataView(hierarchy.buffer);
  for (const chunk of chunks) {
    let o = chunk.offset;
    for (const { node, proxy } of chunk.nodes) {
      const target = proxy && chunks.find((other) => other.top === node);
      records.setUint8(o, proxy ? 2 : kids(node).length ? 0 : 1);
      records.setUint8(o + 1, proxy ? 0 : maskOf(node));
      records.setUint32(o + 2, node.points.length, true);
      records.setBigUint64(o + 6, BigInt(proxy ? target.offset : node.offset), true);
      records.setBigUint64(o + 14, BigInt(proxy ? target.size : node.bytes), true);
      o += 22;
    }
  }
  const metadata = {
    version,
    name: 'test',
    points: cloud.positions.length / 3,
    hierarchy: { firstChunkSize: chunks[0].size, stepSize: step, depth: 8 },
    offset: min,
    scale: [SCALE, SCALE, SCALE],
    spacing,
    boundingBox: { min, max },
    encoding,
    attributes: [
      { name: 'position', size: 12, numElements: 3, elementSize: 4, type: 'int32' },
      { name: 'intensity', size: 2, numElements: 1, elementSize: 2, type: 'uint16' },
      {
        name: 'rgb',
        size: 6,
        numElements: 3,
        elementSize: 2,
        type: 'uint16',
        max: [255 * wide, 255 * wide, 255 * wide],
      },
    ],
  };
  return new Map([
    ['metadata.json', bytesOf(JSON.stringify(metadata))],
    ['hierarchy.bin', hierarchy],
    ['octree.bin', octree],
  ]);
}

/** The folder of a 1.x node: `r/` and a folder per `step` digits, in full groups. */
function folderOf(name, step) {
  const digits = name.slice(1);
  let out = 'data/r/';
  for (let i = 0; i + step <= digits.length; i += step) out += `${digits.slice(i, i + step)}/`;
  return out;
}

/**
 * A Potree 1.x folder: per node a `.bin` of position uint32 from the node's corner, colour RGBA and classification, or
 * with `nodeFile(points)` a file of `kind` 'LAS' or 'LAZ'. An `.hrc` file every `step` levels. `leafZero` writes 0 points
 * in the record of every leaf, as real PotreeConverter 1.7 folders do.
 */
export function writePotree1(cloud, { step = 2, version = '1.7', kind, nodeFile, leafZero = false } = {}) {
  const { root, min, max, spacing } = tree(cloud),
    files = new Map(),
    stride = 12 + 4 + 1;
  const writeNode = (node) => {
    const path = folderOf(node.name, step) + node.name;
    if (kind) files.set(`${path}.${kind.toLowerCase()}`, nodeFile(node.points));
    else {
      const bytes = new Uint8Array(node.points.length * stride),
        view = new DataView(bytes.buffer);
      node.points.forEach((i, k) => {
        for (let a = 0; a < 3; a++)
          view.setUint32(k * stride + a * 4, Math.round((cloud.positions[i * 3 + a] - node.corner[a]) / SCALE), true);
        for (let c = 0; c < 3; c++) bytes[k * stride + 12 + c] = cloud.colors?.[i * 3 + c] ?? 0;
        bytes[k * stride + 15] = 255;
        bytes[k * stride + 16] = 2;
      });
      files.set(`${path}.bin`, bytes);
    }
    kids(node).forEach(writeNode);
  };
  writeNode(root);
  const writeHierarchy = (top) => {
    const queue = [{ node: top, depth: 0 }],
      next = [];
    for (let i = 0; i < queue.length; i++) {
      const { node, depth } = queue[i];
      if (depth === step) {
        if (kids(node).length) next.push(node);
      } else for (const child of kids(node)) queue.push({ node: child, depth: depth + 1 });
    }
    const bytes = new Uint8Array(queue.length * 5),
      view = new DataView(bytes.buffer);
    queue.forEach(({ node }, i) => {
      view.setUint8(i * 5, maskOf(node));
      view.setUint32(i * 5 + 1, leafZero && !kids(node).length ? 0 : node.points.length, true);
    });
    files.set(`${folderOf(top.name, step) + top.name}.hrc`, bytes);
    next.forEach(writeHierarchy);
  };
  writeHierarchy(root);
  const box = { lx: min[0], ly: min[1], lz: min[2], ux: max[0], uy: max[1], uz: max[2] };
  files.set(
    'cloud.js',
    bytesOf(
      JSON.stringify({
        version,
        octreeDir: 'data',
        points: cloud.positions.length / 3,
        boundingBox: box,
        tightBoundingBox: box,
        pointAttributes: kind ?? ['POSITION_CARTESIAN', 'COLOR_PACKED', 'CLASSIFICATION'],
        spacing,
        scale: SCALE,
        hierarchyStepSize: step,
      }),
    ),
  );
  return files;
}

/** A `fetch` answering from `files` under `prefix`, with Range support; `log` collects the requests. */
export function serve(files, prefix = '/scan/', log = []) {
  return async (url, init = {}) => {
    init.signal?.throwIfAborted();
    const name = String(url).slice(prefix.length),
      body = files.get(name),
      range = init.headers?.Range;
    log.push(range ? `${name} ${range}` : name);
    if (!String(url).startsWith(prefix) || !body) return new Response(null, { status: 404 });
    if (!range) return new Response(body, { status: 200 });
    const [, from, to] = /bytes=(\d+)-(\d+)/.exec(range);
    return new Response(body.slice(+from, +to + 1), { status: 206 });
  };
}
