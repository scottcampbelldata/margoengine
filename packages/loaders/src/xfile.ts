// DirectX `.x` files, text and binary, read from Microsoft's public "DirectX File Format" reference (the `xof` header,
// the template data objects Frame, FrameTransformMatrix, Mesh, MeshNormals, MeshTextureCoords, MeshMaterialList, Material,
// TextureFilename, MeshVertexColors, XSkinMeshHeader, SkinWeights, AnimationSet, Animation, AnimationKey and
// AnimTicksPerSecond, and the binary token stream). The format is left-handed with row vectors; `rightHanded` (default
// true) mirrors Z into the engine's space.
import { LoaderError, type LoadedGeometry, type LoadedGroup, type ParseLimits } from './types.js';
import { DEFAULT_MAX_TRIANGLES, DEFAULT_MAX_VERTICES, toBytes, type BinaryInput } from './util.js';

const F = 'X';

/** Options of {@link parseX}: the shared size limits plus the handedness and nesting bounds below. */
export interface XOptions extends ParseLimits {
  /** Mirror the format's left-handed Z into the engine's right-handed space and keep the winding. Default true. */
  rightHanded?: boolean;
  /** Deepest nesting of data objects. Default 128. */
  maxDepth?: number;
  /** Most frames and meshes together. Default 100,000. */
  maxNodes?: number;
}

/** A Material data object. Colours are as the file stores them (sRGB-like, 0 to 1). */
export interface XMaterial {
  name: string;
  /** Diffuse rgba (`faceColor`). */
  color: [number, number, number, number];
  specularPower: number;
  specular: [number, number, number];
  emissive: [number, number, number];
  /** TextureFilename, when the material has one. */
  texture?: string;
}

/** One bone of a skin: the frame that moves it and its inverse bind matrix (16 values, column-major, engine space). */
export interface XBone {
  /** Name of the frame (`transformNodeName`). */
  name: string;
  /** Index into {@link LoadedX.frames}, or -1 when the file names no such frame. */
  frame: number;
  inverseBind: number[];
}

/** A Mesh data object, as triangles with one vertex per distinct (position, normal) pair. */
export interface XMesh {
  name: string;
  /** `groups[i].properties.materialIndex` is a position in `materials`; `attributes.sourceVertex` maps each vertex to the file's own index. */
  geometry: LoadedGeometry;
  /** The mesh's materials, in the file's order (a MeshMaterialList), or empty. */
  materials: XMaterial[];
  /** Four bone indices per vertex (into `bones`) and their weights; `joints1` and `weights1` hold influences five to eight. */
  joints?: Uint16Array;
  weights?: Float32Array;
  joints1?: Uint16Array;
  weights1?: Float32Array;
  bones: XBone[];
}

/** A Frame: a named node of the hierarchy. */
export interface XFrame {
  name: string;
  /** -1 for a root. Parents come before children. */
  parent: number;
  /** FrameTransformMatrix: 16 values, column-major, relative to the parent, in engine space (identity when absent). */
  matrix: number[];
  /** `matrix` times every parent's: the frame's place in the scene. */
  world: number[];
  /** Indices into {@link LoadedX.meshes} of the meshes this frame holds. */
  meshes: number[];
}

/** One channel of an Animation: keys at `times` seconds, `values` flat (rotation x, y, z, w; scale and position xyz; matrix 16). */
export interface XTrack {
  times: Float64Array;
  values: Float32Array;
}

/** An Animation: the tracks that drive one frame. */
export interface XAnimation {
  /** Name of the animated frame. */
  frame: string;
  rotation?: XTrack;
  scale?: XTrack;
  position?: XTrack;
  /** Whole-matrix keys (key types 3 and 4), column-major in engine space. */
  matrix?: XTrack;
}

export interface XAnimationSet {
  name: string;
  animations: XAnimation[];
  /** Seconds to the last key. */
  duration: number;
}

/** What {@link parseX} returns. */
export interface LoadedX {
  /** `'text'` or `'binary'`. */
  format: 'text' | 'binary';
  frames: XFrame[];
  meshes: XMesh[];
  /** Every Material at the top of the file or inside a mesh, in order. */
  materials: XMaterial[];
  animationSets: XAnimationSet[];
  /** AnimTicksPerSecond, or 4800 when the file has none. */
  ticksPerSecond: number;
  warnings: string[];
}

// ---- tokens ---------------------------------------------------------------------------------------------------------

type Tok =
  | { k: 'name'; v: string }
  | { k: 'str'; v: string }
  | { k: 'num'; v: number }
  | { k: '{' | '}' | 'guid' | 'template' };

const bad = (code: 'header' | 'truncated' | 'syntax' | 'range' | 'limit' | 'unsupported', m: string): never => {
  throw new LoaderError(F, code, m);
};

function textTokens(text: string, limit: number): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text.charCodeAt(i);
    if (c <= 32 || c === 59 /* ; */ || c === 44 /* , */) {
      i++;
      continue;
    }
    if (c === 35 /* # */ || (c === 47 && text.charCodeAt(i + 1) === 47)) {
      while (i < n && text.charCodeAt(i) !== 10) i++;
      continue;
    }
    if (out.length >= limit) bad('limit', `more than ${limit} tokens`);
    if (c === 123) {
      out.push({ k: '{' });
      i++;
    } else if (c === 125) {
      out.push({ k: '}' });
      i++;
    } else if (c === 34) {
      const end = text.indexOf('"', i + 1);
      if (end < 0) bad('syntax', 'a string is not closed');
      out.push({ k: 'str', v: text.slice(i + 1, end) });
      i = end + 1;
    } else if (c === 60) {
      const end = text.indexOf('>', i);
      if (end < 0) bad('syntax', 'a GUID is not closed');
      out.push({ k: 'guid' });
      i = end + 1;
    } else {
      let j = i;
      while (j < n) {
        const d = text.charCodeAt(j);
        if (d <= 32 || d === 59 || d === 44 || d === 123 || d === 125 || d === 34) break;
        j++;
      }
      const word = text.slice(i, j);
      i = j;
      if (/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(word)) out.push({ k: 'num', v: Number(word) });
      else if (word === 'template') out.push({ k: 'template' });
      else out.push({ k: 'name', v: word });
    }
  }
  return out;
}

const T = {
  NAME: 1, STRING: 2, INTEGER: 3, GUID: 5, INTEGER_LIST: 6, FLOAT_LIST: 7, OBRACE: 10, CBRACE: 11,
  TEMPLATE: 31, LAST_PUNCT: 20, FIRST_TYPE: 40, LAST_TYPE: 52,
} as const;

function binaryTokens(bytes: Uint8Array, start: number, floatSize: number, limit: number): Tok[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out: Tok[] = [];
  let p = start;
  const need = (n: number, what: string): void => {
    if (n < 0 || p + n > bytes.length) bad('truncated', `${what} runs past the end of the file`);
  };
  while (p < bytes.length) {
    need(2, 'a token');
    const id = view.getUint16(p, true);
    p += 2;
    if (out.length >= limit) bad('limit', `more than ${limit} tokens`);
    if (id === T.NAME || id === T.STRING) {
      need(4, 'a string length');
      const len = view.getUint32(p, true);
      p += 4;
      need(len, 'a string');
      let s = '';
      for (let i = 0; i < len; i++) s += String.fromCharCode(bytes[p + i]);
      p += len;
      out.push(id === T.NAME ? { k: 'name', v: s } : { k: 'str', v: s });
    } else if (id === T.INTEGER) {
      need(4, 'an integer');
      out.push({ k: 'num', v: view.getUint32(p, true) });
      p += 4;
    } else if (id === T.GUID) {
      need(16, 'a GUID');
      p += 16;
      out.push({ k: 'guid' });
    } else if (id === T.INTEGER_LIST || id === T.FLOAT_LIST) {
      need(4, 'a list length');
      const count = view.getUint32(p, true);
      p += 4;
      const size = id === T.INTEGER_LIST ? 4 : floatSize;
      if (count > (bytes.length - p) / size) bad('truncated', `a list of ${count} values runs past the end of the file`);
      if (out.length + count > limit) bad('limit', `more than ${limit} tokens`);
      for (let i = 0; i < count; i++, p += size)
        out.push({
          k: 'num',
          v: id === T.INTEGER_LIST ? view.getUint32(p, true) : size === 4 ? view.getFloat32(p, true) : view.getFloat64(p, true),
        });
    } else if (id === T.OBRACE) out.push({ k: '{' });
    else if (id === T.CBRACE) out.push({ k: '}' });
    else if (id === T.TEMPLATE) out.push({ k: 'template' });
    else if ((id >= 12 && id <= T.LAST_PUNCT) || (id >= T.FIRST_TYPE && id <= T.LAST_TYPE)) {
      // separators and the template member types carry no data of their own
    } else bad('syntax', `unknown token ${id}`);
  }
  return out;
}

// ---- generic object tree --------------------------------------------------------------------------------------------

interface XNode {
  type: string;
  name: string;
  /** Numbers and strings of the object's own data, in order. */
  values: (number | string)[];
  children: XNode[];
  /** `{ name }` references to objects defined elsewhere. */
  refs: string[];
  /** Children and references together, in file order. */
  items: (XNode | string)[];
}

function buildTree(tokens: Tok[], maxDepth: number, maxNodes: number): XNode[] {
  let p = 0,
    count = 0;
  const roots: XNode[] = [];
  const skipBlock = (): void => {
    // At the `{` of a template body: skip to its matching `}`.
    let depth = 0;
    for (; p < tokens.length; p++) {
      const k = tokens[p].k;
      if (k === '{') depth++;
      else if (k === '}' && --depth === 0) {
        p++;
        return;
      }
    }
    bad('truncated', 'a template is not closed');
  };
  const object = (depth: number): XNode => {
    if (depth > maxDepth) bad('limit', `objects nest deeper than ${maxDepth}`);
    if (++count > maxNodes * 8) bad('limit', 'too many data objects');
    const head = tokens[p++];
    const node: XNode = { type: (head as { v: string }).v, name: '', values: [], children: [], refs: [], items: [] };
    // An optional name, an optional GUID, then the body.
    if (tokens[p]?.k === 'name') node.name = (tokens[p++] as { v: string }).v;
    if (tokens[p]?.k !== '{') bad('syntax', `object "${node.type}" has no body`);
    p++;
    if (tokens[p]?.k === 'guid') p++;
    for (;;) {
      const t = tokens[p];
      if (!t) return bad('truncated', `object "${node.type}" is not closed`);
      if (t.k === '}') {
        p++;
        return node;
      }
      if (t.k === 'num' || t.k === 'str') {
        node.values.push(t.v);
        p++;
      } else if (t.k === '{') {
        // A reference: { name } with an optional GUID.
        p++;
        if (tokens[p]?.k === 'name') {
          const ref = (tokens[p++] as { v: string }).v;
          node.refs.push(ref);
          node.items.push(ref);
        }
        while (tokens[p] && tokens[p].k !== '}') p++;
        if (!tokens[p]) bad('truncated', 'a reference is not closed');
        p++;
      } else if (t.k === 'name') {
        const child = object(depth + 1);
        node.children.push(child);
        node.items.push(child);
      } else bad('syntax', `unexpected token in "${node.type}"`);
    }
  };
  while (p < tokens.length) {
    const t = tokens[p];
    if (t.k === 'template') {
      p++;
      if (tokens[p]?.k === 'name') p++;
      if (tokens[p]?.k !== '{') bad('syntax', 'a template has no body');
      skipBlock();
    } else if (t.k === 'name') roots.push(object(0));
    else bad('syntax', 'unexpected token at the top level');
  }
  return roots;
}

// ---- interpretation -------------------------------------------------------------------------------------------------

/** Cursor over a node's numbers with bounds checks: a count that claims more than is left throws. */
class Reader {
  at = 0;
  constructor(
    readonly values: (number | string)[],
    readonly what: string,
  ) {}
  get left(): number {
    return this.values.length - this.at;
  }
  int(): number {
    const v = this.values[this.at++];
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) return bad('syntax', `${this.what}: expected a count or index`);
    return v;
  }
  num(): number {
    const v = this.values[this.at++];
    if (typeof v !== 'number') return bad('truncated', `${this.what}: a number is missing`);
    return v;
  }
  str(): string {
    const v = this.values[this.at++];
    return typeof v === 'string' ? v : bad('syntax', `${this.what}: expected a string`);
  }
  /** `n` numbers; `n` is checked against what is left before anything is allocated. */
  take(n: number): number[] {
    if (n > this.left) bad('truncated', `${this.what}: ${n} values announced, ${this.left} present`);
    const out = this.values.slice(this.at, this.at + n) as number[];
    this.at += n;
    for (const v of out) if (typeof v !== 'number') bad('syntax', `${this.what}: expected numbers`);
    return out;
  }
}

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
function mul(a: number[], b: number[]): number[] {
  const o = new Array<number>(16).fill(0);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) o[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k];
  return o;
}

/**
 * Parses a DirectX `.x` file, text (`txt `) or binary (`bin `), 32 or 64-bit floats. Compressed files (`tzip`, `bzip`)
 * throw `'unsupported'`. Returns the frame hierarchy, meshes (as triangles; polygons are fanned; normals indexed apart
 * from positions split the vertices), materials, skin weights as per-vertex joints and weights, and animation sets with
 * keys in seconds. Counts that claim more data than the file holds, bad indices, runaway nesting and files past the
 * limits throw a `LoaderError`; nothing is allocated from a count before it is checked against the data present.
 */
export function parseX(input: BinaryInput | string, options: XOptions = {}): LoadedX {
  const maxVertices = options.maxVertices ?? DEFAULT_MAX_VERTICES,
    maxTriangles = options.maxTriangles ?? DEFAULT_MAX_TRIANGLES,
    maxDepth = options.maxDepth ?? 128,
    maxNodes = options.maxNodes ?? 100_000,
    rh = options.rightHanded ?? true;
  for (const [k, v] of Object.entries({ maxVertices, maxTriangles, maxDepth, maxNodes }))
    if (!Number.isSafeInteger(v) || v < 0) throw new LoaderError(F, 'range', `${k} must be a non-negative integer`);
  const bytes =
    typeof input === 'string' ? new TextEncoder().encode(input) : toBytes(input, F);
  if (bytes.length < 16) throw new LoaderError(F, 'truncated', 'file is shorter than the 16-byte header');
  const tag = (o: number): string => String.fromCharCode(bytes[o], bytes[o + 1], bytes[o + 2], bytes[o + 3]);
  if (tag(0) !== 'xof ') throw new LoaderError(F, 'header', 'missing the "xof " signature');
  const major = tag(4),
    kind = tag(8),
    floats = tag(12);
  if (!/^0[0-9]{3}$/.test(major)) throw new LoaderError(F, 'header', `bad version "${major}"`);
  if (floats !== '0032' && floats !== '0064') throw new LoaderError(F, 'header', `float size "${floats}" is not 0032 or 0064`);
  if (kind === 'tzip' || kind === 'bzip') throw new LoaderError(F, 'unsupported', 'compressed .x files (MSZip) are not read');
  if (kind !== 'txt ' && kind !== 'bin ') throw new LoaderError(F, 'header', `format "${kind}" is not txt or bin`);
  const budget = Math.max(1024, bytes.length * 2);
  const tokens =
    kind === 'txt '
      ? textTokens(new TextDecoder('latin1').decode(bytes.subarray(16)), budget)
      : binaryTokens(bytes, 16, floats === '0064' ? 8 : 4, budget + 64);
  const roots = buildTree(tokens, maxDepth, maxNodes);

  const warnings: string[] = [];
  const M = (m: number[]): number[] => {
    if (!rh) return m;
    const o = m.slice();
    for (let i = 0; i < 16; i++) if (((i & 3) === 2) !== ((i >> 2) === 2)) o[i] = 0 - o[i];
    return o;
  };
  const named = new Map<string, XNode>();
  const collectNames = (n: XNode, depth: number): void => {
    if (n.name && !named.has(`${n.type}:${n.name}`)) named.set(`${n.type}:${n.name}`, n);
    for (const c of n.children) collectNames(c, depth + 1);
  };
  for (const r of roots) collectNames(r, 0);

  const materials: XMaterial[] = [];
  const made = new Map<XNode, XMaterial>();
  const material = (n: XNode): XMaterial => {
    const cached = made.get(n);
    if (cached) return cached;
    const r = new Reader(n.values, `Material ${n.name}`);
    const c = r.take(4),
      power = r.num(),
      spec = r.take(3),
      emis = r.take(3);
    const out: XMaterial = {
      name: n.name,
      color: [c[0], c[1], c[2], c[3]],
      specularPower: power,
      specular: [spec[0], spec[1], spec[2]],
      emissive: [emis[0], emis[1], emis[2]],
    };
    const tex = n.children.find((x) => x.type === 'TextureFilename');
    if (tex && typeof tex.values[0] === 'string') out.texture = tex.values[0];
    materials.push(out);
    made.set(n, out);
    return out;
  };

  let vertexTotal = 0,
    triangleTotal = 0;
  const meshes: XMesh[] = [];
  const meshOf = (n: XNode): XMesh => {
    const what = `Mesh ${n.name}`;
    const r = new Reader(n.values, what);
    const nv = r.int();
    if (nv * 3 > r.left) bad('truncated', `${what}: ${nv} vertices announced, data for fewer`);
    const verts = r.take(nv * 3);
    const nf = r.int();
    if (nf > r.left) bad('truncated', `${what}: ${nf} faces announced, data for fewer`);
    const faces: number[][] = [];
    let cornerCount = 0;
    for (let f = 0; f < nf; f++) {
      const k = r.int();
      if (k < 3 || k > r.left) bad('syntax', `${what}: face ${f} has ${k} indices`);
      const face = r.take(k);
      for (const v of face) if (!Number.isInteger(v) || v < 0 || v >= nv) bad('range', `${what}: face ${f} names vertex ${v} of ${nv}`);
      faces.push(face);
      cornerCount += k;
      if (cornerCount > maxTriangles * 3 * 4) bad('limit', `${what}: too many face corners`);
    }
    // Per-corner extras
    let normals: number[] | undefined,
      normalFaces: number[][] | undefined,
      uvs: number[] | undefined,
      colorOf: Map<number, number[]> | undefined,
      faceMaterial: number[] | undefined,
      meshMaterials: XMaterial[] = [];
    for (const c of n.children) {
      const cr = new Reader(c.values, `${what} ${c.type}`);
      if (c.type === 'MeshNormals') {
        const nn = cr.int();
        if (nn * 3 > cr.left) bad('truncated', `${what}: ${nn} normals announced, data for fewer`);
        normals = cr.take(nn * 3);
        const nfn = cr.int();
        if (nfn !== nf) bad('syntax', `${what}: ${nfn} normal faces for ${nf} faces`);
        normalFaces = [];
        for (let f = 0; f < nfn; f++) {
          const k = cr.int();
          if (k !== faces[f].length || k > cr.left) bad('syntax', `${what}: normal face ${f} has ${k} indices, the face has ${faces[f].length}`);
          const nf2 = cr.take(k);
          for (const v of nf2) if (!Number.isInteger(v) || v < 0 || v >= nn) bad('range', `${what}: normal face ${f} names normal ${v} of ${nn}`);
          normalFaces.push(nf2);
        }
      } else if (c.type === 'MeshTextureCoords') {
        const nt = cr.int();
        if (nt !== nv) bad('syntax', `${what}: ${nt} texture coordinates for ${nv} vertices`);
        uvs = cr.take(nt * 2);
      } else if (c.type === 'MeshVertexColors') {
        const nc = cr.int();
        if (nc * 5 > cr.left) bad('truncated', `${what}: ${nc} vertex colours announced, data for fewer`);
        colorOf = new Map();
        for (let i = 0; i < nc; i++) {
          const idx = cr.int(),
            rgba = cr.take(4);
          if (idx >= nv) bad('range', `${what}: vertex colour for vertex ${idx} of ${nv}`);
          colorOf.set(idx, rgba);
        }
      } else if (c.type === 'MeshMaterialList') {
        const nm = cr.int(),
          ni = cr.int();
        if (ni > cr.left) bad('truncated', `${what}: ${ni} material indices announced, data for fewer`);
        const idx = cr.take(ni);
        faceMaterial = ni === nf ? idx : Array.from({ length: nf }, (_, i) => idx[i % Math.max(ni, 1)] ?? 0);
        if (ni !== nf && ni !== 1 && ni !== 0) bad('syntax', `${what}: ${ni} material indices for ${nf} faces`);
        for (const v of faceMaterial) if (!Number.isInteger(v) || v < 0 || (nm > 0 && v >= nm)) bad('range', `${what}: material index ${v} of ${nm}`);
        for (const item of c.items) {
          if (typeof item !== 'string') {
            if (item.type === 'Material') meshMaterials.push(material(item));
            continue;
          }
          const m = named.get(`Material:${item}`);
          if (m) meshMaterials.push(material(m));
          else warnings.push(`${what}: material "${item}" is not in the file`);
        }
      }
    }
    // Output vertices: one per distinct (position, normal) pair.
    const key = new Map<number, number>(); // (v * (nNormals + 1) + normal + 1) -> output index
    const nNormals = normals ? normals.length / 3 : 0;
    const source: number[] = [],
      normalSource: number[] = [];
    const corner = (f: number, i: number): number => {
      const v = faces[f][i],
        ni = normalFaces ? normalFaces[f][i] : -1;
      const k = v * (nNormals + 1) + ni + 1;
      let o = key.get(k);
      if (o === undefined) {
        o = source.length;
        if (o >= maxVertices) bad('limit', `${what}: more than ${maxVertices} vertices`);
        key.set(k, o);
        source.push(v);
        normalSource.push(ni);
      }
      return o;
    };
    // Triangles sorted (stably) by material so each material is one group.
    const order = faces.map((_, i) => i);
    if (faceMaterial) order.sort((a, b) => faceMaterial![a] - faceMaterial![b] || a - b);
    const tris: number[] = [],
      groups: LoadedGroup[] = [];
    let groupMaterial = -1,
      groupStart = 0;
    for (const f of order) {
      const face = faces[f];
      const m = faceMaterial ? faceMaterial[f] : 0;
      if (faceMaterial && m !== groupMaterial) {
        if (groupMaterial >= 0) groups.push({ start: groupStart, count: tris.length - groupStart, properties: { materialIndex: groupMaterial } });
        groupMaterial = m;
        groupStart = tris.length;
      }
      for (let i = 1; i + 1 < face.length; i++) {
        triangleTotal++;
        if (triangleTotal > maxTriangles) bad('limit', `more than ${maxTriangles} triangles`);
        const a = corner(f, 0),
          b = corner(f, i),
          c = corner(f, i + 1);
        tris.push(a, rh ? c : b, rh ? b : c);
      }
    }
    if (faceMaterial && groupMaterial >= 0)
      groups.push({ start: groupStart, count: tris.length - groupStart, properties: { materialIndex: groupMaterial } });
    const count = source.length;
    vertexTotal += count;
    if (vertexTotal > maxVertices) bad('limit', `vertex count ${vertexTotal} exceeds the limit of ${maxVertices}`);
    const positions = new Float32Array(count * 3),
      outNormals = normals ? new Float32Array(count * 3) : undefined,
      outUvs = uvs ? new Float32Array(count * 2) : undefined,
      outColors = colorOf ? new Float32Array(count * 3) : undefined;
    for (let i = 0; i < count; i++) {
      const v = source[i];
      positions[i * 3] = verts[v * 3];
      positions[i * 3 + 1] = verts[v * 3 + 1];
      positions[i * 3 + 2] = rh ? 0 - verts[v * 3 + 2] : verts[v * 3 + 2];
      if (outNormals) {
        const ni = normalSource[i];
        outNormals[i * 3] = normals![ni * 3];
        outNormals[i * 3 + 1] = normals![ni * 3 + 1];
        outNormals[i * 3 + 2] = rh ? 0 - normals![ni * 3 + 2] : normals![ni * 3 + 2];
      }
      if (outUvs) {
        outUvs[i * 2] = uvs![v * 2];
        outUvs[i * 2 + 1] = uvs![v * 2 + 1];
      }
      if (outColors) {
        const c = colorOf!.get(v);
        outColors.set(c ? [c[0], c[1], c[2]] : [1, 1, 1], i * 3);
      }
    }
    const geometry: LoadedGeometry = { kind: 'mesh', positions, indices: new Uint32Array(tris) };
    if (outNormals) geometry.normals = outNormals;
    if (outUvs) geometry.uvs = outUvs;
    if (outColors) geometry.colors = outColors;
    if (groups.length) geometry.groups = groups;
    geometry.attributes = { sourceVertex: Float32Array.from(source) };
    const mesh: XMesh = { name: n.name, geometry, materials: meshMaterials, bones: [] };

    // Skin weights: per bone lists to per-vertex influences.
    const skins = n.children.filter((c) => c.type === 'SkinWeights');
    if (skins.length) {
      if (skins.length > 4096) bad('limit', `${what}: more than 4096 bones`);
      const influences: [number, number][][] = Array.from({ length: nv }, () => []);
      skins.forEach((s, bone) => {
        const sr = new Reader(s.values, `${what} SkinWeights`);
        const boneName = sr.str(),
          nw = sr.int();
        if (nw * 2 + 16 > sr.left) bad('truncated', `${what}: ${nw} skin weights announced, data for fewer`);
        const idx = sr.take(nw),
          w = sr.take(nw),
          offset = sr.take(16);
        for (let i = 0; i < nw; i++) {
          if (!Number.isInteger(idx[i]) || idx[i] < 0 || idx[i] >= nv) bad('range', `${what}: skin weight for vertex ${idx[i]} of ${nv}`);
          influences[idx[i]].push([bone, w[i]]);
        }
        mesh.bones.push({ name: boneName, frame: -1, inverseBind: M(offset) });
      });
      const j = new Uint16Array(count * 4),
        wt = new Float32Array(count * 4);
      let j1: Uint16Array | undefined, w1: Float32Array | undefined;
      for (let i = 0; i < count; i++) {
        const list = influences[source[i]].sort((a, b) => b[1] - a[1]);
        const kept = list.slice(0, 8);
        const sum = kept.reduce((t, x) => t + x[1], 0) || 1;
        kept.forEach(([bone, weight], k) => {
          const target = k < 4 ? [j, wt] : [(j1 ??= new Uint16Array(count * 4)), (w1 ??= new Float32Array(count * 4))];
          (target[0] as Uint16Array)[i * 4 + (k & 3)] = bone;
          (target[1] as Float32Array)[i * 4 + (k & 3)] = list.length > 8 ? weight / sum : weight;
        });
      }
      mesh.joints = j;
      mesh.weights = wt;
      if (j1) {
        mesh.joints1 = j1;
        mesh.weights1 = w1;
      }
    }
    meshes.push(mesh);
    return mesh;
  };

  // Frames
  const frames: XFrame[] = [];
  const meshOfNode = new Map<XNode, number>();
  let nodeCount = 0;
  const frameOf = (n: XNode, parent: number): void => {
    if (++nodeCount > maxNodes) bad('limit', `more than ${maxNodes} frames`);
    const own = frames.length;
    const t = n.children.find((c) => c.type === 'FrameTransformMatrix');
    let matrix = IDENTITY.slice();
    if (t) matrix = M(new Reader(t.values, 'FrameTransformMatrix').take(16));
    frames.push({ name: n.name, parent, matrix, world: parent >= 0 ? mul(frames[parent].world, matrix) : matrix.slice(), meshes: [] });
    for (const item of n.items) {
      if (typeof item !== 'string') {
        if (item.type === 'Frame') frameOf(item, own);
        else if (item.type === 'Mesh') {
          meshOfNode.set(item, meshes.length);
          frames[own].meshes.push(meshes.length);
          meshOf(item);
        }
        continue;
      }
      const m = named.get(`Mesh:${item}`);
      if (!m) continue;
      let at = meshOfNode.get(m);
      if (at === undefined) {
        at = meshes.length;
        meshOfNode.set(m, at);
        meshOf(m);
      }
      frames[own].meshes.push(at);
    }
  };
  for (const r of roots) {
    if (r.type === 'Frame') frameOf(r, -1);
    else if (r.type === 'Mesh') {
      frames.push({ name: r.name, parent: -1, matrix: IDENTITY.slice(), world: IDENTITY.slice(), meshes: [meshes.length] });
      meshOf(r);
    } else if (r.type === 'Material') material(r);
  }
  const byName = new Map<string, number>();
  frames.forEach((f, i) => f.name && !byName.has(f.name) && byName.set(f.name, i));
  for (const m of meshes) for (const b of m.bones) b.frame = byName.get(b.name) ?? -1;

  // Animation
  let ticks = 4800;
  const tps = roots.find((r) => r.type === 'AnimTicksPerSecond');
  if (tps && typeof tps.values[0] === 'number' && tps.values[0] > 0) ticks = tps.values[0];
  const animationSets: XAnimationSet[] = [];
  for (const set of roots.filter((r) => r.type === 'AnimationSet')) {
    const animations: XAnimation[] = [];
    let duration = 0;
    for (const a of set.children.filter((c) => c.type === 'Animation')) {
      const animation: XAnimation = { frame: a.refs[0] ?? '' };
      for (const k of a.children.filter((c) => c.type === 'AnimationKey')) {
        const kr = new Reader(k.values, 'AnimationKey');
        const type = kr.int(),
          nk = kr.int();
        if (nk * 3 > kr.left) bad('truncated', `AnimationKey: ${nk} keys announced, data for fewer`);
        const width = [4, 3, 3, 16, 16][type];
        if (width === undefined) {
          warnings.push(`AnimationKey type ${type} is not read`);
          continue;
        }
        const times = new Float64Array(nk),
          values = new Float32Array(nk * width);
        for (let i = 0; i < nk; i++) {
          times[i] = kr.int() / ticks;
          const nv = kr.int();
          if (nv !== width) bad('syntax', `AnimationKey type ${type} key ${i} has ${nv} values, not ${width}`);
          const v = kr.take(nv);
          if (type === 0) {
            // stored w, x, y, z; the engine's order is x, y, z, w
            const [w, x, y, z] = v;
            values.set(rh ? [0 - x, 0 - y, z, w] : [x, y, z, w], i * 4);
          } else if (type === 2) values.set(rh ? [v[0], v[1], 0 - v[2]] : v, i * 3);
          else if (type === 1) values.set(v, i * 3);
          else values.set(M(v), i * 16);
          if (i && times[i] < times[i - 1]) bad('syntax', 'AnimationKey times go backwards');
        }
        if (nk) duration = Math.max(duration, times[nk - 1]);
        const track = { times, values };
        if (type === 0) animation.rotation = track;
        else if (type === 1) animation.scale = track;
        else if (type === 2) animation.position = track;
        else animation.matrix = track;
      }
      animations.push(animation);
    }
    animationSets.push({ name: set.name, animations, duration });
  }
  return { format: kind === 'txt ' ? 'text' : 'binary', frames, meshes, materials, animationSets, ticksPerSecond: ticks, warnings };
}
