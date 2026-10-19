import { LoaderError, type LoadedGeometry, type LoadedGroup, type ParseLimits } from './types.js';
import {
  CornerWelder,
  DEFAULT_MAX_TRIANGLES,
  DEFAULT_MAX_VERTICES,
  floats,
  limits,
  resolvePath,
  toBytes,
  uints,
  type BinaryInput,
  type Limits,
} from './util.js';
import { decodeXML, readXMLTree, type XMLElement } from './xml.js';

const F = 'DAE';
const NONE = 0xffffffff;
// The per-file part cap shared by every loader that makes one mesh per part (docs/limits.md).
const MAX_NODES = 100_000;
const MAX_DEPTH = 64;

/** A primitive's triangle range and the material symbol it binds. */
export interface DAEGroup extends LoadedGroup {
  /** The primitive's `material` attribute: a symbol that each instance binds to a material. */
  symbol?: string;
}

/**
 * One `<geometry>` mesh in Y-up meters. Every distinct corner (vertex, normal, UV and color index) is one vertex;
 * `positionIndices` maps it back to its `<vertices>` entry. Polygons are fan-triangulated: face f with
 * n = `faceSizes[f]` corners c0..cn-1 gives triangles (c0, ck, ck+1). `uvs` are the lowest TEXCOORD set, with
 * v flipped to Margo's convention (1 - t).
 */
export interface DAEGeometry extends LoadedGeometry {
  kind: 'mesh';
  id: string;
  name?: string;
  indices: Uint32Array;
  groups: DAEGroup[];
  faceSizes: Uint32Array;
  positionIndices: Uint32Array;
}

/** A material channel: a color, or a texture read through a named UV set. */
export interface DAEChannel {
  /** RGBA as written. */
  color?: [number, number, number, number];
  /** Image path relative to the .dae folder, and the effect's `texcoord` name. */
  texture?: { path: string; texcoord?: string };
}

/** A `<material>` with its `profile_COMMON` effect resolved. */
export interface DAEMaterial {
  id: string;
  name?: string;
  shading: 'constant' | 'lambert' | 'phong' | 'blinn';
  emission?: DAEChannel;
  ambient?: DAEChannel;
  diffuse?: DAEChannel;
  specular?: DAEChannel;
  reflective?: DAEChannel;
  transparent?: DAEChannel;
  /** `opaque` mode of `transparent`: `'A_ONE'` (default), `'A_ZERO'`, `'RGB_ONE'` or `'RGB_ZERO'`. */
  opaque?: string;
  shininess?: number;
  reflectivity?: number;
  transparency?: number;
  indexOfRefraction?: number;
}

/** An `<instance_geometry>`. */
export interface DAEInstance {
  /** Index into `LoadedDAE.geometries`. */
  geometry: number;
  /** Index into `LoadedDAE.materials` by primitive symbol, in a null-prototype object. */
  materials: Record<string, number>;
}

/** A scene node. `instance_node` references are expanded into copies. */
export interface DAENode {
  id?: string;
  name?: string;
  /** Local transform (the node's matrix, translate, rotate and scale stack), column-major 4x4, in Y-up meters. */
  matrix: number[];
  instances: DAEInstance[];
  children: DAENode[];
}

/** A parsed COLLADA document, converted to Y-up and meters. */
export interface LoadedDAE {
  /** The file's `up_axis`; geometry and matrices are already converted to Y-up. */
  upAxis: 'X_UP' | 'Y_UP' | 'Z_UP';
  /** The file's `unit meter`; geometry and translations are already scaled to meters. */
  meter: number;
  geometries: DAEGeometry[];
  materials: DAEMaterial[];
  /** Image paths the materials use, relative to the .dae folder, without duplicates: give each to the resolver. */
  images: string[];
  /** Root nodes of the instanced visual scene. */
  nodes: DAENode[];
  /** What was skipped: lines, holes, skins, morphs, animations, unresolved references. */
  warnings: string[];
}

/** Options of `parseDAE`. */
export interface DAEParseOptions extends ParseLimits {}

const kid = (e: XMLElement | undefined, name: string): XMLElement | undefined =>
  e?.children.find((c) => c.name === name);
const kids = (e: XMLElement | undefined, name: string): XMLElement[] =>
  e?.children.filter((c) => c.name === name) ?? [];
const ref = (url: string | undefined): string => (url?.startsWith('#') ? url.slice(1) : (url ?? ''));

function numbers(text: string, what: string): number[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  const parts = trimmed.split(/\s+/),
    out = new Array<number>(parts.length);
  for (let i = 0; i < parts.length; i++) {
    const value = Number(parts[i]);
    if (Number.isNaN(value) && !/^[+-]?nan$/i.test(parts[i]))
      throw new LoaderError(F, 'syntax', `${what} has the invalid number "${parts[i].slice(0, 32)}"`);
    out[i] = value;
  }
  return out;
}

function integer(value: string | undefined, fallback: number, what: string): number {
  if (value === undefined) return fallback;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0)
    throw new LoaderError(F, 'syntax', `${what} must be a non-negative integer, got "${value.slice(0, 32)}"`);
  return number;
}

interface Source {
  id: string;
  data: number[];
  stride: number;
  offset: number;
  count: number;
  /** Offset inside a stride of each named `<param>`. */
  params: number[];
}

function readSource(e: XMLElement, ids: Map<string, XMLElement>): Source {
  const id = e.attributes.id ?? '',
    accessor = kid(kid(e, 'technique_common'), 'accessor'),
    array = ids.get(ref(accessor?.attributes.source)) ?? kid(e, 'float_array');
  if (!accessor || array?.name !== 'float_array')
    throw new LoaderError(F, 'syntax', `source "${id}" has no float_array with an accessor`);
  const data = numbers(array.text, `float_array of source "${id}"`),
    count = integer(accessor.attributes.count, 0, `accessor count of source "${id}"`),
    stride = integer(accessor.attributes.stride, 1, `accessor stride of source "${id}"`),
    offset = integer(accessor.attributes.offset, 0, `accessor offset of source "${id}"`),
    declared = kids(accessor, 'param'),
    params: number[] = [];
  declared.forEach((p, i) => p.attributes.name !== undefined && params.push(i));
  if (!declared.length) for (let i = 0; i < stride; i++) params.push(i);
  if (count && offset + (count - 1) * stride + Math.max(1, ...params.map((p) => p + 1)) > data.length)
    throw new LoaderError(
      F,
      'truncated',
      `source "${id}" declares ${count} x ${stride} values but its array holds ${data.length}`,
    );
  return { id, data, stride, offset, count, params };
}

interface Input {
  source: Source;
  offset: number;
}

const AXES = {
  Y_UP: [1, 0, 0, 0, 1, 0, 0, 0, 1],
  // Row-major rotations taking the file's axes to Y-up (COLLADA 1.4.1 up_axis table).
  Z_UP: [1, 0, 0, 0, 0, 1, 0, -1, 0],
  X_UP: [0, -1, 0, 1, 0, 0, 0, 0, 1],
} as const;

function readMesh(
  geometry: XMLElement,
  mesh: XMLElement,
  ids: Map<string, XMLElement>,
  limit: Limits,
  totals: { vertices: number; triangles: number },
  warn: (message: string) => void,
): DAEGeometry {
  const id = geometry.attributes.id ?? '',
    what = `geometry "${id}"`;
  const sources = new Map<string, Source>();
  for (const e of kids(mesh, 'source')) if (e.attributes.id) sources.set(e.attributes.id, readSource(e, ids));
  const source = (url: string | undefined, semantic: string): Source => {
    const found = sources.get(ref(url));
    if (!found) throw new LoaderError(F, 'syntax', `${what} ${semantic} input names no source "${ref(url)}"`);
    return found;
  };
  const vertices = kid(mesh, 'vertices');
  if (!vertices) throw new LoaderError(F, 'syntax', `${what} has no <vertices>`);
  const vertexInputs = new Map(kids(vertices, 'input').map((i) => [i.attributes.semantic, i.attributes.source]));
  if (!vertexInputs.has('POSITION')) throw new LoaderError(F, 'syntax', `${what} <vertices> has no POSITION input`);
  const positionSource = source(vertexInputs.get('POSITION'), 'POSITION'),
    vertexCount = positionSource.count;
  if (positionSource.params.length < 3)
    throw new LoaderError(F, 'syntax', `${what} POSITION source "${positionSource.id}" has fewer than 3 components`);
  const positions = floats(),
    normals = floats(),
    uvs = floats(),
    colors = floats(),
    positionIndices = uints(),
    indices = uints(),
    faceSizes = uints(),
    groups: DAEGroup[] = [];
  let hasNormal = false,
    hasUV = false,
    hasColor = false;
  for (const primitive of mesh.children) {
    const type = primitive.name;
    if (type === 'lines' || type === 'linestrips') {
      warn(`${what}: <${type}> are not imported (only polygons)`);
      continue;
    }
    if (
      type !== 'triangles' &&
      type !== 'polylist' &&
      type !== 'polygons' &&
      type !== 'trifans' &&
      type !== 'tristrips'
    )
      continue;
    const inputs = kids(primitive, 'input'),
      stride = Math.max(0, ...inputs.map((i) => integer(i.attributes.offset, 0, `${what} input offset`) + 1));
    const find = (semantic: string): Input | undefined => {
      const matches = inputs.filter((i) => i.attributes.semantic === semantic);
      matches.sort((a, b) => integer(a.attributes.set, 0, 'set') - integer(b.attributes.set, 0, 'set'));
      const input = matches[0];
      return (
        input && {
          source: source(input.attributes.source, semantic),
          offset: integer(input.attributes.offset, 0, `${what} input offset`),
        }
      );
    };
    const vertexInput = inputs.find((i) => i.attributes.semantic === 'VERTEX');
    if (!vertexInput) throw new LoaderError(F, 'syntax', `${what} <${type}> has no VERTEX input`);
    const vertexOffset = integer(vertexInput.attributes.offset, 0, `${what} input offset`);
    // An attribute the primitive lacks may come from <vertices>, indexed like the vertex.
    const shared = (semantic: string): Input | undefined =>
      find(semantic) ??
      (vertexInputs.has(semantic)
        ? { source: source(vertexInputs.get(semantic), semantic), offset: vertexOffset }
        : undefined);
    const normal = shared('NORMAL'),
      texcoord = shared('TEXCOORD'),
      color = shared('COLOR');
    hasNormal ||= !!normal;
    hasUV ||= !!texcoord;
    hasColor ||= !!color;
    const welder = new CornerWelder(vertexCount),
      base = positions.length / 3,
      start = indices.length;
    let p: number[] = [];
    const at = (input: Input | undefined, corner: number, what2: string): number => {
      if (!input) return NONE;
      const index = p[corner * stride + input.offset],
        count = input.source.count;
      if (!(Number.isInteger(index) && index >= 0 && index < count))
        throw new LoaderError(F, 'range', `${what} ${what2} index ${index} is outside 0..${count - 1}`);
      return index;
    };
    const read = (input: Input, index: number, component: number): number => {
      const s = input.source;
      return component < s.params.length ? s.data[s.offset + index * s.stride + s.params[component]] : 1;
    };
    const position: Input = { source: positionSource, offset: vertexOffset };
    const corner = (c: number): number => {
      const v = at(position, c, 'vertex'),
        n = at(normal, c, 'normal'),
        t = at(texcoord, c, 'texcoord'),
        k = at(color, c, 'color'),
        before = welder.count,
        out = welder.weld(v, n, t, k);
      if (out === before) {
        if (++totals.vertices > limit.maxVertices)
          throw new LoaderError(F, 'limit', `vertex count exceeds the limit of ${limit.maxVertices}`);
        positions.push3(read(position, v, 0), read(position, v, 1), read(position, v, 2));
        if (normal) normals.push3(read(normal, n, 0), read(normal, n, 1), read(normal, n, 2));
        else normals.push3(0, 0, 0);
        uvs.push(texcoord ? read(texcoord, t, 0) : 0);
        uvs.push(texcoord && texcoord.source.params.length > 1 ? 1 - read(texcoord, t, 1) : 0);
        if (color) colors.push3(read(color, k, 0), read(color, k, 1), read(color, k, 2));
        else colors.push3(1, 1, 1);
        positionIndices.push(v);
      }
      return base + out;
    };
    // Corners of one polygon in order, triangulated as a fan.
    const polygon = (first: number, size: number): void => {
      if (size < 3) throw new LoaderError(F, 'syntax', `${what} <${type}> has a polygon with ${size} corners`);
      if ((totals.triangles += size - 2) > limit.maxTriangles)
        throw new LoaderError(F, 'limit', `triangle count exceeds the limit of ${limit.maxTriangles}`);
      const c0 = corner(first);
      let previous = corner(first + 1);
      for (let k = 2; k < size; k++) {
        const current = corner(first + k);
        indices.push3(c0, previous, current);
        previous = current;
      }
      faceSizes.push(size);
    };
    const values = (e: XMLElement | undefined, label: string): number[] =>
      e ? numbers(e.text, `${what} <${label}>`) : [];
    const corners = (list: number[], label: string): number => {
      if (!stride || list.length % stride)
        throw new LoaderError(
          F,
          'syntax',
          `${what} <${label}> holds ${list.length} indices, not a multiple of ${stride}`,
        );
      return list.length / stride;
    };
    if (type === 'triangles' || type === 'polylist') {
      p = values(kid(primitive, 'p'), 'p');
      const total = corners(p, 'p');
      if (type === 'triangles' && total % 3)
        throw new LoaderError(F, 'syntax', `${what} <triangles> has ${total} corners, not a multiple of 3`);
      const sizes =
        type === 'triangles' ? new Array<number>(total / 3).fill(3) : values(kid(primitive, 'vcount'), 'vcount');
      let first = 0;
      for (const size of sizes) {
        if (!Number.isSafeInteger(size) || first + size > total)
          throw new LoaderError(F, 'syntax', `${what} <${type}> vcount does not match its <p> indices`);
        polygon(first, size);
        first += size;
      }
      if (first !== total)
        throw new LoaderError(F, 'syntax', `${what} <${type}> vcount does not match its <p> indices`);
    } else
      for (const e of primitive.children) {
        if (e.name !== 'p' && e.name !== 'ph') continue;
        if (e.name === 'ph') warn(`${what}: polygon holes (<ph><h>) are not imported; the outer polygon is kept`);
        p = values(e.name === 'p' ? e : kid(e, 'p'), 'p');
        const total = corners(p, 'p');
        if (type !== 'tristrips') polygon(0, total);
        else
          for (let k = 0; k + 2 < total; k++) {
            if ((totals.triangles += 1) > limit.maxTriangles)
              throw new LoaderError(F, 'limit', `triangle count exceeds the limit of ${limit.maxTriangles}`);
            const a = corner(k),
              b = corner(k + 1),
              c = corner(k + 2);
            if (k % 2) indices.push3(b, a, c);
            else indices.push3(a, b, c);
            faceSizes.push(3);
          }
      }
    const group: DAEGroup = { start, count: indices.length - start };
    if (primitive.attributes.material !== undefined) group.symbol = primitive.attributes.material;
    if (group.count) groups.push(group);
  }
  const result: DAEGeometry = {
    kind: 'mesh',
    id,
    positions: positions.result(),
    indices: indices.result(),
    groups,
    faceSizes: faceSizes.result(),
    positionIndices: positionIndices.result(),
  };
  if (geometry.attributes.name !== undefined) result.name = geometry.attributes.name;
  if (hasNormal) result.normals = normals.result();
  if (hasUV) result.uvs = uvs.result();
  if (hasColor) result.colors = colors.result();
  return result;
}

/** An `<init_from>` URI as a path relative to the .dae folder (`file:///C:/a%20b.png` becomes `C:/a b.png`). */
function imagePath(uri: string): string {
  let path = uri.trim();
  if (/^data:/i.test(path)) return path;
  path = path.replace(/^file:(\/\/)?/i, '').replace(/^\/([a-z]:)/i, '$1');
  try {
    path = decodeURIComponent(path);
  } catch {
    // Not percent-encoded: keep as written.
  }
  return resolvePath('', path);
}

const SHADINGS = ['constant', 'lambert', 'phong', 'blinn'] as const;
const CHANNELS = ['emission', 'ambient', 'diffuse', 'specular', 'reflective', 'transparent'] as const;
const SCALARS = [
  ['shininess', 'shininess'],
  ['reflectivity', 'reflectivity'],
  ['transparency', 'transparency'],
  ['index_of_refraction', 'indexOfRefraction'],
] as const;

function readMaterial(
  material: XMLElement,
  ids: Map<string, XMLElement>,
  images: Map<string, string>,
  warn: (message: string) => void,
): DAEMaterial {
  const id = material.attributes.id ?? '',
    effect = ids.get(ref(kid(material, 'instance_effect')?.attributes.url)),
    profile = kid(effect, 'profile_COMMON'),
    technique = kid(profile, 'technique'),
    shader = technique?.children.find((c) => (SHADINGS as readonly string[]).includes(c.name));
  const result: DAEMaterial = { id, shading: (shader?.name as DAEMaterial['shading']) ?? 'lambert' };
  if (material.attributes.name !== undefined) result.name = material.attributes.name;
  if (!effect) warn(`material "${id}" names no effect`);
  else if (!shader) warn(`material "${id}": effect "${effect.attributes.id}" has no profile_COMMON shader`);
  if (!shader) return result;
  const params = new Map<string, XMLElement>();
  for (const scope of [effect, profile, technique])
    for (const p of kids(scope, 'newparam')) if (p.attributes.sid) params.set(p.attributes.sid, p);
  const texturePath = (sid: string): string | undefined => {
    const sampler = kid(params.get(sid), 'sampler2D');
    if (sampler) {
      // 1.5: the sampler names the image; 1.4.1: sampler -> surface -> image id.
      const instance = kid(sampler, 'instance_image');
      if (instance) return images.get(ref(instance.attributes.url));
      const surface = kid(params.get(kid(sampler, 'source')?.text.trim() ?? ''), 'surface');
      return images.get(kid(surface, 'init_from')?.text.trim() ?? '');
    }
    return images.get(sid); // some exporters name the image directly
  };
  for (const name of CHANNELS) {
    const e = kid(shader, name);
    if (!e) continue;
    const channel: DAEChannel = {},
      color = kid(e, 'color'),
      texture = kid(e, 'texture');
    if (color) {
      const v = numbers(color.text, `material "${id}" ${name} color`);
      if (v.length !== 3 && v.length !== 4)
        throw new LoaderError(F, 'syntax', `material "${id}" ${name} color has ${v.length} values; expected 3 or 4`);
      channel.color = [v[0], v[1], v[2], v[3] ?? 1];
    }
    if (texture) {
      const path = texturePath(texture.attributes.texture ?? '');
      if (path === undefined) warn(`material "${id}" ${name} texture "${texture.attributes.texture}" names no <image>`);
      else {
        channel.texture = { path };
        if (texture.attributes.texcoord !== undefined) channel.texture.texcoord = texture.attributes.texcoord;
      }
    }
    if (channel.color || channel.texture) result[name] = channel;
    if (name === 'transparent' && e.attributes.opaque) result.opaque = e.attributes.opaque;
  }
  for (const [name, key] of SCALARS) {
    const value = kid(kid(shader, name), 'float');
    if (value) result[key] = numbers(value.text, `material "${id}" ${name}`)[0];
  }
  return result;
}

type Matrix = number[];
const IDENTITY: Matrix = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

/** Column-major a * b. */
function multiply(a: Matrix, b: Matrix): Matrix {
  const out = new Array<number>(16);
  for (let c = 0; c < 4; c++)
    for (let r = 0; r < 4; r++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) sum += a[k * 4 + r] * b[c * 4 + k];
      out[c * 4 + r] = sum;
    }
  return out;
}

/** The node's transform stack, applied in document order (each element post-multiplies). */
function localMatrix(node: XMLElement, warn: (message: string) => void): Matrix {
  let m = IDENTITY;
  for (const e of node.children) {
    const what = `node "${node.attributes.id ?? node.attributes.name ?? ''}" <${e.name}>`;
    const v = (count: number): number[] => {
      const values = numbers(e.text, what);
      if (values.length !== count || !values.every(Number.isFinite))
        throw new LoaderError(F, 'syntax', `${what} needs ${count} finite numbers, got ${values.length}`);
      return values;
    };
    switch (e.name) {
      case 'matrix': {
        const rows = v(16);
        m = multiply(
          m,
          rows.map((_, i) => rows[(i % 4) * 4 + Math.floor(i / 4)]),
        );
        break;
      }
      case 'translate': {
        const [x, y, z] = v(3);
        m = multiply(m, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1]);
        break;
      }
      case 'scale': {
        const [x, y, z] = v(3);
        m = multiply(m, [x, 0, 0, 0, 0, y, 0, 0, 0, 0, z, 0, 0, 0, 0, 1]);
        break;
      }
      case 'rotate': {
        const [ax, ay, az, degrees] = v(4),
          length = Math.hypot(ax, ay, az);
        if (!length) break;
        const x = ax / length,
          y = ay / length,
          z = az / length,
          angle = (degrees * Math.PI) / 180,
          c = Math.cos(angle),
          s = Math.sin(angle),
          t = 1 - c;
        m = multiply(m, [
          t * x * x + c,
          t * x * y + s * z,
          t * x * z - s * y,
          0,
          t * x * y - s * z,
          t * y * y + c,
          t * y * z + s * x,
          0,
          t * x * z + s * y,
          t * y * z - s * x,
          t * z * z + c,
          0,
          0,
          0,
          0,
          1,
        ]);
        break;
      }
      case 'lookat':
      case 'skew':
        warn(`${what} transforms are not imported`);
    }
  }
  return m;
}

/**
 * Parses a COLLADA 1.4.1 or 1.5 document (`.dae`): mesh geometries (`<triangles>`, `<polylist>`, `<polygons>`,
 * `<trifans>`, `<tristrips>` with VERTEX, POSITION, NORMAL, TEXCOORD and COLOR inputs), `profile_COMMON` materials
 * (constant, lambert, phong, blinn; colors and textures through sampler and surface params), images, and the
 * instanced visual scene with matrix/translate/rotate/scale stacks, `bind_material` symbols and `instance_node`.
 * `up_axis` and `unit` are converted to Y-up meters. Lines, polygon holes, skins, morphs and animations are not
 * imported; each is reported in `warnings`. Image paths are relative to the .dae folder, for the caller's resolver.
 */
export function parseDAE(input: BinaryInput | string, options: DAEParseOptions = {}): LoadedDAE {
  const limit = limits(options, F),
    root = readXMLTree(typeof input === 'string' ? input : decodeXML(toBytes(input, F)), F).children[0];
  if (root?.name !== 'COLLADA')
    throw new LoaderError(F, 'header', `root element is <${root?.name ?? ''}>, not <COLLADA>`);
  const warnings = new Set<string>(),
    warn = (message: string): void => void warnings.add(message);
  const ids = new Map<string, XMLElement>(),
    images = new Map<string, string>();
  const index = (e: XMLElement): void => {
    if (e.attributes.id) ids.set(e.attributes.id, e);
    if (e.name === 'image' && e.attributes.id) {
      const from = kid(e, 'init_from'),
        uri = (kid(from, 'ref') ?? from)?.text.trim();
      if (uri) images.set(e.attributes.id, imagePath(uri));
      else warn(`image "${e.attributes.id}" has no file (embedded data is not imported)`);
    }
    for (const child of e.children) index(child);
  };
  index(root);
  const asset = kid(root, 'asset'),
    upAxis = (kid(asset, 'up_axis')?.text.trim() || 'Y_UP') as LoadedDAE['upAxis'],
    unit = kid(asset, 'unit')?.attributes.meter,
    meter = unit === undefined ? 1 : Number(unit);
  if (!Object.hasOwn(AXES, upAxis)) throw new LoaderError(F, 'syntax', `unknown up_axis "${upAxis.slice(0, 16)}"`);
  if (!(meter > 0 && Number.isFinite(meter)))
    throw new LoaderError(F, 'syntax', `unit meter must be a positive number, got "${String(unit).slice(0, 16)}"`);
  const axis = AXES[upAxis];

  const geometries: DAEGeometry[] = [],
    geometryIndex = new Map<string, number>(),
    totals = { vertices: 0, triangles: 0 };
  for (const geometry of kids(kid(root, 'library_geometries'), 'geometry')) {
    const mesh = kid(geometry, 'mesh');
    if (!mesh) {
      warn(`geometry "${geometry.attributes.id}" is not a <mesh> and is not imported`);
      continue;
    }
    const loaded = readMesh(geometry, mesh, ids, limit, totals, warn);
    // Y-up meters: p' = meter * R p, n' = R n.
    const p = loaded.positions,
      n = loaded.normals;
    for (let i = 0; i < p.length; i += 3) {
      const x = p[i],
        y = p[i + 1],
        z = p[i + 2];
      for (let r = 0; r < 3; r++) p[i + r] = meter * (axis[r * 3] * x + axis[r * 3 + 1] * y + axis[r * 3 + 2] * z);
      if (!n) continue;
      const nx = n[i],
        ny = n[i + 1],
        nz = n[i + 2];
      for (let r = 0; r < 3; r++) n[i + r] = axis[r * 3] * nx + axis[r * 3 + 1] * ny + axis[r * 3 + 2] * nz;
    }
    geometryIndex.set(loaded.id, geometries.length);
    geometries.push(loaded);
  }

  const materials: DAEMaterial[] = [],
    materialIndex = new Map<string, number>();
  for (const material of kids(kid(root, 'library_materials'), 'material')) {
    materialIndex.set(material.attributes.id ?? '', materials.length);
    materials.push(readMaterial(material, ids, images, warn));
  }

  // M' = C M C^-1 with C = meter * R: rotations keep their axes in Y-up, translations scale to meters.
  const C: Matrix = [...IDENTITY],
    inverse: Matrix = [...IDENTITY];
  for (let r = 0; r < 3; r++)
    for (let c = 0; c < 3; c++) {
      C[c * 4 + r] = meter * axis[r * 3 + c];
      inverse[r * 4 + c] = axis[r * 3 + c] / meter;
    }
  let nodeCount = 0;
  const readNode = (e: XMLElement, depth: number): DAENode => {
    if (depth > MAX_DEPTH)
      throw new LoaderError(F, 'limit', `nodes nest deeper than ${MAX_DEPTH} (an instance_node cycle?)`);
    if (++nodeCount > MAX_NODES) throw new LoaderError(F, 'limit', `the scene expands to more than ${MAX_NODES} nodes`);
    const node: DAENode = {
      matrix: multiply(multiply(C, localMatrix(e, warn)), inverse),
      instances: [],
      children: [],
    };
    if (e.attributes.id !== undefined) node.id = e.attributes.id;
    if (e.attributes.name !== undefined) node.name = e.attributes.name;
    for (const child of e.children)
      switch (child.name) {
        case 'node':
          node.children.push(readNode(child, depth + 1));
          break;
        case 'instance_node': {
          const target = ids.get(ref(child.attributes.url));
          if (target?.name === 'node') node.children.push(readNode(target, depth + 1));
          else warn(`instance_node "${child.attributes.url}" names no <node>`);
          break;
        }
        case 'instance_geometry': {
          const geometry = geometryIndex.get(ref(child.attributes.url));
          if (geometry === undefined) {
            warn(`instance_geometry "${child.attributes.url}" names no imported mesh`);
            break;
          }
          const bound: Record<string, number> = Object.create(null);
          for (const m of kids(kid(kid(child, 'bind_material'), 'technique_common'), 'instance_material')) {
            const material = materialIndex.get(ref(m.attributes.target));
            if (material === undefined) warn(`instance_material "${m.attributes.target}" names no <material>`);
            else if (m.attributes.symbol !== undefined) bound[m.attributes.symbol] = material;
          }
          node.instances.push({ geometry, materials: bound });
          break;
        }
        case 'instance_controller':
          warn(
            `controller "${ref(child.attributes.url)}" is not imported: skins and morphs are not supported, so its node has no mesh`,
          );
      }
    return node;
  };
  const sceneUrl = kid(kid(root, 'scene'), 'instance_visual_scene')?.attributes.url,
    scene = sceneUrl ? ids.get(ref(sceneUrl)) : kid(kid(root, 'library_visual_scenes'), 'visual_scene');
  if (sceneUrl && scene?.name !== 'visual_scene')
    throw new LoaderError(F, 'syntax', `instance_visual_scene "${sceneUrl.slice(0, 64)}" names no <visual_scene>`);
  const nodes = kids(scene, 'node').map((e) => readNode(e, 0));
  const animations = kids(kid(root, 'library_animations'), 'animation').length;
  if (animations) warn(`${animations} animation${animations > 1 ? 's are' : ' is'} not imported`);
  const used = new Set<string>();
  for (const material of materials)
    for (const name of CHANNELS) {
      const path = material[name]?.texture?.path;
      if (path !== undefined) used.add(path);
    }
  return { upAxis, meter, geometries, materials, images: [...used], nodes, warnings: [...warnings] };
}

/**
 * Bakes a parsed COLLADA scene into one `LoadedGeometry` for `createMeshes` and `toGeometry`: every node instance's
 * geometry transformed by its world matrix (mirroring transforms keep outward winding), one group per instance and
 * primitive, named after the node and colored with the bound material's diffuse color.
 */
export function flattenDAE(dae: LoadedDAE): LoadedGeometry & { faceSizes: Uint32Array } {
  const parts: { node: DAENode; world: Matrix; geometry: DAEGeometry; materials: Record<string, number> }[] = [];
  const walk = (node: DAENode, parent: Matrix): void => {
    const world = multiply(parent, node.matrix);
    for (const instance of node.instances) {
      const geometry = dae.geometries[instance.geometry];
      if (!geometry)
        throw new LoaderError(F, 'range', `instance names geometry ${instance.geometry}, which does not exist`);
      parts.push({ node, world, geometry, materials: instance.materials });
    }
    for (const child of node.children) walk(child, world);
  };
  for (const node of dae.nodes) walk(node, IDENTITY);
  let vertexCount = 0,
    indexCount = 0,
    faceCount = 0;
  for (const { geometry } of parts) {
    vertexCount += geometry.positions.length / 3;
    indexCount += geometry.indices.length;
    faceCount += geometry.faceSizes.length;
  }
  if (vertexCount > DEFAULT_MAX_VERTICES || indexCount / 3 > DEFAULT_MAX_TRIANGLES)
    throw new LoaderError(
      F,
      'limit',
      `the flattened scene has ${vertexCount} vertices and ${indexCount / 3} triangles`,
    );
  const has = (key: 'normals' | 'uvs' | 'colors'): boolean => parts.some((p) => p.geometry[key]),
    positions = new Float32Array(vertexCount * 3),
    normals = has('normals') ? new Float32Array(vertexCount * 3) : undefined,
    uvs = has('uvs') ? new Float32Array(vertexCount * 2) : undefined,
    colors = has('colors') ? new Float32Array(vertexCount * 3).fill(1) : undefined,
    indices = new Uint32Array(indexCount),
    faceSizes = new Uint32Array(faceCount),
    groups: LoadedGroup[] = [];
  let v = 0,
    o = 0,
    f = 0;
  for (const { node, world: m, geometry, materials } of parts) {
    const p = geometry.positions,
      count = p.length / 3;
    // Cofactors of the 3x3 part: the inverse transpose times the determinant.
    const n = [
        m[5] * m[10] - m[6] * m[9],
        m[6] * m[8] - m[4] * m[10],
        m[4] * m[9] - m[5] * m[8],
        m[2] * m[9] - m[1] * m[10],
        m[0] * m[10] - m[2] * m[8],
        m[1] * m[8] - m[0] * m[9],
        m[1] * m[6] - m[2] * m[5],
        m[2] * m[4] - m[0] * m[6],
        m[0] * m[5] - m[1] * m[4],
      ],
      determinant = m[0] * n[0] + m[1] * n[1] + m[2] * n[2];
    for (let i = 0; i < count; i++) {
      const x = p[i * 3],
        y = p[i * 3 + 1],
        z = p[i * 3 + 2],
        out = (v + i) * 3;
      for (let r = 0; r < 3; r++) positions[out + r] = m[r] * x + m[4 + r] * y + m[8 + r] * z + m[12 + r];
      if (normals && geometry.normals) {
        const a = geometry.normals[i * 3],
          b = geometry.normals[i * 3 + 1],
          c = geometry.normals[i * 3 + 2];
        let nx = n[0] * a + n[3] * b + n[6] * c,
          ny = n[1] * a + n[4] * b + n[7] * c,
          nz = n[2] * a + n[5] * b + n[8] * c;
        // Cofactors carry the determinant's sign; the normal transform (inverse transpose) does not.
        const length = (Math.hypot(nx, ny, nz) || 1) * Math.sign(determinant || 1);
        nx /= length;
        ny /= length;
        nz /= length;
        normals.set([nx, ny, nz], out);
      }
      if (uvs && geometry.uvs) uvs.set(geometry.uvs.subarray(i * 2, i * 2 + 2), (v + i) * 2);
      if (colors && geometry.colors) colors.set(geometry.colors.subarray(i * 3, i * 3 + 3), out);
    }
    const flip = determinant < 0,
      source = geometry.indices;
    for (let i = 0; i < source.length; i += 3) {
      indices[o + i] = v + source[i];
      indices[o + i + 1] = v + source[flip ? i + 2 : i + 1];
      indices[o + i + 2] = v + source[flip ? i + 1 : i + 2];
    }
    for (const g of geometry.groups) {
      const group: LoadedGroup = { start: o + g.start, count: g.count };
      const name = node.name ?? node.id;
      if (name !== undefined) group.name = name;
      const material = g.symbol === undefined ? undefined : dae.materials[materials[g.symbol]];
      if (material?.diffuse?.color) group.color = [...material.diffuse.color];
      groups.push(group);
    }
    faceSizes.set(geometry.faceSizes, f);
    v += count;
    o += source.length;
    f += geometry.faceSizes.length;
  }
  const result: LoadedGeometry & { faceSizes: Uint32Array } = { kind: 'mesh', positions, indices, groups, faceSizes };
  if (normals) result.normals = normals;
  if (uvs) result.uvs = uvs;
  if (colors) result.colors = colors;
  return result;
}
