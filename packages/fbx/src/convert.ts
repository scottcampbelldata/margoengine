import { triangulateShape } from '@margoengine/geometry';
import type { FBXNode } from './reader.js';
type M = number[];
type Q = number[];
type V = number[];
interface Obj {
  id: string;
  type: string;
  name: string;
  sub: string;
  node: FBXNode;
  p: Map<string, any>;
}
interface Link {
  id: string;
  rel?: string;
}
interface TRS {
  t: V;
  r: Q;
  s: V;
}
function fail(message: string): never {
  throw new RangeError('FBX: ' + message);
}
// Column-major 4x4 matrices and [x,y,z,w] quaternions, as glTF stores them.
const I = (): M => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const mul = (a: M, b: M): M => {
  const o = new Array<number>(16);
  for (let c = 0; c < 4; c++)
    for (let r = 0; r < 4; r++)
      o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
  return o;
};
const chain = (...m: M[]) => m.reduce(mul);
const move = (v?: V): M => {
  const m = I();
  if (v) {
    m[12] = +v[0];
    m[13] = +v[1];
    m[14] = +v[2];
  }
  return m;
};
const position = (m: M) => move([m[12], m[13], m[14]]);
const scaling = (v?: V): M => {
  const m = I();
  if (v) {
    m[0] = +v[0];
    m[5] = +v[1];
    m[10] = +v[2];
  }
  return m;
};
const columns = (m: M) => [0, 4, 8].map((c) => Math.hypot(m[c], m[c + 1], m[c + 2]));
function invert(m: M): M {
  const a = m.slice(),
    o = I(),
    row = (x: M, r: number, f: (v: number, k: number) => number) => {
      for (let k = 0; k < 4; k++) x[k * 4 + r] = f(x[k * 4 + r], k);
    };
  for (let c = 0; c < 4; c++) {
    let p = c;
    for (let r = c + 1; r < 4; r++) if (Math.abs(a[c * 4 + r]) > Math.abs(a[c * 4 + p])) p = r;
    if (!a[c * 4 + p]) return new Array(16).fill(0);
    for (const x of [a, o]) for (let k = 0; k < 4; k++) [x[k * 4 + c], x[k * 4 + p]] = [x[k * 4 + p], x[k * 4 + c]];
    const d = a[c * 4 + c];
    row(a, c, (v) => v / d);
    row(o, c, (v) => v / d);
    for (let r = 0; r < 4; r++)
      if (r !== c) {
        const f = a[c * 4 + r];
        if (f) {
          row(a, r, (v, k) => v - f * a[k * 4 + c]);
          row(o, r, (v, k) => v - f * o[k * 4 + c]);
        }
      }
  }
  return o;
}
const rotationOf = (m: M): M => {
  const s = columns(m),
    o = I();
  for (let c = 0; c < 3; c++) for (let r = 0; r < 3; r++) o[c * 4 + r] = m[c * 4 + r] / s[c];
  return o;
};
const qmul = (a: Q, b: Q): Q => [
  a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
  a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
  a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
  a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
];
/** FBX extrinsic order N is the intrinsic order string here: rotation = R[order[0]] * R[order[1]] * R[order[2]]. */
const ORDERS = ['ZYX', 'YZX', 'XZY', 'ZXY', 'YXZ', 'XYZ'];
const euler = (rad: V, order: string): Q =>
  [...order].reduce<Q>(
    (q, axis) => {
      const i = 'XYZ'.indexOf(axis),
        h = rad[i] / 2,
        a = [0, 0, 0, Math.cos(h)];
      a[i] = Math.sin(h);
      return qmul(q, a);
    },
    [0, 0, 0, 1],
  );
const degrees = (v: V | undefined, order = 'ZYX'): Q =>
  v
    ? euler(
        v.map((d) => (+d * Math.PI) / 180),
        order,
      )
    : [0, 0, 0, 1];
const qmat = ([x, y, z, w]: Q): M => [
  1 - 2 * (y * y + z * z),
  2 * (x * y + z * w),
  2 * (x * z - y * w),
  0,
  2 * (x * y - z * w),
  1 - 2 * (x * x + z * z),
  2 * (y * z + x * w),
  0,
  2 * (x * z + y * w),
  2 * (y * z - x * w),
  1 - 2 * (x * x + y * y),
  0,
  0,
  0,
  0,
  1,
];
function mquat(m: M): Q {
  const [a, b, c, , d, e, f, , g, h, i] = m,
    trace = a + e + i;
  if (trace > 0) {
    const s = 0.5 / Math.sqrt(trace + 1);
    return [(f - h) * s, (g - c) * s, (b - d) * s, 0.25 / s];
  }
  if (a > e && a > i) {
    const s = 2 * Math.sqrt(1 + a - e - i);
    return [0.25 * s, (d + b) / s, (g + c) / s, (f - h) / s];
  }
  if (e > i) {
    const s = 2 * Math.sqrt(1 + e - a - i);
    return [(d + b) / s, 0.25 * s, (h + f) / s, (g - c) / s];
  }
  const s = 2 * Math.sqrt(1 + i - a - e);
  return [(g + c) / s, (h + f) / s, 0.25 * s, (b - d) / s];
}
function decompose(m: M): TRS {
  const s = columns(m),
    det =
      m[0] * (m[5] * m[10] - m[6] * m[9]) - m[4] * (m[1] * m[10] - m[2] * m[9]) + m[8] * (m[1] * m[6] - m[2] * m[5]);
  if (det < 0) s[0] = -s[0];
  const r = m.slice();
  for (let c = 0; c < 3; c++) for (let k = 0; k < 3; k++) r[c * 4 + k] /= s[c] || 1;
  return { t: [m[12], m[13], m[14]], r: mquat(r), s };
}
const compose = ({ t, r, s }: TRS) => chain(move(t), qmat(r), scaling(s));
const unit = (q: Q) => {
  const l = Math.hypot(...q) || 1;
  return q.map((v) => v / l);
};
function slerp(a: Q, b: Q, t: number): Q {
  const dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3],
    angle = Math.acos(Math.min(1, dot)),
    sin = Math.sin(angle);
  if (sin < 1e-6) return unit(a.map((v, i) => v + (b[i] - v) * t));
  const wa = Math.sin((1 - t) * angle) / sin,
    wb = Math.sin(t * angle) / sin;
  return a.map((v, i) => v * wa + b[i] * wb);
}
const linear = (c: number) => (c < 0.04045 ? c * 0.0773993808 : Math.pow(c * 0.9478672986 + 0.0521327014, 2.4));
const sanitize = (name: string) => name.replace(/\s/g, '_').replace(/[[\].:/]/g, '');
const child = (n: FBXNode, name: string) => n.nodes.find((c) => c.name === name);
const values = (n?: FBXNode): ArrayLike<number> => {
  const v = n?.props[0];
  return v && typeof v === 'object' && 'length' in v ? v : [];
};
const word = (n?: FBXNode) => (n?.props[0] === undefined ? '' : String(n.props[0]));
interface Transform {
  order: string;
  inherit: number;
  t?: V;
  pre?: V;
  r?: V;
  post?: V;
  s?: V;
  so?: V;
  sp?: V;
  ro?: V;
  rp?: V;
}
/** FBX local transform with pivots, offsets and pre/post rotation, resolved against the parent's world matrix for the three inherit types. */
function localMatrix(d: Transform, parentWorld = I(), parentLocal = I()): M {
  const R = qmat(degrees(d.r, d.order)),
    pre = qmat(degrees(d.pre)),
    post = invert(qmat(degrees(d.post))),
    S = scaling(d.s),
    rp = move(d.rp),
    sp = move(d.sp);
  const LR = chain(pre, R, post),
    PR = rotationOf(parentWorld),
    PS = chain(invert(PR), invert(position(parentWorld)), parentWorld);
  const RS =
    d.inherit === 1
      ? chain(PR, PS, LR, S)
      : d.inherit === 2
        ? chain(PR, LR, PS, invert(scaling(columns(parentLocal))), S)
        : chain(PR, LR, PS, S);
  const local = chain(move(d.t), move(d.ro), rp, pre, R, post, invert(rp), move(d.so), sp, S, invert(sp));
  return chain(invert(parentWorld), position(mul(parentWorld, position(local))), RS);
}
/** Converts an FBX record tree into a self-contained GLB with the same scene semantics as Three's FBXLoader + GLTFExporter path. */
export async function fbxToGLB(
  records: FBXNode[],
  fetchImage: (name: string) => Promise<Uint8Array>,
  maxVertices: number,
  signal?: AbortSignal,
): Promise<ArrayBuffer> {
  const top = (name: string) => records.find((n) => n.name === name),
    objects = new Map<string, Obj>(),
    down = new Map<string, Link[]>(),
    up = new Map<string, Link[]>();
  const props = (n: FBXNode) => {
    const p = new Map<string, any>();
    for (const r of child(n, 'Properties70')?.nodes ?? [])
      if (r.name === 'P') {
        const v = r.props.slice(4);
        p.set(String(r.props[0]), v.length === 1 ? v[0] : v);
        p.set(r.props[0] + ':type', r.props[1]);
      }
    return p;
  };
  for (const n of top('Objects')?.nodes ?? []) {
    const id = String(n.props[0]);
    objects.set(id, {
      id,
      type: n.name,
      name: String(n.props[1] ?? '').replace(/^\w+::/, ''),
      sub: String(n.props[2] ?? ''),
      node: n,
      p: props(n),
    });
  }
  for (const c of top('Connections')?.nodes ?? [])
    if (c.name === 'C') {
      const from = String(c.props[1]),
        to = String(c.props[2]),
        rel = c.props[3] === undefined ? undefined : String(c.props[3]);
      for (const [map, key, id] of [
        [down, to, from],
        [up, from, to],
      ] as const) {
        let list = map.get(key);
        if (!list) map.set(key, (list = []));
        list.push({ id, rel });
      }
    }
  const kids = (id: string, type?: string) =>
    (down.get(id) ?? []).filter((l) => !type || objects.get(l.id)?.type === type);
  const parents = (id: string) => up.get(id) ?? [];
  const settings = top('GlobalSettings'),
    upAxis = settings ? props(settings).get('UpAxis') : undefined;
  // glTF document and binary chunk.
  const json: any = {
    asset: { version: '2.0', generator: 'Margo FBX' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ children: [] }],
    meshes: [],
    materials: [],
    textures: [],
    images: [],
    samplers: [],
    skins: [],
    animations: [],
    accessors: [],
    bufferViews: [],
  };
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  const view = (data: ArrayBufferView) => {
    const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
      pad = (4 - (bytes.length % 4)) % 4;
    chunks.push(bytes, new Uint8Array(pad));
    const index = json.bufferViews.push({ buffer: 0, byteOffset: byteLength, byteLength: bytes.length }) - 1;
    byteLength += bytes.length + pad;
    return index;
  };
  const accessor = (data: Float32Array | Uint16Array | Uint32Array, size: number, bounds = false) => {
    const def: any = {
      bufferView: view(data),
      componentType: data instanceof Float32Array ? 5126 : data instanceof Uint16Array ? 5123 : 5125,
      count: data.length / size,
      type: size === 1 ? 'SCALAR' : size === 16 ? 'MAT4' : 'VEC' + size,
    };
    if (bounds) {
      def.min = Array(size).fill(Infinity);
      def.max = Array(size).fill(-Infinity);
      data.forEach((v, i) => {
        const k = i % size;
        def.min[k] = Math.min(def.min[k], v);
        def.max[k] = Math.max(def.max[k], v);
      });
    }
    return json.accessors.push(def) - 1;
  };
  // Hierarchy and transforms.
  const models = [...objects.values()].filter((o) => o.type === 'Model'),
    parentOf = new Map<string, string>(),
    childrenOf = new Map<string, string[]>();
  for (const m of models) {
    let parent = '';
    for (const l of parents(m.id)) if (objects.get(l.id)?.type === 'Model') parent = l.id;
    parentOf.set(m.id, parent);
    childrenOf.set(parent, [...(childrenOf.get(parent) ?? []), m.id]);
  }
  const transform = (o: Obj, geometric = false): Transform => {
    const g = (name: string) => o.p.get(name) as V | undefined;
    return {
      order: ORDERS[o.p.get('RotationOrder') | 0] ?? 'ZYX',
      inherit: o.p.get('InheritType') | 0,
      ...(geometric
        ? { t: g('GeometricTranslation'), r: g('GeometricRotation'), s: g('GeometricScaling') }
        : {
            t: g('Lcl Translation'),
            pre: g('PreRotation'),
            r: g('Lcl Rotation'),
            post: g('PostRotation'),
            s: g('Lcl Scaling'),
            so: g('ScalingOffset'),
            sp: g('ScalingPivot'),
            ro: g('RotationOffset'),
            rp: g('RotationPivot'),
          }),
    };
  };
  const trs = new Map<string, TRS>(),
    world = new Map<string, M>(),
    order: string[] = [];
  const walk = (parent: string, parentWorld: M, parentLocal: M, depth: number) => {
    if (depth > 256) fail('hierarchy too deep');
    for (const id of childrenOf.get(parent) ?? []) {
      if (trs.has(id)) continue;
      const value = decompose(localMatrix(transform(objects.get(id)!), parentWorld, parentLocal)),
        local = compose(value),
        w = mul(parentWorld, local);
      trs.set(id, value);
      world.set(id, w);
      order.push(id);
      walk(id, w, local, depth + 1);
    }
  };
  walk('', I(), I(), 0);
  // Skin clusters, then BindPose for bones that no cluster drives (their Lcl values may be an animation frame).
  const deformers = (geo: string, sub: string) =>
    kids(geo, 'Deformer')
      .map((l) => objects.get(l.id)!)
      .filter((d) => d.sub === sub);
  const clusterBones = new Set<string>();
  for (const o of objects.values())
    if (o.type === 'Deformer' && o.sub === 'Cluster') for (const k of kids(o.id, 'Model')) clusterBones.add(k.id);
  const bindPose = new Map<string, M>();
  for (const o of objects.values())
    if (o.type === 'Pose' && o.sub === 'BindPose')
      for (const n of o.node.nodes)
        if (n.name === 'PoseNode') {
          const m = values(child(n, 'Matrix'));
          if (m.length === 16) bindPose.set(word(child(n, 'Node')), Array.from(m));
        }
  for (const id of order) {
    const o = objects.get(id)!,
      pose = bindPose.get(id);
    if (!pose || !['LimbNode', 'Root'].includes(o.sub) || clusterBones.has(id)) continue;
    const value = decompose(mul(invert(world.get(parentOf.get(id)!) ?? I()), pose));
    trs.set(id, value);
    world.set(id, pose);
  }
  for (const id of order) world.set(id, mul(world.get(parentOf.get(id)!) ?? I(), compose(trs.get(id)!)));
  const nodeIndex = new Map<string, number>();
  for (const id of order) {
    const o = objects.get(id)!,
      { t, r, s } = trs.get(id)!,
      node: any = {};
    r.splice(0, 4, ...unit(r));
    if (o.name) node.name = sanitize(o.name);
    if (t.some((v) => v)) node.translation = t;
    if (r[3] !== 1) node.rotation = r;
    if (s.some((v) => v !== 1)) node.scale = s;
    nodeIndex.set(id, json.nodes.push(node) - 1);
  }
  for (const id of order) {
    const p = parentOf.get(id)!,
      list = p ? (json.nodes[nodeIndex.get(p)!].children ??= []) : json.nodes[0].children;
    list.push(nodeIndex.get(id));
  }
  if (upAxis === 2) json.nodes[0].rotation = [-Math.SQRT1_2, 0, 0, Math.SQRT1_2];
  // Images, textures, materials.
  const imageIds = new Map<string, number>(),
    textureIds = new Map<string, number | undefined>(),
    samplerIds = new Map<string, number>(),
    materialIds = new Map<string, number>();
  const MIME: Record<string, string> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    webp: 'image/webp',
    bmp: 'image/bmp',
    gif: 'image/gif',
  };
  let transformUsed = false;
  async function image(video: Obj): Promise<number | undefined> {
    if (imageIds.has(video.id)) return imageIds.get(video.id);
    const file = word(child(video.node, 'RelativeFilename')) || word(child(video.node, 'Filename')),
      extension = file.slice(file.lastIndexOf('.') + 1).toLowerCase(),
      // Own keys only: a file named `x.constructor` must not pick up Object.prototype.constructor.
      mimeType = Object.hasOwn(MIME, extension) ? MIME[extension] : undefined;
    if (!mimeType) return;
    const content = child(video.node, 'Content'),
      raw =
        content?.props.find((v) => v instanceof Uint8Array && v.length) ??
        content?.props.filter((v) => typeof v === 'string').join('');
    signal?.throwIfAborted();
    const bytes =
      raw instanceof Uint8Array
        ? raw
        : raw
          ? Uint8Array.from(atob(raw), (c) => c.charCodeAt(0))
          : await fetchImage(file.split('\\').pop()!);
    const index = json.images.push({ bufferView: view(bytes), mimeType }) - 1;
    imageIds.set(video.id, index);
    return index;
  }
  async function texture(id: string): Promise<number | undefined> {
    let o = objects.get(id);
    if (o?.type === 'LayeredTexture') o = objects.get(kids(o.id)[0]?.id ?? '');
    if (!o || o.type !== 'Texture') return;
    if (textureIds.has(o.id)) return textureIds.get(o.id);
    const video = kids(o.id, 'Video')[0],
      source = video && (await image(objects.get(video.id)!));
    let index: number | undefined;
    if (source !== undefined) {
      const wrap = (name: string) => (o!.p.get(name) === 1 ? 33071 : 10497),
        key = wrap('WrapModeU') + ':' + wrap('WrapModeV');
      if (!samplerIds.has(key))
        samplerIds.set(
          key,
          json.samplers.push({ magFilter: 9729, minFilter: 9987, wrapS: wrap('WrapModeU'), wrapT: wrap('WrapModeV') }) -
            1,
        );
      index = json.textures.push({ sampler: samplerIds.get(key), source }) - 1;
    }
    textureIds.set(o.id, index);
    return index;
  }
  const textureInfo = (index: number, o: Obj) => {
    const info: any = { index },
      scale = (o.p.get('Scaling') as V | undefined)?.map(Number) ?? [1, 1],
      offset = (o.p.get('Translation') as V | undefined)?.map(Number) ?? [0, 0];
    // UVs are written with V flipped (glTF's top-left origin), so the V offset is mirrored too.
    if (scale[0] !== 1 || scale[1] !== 1 || offset[0] || offset[1]) {
      transformUsed = true;
      info.extensions = {
        KHR_texture_transform: { offset: [offset[0], 1 - offset[1] - scale[1]], scale: [scale[0], scale[1]] },
      };
    }
    return info;
  };
  /** Phong/Lambert to metallic-roughness exactly as the previous bridge: linear diffuse, opacity, roughness from shininess, diffuse and normal maps. */
  async function material(o: Obj | undefined, fallback = ''): Promise<number> {
    const key = o?.id ?? fallback;
    if (materialIds.has(key)) return materialIds.get(key)!;
    const p = o?.p ?? new Map(),
      color = (name: string) => (p.get(name) as V).slice(0, 3).map((v) => linear(+v));
    const lambert =
      !!o && /^lambert$/i.test(word(child(o.node, 'ShadingModel')) || String(p.get('ShadingModel') ?? ''));
    const base = p.has('Diffuse')
      ? color('Diffuse')
      : /^Color(RGB)?$/.test(p.get('DiffuseColor:type'))
        ? color('DiffuseColor')
        : fallback === '__DEFAULT'
          ? [0.8, 0.8, 0.8].map(linear)
          : [1, 1, 1];
    // Some exporters write scalars as vectors (`Opacity` = 1,0,0); the first component is the value.
    const scalar = (name: string, fallback: number) => {
      const v = p.get(name);
      return p.has(name) ? +(Array.isArray(v) ? v[0] : v) : fallback;
    };
    let opacity = 1 - scalar('TransparencyFactor', 0);
    if (opacity === 1 || opacity === 0) opacity = scalar('Opacity', 1);
    let transparent = opacity < 1;
    const shininess = lambert ? 0 : scalar('Shininess', 30),
      pbr: any = {},
      def: any = { pbrMetallicRoughness: pbr };
    for (const l of o ? kids(o.id) : []) {
      if (['TransparentColor', 'TransparencyFactor'].includes(l.rel!)) transparent = true;
      const slot = ['DiffuseColor', 'Maya|TEX_color_map'].includes(l.rel!)
        ? 'base'
        : ['NormalMap', 'Maya|TEX_normal_map'].includes(l.rel!)
          ? 'normal'
          : '';
      const index = slot ? await texture(l.id) : undefined;
      if (index === undefined) continue;
      const info = textureInfo(
        index,
        objects.get(l.id)!.type === 'Texture' ? objects.get(l.id)! : objects.get(kids(l.id)[0].id)!,
      );
      if (slot === 'base') pbr.baseColorTexture = info;
      else def.normalTexture = info;
    }
    if (base.some((v) => v !== 1) || opacity !== 1) pbr.baseColorFactor = [...base, opacity];
    pbr.metallicFactor = 0;
    pbr.roughnessFactor = Math.max(0.045, Math.min(1, Math.sqrt(2 / (shininess + 2))));
    if (transparent) def.alphaMode = 'BLEND';
    const name = o ? o.name : fallback;
    if (name) def.name = name;
    const index = json.materials.push(def) - 1;
    materialIds.set(key, index);
    return index;
  }
  // Geometry: polygons fan out per corner exactly like the old path, n-gons through ear clipping in the polygon plane.
  type Layer = { data: ArrayLike<number>; index: ArrayLike<number>; map: string; ref: string; size: number };
  const layer = (n: FBXNode | undefined, data: string, index: string[], size: number): Layer | undefined => {
    const d = n && child(n, data);
    if (!d) return;
    return {
      data: values(d),
      index: values(index.map((name) => child(n!, name)).find(Boolean)),
      map: word(child(n!, 'MappingInformationType')),
      ref: word(child(n!, 'ReferenceInformationType')),
      size,
    };
  };
  const layers = (geo: FBXNode, name: string) =>
    geo.nodes.filter((n) => n.name === name).sort((a, b) => +a.props[0] - +b.props[0]);
  const at = (l: Layer, corner: number, polygon: number, vertex: number) => {
    let i = l.map === 'ByPolygonVertex' ? corner : l.map === 'ByPolygon' ? polygon : l.map === 'AllSame' ? 0 : vertex;
    if (l.ref === 'IndexToDirect' || l.ref === 'Index') i = l.index[i];
    if (!(i >= 0 && (i + 1) * l.size <= l.data.length)) fail('layer element index outside its data');
    return i * l.size;
  };
  let totalVertices = 0,
    polygonWork = 0;
  const meshIds = new Map<string, number>(),
    skinOf = new Map<string, string>(),
    morphNames = new Map<string, string[]>();
  async function mesh(model: Obj): Promise<number | undefined> {
    const geo = kids(model.id, 'Geometry')
      .map((l) => objects.get(l.id)!)
      .find((g) => g.sub === 'Mesh');
    if (!geo) return;
    const mats = kids(model.id, 'Material').map((l) => objects.get(l.id)!),
      key = geo.id + ':' + mats.map((m) => m.id).join(',');
    if (meshIds.has(key)) return meshIds.get(key);
    const owner = objects.get(parents(geo.id).find((l) => objects.get(l.id)?.type === 'Model')!.id)!,
      pre = localMatrix(transform(owner, true)),
      preNormal = invert(pre),
      preMorph = pre.slice(0, 12).concat([0, 0, 0, 1]);
    const g = geo.node,
      points = values(child(g, 'Vertices')),
      polygons = values(child(g, 'PolygonVertexIndex')),
      pointCount = points.length / 3;
    const normal = layer(layers(g, 'LayerElementNormal')[0], 'Normals', ['NormalsIndex', 'NormalIndex'], 3),
      color = layer(layers(g, 'LayerElementColor')[0], 'Colors', ['ColorIndex'], 4);
    const uvs = layers(g, 'LayerElementUV')
        .map((n) => layer(n, 'UV', ['UVIndex'], 2))
        .filter(Boolean) as Layer[],
      materialLayer = layer(layers(g, 'LayerElementMaterial')[0], 'Materials', [], 1);
    const perFace =
      materialLayer &&
      materialLayer.map !== 'AllSame' &&
      materialLayer.map !== 'NoMappingInformation' &&
      mats.length > 1
        ? { ...materialLayer, ref: 'Direct' }
        : undefined;
    // Skin weights per control point, in cluster order; more than four keep the four largest.
    const skin = deformers(geo.id, 'Skin')[0],
      clusters = skin
        ? kids(skin.id, 'Deformer')
            .map((l) => objects.get(l.id)!)
            .filter((d) => d.sub === 'Cluster')
        : [],
      table = new Map<number, [number, number][]>();
    clusters.forEach((c, j) => {
      const index = values(child(c.node, 'Indexes')),
        weight = values(child(c.node, 'Weights'));
      for (let k = 0; k < index.length; k++) {
        const list = table.get(index[k]) ?? [];
        list.push([j, weight[k]]);
        table.set(index[k], list);
      }
    });
    const morphs = deformers(geo.id, 'BlendShape').flatMap((b) =>
      kids(b.id, 'Deformer')
        .map((l) => objects.get(l.id)!)
        .filter((d) => d.sub === 'BlendShapeChannel')
        .flatMap((channel) => {
          const shape = kids(channel.id, 'Geometry').find((l) => l.rel === undefined);
          if (!shape) return [];
          const n = objects.get(shape.id)!.node,
            delta = new Float64Array(points.length),
            index = values(child(n, 'Indexes')),
            offset = values(child(n, 'Vertices'));
          for (let k = 0; k < index.length; k++)
            if (index[k] >= 0 && index[k] < pointCount)
              for (let d = 0; d < 3; d++) delta[index[k] * 3 + d] = offset[k * 3 + d];
          return [{ name: channel.name, delta }];
        }),
    );
    const corners: number[] = [],
      faceMaterial: number[] = [],
      normals: number[] = [],
      colors: number[] = [],
      uvOut: number[][] = uvs.map(() => []),
      skinOut: number[][] = [];
    let face: number[] = [],
      polygon = 0,
      materialIndex = 0;
    for (let c = 0; c < polygons.length; c++) {
      let v = polygons[c];
      const end = v < 0;
      if (end) v = ~v;
      if (!Number.isInteger(v) || v >= pointCount) fail('polygon vertex outside the vertex array');
      if (face.push(c) > 4096) fail('polygon has more than 4096 corners');
      if (perFace) materialIndex = Math.max(0, perFace.data[at(perFace, c, polygon, v)]);
      if (!end) continue;
      const vertex = (k: number) => {
          const i = polygons[face[k]];
          return i < 0 ? ~i : i;
        },
        p = (k: number) => [0, 1, 2].map((d) => +points[vertex(k) * 3 + d]);
      let triangles = [[0, 1, 2]];
      if (face.length > 3) {
        // Ear clipping is quadratic in the corner count: bound the total, not only each polygon.
        if ((polygonWork += face.length * face.length) > 100_000_000) fail('polygon triangulation work exceeds limit');
        const ring = face.map((_, k) => p(k)),
          n = [0, 0, 0];
        ring.forEach((a, k) => {
          const b = ring[(k + 1) % ring.length];
          n[0] += (a[1] - b[1]) * (a[2] + b[2]);
          n[1] += (a[2] - b[2]) * (a[0] + b[0]);
          n[2] += (a[0] - b[0]) * (a[1] + b[1]);
        });
        const norm = (x: V) => {
            const l = Math.hypot(...x) || 1;
            return x.map((e) => e / l);
          },
          cross = (a: V, b: V) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
        const nn = norm(n),
          tangent = norm(cross(Math.abs(nn[2]) > 0.5 ? [0, 1, 0] : [0, 0, 1], nn)),
          bitangent = norm(cross(nn, tangent)),
          dot = (a: V, b: V) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
        const flat = triangulateShape(
          ring.map((a) => [dot(a, tangent), dot(a, bitangent)] as [number, number]),
        ).indices;
        triangles = [];
        for (let k = 0; k < flat.length; k += 3) triangles.push([flat[k], flat[k + 1], flat[k + 2]]);
      } else if (face.length < 3) triangles = [];
      // The vertex budget holds while corners accumulate, not only once the whole geometry is built.
      if (totalVertices + corners.length + triangles.length * 3 > maxVertices)
        throw new RangeError('FBX geometry budget exceeded');
      for (const tri of triangles) {
        for (const k of tri) {
          const c2 = face[k],
            v2 = vertex(k);
          corners.push(v2);
          if (normal) {
            const o = at(normal, c2, polygon, v2);
            normals.push(normal.data[o], normal.data[o + 1], normal.data[o + 2]);
          }
          if (color) {
            const o = at(color, c2, polygon, v2);
            colors.push(linear(+color.data[o]), linear(+color.data[o + 1]), linear(+color.data[o + 2]));
          }
          uvs.forEach((l, u) => {
            const o = at(l, c2, polygon, v2);
            uvOut[u].push(l.data[o], 1 - l.data[o + 1]);
          });
          if (skin) {
            let list = table.get(v2) ?? [];
            if (list.length > 4) {
              const best: [number, number][] = [
                [0, 0],
                [0, 0],
                [0, 0],
                [0, 0],
              ];
              for (let w of list) for (let b = 0; b < 4; b++) if (w[1] > best[b][1]) [best[b], w] = [w, best[b]];
              list = best;
            }
            const four = [...list, [0, 0], [0, 0], [0, 0], [0, 0]].slice(0, 4),
              sum = four.reduce((s, w) => s + Math.abs(w[1]), 0);
            skinOut.push(four.flatMap((w) => [w[0], sum ? w[1] / sum : 0]));
            if (!sum) skinOut.at(-1)![1] = 1;
          }
        }
        faceMaterial.push(materialIndex);
      }
      face = [];
      polygon++;
    }
    if (face.length) fail('polygon list does not end a face');
    const count = corners.length;
    if ((totalVertices += count) > maxVertices) throw new RangeError('FBX geometry budget exceeded');
    if (!count) return;
    const apply = (m: M, x: number, y: number, z: number) =>
      [0, 1, 2].map((r) => m[r] * x + m[4 + r] * y + m[8 + r] * z + m[12 + r]);
    const position = new Float32Array(count * 3);
    corners.forEach((v, i) => position.set(apply(pre, +points[v * 3], +points[v * 3 + 1], +points[v * 3 + 2]), i * 3));
    const attributes: any = { POSITION: accessor(position, 3, true) };
    if (normal) {
      const out = new Float32Array(count * 3);
      for (let i = 0; i < count; i++) {
        const [x, y, z] = [0, 1, 2].map((d) => +normals[i * 3 + d]),
          n = [0, 1, 2].map((r) => preNormal[r * 4] * x + preNormal[r * 4 + 1] * y + preNormal[r * 4 + 2] * z),
          l = Math.hypot(...n);
        out.set(l ? n.map((e) => e / l) : [1, 0, 0], i * 3);
      }
      attributes.NORMAL = accessor(out, 3);
    }
    uvOut.forEach((list, u) => {
      attributes['TEXCOORD_' + u] = accessor(new Float32Array(list), 2);
    });
    if (color) attributes.COLOR_0 = accessor(new Float32Array(colors), 3);
    if (skin) {
      attributes.JOINTS_0 = accessor(Uint16Array.from(skinOut.flatMap((w) => [w[0], w[2], w[4], w[6]])), 4);
      attributes.WEIGHTS_0 = accessor(Float32Array.from(skinOut.flatMap((w) => [w[1], w[3], w[5], w[7]])), 4);
      skinOf.set(geo.id, skin.id);
    }
    const targets = morphs.map((m) => {
      const out = new Float32Array(count * 3);
      corners.forEach((v, i) => {
        const p = apply(preMorph, m.delta[v * 3], m.delta[v * 3 + 1], m.delta[v * 3 + 2]);
        out.set(p, i * 3);
      });
      return { POSITION: accessor(out, 3, true) };
    });
    const def: any = { primitives: [] };
    if (targets.length) {
      def.weights = targets.map(() => 0);
      def.extras = { targetNames: morphs.map((m) => m.name) };
      morphNames.set(
        geo.id,
        morphs.map((m) => m.name),
      );
    }
    if (perFace) {
      // One primitive per material in first-use order; an index past the material list gets a plain default.
      const groups = new Map<number, number[]>();
      faceMaterial.forEach((m, t) => {
        const list = groups.get(m) ?? [];
        list.push(t * 3, t * 3 + 1, t * 3 + 2);
        groups.set(m, list);
      });
      for (const [m, list] of groups)
        def.primitives.push({
          attributes,
          indices: accessor(count > 65535 ? Uint32Array.from(list) : Uint16Array.from(list), 1),
          material: m < mats.length ? await material(mats[m]) : await material(undefined, ''),
          ...(targets.length ? { targets } : {}),
        });
    } else
      def.primitives.push({
        attributes,
        material: await material(mats[materialLayer?.data[0] ?? 0] ?? mats[0], '__DEFAULT'),
        ...(targets.length ? { targets } : {}),
      });
    const index = json.meshes.push(def) - 1;
    meshIds.set(key, index);
    return index;
  }
  for (const id of order) {
    const o = objects.get(id)!;
    if (o.sub !== 'Mesh') continue;
    const index = await mesh(o);
    if (index === undefined) continue;
    const node = json.nodes[nodeIndex.get(id)!];
    node.mesh = index;
    const geo = kids(id, 'Geometry')
        .map((l) => objects.get(l.id)!)
        .find((g) => g.sub === 'Mesh')!,
      skin = skinOf.get(geo.id);
    if (!skin) continue;
    const clusters = kids(skin, 'Deformer')
        .map((l) => objects.get(l.id)!)
        .filter((d) => d.sub === 'Cluster'),
      bind = world.get(id)!,
      matrices = new Float32Array(clusters.length * 16),
      joints: number[] = [];
    clusters.forEach((c, j) => {
      const bone = kids(c.id, 'Model')[0],
        link = values(child(c.node, 'TransformLink'));
      if (!bone || !nodeIndex.has(bone.id) || link.length !== 16) fail('skin cluster without a bone or TransformLink');
      joints.push(nodeIndex.get(bone.id)!);
      matrices.set(mul(invert(Array.from(link)), bind), j * 16);
    });
    node.skin = json.skins.push({ inverseBindMatrices: accessor(matrices, 16), joints, skeleton: joints[0] }) - 1;
  }
  if (!totalVertices) throw new RangeError('FBX has no mesh geometry');
  // Animation stacks: first layer only; T/S keep the last keyed value per axis, R becomes quaternions with pre/post rotation.
  const curves = new Map<string, Record<string, { times: number[]; values: number[] }>>();
  for (const o of objects.values())
    if (o.type === 'AnimationCurve') {
      const link = parents(o.id)[0],
        axis = /X/.test(link?.rel ?? '')
          ? 'x'
          : /Y/.test(link?.rel ?? '')
            ? 'y'
            : /Z/.test(link?.rel ?? '')
              ? 'z'
              : /DeformPercent/.test(link?.rel ?? '')
                ? 'morph'
                : '';
      if (!axis) continue;
      const map = curves.get(link.id) ?? {};
      curves.set(link.id, map);
      map[axis] = {
        times: Array.from(values(child(o.node, 'KeyTime')), (t) => t / 46186158000),
        values: Array.from(values(child(o.node, 'KeyValueFloat'))),
      };
    }
  const union = (list: { times: number[] }[]) => [...new Set(list.flatMap((c) => c.times))].sort((a, b) => a - b);
  const sample = (c: { times: number[]; values: number[] }, t: number) => {
    const { times: x, values: y } = c;
    if (t <= x[0]) return y[0];
    if (t >= x[x.length - 1]) return y[y.length - 1];
    let i = 0;
    while (x[i + 1] < t) i++;
    return x[i] === t ? y[i] : y[i] + ((y[i + 1] - y[i]) * (t - x[i])) / (x[i + 1] - x[i]);
  };
  for (const stack of [...objects.values()].filter((o) => o.type === 'AnimationStack')) {
    const layerId = kids(stack.id)[0]?.id,
      samplers: any[] = [],
      channels: any[] = [],
      weights = new Map<
        string,
        { node: number; names: string[]; tracks: { target: number; times: number[]; values: number[] }[] }
      >();
    const channel = (node: number, path: string, times: number[], output: number[], size: number) => {
      samplers.push({
        input: accessor(Float32Array.from(times), 1, true),
        output: accessor(Float32Array.from(output), size),
        interpolation: 'LINEAR',
      });
      channels.push({ sampler: samplers.length - 1, target: { node, path } });
    };
    for (const l of layerId ? kids(layerId, 'AnimationCurveNode') : []) {
      const curveNode = objects.get(l.id)!,
        set = curves.get(l.id),
        owner = parents(l.id).find((p) => p.rel !== undefined);
      if (!set || !owner) continue;
      if (curveNode.name === 'DeformPercent' && set.morph) {
        const channelObj = objects.get(owner.id),
          geo = parents(parents(owner.id)[0]?.id ?? '')[0]?.id ?? '',
          model = parents(geo)[0]?.id ?? '',
          names = morphNames.get(geo),
          node = nodeIndex.get(model);
        if (!channelObj || !names || node === undefined || !names.includes(channelObj.name)) continue;
        const entry = weights.get(model) ?? { node, names, tracks: [] };
        weights.set(model, entry);
        entry.tracks.push({
          target: names.indexOf(channelObj.name),
          times: set.morph.times,
          values: set.morph.values.map((v) => v / 100),
        });
        continue;
      }
      const node = nodeIndex.get(owner.id),
        model = objects.get(owner.id),
        axes = (['x', 'y', 'z'] as const).map((a) => set[a]);
      if (node === undefined || !model || !axes.some(Boolean)) continue;
      const times = union(axes.filter(Boolean) as { times: number[] }[]);
      if (!times.length) continue;
      if (curveNode.name === 'T' || curveNode.name === 'S') {
        const last = [...trs.get(owner.id)![curveNode.name === 'T' ? 't' : 's']],
          out: number[] = [];
        for (const t of times)
          axes.forEach((c, a) => {
            const i = c ? c.times.indexOf(t) : -1;
            if (i >= 0) last[a] = c!.values[i];
            out.push(last[a]);
          });
        channel(node, curveNode.name === 'T' ? 'translation' : 'scale', times, out, 3);
      } else if (curveNode.name === 'R') {
        const d = transform(model),
          initial = (d.r ?? [0, 0, 0]).map(Number),
          pre = degrees(d.pre),
          post = degrees(d.post),
          postInverse = [-post[0], -post[1], -post[2], post[3]];
        const sync = axes.map((c, a) =>
          !c
            ? times.map(() => initial[a])
            : c.times.length === times.length
              ? c.values
              : times.map((t) => sample(c, t)),
        );
        const keyTimes = [times[0]],
          keys: Q[] = [degrees([sync[0][0], sync[1][0], sync[2][0]], d.order)];
        for (let i = 1; i < times.length; i++) {
          const from = sync.map((s) => s[i - 1]),
            to = sync.map((s) => s[i]),
            span = Math.max(...from.map((v, a) => Math.abs(to[a] - v)));
          if (span < 180) {
            keyTimes.push(times[i]);
            keys.push(degrees(to, d.order));
            continue;
          }
          // Large Euler steps are slerped in 180-degree slices so the quaternion keeps the intended direction.
          const a = degrees(from, d.order),
            b0 = degrees(to, d.order),
            dot = a.reduce((s, v, k) => s + v * b0[k], 0),
            b = dot < 0 ? b0.map((v) => -v) : b0,
            steps = Math.ceil(span / 180);
          for (let k = 1; k <= steps; k++) {
            keyTimes.push(times[i - 1] + ((times[i] - times[i - 1]) * k) / steps);
            keys.push(slerp(a, b, k / steps));
          }
        }
        const out: number[] = [];
        let previous: Q | undefined;
        for (const k of keys) {
          let q = unit(qmul(qmul(pre, k), postInverse));
          if (previous && previous.reduce((s, v, j) => s + v * q[j], 0) < 0) q = q.map((v) => -v);
          out.push(...q);
          previous = q;
        }
        channel(node, 'rotation', keyTimes, out, 4);
      }
    }
    for (const { node, names, tracks } of weights.values()) {
      const times = union(tracks),
        out: number[] = [];
      for (const t of times)
        for (let target = 0; target < names.length; target++) {
          const track = tracks.find((k) => k.target === target);
          out.push(track ? sample(track, t) : 0);
        }
      channel(node, 'weights', times, out, 1);
    }
    if (channels.length)
      json.animations.push({ name: stack.name || 'clip_' + json.animations.length, samplers, channels });
  }
  if (transformUsed) json.extensionsUsed = ['KHR_texture_transform'];
  for (const key of Object.keys(json)) if (Array.isArray(json[key]) && !json[key].length) delete json[key];
  json.buffers = [{ byteLength }];
  const text = new TextEncoder().encode(JSON.stringify(json)),
    jsonLength = Math.ceil(text.length / 4) * 4,
    glb = new Uint8Array(28 + jsonLength + byteLength),
    out = new DataView(glb.buffer);
  out.setUint32(0, 0x46546c67, true);
  out.setUint32(4, 2, true);
  out.setUint32(8, glb.length, true);
  out.setUint32(12, jsonLength, true);
  out.setUint32(16, 0x4e4f534a, true);
  glb.fill(0x20, 20, 20 + jsonLength);
  glb.set(text, 20);
  out.setUint32(20 + jsonLength, byteLength, true);
  out.setUint32(24 + jsonLength, 0x004e4942, true);
  let offset = 28 + jsonLength;
  for (const chunk of chunks) {
    glb.set(chunk, offset);
    offset += chunk.length;
  }
  return glb.buffer;
}
