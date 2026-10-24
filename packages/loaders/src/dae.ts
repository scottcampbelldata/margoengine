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
import {
  AXES,
  converter,
  F,
  IDENTITY,
  integer,
  kid,
  kids,
  lookatMatrix,
  multiply,
  numbers,
  readSource,
  ref,
  skewMatrix,
  stackMatrix,
  TRANSFORM_SIZES,
  type DAETransform,
  type Matrix,
  type Source,
} from './dae-common.js';
import { readControllers, type DAEMorph, type DAESkin } from './dae-controllers.js';
import { readAnimations, type DAEAnimation, type DAEClip } from './dae-animation.js';
import { deformInstance, restPose, type DAEPose } from './dae-pose.js';
import { placeScene, type DAECamera, type DAELight, type DAEPlacement } from './dae-scene.js';

export type { DAETransform } from './dae-common.js';
export type { DAESkin, DAEMorph } from './dae-controllers.js';
export type { DAECamera, DAELight } from './dae-scene.js';
export type {
  DAEAnimation,
  DAEAnimationChannel,
  DAEClip,
  DAEInterpolation,
  DAESampler,
} from './dae-animation.js';

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

/**
 * An `<instance_geometry>`, or an `<instance_controller>` (then `skin` and/or `morph` are set and `geometry` is the
 * controller's base mesh).
 */
export interface DAEInstance {
  /** Index into `LoadedDAE.geometries`. */
  geometry: number;
  /** Index into `LoadedDAE.materials` by primitive symbol, in a null-prototype object. */
  materials: Record<string, number>;
  /** Index into `LoadedDAE.skins`; set only when every joint resolved to a node (`joints`). */
  skin?: number;
  /** Index into `LoadedDAE.morphs`. */
  morph?: number;
  /** The node of each of the skin's `joints`, found under the instance's `<skeleton>` roots (else the whole scene). */
  joints?: DAENode[];
}

/** A scene node. `instance_node` references are expanded into copies. */
export interface DAENode {
  id?: string;
  name?: string;
  /** The node's `sid`, which skin joints name. */
  sid?: string;
  /**
   * Local transform (the node's matrix, translate, rotate, scale, lookat and skew stack), column-major 4x4, in Y-up
   * meters.
   */
  matrix: number[];
  /** The transform stack as written (the file's axes and units), which animation channels address by sid. */
  transforms: DAETransform[];
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
  /** `<skin>` controllers, in Y-up meters. */
  skins: DAESkin[];
  /** `<morph>` controllers. */
  morphs: DAEMorph[];
  /** Every `<animation>`, nested ones included, with the channels that address imported nodes and morphs. */
  animations: DAEAnimation[];
  /** `<animation_clip>`s. */
  clips: DAEClip[];
  /** Every `<instance_camera>` in scene order, with its optics and frame at rest. */
  cameras: DAECamera[];
  /** Every `<instance_light>` in scene order, with its color, attenuation and frame at rest. */
  lights: DAELight[];
  /** What was skipped: lines, holes, unresolved references, channels and controllers that do not fit. */
  warnings: string[];
}

/** Options of `parseDAE`. */
export interface DAEParseOptions extends ParseLimits {}

interface Input {
  source: Source;
  offset: number;
}

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

/** The node's transform stack as written, in document order (each element post-multiplies). */
function readTransforms(node: XMLElement, warn: (message: string) => void): DAETransform[] {
  const out: DAETransform[] = [];
  for (const e of node.children) {
    if (!Object.hasOwn(TRANSFORM_SIZES, e.name)) continue;
    const type = e.name as DAETransform['type'],
      count = TRANSFORM_SIZES[type],
      what = `node "${node.attributes.id ?? node.attributes.name ?? ''}" <${e.name}>`,
      values = numbers(e.text, what);
    if (values.length !== count || !values.every(Number.isFinite))
      throw new LoaderError(F, 'syntax', `${what} needs ${count} finite numbers, got ${values.length}`);
    if (type === 'lookat' && !lookatMatrix(values))
      warn(
        `${what} has its eye on the interest point or up along the view; only the eye is used: fix eye, interest or up`,
      );
    if (type === 'skew' && !skewMatrix(values))
      warn(
        `${what} is skipped: give a nonzero translation axis, a rotation axis not parallel to it, and an angle that does not turn the rotation axis onto or past it`,
      );
    const transform: DAETransform = { type, values };
    if (e.attributes.sid !== undefined) transform.sid = e.attributes.sid;
    out.push(transform);
  }
  return out;
}

function bindMaterials(
  instance: XMLElement,
  materialIndex: Map<string, number>,
  warn: (message: string) => void,
): Record<string, number> {
  const bound: Record<string, number> = Object.create(null);
  for (const m of kids(kid(kid(instance, 'bind_material'), 'technique_common'), 'instance_material')) {
    const material = materialIndex.get(ref(m.attributes.target));
    if (material === undefined) warn(`instance_material "${m.attributes.target}" names no <material>`);
    else if (m.attributes.symbol !== undefined) bound[m.attributes.symbol] = material;
  }
  return bound;
}

/** Depth-first search of node trees. */
function findNode(roots: readonly DAENode[], match: (node: DAENode) => boolean): DAENode | undefined {
  for (const root of roots) {
    if (match(root)) return root;
    const found = findNode(root.children, match);
    if (found) return found;
  }
  return undefined;
}

/**
 * Parses a COLLADA 1.4.1 or 1.5 document (`.dae`): mesh geometries (`<triangles>`, `<polylist>`, `<polygons>`,
 * `<trifans>`, `<tristrips>` with VERTEX, POSITION, NORMAL, TEXCOORD and COLOR inputs), `profile_COMMON` materials
 * (constant, lambert, phong, blinn; colors and textures through sampler and surface params), images, and the
 * instanced visual scene with matrix/translate/rotate/scale stacks, `bind_material` symbols and `instance_node`.
 * Controllers (`<skin>` with up to four influences per vertex, `<morph>` NORMALIZED or RELATIVE) and
 * `<instance_controller>` with `<skeleton>` roots, animations (nested, LINEAR, STEP, BEZIER and HERMITE samplers on
 * node transform elements and morph weights) and animation clips are read too. `up_axis` and `unit` are converted to
 * Y-up meters, alike for geometry, node, bind shape and inverse bind matrices. `lookat` and `skew` join the transform
 * stack; `<instance_camera>` and `<instance_light>` give `cameras` and `lights` (technique_common optics and lights)
 * with their frames. Lines, polygon holes, and cameras, lights, channels or controllers that do not fit are not
 * imported; each is reported in `warnings`. Image paths are
 * relative to the .dae folder, for the caller's resolver.
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
  const convert = converter(upAxis, meter);
  const { skins, morphs, controllers } = readControllers(
    root,
    ids,
    geometryIndex,
    (g) => geometries[g].positionIndices,
    convert,
    warn,
  );
  // Controller instances whose skin joints resolve once the whole scene exists.
  const pending: { instance: DAEInstance; roots: string[]; idref: boolean; url: string }[] = [],
    placements: DAEPlacement[] = [],
    copies = new Map<XMLElement, DAENode[]>();
  let nodeCount = 0;
  const readNode = (e: XMLElement, depth: number): DAENode => {
    if (depth > MAX_DEPTH)
      throw new LoaderError(F, 'limit', `nodes nest deeper than ${MAX_DEPTH} (an instance_node cycle?)`);
    if (++nodeCount > MAX_NODES) throw new LoaderError(F, 'limit', `the scene expands to more than ${MAX_NODES} nodes`);
    const transforms = readTransforms(e, warn),
      node: DAENode = { matrix: convert(stackMatrix(transforms)), transforms, instances: [], children: [] };
    if (e.attributes.id !== undefined) node.id = e.attributes.id;
    if (e.attributes.name !== undefined) node.name = e.attributes.name;
    if (e.attributes.sid !== undefined) node.sid = e.attributes.sid;
    const list = copies.get(e);
    if (list) list.push(node);
    else copies.set(e, [node]);
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
        case 'instance_camera':
        case 'instance_light':
          placements.push({
            node,
            kind: child.name === 'instance_camera' ? 'camera' : 'light',
            url: child.attributes.url ?? '',
          });
          break;
        case 'instance_geometry': {
          const geometry = geometryIndex.get(ref(child.attributes.url));
          if (geometry === undefined) {
            warn(`instance_geometry "${child.attributes.url}" names no imported mesh`);
            break;
          }
          node.instances.push({ geometry, materials: bindMaterials(child, materialIndex, warn) });
          break;
        }
        case 'instance_controller': {
          const url = ref(child.attributes.url),
            controller = controllers.get(url);
          if (!controller) {
            warn(
              `instance_controller "${child.attributes.url}" names no imported <controller>, so its node has no mesh`,
            );
            break;
          }
          const instance: DAEInstance = {
            geometry: controller.geometry,
            materials: bindMaterials(child, materialIndex, warn),
          };
          if (controller.morph !== undefined) instance.morph = controller.morph;
          if (controller.skin !== undefined) {
            instance.skin = controller.skin;
            pending.push({
              instance,
              roots: kids(child, 'skeleton').map((s) => ref(s.text.trim())),
              idref: !!controller.idref,
              url,
            });
          }
          node.instances.push(instance);
        }
      }
    return node;
  };
  const sceneUrl = kid(kid(root, 'scene'), 'instance_visual_scene')?.attributes.url,
    scene = sceneUrl ? ids.get(ref(sceneUrl)) : kid(kid(root, 'library_visual_scenes'), 'visual_scene');
  if (sceneUrl && scene?.name !== 'visual_scene')
    throw new LoaderError(F, 'syntax', `instance_visual_scene "${sceneUrl.slice(0, 64)}" names no <visual_scene>`);
  const nodes = kids(scene, 'node').map((e) => readNode(e, 0));
  // Name_array joints are sids under the <skeleton> roots; IDREF_array joints are node ids. Ids and names are also
  // tried, since exporters disagree.
  for (const { instance, roots, idref, url } of pending) {
    const skin = skins[instance.skin!],
      starts = roots.flatMap((id) => {
        const element = ids.get(id);
        return (element && copies.get(element)?.slice(0, 1)) ?? [];
      }),
      scope = starts.length ? starts : nodes,
      joints: DAENode[] = [];
    for (const name of skin.joints) {
      const joint = idref
        ? findNode(nodes, (n) => n.id === name)
        : (findNode(scope, (n) => n.sid === name) ??
          findNode(scope, (n) => n.id === name) ??
          findNode(scope, (n) => n.name === name) ??
          findNode(nodes, (n) => n.sid === name));
      if (!joint) {
        warn(`skin "${url}": joint "${name}" names no node, so the mesh is not skinned`);
        break;
      }
      joints.push(joint);
    }
    if (joints.length === skin.joints.length) instance.joints = joints;
    else delete instance.skin;
  }
  const { animations, clips } = readAnimations(root, ids, morphs, warn),
    { cameras, lights } = placeScene({ nodes, upAxis, meter }, ids, placements, warn);
  const used = new Set<string>();
  for (const material of materials)
    for (const name of CHANNELS) {
      const path = material[name]?.texture?.path;
      if (path !== undefined) used.add(path);
    }
  return {
    upAxis,
    meter,
    geometries,
    materials,
    images: [...used],
    nodes,
    skins,
    morphs,
    animations,
    clips,
    cameras,
    lights,
    warnings: [...warnings],
  };
}

/**
 * Bakes a parsed COLLADA scene into one `LoadedGeometry` for `createMeshes` and `toGeometry`: every node instance's
 * geometry transformed by its world matrix (mirroring transforms keep outward winding), one group per instance and
 * primitive, named after the node and colored with the bound material's diffuse color. Morphed instances use the
 * pose's weights and skinned ones are skinned by their joints' world matrices, so `flattenDAE(dae, poseDAE(dae, t))`
 * bakes the animated scene at time t; without a pose the scene is at rest.
 */
export function flattenDAE(dae: LoadedDAE, pose: DAEPose = restPose(dae)): LoadedGeometry & { faceSizes: Uint32Array } {
  const parts: {
    node: DAENode;
    geometry: DAEGeometry;
    materials: Record<string, number>;
    positions: Float32Array;
    normals?: Float32Array;
    flip: boolean;
  }[] = [];
  const walk = (node: DAENode, parent: Matrix): void => {
    const world = multiply(parent, pose.local.get(node) ?? node.matrix);
    for (const instance of node.instances) {
      const geometry = dae.geometries[instance.geometry];
      if (!geometry)
        throw new LoaderError(F, 'range', `instance names geometry ${instance.geometry}, which does not exist`);
      parts.push({ node, geometry, materials: instance.materials, ...deformInstance(dae, instance, world, pose) });
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
  for (const part of parts) {
    const { node, geometry, materials } = part,
      count = geometry.positions.length / 3;
    positions.set(part.positions, v * 3);
    if (normals && part.normals) normals.set(part.normals, v * 3);
    if (uvs && geometry.uvs) uvs.set(geometry.uvs, v * 2);
    if (colors && geometry.colors) colors.set(geometry.colors, v * 3);
    const flip = part.flip,
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
