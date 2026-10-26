// @ts-check
// glTF meshopt bufferView encoding for margo-convert, written clean room from the EXT_meshopt_compression and
// KHR_meshopt_compression specifications (Appendix A "Bitstream"): the version 0 attribute codec and the version 0
// triangle codec. Margo's decoder (@margoengine/decoders/meshopt) is the reader these streams are tested against.
// Nothing here was derived from another encoder's source.

const GROUP = 16;
/** Bits per delta for each 2-bit group header of the version 0 attribute codec. */
const WIDTHS = [0, 2, 4, 8];

/** @param {number} d signed 8-bit delta @returns {number} */
const zigzag8 = (d) => ((d << 1) ^ (d >> 7)) & 0xff;

/**
 * Encodes `count` elements of `size` bytes (a multiple of 4, at most 256) with the version 0 attribute codec.
 * Every byte lane is delta coded against the previous element, zigzagged, and packed per group of 16 elements with
 * the narrowest of 0, 2, 4 or 8 bits that is cheapest (the all-ones value of a narrow width escapes to a full byte).
 * @param {Uint8Array} data count * size bytes, elements interleaved
 * @param {number} count elements
 * @param {number} size bytes per element
 * @returns {Uint8Array}
 */
export function encodeVertexBuffer(data, count, size) {
  if (!Number.isInteger(size) || size < 4 || size > 256 || size % 4 !== 0)
    throw new RangeError(`meshopt attribute stride must be a multiple of 4 from 4 to 256, got ${size}`);
  if (!Number.isInteger(count) || count < 1 || data.length < count * size)
    throw new RangeError('meshopt attribute data does not hold count * stride bytes');
  const blockMax = Math.min(Math.floor(8192 / size) & ~15, 256);
  /** @type {number[]} */
  const out = [0xa0];
  const prev = Uint8Array.from(data.subarray(0, size));
  const baseline = Uint8Array.from(prev);
  const lane = new Uint8Array(256);
  for (let start = 0; start < count; start += blockMax) {
    const n = Math.min(count - start, blockMax),
      groups = (n + GROUP - 1) >> 4;
    for (let k = 0; k < size; k++) {
      lane.fill(0);
      let p = prev[k];
      for (let i = 0; i < n; i++) {
        const v = data[(start + i) * size + k];
        lane[i] = zigzag8(((v - p) << 24) >> 24);
        p = v;
      }
      prev[k] = p;
      const headerAt = out.length,
        headerBytes = (groups + 3) >> 2;
      for (let h = 0; h < headerBytes; h++) out.push(0);
      for (let g = 0; g < groups; g++) {
        const at = g * GROUP;
        // Cheapest of the four widths: packed codes (2 * bits bytes) plus one byte per escaped delta.
        let best = 3,
          bestCost = 16;
        let zero = true,
          over3 = 0,
          over15 = 0;
        for (let i = 0; i < GROUP; i++) {
          const v = lane[at + i];
          if (v !== 0) zero = false;
          if (v >= 3) over3++;
          if (v >= 15) over15++;
        }
        if (zero) {
          best = 0;
          bestCost = 0;
        } else {
          if (4 + over3 < bestCost) {
            best = 1;
            bestCost = 4 + over3;
          }
          if (8 + over15 < bestCost) {
            best = 2;
            bestCost = 8 + over15;
          }
        }
        out[headerAt + (g >> 2)] |= best << ((g & 3) * 2);
        const bits = WIDTHS[best];
        if (bits === 0) continue;
        if (bits === 8) {
          for (let i = 0; i < GROUP; i++) out.push(lane[at + i]);
          continue;
        }
        const marker = (1 << bits) - 1,
          perByte = 8 / bits,
          packedAt = out.length,
          escapes = [];
        for (let b = 0; b < GROUP / perByte; b++) out.push(0);
        for (let i = 0; i < GROUP; i++) {
          const v = lane[at + i];
          let code = v;
          if (v >= marker) {
            code = marker;
            escapes.push(v);
          }
          out[packedAt + Math.floor(i / perByte)] |= code << (8 - bits - bits * (i % perByte));
        }
        for (const e of escapes) out.push(e);
      }
    }
  }
  const tail = Math.max(32, size);
  for (let i = 0; i < tail - size; i++) out.push(0);
  for (let i = 0; i < size; i++) out.push(baseline[i]);
  return Uint8Array.from(out);
}

/** The 14 code-aux pairs (z << 4 | w) the triangle codec's tail table offers for a new first vertex. */
const AUX = [0x00, 0x01, 0x10, 0x12, 0x21, 0x02, 0x20, 0x13, 0x31, 0x23, 0x32, 0x03, 0x30, 0x11];

/**
 * Encodes a triangle list with the version 0 triangle codec. Vertices are renumbered in order of first use, which the
 * codec requires; the result carries the renumbering so the caller can reorder its vertex data to match.
 * @param {ArrayLike<number>} indices a multiple of 3 indices into `vertexCount` vertices
 * @param {number} vertexCount
 * @returns {{bytes: Uint8Array, remap: Uint32Array, indices: Uint32Array}} `remap[old]` is the new index of vertex
 *   `old` (vertices no triangle uses follow the used ones); `indices` are the triangles in the new numbering
 */
export function encodeTriangles(indices, vertexCount) {
  const triangles = indices.length / 3;
  if (!Number.isInteger(triangles) || triangles < 1) throw new RangeError('meshopt triangles need whole triangles');
  const map = new Int32Array(vertexCount).fill(-1);
  const edgeA = new Int32Array(16).fill(-1),
    edgeB = new Int32Array(16).fill(-1),
    verts = new Int32Array(16).fill(-1);
  let edgeHead = 0,
    vertHead = 0,
    next = 0,
    last = 0;
  const pushEdge = (/** @type {number} */ a, /** @type {number} */ b) => {
    edgeA[edgeHead] = a;
    edgeB[edgeHead] = b;
    edgeHead = (edgeHead + 1) & 15;
  };
  const pushVertex = (/** @type {number} */ v) => {
    verts[vertHead] = v;
    vertHead = (vertHead + 1) & 15;
  };
  const vertexAt = (/** @type {number} */ i) => verts[(vertHead - 1 - i) & 15];
  const fifoIndex = (/** @type {number} */ v, /** @type {number} */ from, /** @type {number} */ to) => {
    for (let i = from; i <= to; i++) if (vertexAt(i) === v) return i;
    return -1;
  };
  const codes = new Uint8Array(triangles),
    result = new Uint32Array(indices.length);
  /** @type {number[]} */
  const data = [];
  const varintSize = (/** @type {number} */ id, /** @type {number} */ from) => {
    const d = (id - from) | 0,
      z = ((d << 1) ^ (d >> 31)) >>> 0;
    return z < 128 ? 1 : z < 16384 ? 2 : z < 2097152 ? 3 : z < 268435456 ? 4 : 5;
  };
  const putVarint = (/** @type {number} */ id) => {
    const d = (id - last) | 0;
    let z = ((d << 1) ^ (d >> 31)) >>> 0;
    while (z >= 128) {
      data.push((z & 127) | 128);
      z >>>= 7;
    }
    data.push(z);
    last = id;
  };

  for (let t = 0; t < triangles; t++) {
    const o = [indices[t * 3], indices[t * 3 + 1], indices[t * 3 + 2]];
    for (const v of o)
      if (!(v >= 0 && v < vertexCount)) throw new RangeError(`meshopt index ${v} is outside the vertices`);
    // Best edge-fifo candidate over the three rotations of the triangle.
    let best = null;
    for (let r = 0; r < 3; r++) {
      const x = map[o[r]],
        y = map[o[(r + 1) % 3]],
        zOld = o[(r + 2) % 3],
        z = map[zOld];
      if (x < 0 || y < 0) continue;
      for (let hi = 0; hi < 15; hi++) {
        const e = (edgeHead - 1 - hi) & 15;
        if (edgeA[e] !== x || edgeB[e] !== y) continue;
        let lo = 0,
          cost = 0;
        if (z >= 0) {
          const f = fifoIndex(z, 1, 14);
          if (f > 0) lo = f;
          else {
            lo = 15;
            cost = varintSize(z, last);
          }
        }
        if (!best || cost < best.cost || (cost === best.cost && hi < best.hi)) best = { r, hi, lo, cost };
        break;
      }
    }
    if (best) {
      const { r, hi, lo } = best,
        x = map[o[r]],
        y = map[o[(r + 1) % 3]],
        zOld = o[(r + 2) % 3];
      let z = map[zOld];
      codes[t] = (hi << 4) | lo;
      if (lo === 0) {
        z = next++;
        map[zOld] = z;
        pushVertex(z);
      } else if (lo === 15) {
        putVarint(z);
        pushVertex(z);
      }
      pushEdge(z, y);
      pushEdge(x, z);
      result[t * 3] = x;
      result[t * 3 + 1] = y;
      result[t * 3 + 2] = z;
      continue;
    }

    // No edge to continue from: a first vertex plus two described by one code-aux byte.
    let pick = null;
    for (let r = 0; r < 3; r++) {
      const ids = [o[r], o[(r + 1) % 3], o[(r + 2) % 3]];
      const aNew = map[ids[0]] < 0;
      if (!aNew && pick?.aNew) continue;
      // Plan the three vertices in order; new ones take consecutive ids after the first.
      let n = next,
        l = last,
        extra = 0;
      /** @type {number[]} */
      const refs = [];
      const seen = new Map();
      const plan = ids.map((old, k) => {
        const known = seen.get(old);
        if (known !== undefined) return { id: known, code: -1 };
        const m = map[old];
        if (m < 0) {
          const id = n++;
          seen.set(old, id);
          return { id, code: 0 };
        }
        if (k === 0) {
          extra += varintSize(m, l);
          l = m;
          return { id: m, code: 15 };
        }
        const f = fifoIndex(m, 0, 13);
        if (f >= 0) return { id: m, code: f + 1 };
        extra += varintSize(m, l);
        l = m;
        return { id: m, code: 15 };
      });
      void refs;
      if (plan.some((p) => p.code === -1)) throw new RangeError('meshopt triangle repeats a vertex');
      const z = plan[1].code,
        w = plan[2].code;
      const aux = (z << 4) | w;
      let table = aNew ? AUX.indexOf(aux) : -1;
      if (aNew && table < 0 && aux === 0) table = 0;
      // Data route: a code-aux byte (never 0, which would reset the new-vertex counter) plus explicit values.
      let cost = extra + (table >= 0 ? 0 : 1);
      if (!aNew && aux === 0) cost = Infinity;
      if (!pick || cost < pick.cost) pick = { r, ids, plan, z, w, aux, table, aNew, cost };
    }
    if (!pick || pick.cost === Infinity) throw new RangeError('meshopt triangle cannot be coded');
    const { ids, plan, z, w, aux, table, aNew } = pick;
    const lo = table >= 0 ? table : aNew ? 14 : 15;
    codes[t] = 0xf0 | lo;
    if (table < 0) data.push(aux);
    // Emit in decoder order: a, then b and c.
    const resolved = [0, 0, 0];
    for (let k = 0; k < 3; k++) {
      const p = plan[k];
      if (p.code === 0) {
        resolved[k] = next++;
        map[ids[k]] = resolved[k];
      } else {
        resolved[k] = p.id;
        if (p.code === 15) putVarint(p.id);
      }
    }
    const [a, b, c] = resolved;
    pushEdge(b, a);
    pushEdge(c, b);
    pushEdge(a, c);
    pushVertex(a);
    if (z === 0 || z === 15) pushVertex(b);
    if (w === 0 || w === 15) pushVertex(c);
    result[t * 3] = a;
    result[t * 3 + 1] = b;
    result[t * 3 + 2] = c;
  }

  const bytes = new Uint8Array(1 + triangles + data.length + 16);
  bytes[0] = 0xe0;
  bytes.set(codes, 1);
  bytes.set(data, 1 + triangles);
  for (let i = 0; i < 14; i++) bytes[bytes.length - 16 + i] = AUX[i];
  // Vertices no triangle uses follow the used ones.
  const remap = new Uint32Array(vertexCount);
  for (let v = 0; v < vertexCount; v++) remap[v] = map[v] >= 0 ? map[v] : next++;
  return { bytes, remap, indices: result };
}
