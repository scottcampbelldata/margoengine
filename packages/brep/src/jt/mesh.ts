// JT 9 tessellated shapes: the Tri-Strip Set Shape LOD element's topologically compressed mesh (JT File Format Reference
// 9.5, 7.2.2.1.2.5-6), rebuilt by the polygon mesh topology decoder of Appendix E, with its vertex coordinates (8.1.4,
// quantized or as float bits) and normals (8.1.5, Deering-coded or as float bits). The coder visits the mesh's dual:
// each dual vertex is a polygon (its valence the polygon's size, usually 3) and each dual face a mesh vertex (its degree
// the number of polygons around it). Cover polygons added to close open meshes are flagged and dropped.
//
// This software reads the JT Data Format as described in the Siemens JT File Format Reference and ISO 14306. Copyright
// in the JT data structures and operators is owned by Siemens Product Lifecycle Management Software Inc. (Siemens
// Digital Industries Software) and they are used under the Siemens JT Data Format Reference Intellectual Property
// License Terms. US 8,019,788, US 2011/0199382 and corresponding foreign patents are licensed royalty-free under the
// Siemens JT Data Format Reference Patent Clarification Notice. JT and Parasolid are trademarks of Siemens; they are
// named here only to identify the format. This software is not endorsed by or affiliated with Siemens.
import { hash16, hash32, int32Packet2, Predictor, unpack } from './codec.js';
import { type JTContainer, type JTReader, fail, readElement } from './file.js';

/** A tessellated shape. */
export interface JTMesh {
  /** Vertex positions in metres, three per vertex. */
  readonly positions: Float32Array;
  /** Unit vertex normals, three per vertex, when the file stores them. */
  readonly normals?: Float32Array;
  /** Three vertex indices per triangle, counter-clockwise seen from outside. */
  readonly indices: Uint32Array;
  /** Face group of each triangle (by the format's convention, the B-rep face it came from). */
  readonly groups: Int32Array;
}

export const TRI_STRIP_LOD = '10dd10ab-2ac8-11d1-9b6b-0080c7bb5997';

/** The topology coder's symbol streams (Topologically Compressed Rep Data). */
interface Symbols {
  readonly degrees: Int32Array[];
  readonly valences: Int32Array;
  readonly groups: Int32Array;
  readonly flags: Int32Array;
  /** Per context, the attribute mask bits 0-29; context 7 also has bits 30-59 and 60-63. */
  readonly masks: Int32Array[];
  readonly masks7Mid: Int32Array;
  readonly masks7Top: Int32Array;
  readonly large: Uint32Array;
  readonly splitFaces: Int32Array;
  readonly splitPositions: Int32Array;
}

function readSymbols(r: JTReader): Symbols {
  const packet = () => int32Packet2(r),
    degrees = Array.from({ length: 8 }, packet),
    valences = packet(),
    groups = packet(),
    flags = unpack(packet(), Predictor.Lag1),
    masks = Array.from({ length: 8 }, packet),
    masks7Mid = packet(),
    masks7Top = packet(),
    large = r.vecU32(),
    splitFaces = unpack(packet(), Predictor.Lag1),
    splitPositions = packet(),
    stored = r.u32();
  let h = 0;
  for (const d of degrees) h = hash32(d, h);
  h = hash32(valences, h);
  h = hash32(groups, h);
  h = hash16(flags, h);
  for (const m of masks) h = hash32(m, h);
  h = hash32(masks7Mid, h);
  h = hash32(masks7Top, h);
  h = hash32(large, h);
  h = hash32(splitFaces, h);
  h = hash32(splitPositions, h);
  if (h !== stored) fail(`mesh topology hash ${h.toString(16)} does not match the stored ${stored.toString(16)}`);
  return { degrees, valences, groups, flags, masks, masks7Mid, masks7Top, large, splitFaces, splitPositions };
}

/** The dual mesh as the decoder builds it: dual vertices (polygons) and dual faces (mesh vertices), linked by slots. */
class DualMeshDecoder {
  // Dual vertices.
  readonly valence: number[] = [];
  readonly group: number[] = [];
  readonly flag: number[] = [];
  private readonly vStart: number[] = [];
  readonly vFaces: number[] = [];
  // Dual faces.
  readonly degree: number[] = [];
  private readonly empty: number[] = [];
  private readonly fStart: number[] = [];
  readonly fVerts: number[] = [];
  /** Attribute mask bit per face slot, parallel to fVerts. */
  readonly fBits: number[] = [];
  /** First attribute record number of each face and how many it has. */
  readonly fAttr: number[] = [];
  readonly fAttrs: number[] = [];
  attributes = 0;

  private readonly active: number[] = [];
  private readonly removed: boolean[] = [];
  private readonly pos = {
    degree: new Int32Array(8),
    mask: new Int32Array(8),
    val: 0,
    large: 0,
    split: 0,
    splitPos: 0,
  };

  constructor(private readonly s: Symbols) {}

  face(v: number, slot: number) {
    return this.vFaces[this.vStart[v] + slot];
  }
  vtx(f: number, slot: number) {
    return this.fVerts[this.fStart[f] + slot];
  }
  slotOfVtx(f: number, v: number): number {
    const at = this.fStart[f];
    for (let k = 0; k < this.degree[f]; k++) if (this.fVerts[at + k] === v) return k;
    return -1;
  }
  slotOfFace(v: number, f: number): number {
    const at = this.vStart[v];
    for (let k = 0; k < this.valence[v]; k++) if (this.vFaces[at + k] === f) return k;
    return -1;
  }
  private setVtxFace(v: number, slot: number, f: number) {
    this.vFaces[this.vStart[v] + slot] = f;
  }
  private setFaceVtx(f: number, slot: number, v: number) {
    const i = this.fStart[f] + slot;
    if (this.fVerts[i] !== v) this.empty[f]--;
    this.fVerts[i] = v;
  }

  /** Reads a valence (and the vertex's group and flag) and makes a dual vertex; -1 when the valences are used up. */
  private ioVtx(): number {
    const s = this.s,
      p = this.pos;
    if (p.val >= s.valences.length) return -1;
    const valence = s.valences[p.val],
      group = p.val < s.groups.length ? s.groups[p.val] : -1,
      flag = p.val < s.flags.length ? s.flags[p.val] : 0;
    p.val++;
    if (valence < 1 || valence > 1 << 16) fail(`dual vertex valence ${valence}`);
    const v = this.valence.length;
    this.valence.push(valence);
    this.group.push(group);
    this.flag.push(flag);
    this.vStart.push(this.vFaces.length);
    for (let k = 0; k < valence; k++) this.vFaces.push(-1);
    return v;
  }

  /** The degree context of a new face on dual vertex v, from v's valence and its known faces' degrees. */
  private context(v: number): number {
    const valence = this.valence[v];
    let known = 0,
      total = 0;
    for (let k = 0; k < valence; k++) {
      const f = this.face(v, k);
      if (f < 0) continue;
      known++;
      total += this.degree[f];
    }
    if (valence === 3) return total < known * 6 ? 0 : total === known * 6 ? 1 : 2;
    if (valence === 4) return total < known * 4 ? 3 : total === known * 4 ? 4 : 5;
    return valence === 5 ? 6 : 7;
  }

  /** Reads a degree and makes a dual face with its attribute mask; -1 for a split (degree symbol 0). */
  private ioFace(v: number): number {
    const s = this.s,
      p = this.pos,
      c = this.context(v),
      list = s.degrees[c];
    if (p.degree[c] >= list.length) fail(`face degree symbols of context ${c} run out`);
    const degree = list[p.degree[c]++];
    if (degree === 0) return -1;
    if (degree < 0 || degree > 1 << 20) fail(`dual face degree ${degree}`);
    const f = this.degree.length;
    this.degree.push(degree);
    this.empty.push(degree);
    this.fStart.push(this.fVerts.length);
    let count = 0;
    if (degree <= 64) {
      const m = Math.min(7, Math.max(0, degree - 2)),
        i = p.mask[m]++,
        lo = i < s.masks[m].length ? s.masks[m][i] : 0,
        mid = m === 7 && i < s.masks7Mid.length ? s.masks7Mid[i] : 0,
        top = m === 7 && i < s.masks7Top.length ? s.masks7Top[i] : 0;
      for (let k = 0; k < degree; k++) {
        const bit = k < 30 ? (lo >>> k) & 1 : k < 60 ? (mid >>> (k - 30)) & 1 : (top >>> (k - 60)) & 1;
        this.fVerts.push(-1);
        this.fBits.push(bit);
        count += bit;
      }
    } else {
      const words = Math.ceil(degree / 32),
        has = p.large < s.large.length;
      for (let k = 0; k < degree; k++) {
        const bit = has ? (s.large[p.large + (k >>> 5)] >>> (k & 31)) & 1 : 0;
        this.fVerts.push(-1);
        this.fBits.push(bit);
        count += bit;
      }
      if (has) p.large += words;
    }
    this.fAttr.push(this.attributes);
    this.fAttrs.push(count);
    this.attributes += count;
    this.removed.push(false);
    return f;
  }

  private activateF(v: number, slot: number): number {
    let f = this.ioFace(v);
    if (f >= 0) {
      this.setVtxFace(v, slot, f);
      this.setFaceVtx(f, 0, v);
      this.active.push(f);
    } else {
      const p = this.pos,
        offset = p.split < this.s.splitFaces.length ? this.s.splitFaces[p.split++] : -1,
        position = p.splitPos < this.s.splitPositions.length ? this.s.splitPositions[p.splitPos++] : -1;
      if (offset < 1 || offset > this.active.length) fail(`split face offset ${offset}`);
      f = this.active[this.active.length - offset];
      if (position < 0 || position >= this.degree[f]) fail(`split position ${position}`);
      this.setVtxFace(v, slot, f);
      this.addVtxToFace(v, slot, f, position);
    }
    return f;
  }

  private activateV(f: number, slot: number): number {
    const v = this.ioVtx();
    if (v < 0) fail('vertex valence symbols run out');
    this.setVtxFace(v, 0, f);
    this.addVtxToFace(v, 0, f, slot);
    return v;
  }

  /** Puts dual vertex v in face f's slot, and links v to the faces across the edges to f's neighbouring vertices. */
  private addVtxToFace(v: number, vSlot: number, f: number, fSlot: number) {
    const deg = this.degree[f],
      val = this.valence[v],
      ccw = (fSlot + 1) % deg,
      cw = (fSlot + deg - 1) % deg;
    this.setFaceVtx(f, fSlot, v);
    const fp = this.vtx(f, cw);
    if (fp !== -1) {
      const next = (vSlot + 1) % val;
      if (this.face(v, next) === -1) {
        const ip = this.slotOfFace(fp, f),
          n = this.valence[fp];
        this.setVtxFace(v, next, this.face(fp, (ip + n - 1) % n));
      }
    }
    const fn = this.vtx(f, ccw);
    if (fn !== -1) {
      const prev = (vSlot + val - 1) % val;
      if (this.face(v, prev) === -1) {
        const ip = this.slotOfFace(fn, f),
          n = this.valence[fn];
        this.setVtxFace(v, prev, this.face(fn, (ip + 1) % n));
      }
    }
  }

  /** Links dual vertex v (in slot `slot` of its face 0) to faces reachable around it, then activates the rest. */
  private completeV(v: number, slot: number) {
    const val = this.valence[v];
    let vp = this.face(v, 0),
      jp = slot,
      i = 1;
    for (let vn = this.face(v, i); vn !== -1; vn = this.face(v, i)) {
      jp = (jp + this.degree[vp] - 1) % this.degree[vp];
      const other = this.vtx(vp, jp);
      if (other === -1) break;
      let jn = this.slotOfVtx(vn, other);
      if (jn < 0) fail('dual mesh rings disagree');
      jn = (jn + this.degree[vn] - 1) % this.degree[vn];
      this.addVtxToFace(v, i, vn, jn);
      vp = vn;
      jp = jn;
      if (++i >= val) return;
    }
    let last = i;
    vp = this.face(v, 0);
    jp = slot;
    i = val - 1;
    for (let vn = this.face(v, i); vn !== -1; vn = this.face(v, i)) {
      jp = (jp + 1) % this.degree[vp];
      const other = this.vtx(vp, jp);
      if (other === -1) break;
      let jn = this.slotOfVtx(vn, other);
      if (jn < 0) fail('dual mesh rings disagree');
      jn = (jn + 1) % this.degree[vn];
      this.addVtxToFace(v, i, vn, jn);
      vp = vn;
      jp = jn;
      if (--i < last) return;
    }
    for (; last <= i; last++) this.activateF(v, last);
  }

  private completeF(f: number) {
    for (let j = this.slotOfVtx(f, -1); j !== -1; j = this.slotOfVtx(f, -1)) {
      const v = this.activateV(f, j);
      this.completeV(v, j);
    }
  }

  /** Of the last 16 active faces, the one with the fewest empty slots (the latest on a tie). */
  private nextActiveFace(): number {
    const a = this.active;
    while (a.length && this.removed[a[a.length - 1]]) a.pop();
    let best = -1,
      fewest = Number.POSITIVE_INFINITY;
    for (let i = a.length - 1; i >= Math.max(0, a.length - 16); i--) {
      const f = a[i];
      if (this.removed[f]) {
        a.splice(i, 1);
        continue;
      }
      if (this.empty[f] < fewest) {
        fewest = this.empty[f];
        best = f;
      }
    }
    return best;
  }

  run() {
    for (let v = this.ioVtx(); v !== -1; v = this.ioVtx()) {
      for (let k = 0; k < this.valence[v]; k++) this.activateF(v, k);
      for (let f = this.nextActiveFace(); f !== -1; f = this.nextActiveFace()) {
        this.completeF(f);
        this.removed[f] = true;
      }
    }
    const p = this.pos,
      s = this.s;
    if (p.split !== s.splitFaces.length || p.splitPos !== s.splitPositions.length)
      fail('mesh topology left split symbols unread');
    for (let c = 0; c < 8; c++)
      if (p.degree[c] !== s.degrees[c].length) fail(`mesh topology left degree symbols of context ${c} unread`);
  }

  /** The attribute record of mesh vertex f as seen from polygon v (the last set mask bit at or before v's slot). */
  attribute(f: number, v: number): number {
    if (this.fAttrs[f] === 0) return -1;
    const at = this.fStart[f],
      k = this.slotOfVtx(f, v);
    let rank = 0;
    for (let i = 0; i <= k; i++) rank += this.fBits[at + i];
    return this.fAttr[f] + (rank === 0 ? this.fAttrs[f] : rank) - 1;
  }
}

/** Reads a float from its stored sign-and-exponent and mantissa fields (F32: 9 and 23 bits). */
const view = new DataView(new ArrayBuffer(4));
function float(exponent: number, mantissa: number): number {
  view.setUint32(0, ((exponent << 23) | (mantissa & 0x7fffff)) >>> 0);
  return view.getFloat32(0);
}

/** Compressed Vertex Coordinate Array (8.1.4): xyz per topological vertex. */
function readCoordinates(r: JTReader): Float32Array {
  const count = r.i32(),
    components = r.u8(),
    quantizers = [0, 1, 2].map(() => ({ min: r.f32(), max: r.f32(), bits: r.u8() }));
  if (count < 0 || components < 1 || components > 4) fail(`vertex coordinates ${count} x ${components}`);
  const out = new Float32Array(count * 3),
    bits = quantizers[0].bits;
  let h = 0;
  for (let c = 0; c < components; c++) {
    if (bits === 0) {
      const exponents = unpack(int32Packet2(r), Predictor.Lag1),
        mantissae = unpack(int32Packet2(r), Predictor.Lag1);
      for (let i = 0; i < count; i++) {
        const v = float(exponents[i], mantissae[i]);
        if (c < 3) out[i * 3 + c] = v;
        view.setFloat32(0, v);
        h = hash32([view.getUint32(0)], h);
      }
    } else {
      const codes = unpack(int32Packet2(r), Predictor.Lag1),
        q = quantizers[Math.min(c, 2)],
        step = (q.max - q.min) / (q.bits >= 32 ? 0xffffffff : 2 ** q.bits - 1);
      if (codes.length !== count) fail(`${codes.length} coordinate codes for ${count} vertices`);
      if (c < 3) for (let i = 0; i < count; i++) out[i * 3 + c] = q.min + (codes[i] >>> 0) * step;
      h = hash32(codes, h);
    }
  }
  const stored = r.u32();
  if (h !== stored) fail(`vertex coordinate hash ${h.toString(16)} does not match the stored ${stored.toString(16)}`);
  return out;
}

/** A Deering-coded normal (Appendix C 4.2): sextant and octant of the sphere, then two angles of `bits` bits. */
function deering(
  sextant: number,
  octant: number,
  theta: number,
  psi: number,
  bits: number,
  out: Float32Array,
  i: number,
) {
  const psiMax = 0.615479709,
    range = 2 ** bits,
    t = Math.asin(Math.tan((psiMax * (range - (theta + (sextant & 1)))) / range)),
    p = (psiMax * psi) / range,
    xx = Math.cos(t) * Math.cos(p),
    yy = Math.sin(p),
    zz = Math.sin(t) * Math.cos(p);
  let x = xx,
    y = yy,
    z = zz;
  switch (sextant) {
    case 1:
      z = xx;
      x = zz;
      break;
    case 2:
      z = xx;
      x = yy;
      y = zz;
      break;
    case 3:
      y = xx;
      x = yy;
      break;
    case 4:
      y = xx;
      z = yy;
      x = zz;
      break;
    case 5:
      z = yy;
      y = zz;
      break;
  }
  out[i * 3] = octant & 4 ? x : -x;
  out[i * 3 + 1] = octant & 2 ? y : -y;
  out[i * 3 + 2] = octant & 1 ? z : -z;
}

/** Compressed Vertex Normal Array (8.1.5): one normal per vertex attribute record. */
function readNormals(r: JTReader): Float32Array {
  const count = r.i32(),
    components = r.u8(),
    bits = r.u8();
  if (count < 0 || components < 1 || components > 4) fail(`vertex normals ${count} x ${components}`);
  const out = new Float32Array(count * 3);
  let h = 0;
  if (bits === 0) {
    for (let c = 0; c < components; c++) {
      const exponents = int32Packet2(r),
        mantissae = int32Packet2(r);
      for (let i = 0; i < count; i++) {
        const v = float(exponents[i], mantissae[i]);
        if (c < 3) out[i * 3 + c] = v;
        view.setFloat32(0, v);
        h = hash32([view.getUint32(0)], h);
      }
    }
  } else {
    const sextant = int32Packet2(r),
      octant = int32Packet2(r),
      theta = int32Packet2(r),
      psi = int32Packet2(r);
    if (sextant.length !== count || octant.length !== count || theta.length !== count || psi.length !== count)
      fail('normal code arrays of different lengths');
    for (let i = 0; i < count; i++) deering(sextant[i], octant[i], theta[i], psi[i], bits, out, i);
    h = hash32(psi, hash32(theta, hash32(octant, hash32(sextant, h))));
  }
  const stored = r.u32();
  if (h !== stored) fail(`vertex normal hash ${h.toString(16)} does not match the stored ${stored.toString(16)}`);
  return out;
}

/**
 * Reads a Tri-Strip Set Shape LOD segment into a triangle mesh in metres (`unit` metres per file unit). Throws a
 * TypeError for malformed or inconsistent data and a RangeError for a coding this reader does not support yet.
 */
export function readTriStripLOD(container: JTContainer, segment: string, unit: number): JTMesh {
  if (container.version >= 10)
    throw new RangeError('JT 10 tessellated shapes are not supported yet (JT 9 shapes and JT 10 XT B-rep are)');
  const r = container.data(segment),
    element = readElement(r) ?? fail(`segment ${segment} holds no element`);
  if (element.type !== TRI_STRIP_LOD) fail(`segment ${segment} holds ${element.type}, not a tri-strip set LOD`);
  const d = element.data;
  d.i16(); // base shape LOD data version
  d.i16(); // vertex shape LOD data version
  d.u32();
  d.u32(); // vertex bindings (repeated with the vertex records)
  d.i16(); // TopoMesh LOD data version
  d.i32(); // vertex records object ID
  d.i16(); // topologically compressed LOD data version
  const symbols = readSymbols(d);

  // Topologically Compressed Vertex Records.
  const a = d.u32(),
    b = d.u32(),
    low = d.little ? a : b;
  d.need(4); // quantization parameters (each array carries its own)
  const vertices = d.i32(),
    records = vertices > 0 ? d.i32() : 0,
    coordinates = low & 7 ? readCoordinates(d) : undefined,
    normals = low & 8 && records > 0 ? readNormals(d) : undefined;

  const mesh = new DualMeshDecoder(symbols);
  mesh.run();
  const nFaces = mesh.degree.length;
  if (vertices !== nFaces) fail(`${vertices} topological vertices stored, ${nFaces} decoded`);
  if (!coordinates || coordinates.length / 3 !== nFaces)
    return fail('vertex coordinates missing or of the wrong count');
  if (records !== mesh.attributes) fail(`${records} vertex records stored, ${mesh.attributes} decoded`);
  if (normals && normals.length / 3 !== records) fail(`${normals.length / 3} normals for ${records} vertex records`);

  // Output vertices: one per attribute record (its mesh vertex's position), or one per mesh vertex without records.
  const byRecord = records > 0,
    count = byRecord ? records : nFaces,
    owner = new Int32Array(count);
  if (byRecord) {
    for (let f = 0; f < nFaces; f++) for (let k = 0; k < mesh.fAttrs[f]; k++) owner[mesh.fAttr[f] + k] = f;
  } else for (let f = 0; f < nFaces; f++) owner[f] = f;
  const positions = new Float32Array(count * 3);
  for (let i = 0; i < count; i++)
    for (let c = 0; c < 3; c++) positions[i * 3 + c] = coordinates[owner[i] * 3 + c] * unit;

  const indices: number[] = [],
    groups: number[] = [],
    corner: number[] = [];
  let at = 0;
  for (let v = 0; v < mesh.valence.length; v++) {
    const n = mesh.valence[v];
    if (mesh.flag[v] === 0) {
      corner.length = 0;
      for (let k = 0; k < n; k++) {
        const f = mesh.vFaces[at + k];
        if (f < 0) fail(`polygon ${v} is not closed`);
        const record = byRecord ? mesh.attribute(f, v) : f;
        if (record < 0) fail(`mesh vertex ${f} has no vertex record`);
        corner.push(record);
      }
      for (let k = 1; k + 1 < n; k++) {
        indices.push(corner[0], corner[k], corner[k + 1]);
        groups.push(mesh.group[v]);
      }
    }
    at += n;
  }
  const out = Uint32Array.from(indices);
  // The ring order fixes the winding; where the file stores normals, follow them.
  if (normals) {
    let agree = 0;
    for (let t = 0; t < out.length; t += 3) {
      const [i, j, k] = [out[t], out[t + 1], out[t + 2]],
        p = (n: number, c: number) => positions[n * 3 + c],
        ux = p(j, 0) - p(i, 0),
        uy = p(j, 1) - p(i, 1),
        uz = p(j, 2) - p(i, 2),
        vx = p(k, 0) - p(i, 0),
        vy = p(k, 1) - p(i, 1),
        vz = p(k, 2) - p(i, 2),
        nx = uy * vz - uz * vy,
        ny = uz * vx - ux * vz,
        nz = ux * vy - uy * vx;
      for (const n of [i, j, k]) agree += nx * normals[n * 3] + ny * normals[n * 3 + 1] + nz * normals[n * 3 + 2];
    }
    if (agree < 0)
      for (let t = 0; t < out.length; t += 3) {
        const s = out[t + 1];
        out[t + 1] = out[t + 2];
        out[t + 2] = s;
      }
  }
  return { positions, normals, indices: out, groups: Int32Array.from(groups) };
}
