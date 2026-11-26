// MikuMikuDance files: PMD and PMX models, VMD motion and camera clips. Read from the public format descriptions (the PMD
// 1.0 layout, the PMX 2.0 and 2.1 specification and the VMD layout). MMD is left-handed and measures in units of about
// 8 cm; `rightHanded` (default true) mirrors Z into the engine's space and `scale` (default 0.08) turns units into metres.
// Rigid bodies and joints are parsed into data only: this package never simulates them.
import { LoaderError, type LoadedGeometry, type LoadedGroup, type ParseLimits } from './types.js';
import { DEFAULT_MAX_TRIANGLES, DEFAULT_MAX_VERTICES, toBytes, type BinaryInput } from './util.js';

const F = 'MMD';

/** Options of the MMD parsers: the shared size limits, the space conversion and the bounds below. */
export interface MMDOptions extends ParseLimits {
  /** Metres per MMD unit. Default 0.08. */
  scale?: number;
  /** Mirror MMD's left-handed Z into the engine's space and keep the winding. Default true. */
  rightHanded?: boolean;
}

/** A material of a PMX or PMD model, with the run of triangles it draws. */
export interface MMDMaterial {
  name: string;
  nameEnglish: string;
  diffuse: [number, number, number, number];
  specular: [number, number, number];
  specularPower: number;
  ambient: [number, number, number];
  /** Both faces are drawn (PMX flag 1; PMD: a diffuse alpha under 1 does not imply it). */
  doubleSided: boolean;
  /** Outline drawing: PMX flag 16 or PMD `edge_flag`. */
  edge: boolean;
  edgeColor: [number, number, number, number];
  edgeSize: number;
  /** Texture path (PMX: from the texture table; PMD: the part before `*`), or undefined. */
  texture?: string;
  /** Sphere map path and mode (0 none, 1 multiply, 2 add, 3 sub-texture). */
  sphere?: string;
  sphereMode: number;
  /** A shared toon number 0 to 9 (`toon<n+1>.bmp`), or a texture path. */
  toon?: number | string;
  /** Number of triangles; the material's group of `geometry` has this many. */
  triangles: number;
}

/** A bone of a PMX or PMD model: its rest position, parent, flags, grant and IK chain. */
export interface MMDBone {
  name: string;
  nameEnglish: string;
  /** Rest position in the engine's space. */
  position: [number, number, number];
  /** -1 for a root. */
  parent: number;
  /** PMX deform layer (0 for PMD). */
  layer: number;
  /** PMX flags (see the specification); PMD bones set `visible`, `rotatable` and `ik`. */
  rotatable: boolean;
  translatable: boolean;
  visible: boolean;
  /** PMD bone type 0 to 9, or -1 for PMX. */
  type: number;
  /** Tail bone index, or -1 when the tail is an offset. */
  tail: number;
  tailOffset?: [number, number, number];
  /** Inherit rotation or translation from this bone (PMX grant), at `inheritRate`. */
  inheritRotation: boolean;
  inheritTranslation: boolean;
  inherit: number;
  inheritRate: number;
  afterPhysics: boolean;
  ik?: {
    target: number;
    iterations: number;
    limitAngle: number;
    links: { bone: number; limit?: { min: number[]; max: number[] } }[];
  };
}

/** A morph of a PMX or PMD model: its panel, type and raw offsets. */
export interface MMDMorph {
  name: string;
  nameEnglish: string;
  /** Panel 0 system, 1 eyebrows, 2 eyes, 3 mouth, 4 other. */
  panel: number;
  type: 'group' | 'vertex' | 'bone' | 'uv' | 'uv1' | 'uv2' | 'uv3' | 'uv4' | 'material' | 'flip' | 'impulse';
  /** The offsets, as the type reads them: `{morph, rate}`, `{vertex, offset}`, `{bone, translation, rotation}`, and so on. */
  offsets: Record<string, unknown>[];
}

/** A rigid body, as data only: this package never simulates it. Positions and sizes are in the engine's units. */
export interface MMDRigidBody {
  name: string;
  nameEnglish: string;
  bone: number;
  group: number;
  /** Bit mask of groups it does not collide with. */
  noCollide: number;
  shape: 'sphere' | 'box' | 'capsule';
  size: [number, number, number];
  position: [number, number, number];
  /** Euler angles in radians. */
  rotation: [number, number, number];
  mass: number;
  linearDamping: number;
  angularDamping: number;
  restitution: number;
  friction: number;
  /** 'bone' follows the bone, 'physics' is driven, 'physicsBone' is driven and aligned to the bone. */
  mode: 'bone' | 'physics' | 'physicsBone';
}

/** A joint between two rigid bodies, as data only. */
export interface MMDJoint {
  name: string;
  nameEnglish: string;
  type: number;
  bodyA: number;
  bodyB: number;
  position: [number, number, number];
  rotation: [number, number, number];
  limitPositionMin: [number, number, number];
  limitPositionMax: [number, number, number];
  limitRotationMin: [number, number, number];
  limitRotationMax: [number, number, number];
  springPosition: [number, number, number];
  springRotation: [number, number, number];
}

/** A parsed PMD or PMX model. */
export interface LoadedMMD {
  format: 'PMD' | 'PMX';
  version: number;
  name: string;
  nameEnglish: string;
  comment: string;
  commentEnglish: string;
  /** Triangles; one group per material (`properties.materialIndex`). `attributes` may hold `uv1` to `uv4` (4 each) and `edgeScale`. */
  geometry: LoadedGeometry;
  /** Four bone indices per vertex and their weights; `skinning` names the PMX weight type used. */
  joints: Uint16Array;
  weights: Float32Array;
  /** SDEF vertices: `vertices` index them, `data` holds C, R0 and R1 (9 values each) in the engine's space. */
  sdef?: { vertices: Uint32Array; data: Float32Array };
  materials: MMDMaterial[];
  /** PMX texture table (PMD has none: textures are on the materials). */
  textures: string[];
  bones: MMDBone[];
  morphs: MMDMorph[];
  rigidBodies: MMDRigidBody[];
  joints_: MMDJoint[];
  warnings: string[];
}

// ---- reading helpers ------------------------------------------------------------------------------------------------

const fail = (code: 'header' | 'truncated' | 'range' | 'limit' | 'syntax' | 'unsupported', m: string): never => {
  throw new LoaderError(F, code, m);
};

class Reader {
  p = 0;
  readonly view: DataView;
  constructor(
    readonly bytes: Uint8Array,
    private readonly sjis: boolean,
    private utf16 = false,
  ) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  get left(): number {
    return this.bytes.length - this.p;
  }
  need(n: number, what = 'data'): void {
    if (!(n >= 0) || n > this.left) fail('truncated', `${what} runs past the end of the file`);
  }
  /** `count` records of at least `size` bytes must fit in what is left. */
  records(count: number, size: number, what: string): number {
    if (!Number.isSafeInteger(count) || count < 0) fail('syntax', `bad ${what} count ${count}`);
    if (count * size > this.left) fail('truncated', `${count} ${what} announced, data for fewer`);
    return count;
  }
  u8(): number {
    this.need(1);
    return this.bytes[this.p++];
  }
  i8(): number {
    this.need(1);
    return this.view.getInt8(this.p++);
  }
  u16(): number {
    this.need(2);
    const v = this.view.getUint16(this.p, true);
    this.p += 2;
    return v;
  }
  i16(): number {
    this.need(2);
    const v = this.view.getInt16(this.p, true);
    this.p += 2;
    return v;
  }
  u32(): number {
    this.need(4);
    const v = this.view.getUint32(this.p, true);
    this.p += 4;
    return v;
  }
  i32(): number {
    this.need(4);
    const v = this.view.getInt32(this.p, true);
    this.p += 4;
    return v;
  }
  f32(): number {
    this.need(4);
    const v = this.view.getFloat32(this.p, true);
    this.p += 4;
    return Number.isFinite(v) ? v : 0;
  }
  vec(n: number): number[] {
    const out: number[] = [];
    for (let i = 0; i < n; i++) out.push(this.f32());
    return out;
  }
  skip(n: number): void {
    this.need(n);
    this.p += n;
  }
  /** An index of `size` bytes: signed (-1 means none) for bones, textures and the like, unsigned for vertices. */
  index(size: number, signed: boolean): number {
    if (size === 1) return signed ? this.i8() : this.u8();
    if (size === 2) return signed ? this.i16() : this.u16();
    return this.i32();
  }
  /** A fixed-width Shift-JIS field, cut at the first zero byte. */
  fixed(n: number): string {
    this.need(n);
    let end = 0;
    while (end < n && this.bytes[this.p + end] !== 0) end++;
    const s = decode(this.bytes.subarray(this.p, this.p + end), 'shift_jis');
    this.p += n;
    return s;
  }
  /** A PMX text: a 32-bit byte length and the characters in the model's encoding. */
  text(): string {
    const n = this.i32();
    if (n < 0) fail('syntax', 'negative text length');
    this.need(n, 'a text');
    const s = decode(this.bytes.subarray(this.p, this.p + n), this.utf16 ? 'utf-16le' : 'utf-8');
    this.p += n;
    return s;
  }
}

function decode(bytes: Uint8Array, label: string): string {
  try {
    return new TextDecoder(label).decode(bytes);
  } catch {
    let s = '';
    for (const b of bytes) s += String.fromCharCode(b);
    return s;
  }
}

function conversion(options: MMDOptions) {
  const scale = options.scale ?? 0.08,
    rh = options.rightHanded ?? true;
  if (!(scale > 0) || !Number.isFinite(scale)) throw new LoaderError(F, 'range', 'scale must be positive and finite');
  const maxVertices = options.maxVertices ?? DEFAULT_MAX_VERTICES,
    maxTriangles = options.maxTriangles ?? DEFAULT_MAX_TRIANGLES;
  for (const [k, v] of Object.entries({ maxVertices, maxTriangles }))
    if (!Number.isSafeInteger(v) || v < 0) throw new LoaderError(F, 'range', `${k} must be a non-negative integer`);
  return {
    scale,
    rh,
    maxVertices,
    maxTriangles,
    point: (v: number[]): [number, number, number] => [v[0] * scale, v[1] * scale, (rh ? 0 - v[2] : v[2]) * scale],
    dir: (v: number[]): [number, number, number] => [v[0], v[1], rh ? 0 - v[2] : v[2]],
    // Euler angles mirror like an axis does: x and y turn the other way.
    euler: (v: number[]): [number, number, number] => (rh ? [0 - v[0], 0 - v[1], v[2]] : [v[0], v[1], v[2]]),
    quat: (q: number[]): [number, number, number, number] =>
      rh ? [0 - q[0], 0 - q[1], q[2], q[3]] : [q[0], q[1], q[2], q[3]],
    size: (v: number[]): [number, number, number] => [v[0] * scale, v[1] * scale, v[2] * scale],
  };
}
type Conv = ReturnType<typeof conversion>;

/** Common tail of both model parsers: triangles into a geometry with one group per material. */
function geometryOf(
  positions: Float32Array,
  normals: Float32Array,
  uvs: Float32Array,
  faces: Uint32Array,
  materials: MMDMaterial[],
  c: Conv,
  vertexCount: number,
): LoadedGeometry {
  if (faces.length % 3) fail('syntax', `${faces.length} face indices is not a multiple of 3`);
  if (faces.length / 3 > c.maxTriangles)
    fail('limit', `triangle count ${faces.length / 3} exceeds the limit of ${c.maxTriangles}`);
  for (let i = 0; i < faces.length; i++)
    if (faces[i] >= vertexCount) fail('range', `face index ${faces[i]} is past the ${vertexCount} vertices`);
  const indices = new Uint32Array(faces.length);
  for (let i = 0; i < faces.length; i += 3) {
    indices[i] = faces[i];
    indices[i + 1] = c.rh ? faces[i + 2] : faces[i + 1];
    indices[i + 2] = c.rh ? faces[i + 1] : faces[i + 2];
  }
  const groups: LoadedGroup[] = [];
  let start = 0;
  materials.forEach((m, i) => {
    const count = m.triangles * 3;
    if (start + count > indices.length) fail('range', `material ${i} covers faces past the face list`);
    groups.push({ start, count, name: m.name, properties: { materialIndex: i } });
    start += count;
  });
  const geometry: LoadedGeometry = { kind: 'mesh', positions, normals, uvs, indices };
  if (groups.length) geometry.groups = groups;
  return geometry;
}

// ---- PMD ------------------------------------------------------------------------------------------------------------

/**
 * Parses a PMD model (Polygon Model Data 1.0): vertices with two-bone weights, triangles by material, bones and IK,
 * morphs, the optional English names, and rigid bodies and joints as data. Shift-JIS names are decoded with
 * `TextDecoder('shift_jis')`.
 */
export function parsePMD(input: BinaryInput, options: MMDOptions = {}): LoadedMMD {
  const c = conversion(options),
    bytes = toBytes(input, F),
    r = new Reader(bytes, true);
  if (bytes.length < 283 || bytes[0] !== 0x50 || bytes[1] !== 0x6d || bytes[2] !== 0x64)
    throw new LoaderError(F, 'header', 'missing the "Pmd" signature');
  r.p = 3;
  const version = r.f32();
  if (version !== 1) fail('unsupported', `PMD version ${version} is not 1.0`);
  const name = r.fixed(20),
    comment = r.fixed(256);
  const nv = r.u32();
  if (nv > c.maxVertices) fail('limit', `vertex count ${nv} exceeds the limit of ${c.maxVertices}`);
  r.records(nv, 38, 'vertices');
  const positions = new Float32Array(nv * 3),
    normals = new Float32Array(nv * 3),
    uvs = new Float32Array(nv * 2),
    joints = new Uint16Array(nv * 4),
    weights = new Float32Array(nv * 4),
    edgeScale = new Float32Array(nv);
  for (let i = 0; i < nv; i++) {
    positions.set(c.point(r.vec(3)), i * 3);
    normals.set(c.dir(r.vec(3)), i * 3);
    uvs.set(r.vec(2), i * 2);
    joints[i * 4] = r.u16();
    joints[i * 4 + 1] = r.u16();
    const w = Math.min(100, r.u8()) / 100;
    weights[i * 4] = w;
    weights[i * 4 + 1] = 1 - w;
    edgeScale[i] = r.u8() ? 0 : 1; // edge_flag 1 turns the outline off for the vertex
  }
  const nf = r.u32();
  r.records(nf, 2, 'face indices');
  const faces = new Uint32Array(nf);
  for (let i = 0; i < nf; i++) faces[i] = r.u16();
  const nm = r.u32();
  r.records(nm, 70, 'materials');
  const materials: MMDMaterial[] = [];
  for (let i = 0; i < nm; i++) {
    const diffuse = r.vec(4),
      power = r.f32(),
      specular = r.vec(3),
      ambient = r.vec(3),
      toon = r.u8(),
      edge = r.u8() !== 0,
      count = r.u32(),
      tex = r.fixed(20).split('*');
    if (count % 3) fail('syntax', `material ${i} has ${count} indices`);
    const m: MMDMaterial = {
      name: `material_${i}`,
      nameEnglish: '',
      diffuse: diffuse as [number, number, number, number],
      specular: specular as [number, number, number],
      specularPower: power,
      ambient: ambient as [number, number, number],
      doubleSided: diffuse[3] < 0.9999,
      edge,
      edgeColor: [0, 0, 0, 1],
      edgeSize: 1,
      sphereMode: 0,
      toon: toon === 255 ? undefined : toon,
      triangles: count / 3,
    };
    if (tex[0]) m.texture = tex[0];
    if (tex[1]) {
      m.sphere = tex[1];
      m.sphereMode = /\.spa$/i.test(tex[1]) ? 2 : 1;
    }
    materials.push(m);
  }
  const geometry = geometryOf(positions, normals, uvs, faces, materials, c, nv);
  geometry.attributes = { edgeScale };
  const nb = r.u16();
  r.records(nb, 39, 'bones');
  const bones: MMDBone[] = [];
  for (let i = 0; i < nb; i++) {
    const bn = r.fixed(20),
      parent = r.u16(),
      tail = r.u16(),
      type = r.u8();
    r.u16(); // IK parent
    const pos = r.vec(3);
    bones.push({
      name: bn,
      nameEnglish: '',
      position: c.point(pos),
      parent: parent === 0xffff ? -1 : parent,
      layer: 0,
      rotatable: type !== 7 && type !== 8,
      translatable: type === 1,
      visible: type !== 7,
      type,
      tail: tail === 0xffff || tail === 0 ? -1 : tail,
      inheritRotation: type === 5 || type === 9,
      inheritTranslation: false,
      inherit: -1,
      inheritRate: 1,
      afterPhysics: false,
    });
  }
  for (const [i, b] of bones.entries()) {
    if (b.parent >= nb) fail('range', `bone ${i} has parent ${b.parent} of ${nb}`);
    if (b.tail >= nb) b.tail = -1;
  }
  const nik = r.u16();
  r.records(nik, 11, 'IK chains');
  for (let i = 0; i < nik; i++) {
    const bone = r.u16(),
      target = r.u16(),
      chain = r.u8(),
      iterations = r.u16(),
      limit = r.f32();
    r.records(chain, 2, 'IK links');
    const links: { bone: number }[] = [];
    for (let k = 0; k < chain; k++) {
      const l = r.u16();
      if (l >= nb) fail('range', `IK link ${l} of ${nb} bones`);
      links.push({ bone: l });
    }
    if (bone >= nb || target >= nb) fail('range', `IK chain ${i} names a bone past ${nb}`);
    bones[bone].ik = { target, iterations, limitAngle: limit, links };
  }
  const nmo = r.u16();
  const morphs: MMDMorph[] = [];
  r.records(nmo, 25, 'morphs');
  for (let i = 0; i < nmo; i++) {
    const mn = r.fixed(20),
      count = r.u32(),
      panel = r.u8();
    r.records(count, 16, 'morph offsets');
    const offsets: Record<string, unknown>[] = [];
    for (let k = 0; k < count; k++) {
      const vertex = r.u32();
      const o = r.vec(3);
      if (vertex >= nv && panel !== 0) fail('range', `morph ${i} names vertex ${vertex} of ${nv}`);
      offsets.push({ vertex, offset: c.point(o) });
    }
    // The first morph ("base") lists the vertices the others index into; it is kept as a vertex morph.
    morphs.push({ name: mn, nameEnglish: '', panel, type: 'vertex', offsets });
  }
  // Display lists: morph panel, bone group names, bone display frames: parsed past, not kept.
  const nd = r.u8();
  r.skip(nd * 2);
  const ng = r.u8();
  r.skip(ng * 50);
  const ndisp = r.u32();
  r.records(ndisp, 3, 'bone display entries');
  r.skip(ndisp * 3);
  let nameEnglish = '',
    commentEnglish = '';
  const warnings: string[] = [];
  if (r.left > 0 && r.u8() === 1) {
    nameEnglish = r.fixed(20);
    commentEnglish = r.fixed(256);
    for (let i = 0; i < nb; i++) bones[i].nameEnglish = r.fixed(20);
    for (let i = 1; i < nmo; i++) morphs[i].nameEnglish = r.fixed(20);
    r.skip(Math.max(0, ng) * 50);
  }
  if (r.left >= 1000) r.skip(1000); // toon texture names
  const rigidBodies: MMDRigidBody[] = [],
    joints_: MMDJoint[] = [];
  if (r.left >= 4) {
    const nr = r.u32();
    r.records(nr, 83, 'rigid bodies');
    for (let i = 0; i < nr; i++) {
      const rn = r.fixed(20),
        bone = r.u16(),
        group = r.u8(),
        noCollide = r.u16(),
        shape = r.u8(),
        size = r.vec(3),
        pos = r.vec(3),
        rot = r.vec(3),
        mass = r.f32(),
        ld = r.f32(),
        ad = r.f32(),
        rest = r.f32(),
        fr = r.f32(),
        type = r.u8();
      rigidBodies.push({
        name: rn,
        nameEnglish: '',
        bone: bone === 0xffff ? -1 : bone,
        group,
        noCollide,
        shape: (['sphere', 'box', 'capsule'] as const)[shape] ?? 'sphere',
        size: c.size(size),
        position: c.point(pos),
        rotation: c.euler(rot),
        mass,
        linearDamping: ld,
        angularDamping: ad,
        restitution: rest,
        friction: fr,
        mode: (['bone', 'physics', 'physicsBone'] as const)[type] ?? 'bone',
      });
    }
  }
  if (r.left >= 4) {
    const nj = r.u32();
    r.records(nj, 124, 'joints');
    for (let i = 0; i < nj; i++) {
      const jn = r.fixed(20),
        a = r.u32(),
        b = r.u32();
      const v = (n: number) => r.vec(n);
      joints_.push({
        name: jn,
        nameEnglish: '',
        type: 0,
        bodyA: a,
        bodyB: b,
        position: c.point(v(3)),
        rotation: c.euler(v(3)),
        limitPositionMin: c.size(v(3)),
        limitPositionMax: c.size(v(3)),
        limitRotationMin: v(3) as [number, number, number],
        limitRotationMax: v(3) as [number, number, number],
        springPosition: v(3) as [number, number, number],
        springRotation: v(3) as [number, number, number],
      });
    }
  }
  return {
    format: 'PMD',
    version,
    name,
    nameEnglish,
    comment,
    commentEnglish,
    geometry,
    joints,
    weights,
    materials,
    textures: [],
    bones,
    morphs,
    rigidBodies,
    joints_,
    warnings,
  };
}

// ---- PMX ------------------------------------------------------------------------------------------------------------

/**
 * Parses a PMX 2.0 or 2.1 model: vertices with BDEF1, BDEF2, BDEF4, SDEF and QDEF weights and up to four extra UV sets,
 * the texture table, materials with edge, sphere and toon settings, bones with IK, grants and axes, every morph kind,
 * and rigid bodies and joints as data. Soft bodies (2.1) are not read. Index sizes of 1, 2 and 4 bytes are honoured.
 */
export function parsePMX(input: BinaryInput, options: MMDOptions = {}): LoadedMMD {
  const c = conversion(options),
    bytes = toBytes(input, F);
  if (bytes.length < 17 || bytes[0] !== 0x50 || bytes[1] !== 0x4d || bytes[2] !== 0x58 || bytes[3] !== 0x20)
    throw new LoaderError(F, 'header', 'missing the "PMX " signature');
  const probe = new Reader(bytes, false);
  probe.p = 4;
  const version = probe.f32();
  if (version < 2 || version >= 3) fail('unsupported', `PMX version ${version} is not 2.x`);
  const nGlobals = probe.u8();
  if (nGlobals < 8) fail('header', `${nGlobals} globals, 8 needed`);
  const g = Array.from({ length: nGlobals }, () => probe.u8());
  const [encoding, extraUV, vSize, tSize, mSize, bSize, moSize, rSize] = g;
  if (encoding > 1) fail('header', `text encoding ${encoding} is not 0 or 1`);
  if (extraUV > 4) fail('header', `${extraUV} additional UV sets, 4 at most`);
  for (const s of [vSize, tSize, mSize, bSize, moSize, rSize])
    if (s !== 1 && s !== 2 && s !== 4) fail('header', `index size ${s} is not 1, 2 or 4`);
  const r = new Reader(bytes, false, encoding === 0);
  r.p = probe.p;
  const name = r.text(),
    nameEnglish = r.text(),
    comment = r.text(),
    commentEnglish = r.text();

  const nv = r.i32();
  if (nv < 0) fail('syntax', 'negative vertex count');
  if (nv > c.maxVertices) fail('limit', `vertex count ${nv} exceeds the limit of ${c.maxVertices}`);
  r.records(nv, 38 + extraUV * 16, 'vertices');
  const positions = new Float32Array(nv * 3),
    normals = new Float32Array(nv * 3),
    uvs = new Float32Array(nv * 2),
    joints = new Uint16Array(nv * 4),
    weights = new Float32Array(nv * 4),
    edgeScale = new Float32Array(nv),
    extra = Array.from({ length: extraUV }, () => new Float32Array(nv * 4));
  const sdefVertices: number[] = [],
    sdefData: number[] = [];
  for (let i = 0; i < nv; i++) {
    positions.set(c.point(r.vec(3)), i * 3);
    normals.set(c.dir(r.vec(3)), i * 3);
    uvs.set(r.vec(2), i * 2);
    for (let k = 0; k < extraUV; k++) extra[k].set(r.vec(4), i * 4);
    const type = r.u8();
    const bone = () => Math.max(0, r.index(bSize, true));
    if (type === 0) {
      joints[i * 4] = bone();
      weights[i * 4] = 1;
    } else if (type === 1 || type === 3) {
      joints[i * 4] = bone();
      joints[i * 4 + 1] = bone();
      const w = Math.min(1, Math.max(0, r.f32()));
      weights[i * 4] = w;
      weights[i * 4 + 1] = 1 - w;
      if (type === 3) {
        const cc = r.vec(3),
          r0 = r.vec(3),
          r1 = r.vec(3);
        sdefVertices.push(i);
        sdefData.push(...c.point(cc), ...c.point(r0), ...c.point(r1));
      }
    } else if (type === 2 || type === 4) {
      for (let k = 0; k < 4; k++) joints[i * 4 + k] = bone();
      for (let k = 0; k < 4; k++) weights[i * 4 + k] = Math.max(0, r.f32());
    } else fail('syntax', `vertex ${i} has weight type ${type}`);
    edgeScale[i] = r.f32();
  }
  const nf = r.i32();
  if (nf < 0) fail('syntax', 'negative face count');
  r.records(nf, vSize, 'face indices');
  if (nf % 3) fail('syntax', `${nf} face indices is not a multiple of 3`);
  const faces = new Uint32Array(nf);
  for (let i = 0; i < nf; i++) faces[i] = r.index(vSize, false) >>> 0;
  const ntex = r.i32();
  r.records(ntex, 4, 'textures');
  const textures: string[] = [];
  for (let i = 0; i < ntex; i++) textures.push(r.text());
  const texture = (i: number): string | undefined => {
    if (i < 0) return undefined;
    if (i >= textures.length) fail('range', `texture ${i} of ${textures.length}`);
    return textures[i];
  };
  const nm = r.i32();
  r.records(nm, 60, 'materials');
  const materials: MMDMaterial[] = [];
  for (let i = 0; i < nm; i++) {
    const mn = r.text(),
      me = r.text(),
      diffuse = r.vec(4),
      specular = r.vec(3),
      power = r.f32(),
      ambient = r.vec(3),
      flags = r.u8(),
      edgeColor = r.vec(4),
      edgeSize = r.f32(),
      tex = r.index(tSize, true),
      sph = r.index(tSize, true),
      sphereMode = r.u8(),
      shared = r.u8();
    const toon = shared ? r.u8() : r.index(tSize, true);
    r.text(); // memo
    const count = r.i32();
    if (count < 0 || count % 3) fail('syntax', `material ${i} has ${count} indices`);
    const m: MMDMaterial = {
      name: mn,
      nameEnglish: me,
      diffuse: diffuse as [number, number, number, number],
      specular: specular as [number, number, number],
      specularPower: power,
      ambient: ambient as [number, number, number],
      doubleSided: !!(flags & 1),
      edge: !!(flags & 16),
      edgeColor: edgeColor as [number, number, number, number],
      edgeSize,
      sphereMode,
      triangles: count / 3,
    };
    const t = texture(tex);
    if (t) m.texture = t;
    const s = texture(sph);
    if (s) m.sphere = s;
    if (shared) m.toon = toon;
    else if (toon >= 0) m.toon = texture(toon);
    materials.push(m);
  }
  const geometry = geometryOf(positions, normals, uvs, faces, materials, c, nv);
  geometry.attributes = { edgeScale };
  extra.forEach((a, k) => (geometry.attributes![`uv${k + 1}`] = a));

  const nb = r.i32();
  r.records(nb, 20, 'bones');
  const bones: MMDBone[] = [];
  const checkBone = (b: number, what: string): number => {
    if (b < -1 || b >= nb) fail('range', `${what} names bone ${b} of ${nb}`);
    return b;
  };
  for (let i = 0; i < nb; i++) {
    const bn = r.text(),
      be = r.text(),
      pos = r.vec(3),
      parent = r.index(bSize, true),
      layer = r.i32(),
      flags = r.u16();
    const bone: MMDBone = {
      name: bn,
      nameEnglish: be,
      position: c.point(pos),
      parent: parent,
      layer,
      rotatable: !!(flags & 2),
      translatable: !!(flags & 4),
      visible: !!(flags & 8),
      type: -1,
      tail: -1,
      inheritRotation: !!(flags & 0x100),
      inheritTranslation: !!(flags & 0x200),
      inherit: -1,
      inheritRate: 1,
      afterPhysics: !!(flags & 0x1000),
    };
    if (flags & 1) bone.tail = r.index(bSize, true);
    else bone.tailOffset = c.point(r.vec(3));
    if (flags & 0x300) {
      bone.inherit = r.index(bSize, true);
      bone.inheritRate = r.f32();
    }
    if (flags & 0x400) r.skip(12);
    if (flags & 0x800) r.skip(24);
    if (flags & 0x2000) r.skip(4);
    if (flags & 0x20) {
      const target = r.index(bSize, true),
        iterations = r.i32(),
        limitAngle = r.f32(),
        links = r.i32();
      r.records(links, bSize + 1, 'IK links');
      const out: { bone: number; limit?: { min: number[]; max: number[] } }[] = [];
      for (let k = 0; k < links; k++) {
        const lb = r.index(bSize, true);
        const link: { bone: number; limit?: { min: number[]; max: number[] } } = { bone: lb };
        if (r.u8()) link.limit = { min: r.vec(3), max: r.vec(3) };
        out.push(link);
      }
      bone.ik = { target, iterations, limitAngle, links: out };
    }
    bones.push(bone);
  }
  bones.forEach((b, i) => {
    checkBone(b.parent, `bone ${i} parent`);
    if (b.tail >= nb) fail('range', `bone ${i} tail ${b.tail} of ${nb}`);
    checkBone(b.inherit, `bone ${i} inherit`);
    if (b.ik) {
      checkBone(b.ik.target, `bone ${i} IK target`);
      b.ik.links.forEach((l) => checkBone(l.bone, `bone ${i} IK link`));
    }
  });
  for (let i = 0; i < nv; i++)
    for (let k = 0; k < 4; k++)
      if (joints[i * 4 + k] >= Math.max(nb, 1))
        fail('range', `vertex ${i} is skinned to bone ${joints[i * 4 + k]} of ${nb}`);

  const nmo = r.i32();
  r.records(nmo, 10, 'morphs');
  const morphs: MMDMorph[] = [];
  const TYPES = ['group', 'vertex', 'bone', 'uv', 'uv1', 'uv2', 'uv3', 'uv4', 'material', 'flip', 'impulse'] as const;
  for (let i = 0; i < nmo; i++) {
    const mn = r.text(),
      me = r.text(),
      panel = r.u8(),
      kind = r.u8(),
      count = r.i32();
    const type = TYPES[kind];
    if (!type) fail('syntax', `morph ${i} has type ${kind}`);
    r.records(count, 5, 'morph offsets');
    const offsets: Record<string, unknown>[] = [];
    for (let k = 0; k < count; k++) {
      switch (type) {
        case 'group':
        case 'flip':
          offsets.push({ morph: r.index(moSize, true), rate: r.f32() });
          break;
        case 'vertex': {
          const vertex = r.index(vSize, false) >>> 0;
          if (vertex >= nv) fail('range', `morph ${i} names vertex ${vertex} of ${nv}`);
          offsets.push({ vertex, offset: c.point(r.vec(3)) });
          break;
        }
        case 'bone':
          offsets.push({ bone: r.index(bSize, true), translation: c.point(r.vec(3)), rotation: c.quat(r.vec(4)) });
          break;
        case 'material': {
          const material = r.index(mSize, true),
            op = r.u8();
          offsets.push({
            material,
            operation: op === 0 ? 'multiply' : 'add',
            diffuse: r.vec(4),
            specular: r.vec(3),
            specularPower: r.f32(),
            ambient: r.vec(3),
            edgeColor: r.vec(4),
            edgeSize: r.f32(),
            texture: r.vec(4),
            sphere: r.vec(4),
            toon: r.vec(4),
          });
          break;
        }
        case 'impulse':
          offsets.push({
            rigidBody: r.index(rSize, true),
            local: r.u8() !== 0,
            velocity: c.point(r.vec(3)),
            torque: r.vec(3),
          });
          break;
        default: {
          // uv, uv1 .. uv4
          const vertex = r.index(vSize, false) >>> 0;
          if (vertex >= nv) fail('range', `morph ${i} names vertex ${vertex} of ${nv}`);
          offsets.push({ vertex, offset: r.vec(4) });
        }
      }
    }
    morphs.push({ name: mn, nameEnglish: me, panel, type, offsets });
  }
  // Display frames: names and entries, parsed past.
  const ndf = r.i32();
  r.records(ndf, 10, 'display frames');
  for (let i = 0; i < ndf; i++) {
    r.text();
    r.text();
    r.u8();
    const n = r.i32();
    r.records(n, 1 + Math.min(bSize, moSize), 'display entries');
    for (let k = 0; k < n; k++) r.index(r.u8() === 0 ? bSize : moSize, true);
  }
  const rigidBodies: MMDRigidBody[] = [],
    joints_: MMDJoint[] = [];
  const warnings: string[] = [];
  if (r.left >= 4) {
    const nr = r.i32();
    r.records(nr, 60, 'rigid bodies');
    for (let i = 0; i < nr; i++) {
      const rn = r.text(),
        re = r.text(),
        bone = r.index(bSize, true),
        group = r.u8(),
        noCollide = r.u16(),
        shape = r.u8(),
        size = r.vec(3),
        pos = r.vec(3),
        rot = r.vec(3),
        mass = r.f32(),
        ld = r.f32(),
        ad = r.f32(),
        rest = r.f32(),
        fr = r.f32(),
        mode = r.u8();
      rigidBodies.push({
        name: rn,
        nameEnglish: re,
        bone: checkBone(bone, `rigid body ${i}`),
        group,
        noCollide,
        shape: (['sphere', 'box', 'capsule'] as const)[shape] ?? 'sphere',
        size: c.size(size),
        position: c.point(pos),
        rotation: c.euler(rot),
        mass,
        linearDamping: ld,
        angularDamping: ad,
        restitution: rest,
        friction: fr,
        mode: (['bone', 'physics', 'physicsBone'] as const)[mode] ?? 'bone',
      });
    }
  }
  if (r.left >= 4) {
    const nj = r.i32();
    r.records(nj, 100, 'joints');
    for (let i = 0; i < nj; i++) {
      const jn = r.text(),
        je = r.text(),
        type = r.u8(),
        a = r.index(rSize, true),
        b = r.index(rSize, true);
      const v = (n: number) => r.vec(n);
      if (a >= rigidBodies.length || b >= rigidBodies.length)
        fail('range', `joint ${i} names a rigid body past ${rigidBodies.length}`);
      joints_.push({
        name: jn,
        nameEnglish: je,
        type,
        bodyA: a,
        bodyB: b,
        position: c.point(v(3)),
        rotation: c.euler(v(3)),
        limitPositionMin: c.size(v(3)),
        limitPositionMax: c.size(v(3)),
        limitRotationMin: v(3) as [number, number, number],
        limitRotationMax: v(3) as [number, number, number],
        springPosition: v(3) as [number, number, number],
        springRotation: v(3) as [number, number, number],
      });
    }
  }
  if (r.left > 0) warnings.push(`${r.left} bytes after the joints (soft bodies of PMX 2.1) are not read`);
  const out: LoadedMMD = {
    format: 'PMX',
    version,
    name,
    nameEnglish,
    comment,
    commentEnglish,
    geometry,
    joints,
    weights,
    materials,
    textures,
    bones,
    morphs,
    rigidBodies,
    joints_,
    warnings,
  };
  if (sdefVertices.length) out.sdef = { vertices: Uint32Array.from(sdefVertices), data: Float32Array.from(sdefData) };
  return out;
}

/** Reads a PMD or a PMX file, by its signature. */
export function parseMMD(input: BinaryInput, options: MMDOptions = {}): LoadedMMD {
  const bytes = toBytes(input, F);
  if (bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4d && bytes[2] === 0x58 && bytes[3] === 0x20)
    return parsePMX(bytes, options);
  if (bytes.length >= 3 && bytes[0] === 0x50 && bytes[1] === 0x6d && bytes[2] === 0x64) return parsePMD(bytes, options);
  throw new LoaderError(F, 'header', 'not a PMD or PMX file');
}

// ---- VMD ------------------------------------------------------------------------------------------------------------

/** Options of {@link parseVMD}: the space conversion and the bounds on counts. */
export interface VMDOptions {
  /** Metres per MMD unit. Default 0.08. */
  scale?: number;
  /** Mirror MMD's left-handed Z into the engine's space. Default true. */
  rightHanded?: boolean;
  /** Most keys of one kind. Default 2,000,000. */
  maxKeys?: number;
}

/** The keys of one named bone, in frame order. `interpolation` holds 64 bytes a key (see {@link sampleVMDBone}). */
export interface VMDBoneTrack {
  name: string;
  frames: Uint32Array;
  /** xyz a key, in metres. */
  positions: Float32Array;
  /** Quaternion x, y, z, w a key. */
  rotations: Float32Array;
  interpolation: Uint8Array;
}

/** The weights of one named morph, in frame order. */
export interface VMDMorphTrack {
  name: string;
  frames: Uint32Array;
  weights: Float32Array;
}

/** Camera keys, in frame order. `rotation` is MMD's Euler angles (radians); `distance` is from `position` back to the eye. */
export interface VMDCameraTrack {
  frames: Uint32Array;
  distance: Float32Array;
  /** The point looked at, xyz a key, in metres. */
  position: Float32Array;
  /** Euler angles xyz a key, mirrored with the space. */
  rotation: Float32Array;
  /** Vertical field of view in radians. */
  fov: Float32Array;
  /** false when the key turns perspective off. */
  perspective: Uint8Array;
  /** 24 bytes a key. */
  interpolation: Uint8Array;
}

/** A parsed VMD motion. Frames run at 30 a second. */
export interface LoadedVMD {
  /** The model the motion was made for. */
  modelName: string;
  fps: 30;
  bones: VMDBoneTrack[];
  morphs: VMDMorphTrack[];
  /** Empty for a motion with no camera keys. */
  camera: VMDCameraTrack | undefined;
  lights: { frame: number; color: [number, number, number]; position: [number, number, number] }[];
  shadows: { frame: number; mode: number; distance: number }[];
  /** IK on/off switches by frame. */
  ik: { frame: number; show: boolean; states: { name: string; enabled: boolean }[] }[];
  /** The last frame of any track. */
  duration: number;
}

/** Parses a VMD motion or camera clip: bone, morph, camera, light, shadow and IK keys. Tracks are grouped by name. */
export function parseVMD(input: BinaryInput, options: VMDOptions = {}): LoadedVMD {
  const bytes = toBytes(input, F);
  const c = conversion({ scale: options.scale, rightHanded: options.rightHanded });
  const maxKeys = options.maxKeys ?? 2_000_000;
  if (!Number.isSafeInteger(maxKeys) || maxKeys < 0)
    throw new LoaderError(F, 'range', 'maxKeys must be a non-negative integer');
  const header = decode(bytes.subarray(0, Math.min(30, bytes.length)), 'ascii');
  if (!header.startsWith('Vocaloid Motion Data'))
    throw new LoaderError(F, 'header', 'missing the "Vocaloid Motion Data" signature');
  const v2 = header.startsWith('Vocaloid Motion Data 0002');
  const r = new Reader(bytes, true);
  r.p = 30;
  const modelName = r.fixed(v2 ? 20 : 10);
  const section = (size: number, what: string): number => {
    if (r.left < 4) return 0; // older files end early
    const n = r.u32();
    if (n > maxKeys) fail('limit', `${n} ${what} keys exceed the limit of ${maxKeys}`);
    return r.records(n, size, `${what} keys`);
  };
  const lists = new Map<string, { frame: number; at: number }[]>();
  const nb = section(111, 'bone');
  const boneStart = r.p;
  for (let i = 0; i < nb; i++) {
    const name = r.fixed(15),
      frame = r.u32(),
      at = r.p;
    r.skip(92 - 0);
    let list = lists.get(name);
    if (!list) lists.set(name, (list = []));
    list.push({ frame, at });
  }
  void boneStart;
  const bones: VMDBoneTrack[] = [];
  let duration = 0;
  const view = r.view;
  for (const [name, list] of lists) {
    list.sort((a, b) => a.frame - b.frame);
    const n = list.length;
    const track: VMDBoneTrack = {
      name,
      frames: new Uint32Array(n),
      positions: new Float32Array(n * 3),
      rotations: new Float32Array(n * 4),
      interpolation: new Uint8Array(n * 64),
    };
    list.forEach(({ frame, at }, i) => {
      track.frames[i] = frame;
      duration = Math.max(duration, frame);
      const f = (k: number) => {
        const v = view.getFloat32(at + k * 4, true);
        return Number.isFinite(v) ? v : 0;
      };
      track.positions.set(c.point([f(0), f(1), f(2)]), i * 3);
      track.rotations.set(c.quat([f(3), f(4), f(5), f(6)]), i * 4);
      track.interpolation.set(bytes.subarray(at + 28, at + 92), i * 64);
    });
    bones.push(track);
  }
  const morphLists = new Map<string, { frame: number; weight: number }[]>();
  const nm = section(23, 'morph');
  for (let i = 0; i < nm; i++) {
    const name = r.fixed(15),
      frame = r.u32(),
      weight = r.f32();
    let list = morphLists.get(name);
    if (!list) morphLists.set(name, (list = []));
    list.push({ frame, weight });
  }
  const morphs: VMDMorphTrack[] = [];
  for (const [name, list] of morphLists) {
    list.sort((a, b) => a.frame - b.frame);
    morphs.push({
      name,
      frames: Uint32Array.from(list, (k) => k.frame),
      weights: Float32Array.from(list, (k) => k.weight),
    });
    duration = Math.max(duration, list[list.length - 1].frame);
  }
  let camera: VMDCameraTrack | undefined;
  const nc = section(61, 'camera');
  if (nc) {
    const keys: {
      frame: number;
      d: number;
      p: number[];
      rot: number[];
      interp: Uint8Array;
      fov: number;
      persp: number;
    }[] = [];
    for (let i = 0; i < nc; i++) {
      const frame = r.u32(),
        d = r.f32(),
        p = r.vec(3),
        rot = r.vec(3);
      const interp = bytes.slice(r.p, r.p + 24);
      r.skip(24);
      const fov = r.u32(),
        persp = r.u8();
      keys.push({ frame, d, p, rot, interp, fov, persp });
    }
    keys.sort((a, b) => a.frame - b.frame);
    camera = {
      frames: Uint32Array.from(keys, (k) => k.frame),
      distance: Float32Array.from(keys, (k) => k.d * c.scale),
      position: new Float32Array(keys.length * 3),
      rotation: new Float32Array(keys.length * 3),
      fov: Float32Array.from(keys, (k) => (k.fov * Math.PI) / 180),
      perspective: Uint8Array.from(keys, (k) => (k.persp === 0 ? 1 : 0)),
      interpolation: new Uint8Array(keys.length * 24),
    };
    keys.forEach((k, i) => {
      camera!.position.set(c.point(k.p), i * 3);
      camera!.rotation.set(c.euler(k.rot), i * 3);
      camera!.interpolation.set(k.interp, i * 24);
    });
    duration = Math.max(duration, keys[keys.length - 1].frame);
  }
  const lights: LoadedVMD['lights'] = [];
  const nl = section(28, 'light');
  for (let i = 0; i < nl; i++)
    lights.push({ frame: r.u32(), color: r.vec(3) as [number, number, number], position: c.dir(r.vec(3)) });
  const shadows: LoadedVMD['shadows'] = [];
  const ns = section(9, 'shadow');
  for (let i = 0; i < ns; i++) shadows.push({ frame: r.u32(), mode: r.u8(), distance: r.f32() });
  const ik: LoadedVMD['ik'] = [];
  const ni = section(9, 'IK');
  for (let i = 0; i < ni; i++) {
    const frame = r.u32(),
      show = r.u8() !== 0,
      n = r.u32();
    r.records(n, 21, 'IK states');
    const states: { name: string; enabled: boolean }[] = [];
    for (let k = 0; k < n; k++) states.push({ name: r.fixed(20), enabled: r.u8() !== 0 });
    ik.push({ frame, show, states });
  }
  return { modelName, fps: 30, bones, morphs, camera, lights, shadows, ik, duration };
}

/** A cubic Bezier easing through (0,0), (x1,y1), (x2,y2) and (1,1), with the control values 0 to 127 as VMD stores them. */
export function vmdBezier(x1: number, y1: number, x2: number, y2: number, t: number): number {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  const ax = x1 / 127,
    ay = y1 / 127,
    bx = x2 / 127,
    by = y2 / 127;
  const at = (a: number, b: number, s: number): number =>
    3 * a * s * (1 - s) * (1 - s) + 3 * b * s * s * (1 - s) + s * s * s;
  let lo = 0,
    hi = 1;
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2;
    if (at(ax, bx, mid) < t) lo = mid;
    else hi = mid;
  }
  return at(ay, by, (lo + hi) / 2);
}

/**
 * Samples a bone track at `frame` (fractional frames allowed): position and rotation between the two keys around it,
 * each eased by the later key's Bezier curves (the X, Y, Z and rotation curves are the interleaved first 16 bytes of its
 * `interpolation`: x1, y1, x2, y2 of curve k are at bytes k, k + 4, k + 8, k + 12). Before the first key and after the last
 * it holds that key. Returns `{position, rotation}` in the track's space, or undefined for an empty track.
 */
export function sampleVMDBone(
  track: VMDBoneTrack,
  frame: number,
): { position: [number, number, number]; rotation: [number, number, number, number] } | undefined {
  const n = track.frames.length;
  if (!n) return undefined;
  const key = (i: number) => ({
    p: [track.positions[i * 3], track.positions[i * 3 + 1], track.positions[i * 3 + 2]] as [number, number, number],
    q: [track.rotations[i * 4], track.rotations[i * 4 + 1], track.rotations[i * 4 + 2], track.rotations[i * 4 + 3]] as [
      number,
      number,
      number,
      number,
    ],
  });
  if (frame <= track.frames[0]) return { position: key(0).p, rotation: key(0).q };
  if (frame >= track.frames[n - 1]) return { position: key(n - 1).p, rotation: key(n - 1).q };
  let lo = 0,
    hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (track.frames[mid] <= frame) lo = mid;
    else hi = mid;
  }
  const a = key(lo),
    b = key(hi),
    t = (frame - track.frames[lo]) / (track.frames[hi] - track.frames[lo]);
  const m = track.interpolation.subarray(hi * 64, hi * 64 + 16);
  const ease = (k: number) => vmdBezier(m[k], m[4 + k], m[8 + k], m[12 + k], t);
  const position: [number, number, number] = [
    a.p[0] + (b.p[0] - a.p[0]) * ease(0),
    a.p[1] + (b.p[1] - a.p[1]) * ease(1),
    a.p[2] + (b.p[2] - a.p[2]) * ease(2),
  ];
  // Slerp along the shorter arc, eased by the rotation curve.
  const s = ease(3);
  let [bx, by, bz, bw] = b.q;
  let dot = a.q[0] * bx + a.q[1] * by + a.q[2] * bz + a.q[3] * bw;
  if (dot < 0) {
    dot = -dot;
    bx = -bx;
    by = -by;
    bz = -bz;
    bw = -bw;
  }
  let wa = 1 - s,
    wb = s;
  if (dot < 0.9995) {
    const theta = Math.acos(dot),
      sin = Math.sin(theta);
    wa = Math.sin((1 - s) * theta) / sin;
    wb = Math.sin(s * theta) / sin;
  }
  const q: [number, number, number, number] = [
    wa * a.q[0] + wb * bx,
    wa * a.q[1] + wb * by,
    wa * a.q[2] + wb * bz,
    wa * a.q[3] + wb * bw,
  ];
  const len = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
  return { position, rotation: [q[0] / len, q[1] / len, q[2] / len, q[3] / len] };
}
