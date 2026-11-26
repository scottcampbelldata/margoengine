// Babylon.js `.babylon` scenes: a JSON file of meshes, geometries, materials, cameras, lights, skeletons and animations.
// Read from the public description of the file (doc.babylonjs.com, "Babylon file format" and the serialization
// reference). Babylon is left-handed with Y up; `rightHanded` (default true) mirrors Z into the engine's space.
import { LoaderError, type LoadedGeometry, type LoadedGroup, type ParseLimits } from './types.js';
import { DEFAULT_MAX_VERTICES, DEFAULT_MAX_TRIANGLES, toBytes, type BinaryInput } from './util.js';

const F = 'BABYLON';

/** Options of {@link parseBabylon}: the shared size limits plus the handedness and byte bounds below. */
export interface BabylonOptions extends ParseLimits {
  /** Mirror Babylon's left-handed Z into the engine's right-handed space and keep the winding. Default true. */
  rightHanded?: boolean;
  /** Largest file in bytes. Default 256 MiB. */
  maxBytes?: number;
  /** Most nodes (meshes, instances, transform nodes, cameras, lights). Default 100,000. */
  maxNodes?: number;
  /** Most bytes of embedded `base64String` textures, all together. Default 64 MiB. */
  maxTextureBytes?: number;
}

/** A texture slot of a material. An embedded image arrives decoded in `data`; otherwise `name` is a path or URL. */
export interface BabylonTexture {
  name: string;
  level: number;
  offset: [number, number];
  scale: [number, number];
  /** Radians, about the texture centre. */
  angle: number;
  hasAlpha: boolean;
  /** Babylon flips the image on load (true, the default); false means the file's v runs down the image, as glTF's does. */
  invertY: boolean;
  /** UV set: 0 (`uvs`) or 1 (`uvs2`). */
  uvSet: number;
  /** Wrap per axis: 0 clamp, 1 wrap, 2 mirror. */
  wrap: [number, number];
  /** Bytes of an embedded `data:` image (`base64String`). */
  data?: Uint8Array;
  /** Media type of `data`. */
  mimeType?: string;
}

/** A material reduced to what an engine material needs. Colours are linear rgb. */
export interface BabylonMaterial {
  id: string;
  name: string;
  /** `'pbr'` for the PBR classes, `'standard'` for StandardMaterial and anything else. */
  kind: 'standard' | 'pbr';
  /** The `customType` the file named, such as `BABYLON.PBRMetallicRoughnessMaterial`. */
  className: string;
  /** Diffuse or albedo or base colour, with the material's alpha in the fourth value. */
  color: [number, number, number, number];
  emissive: [number, number, number];
  /** Standard materials: specular colour and exponent. */
  specular: [number, number, number];
  specularPower: number;
  /** PBR materials. */
  metallic?: number;
  roughness?: number;
  alpha: number;
  doubleSided: boolean;
  /** `disableLighting`: shade with the colour alone. */
  unlit: boolean;
  textures: Partial<
    Record<'color' | 'normal' | 'emissive' | 'opacity' | 'metallicRoughness' | 'occlusion' | 'specular', BabylonTexture>
  >;
}

/** A MultiMaterial: submesh `materialIndex` picks `materials[materialIndex]` (material ids). */
export interface BabylonMultiMaterial {
  id: string;
  name: string;
  materials: string[];
}

/** One animation of a node: keys of `values` at `frame` for a property, at `fps` frames a second. */
export interface BabylonAnimation {
  name: string;
  /** `position`, `rotationQuaternion` or `scaling` (an Euler `rotation` is converted to `rotationQuaternion`). */
  property: string;
  fps: number;
  loop: boolean;
  keys: { frame: number; values: number[] }[];
}

/** Fields of every node: placement relative to the parent, in the engine's space. */
export interface BabylonNode {
  id: string;
  name: string;
  parentId?: string;
  translation: [number, number, number];
  /** Quaternion x, y, z, w. */
  rotation: [number, number, number, number];
  scale: [number, number, number];
  visible: boolean;
  animations: BabylonAnimation[];
}

/** A mesh. A mesh made by `instances` shares its source's geometry object and sets `instanceOf`. */
export interface BabylonMesh extends BabylonNode {
  /** `uvs2` is `attributes.uv1`; each submesh is a group with `properties.materialIndex`. */
  geometry: LoadedGeometry;
  /** A material id, or a multi-material id when the mesh has submeshes with their own `materialIndex`. */
  materialId?: string;
  skeletonId?: string;
  /** Four bone indices per vertex, and their weights; `joints1`/`weights1` hold influences five to eight. */
  joints?: Uint16Array;
  weights?: Float32Array;
  joints1?: Uint16Array;
  weights1?: Float32Array;
  instanceOf?: string;
}

/** A TransformNode: a pure parent. */
export interface BabylonTransformNode extends BabylonNode {}

/** A camera of the scene file, with its look-at point and lens. */
export interface BabylonCamera {
  id: string;
  name: string;
  parentId?: string;
  /** The file's class: `FreeCamera`, `ArcRotateCamera`, `UniversalCamera`, ... */
  className: string;
  position: [number, number, number];
  /** The point looked at, derived from `target`, from alpha/beta/radius, or from the rotation. */
  target: [number, number, number];
  /** Vertical field of view in radians. */
  fov: number;
  near: number;
  far: number;
  /** Set for orthographic cameras (`mode` 1). */
  orthographic?: { left: number; right: number; top: number; bottom: number };
}

/** A light of the scene file: point, directional, spot or hemispheric, in linear rgb. */
export interface BabylonLight {
  id: string;
  name: string;
  parentId?: string;
  kind: 'point' | 'directional' | 'spot' | 'hemispheric';
  /** Linear rgb (`diffuse`). */
  color: [number, number, number];
  intensity: number;
  position?: [number, number, number];
  /** Directional and spot: the way it shines. Hemispheric: the direction of the sky. */
  direction?: [number, number, number];
  range?: number;
  /** Spot: the full cone angle in radians. */
  angle?: number;
  /** Spot: the full inner cone angle in radians, when the file gives it. */
  innerAngle?: number;
  groundColor?: [number, number, number];
}

/** One bone of a skeleton: its name, index, parent and bind matrix. */
export interface BabylonBone {
  name: string;
  index: number;
  parentBoneIndex: number;
  /** Local bind matrix, 16 values column-major, in the engine's space. */
  matrix: number[];
}

/** A skeleton of the scene file: its bones in file order. */
export interface BabylonSkeleton {
  id: string;
  name: string;
  bones: BabylonBone[];
}

/** What {@link parseBabylon} returns. Every list is in file order. */
export interface LoadedBabylon {
  meshes: BabylonMesh[];
  transformNodes: BabylonTransformNode[];
  materials: BabylonMaterial[];
  multiMaterials: BabylonMultiMaterial[];
  cameras: BabylonCamera[];
  lights: BabylonLight[];
  skeletons: BabylonSkeleton[];
  clearColor?: [number, number, number];
  ambientColor?: [number, number, number];
  activeCameraId?: string;
  /** The `producer` block's name and version, when present. */
  producer?: { name: string; version: string };
  /** Things the loader skipped (delay-loaded meshes, pivot matrices, unknown classes). */
  warnings: string[];
}

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const syntax = (m: string): never => {
  throw new LoaderError(F, 'syntax', m);
};
const list = (v: unknown, what: string): Json[] => {
  if (v === undefined) return [];
  if (!Array.isArray(v)) return syntax(`${what} is not an array`);
  for (const item of v) if (!isObject(item)) syntax(`${what} holds a value that is not an object`);
  return v as Json[];
};
const str = (v: unknown, fallback: string): string =>
  typeof v === 'string' ? v : typeof v === 'number' ? String(v) : fallback;
const num = (v: unknown, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
const flag = (v: unknown, fallback: boolean): boolean =>
  typeof v === 'boolean' ? v : typeof v === 'number' ? v !== 0 : fallback;
function vec<N extends number>(v: unknown, n: N, fallback: number[], what: string): number[] {
  if (v === undefined || v === null) return fallback;
  if (!Array.isArray(v) || v.length < n || v.slice(0, n).some((x) => typeof x !== 'number' || !Number.isFinite(x)))
    return syntax(`${what} must be ${n} numbers`);
  return v.slice(0, n) as number[];
}
function numbers(v: unknown, what: string, multiple: number, max: number): number[] | undefined {
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v)) return syntax(`${what} is not an array`);
  if (v.length > max) throw new LoaderError(F, 'limit', `${what} has ${v.length} values, past the limit of ${max}`);
  if (v.length % multiple) syntax(`${what} length ${v.length} is not a multiple of ${multiple}`);
  for (let i = 0; i < v.length; i++)
    if (typeof v[i] !== 'number' || !Number.isFinite(v[i])) syntax(`${what}[${i}] is not a number`);
  return v as number[];
}

const srgbToLinear = (c: number): number => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const linearToSrgb = (c: number): number => (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055);

function eulerToQuaternion(x: number, y: number, z: number): [number, number, number, number] {
  // Babylon's YXZ order: roll about Z first, then pitch about X, then yaw about Y; q = qy * qx * qz.
  const [sx, cx, sy, cy, sz, cz] = [
    Math.sin(x / 2),
    Math.cos(x / 2),
    Math.sin(y / 2),
    Math.cos(y / 2),
    Math.sin(z / 2),
    Math.cos(z / 2),
  ];
  // qy * qx
  const ax = cy * sx,
    ay = sy * cx,
    az = -sy * sx,
    aw = cy * cx;
  // (qy * qx) * qz, qz = (0, 0, sz, cz)
  return [ax * cz + ay * sz, ay * cz - ax * sz, az * cz + aw * sz, aw * cz - az * sz];
}

function decodeBase64(text: string, what: string): Uint8Array {
  try {
    const bin = atob(text);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return syntax(`${what} is not valid base64`);
  }
}

/**
 * Parses a Babylon.js `.babylon` scene. `input` is the file's bytes, its JSON text or the parsed object. Meshes keep the
 * file's own vertices (`positions`, `normals`, `uvs`, `uvs2`, `colors`, `indices`) or the shared `geometries` they name;
 * `instances` become meshes that share the geometry object. Skeletons, per-vertex bone weights and node animations are
 * read; particle systems, sprites, sounds, post processes, LODs and delay-loaded binary mesh data are skipped with a
 * warning. Bad shapes, out-of-range indices and counts past the limits throw a `LoaderError`.
 */
export function parseBabylon(input: BinaryInput | string | object, options: BabylonOptions = {}): LoadedBabylon {
  const maxBytes = options.maxBytes ?? 256 * 1024 * 1024,
    maxVertices = options.maxVertices ?? DEFAULT_MAX_VERTICES,
    maxTriangles = options.maxTriangles ?? DEFAULT_MAX_TRIANGLES,
    maxNodes = options.maxNodes ?? 100_000,
    maxTextureBytes = options.maxTextureBytes ?? 64 * 1024 * 1024,
    rh = options.rightHanded ?? true;
  for (const [k, v] of Object.entries({ maxBytes, maxVertices, maxTriangles, maxNodes, maxTextureBytes }))
    if (!Number.isSafeInteger(v) || v < 0) throw new LoaderError(F, 'range', `${k} must be a non-negative integer`);
  let doc: unknown;
  if (typeof input === 'string' || ArrayBuffer.isView(input) || input instanceof ArrayBuffer) {
    let text: string;
    if (typeof input === 'string') {
      if (input.length > maxBytes) throw new LoaderError(F, 'limit', `file is past the limit of ${maxBytes} bytes`);
      text = input;
    } else {
      const bytes = toBytes(input as BinaryInput, F);
      if (bytes.length > maxBytes) throw new LoaderError(F, 'limit', `file is past the limit of ${maxBytes} bytes`);
      text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
    }
    try {
      doc = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
    } catch (e) {
      throw new LoaderError(F, 'syntax', `not valid JSON (${(e as Error).message.slice(0, 80)})`, { cause: e });
    }
  } else if (isObject(input)) doc = input;
  else throw new LoaderError(F, 'range', 'expected bytes, JSON text or a parsed object');
  if (!isObject(doc)) return syntax('the file is not a JSON object');
  if (
    doc.meshes === undefined &&
    doc.cameras === undefined &&
    doc.lights === undefined &&
    doc.materials === undefined &&
    doc.geometries === undefined &&
    doc.transformNodes === undefined
  )
    throw new LoaderError(F, 'header', 'no meshes, cameras, lights, materials or geometries: not a .babylon scene');

  const warnings: string[] = [];
  const warn = (m: string) => {
    if (warnings.length < 200) warnings.push(m);
  };
  let nodeCount = 0;
  const countNode = () => {
    if (++nodeCount > maxNodes) throw new LoaderError(F, 'limit', `more than ${maxNodes} nodes`);
  };
  // Mirror helpers.
  const P = (v: number[]): [number, number, number] => [v[0], v[1], rh ? 0 - v[2] : v[2]];
  const Q = (q: number[]): [number, number, number, number] =>
    rh ? [0 - q[0], 0 - q[1], q[2], q[3]] : [q[0], q[1], q[2], q[3]];

  // ---- textures and materials
  let textureBytes = 0;
  const texture = (v: unknown, what: string): BabylonTexture | undefined => {
    if (!isObject(v)) return undefined;
    const t: BabylonTexture = {
      name: str(v.name, ''),
      level: num(v.level, 1),
      offset: [num(v.uOffset, 0), num(v.vOffset, 0)],
      scale: [num(v.uScale, 1), num(v.vScale, 1)],
      angle: num(v.wAng, 0),
      hasAlpha: flag(v.hasAlpha, false),
      invertY: flag(v.invertY, true),
      uvSet: num(v.coordinatesIndex, 0),
      wrap: [num(v.wrapU, 1), num(v.wrapV, 1)],
    };
    if (typeof v.base64String === 'string') {
      const m = /^data:([^;,]+)?(?:;[^,]*)?,/.exec(v.base64String);
      const body = m ? v.base64String.slice(m[0].length) : v.base64String;
      if (body.length * 0.75 + textureBytes > maxTextureBytes)
        throw new LoaderError(F, 'limit', `embedded textures pass the limit of ${maxTextureBytes} bytes`);
      t.data = decodeBase64(body, `${what} base64String`);
      textureBytes += t.data.length;
      if (m?.[1]) t.mimeType = m[1];
    }
    return t;
  };
  const rgb = (v: unknown, fallback: number[], what: string, linearize: boolean): [number, number, number] => {
    const c = vec(v, 3, fallback, what);
    return (linearize ? c.map((x) => srgbToLinear(Math.min(1, Math.max(0, x)))) : c) as [number, number, number];
  };
  const materials: BabylonMaterial[] = [];
  for (const m of list(doc.materials, 'materials')) {
    const className = str(m.customType, 'BABYLON.StandardMaterial');
    const pbr = /PBR/i.test(className);
    const alpha = num(m.alpha, 1);
    const textures: BabylonMaterial['textures'] = {};
    const put = (slot: keyof BabylonMaterial['textures'], v: unknown) => {
      const t = texture(v, `material ${str(m.id, '?')} ${slot}`);
      if (t) textures[slot] = t;
    };
    if (pbr) {
      put('color', m.baseTexture ?? m.albedoTexture);
      put('metallicRoughness', m.metallicRoughnessTexture ?? m.metallicTexture);
      put('occlusion', m.ambientTexture);
    } else {
      put('color', m.diffuseTexture);
      put('specular', m.specularTexture);
      put('occlusion', m.ambientTexture);
    }
    put('normal', m.normalTexture ?? m.bumpTexture);
    put('emissive', m.emissiveTexture);
    put('opacity', m.opacityTexture);
    const base = pbr ? (m.baseColor ?? m.albedo ?? m.albedoColor) : m.diffuse;
    const c = rgb(base, [1, 1, 1], `material ${str(m.id, '?')} color`, !pbr);
    const metallic = pbr ? num(m.metallic, 1) : undefined,
      roughness = pbr ? num(m.roughness, 1) : undefined;
    materials.push({
      id: str(m.id, str(m.name, `material_${materials.length}`)),
      name: str(m.name, str(m.id, `material_${materials.length}`)),
      kind: pbr ? 'pbr' : 'standard',
      className,
      color: [c[0], c[1], c[2], alpha],
      emissive: rgb(m.emissive, [0, 0, 0], 'emissive', !pbr),
      specular: rgb(m.specular, [1, 1, 1], 'specular', !pbr),
      specularPower: num(m.specularPower, 64),
      ...(metallic !== undefined ? { metallic } : {}),
      ...(roughness !== undefined ? { roughness } : {}),
      alpha,
      doubleSided: m.backFaceCulling === false || m.doubleSided === true || m.twoSidedLighting === true,
      unlit: flag(m.disableLighting, false) || flag(m.unlit, false),
      textures,
    });
  }
  const multiMaterials: BabylonMultiMaterial[] = list(doc.multiMaterials, 'multiMaterials').map((m, i) => ({
    id: str(m.id, str(m.name, `multi_${i}`)),
    name: str(m.name, str(m.id, `multi_${i}`)),
    materials: Array.isArray(m.materials) ? m.materials.map((x) => str(x, '')) : [],
  }));

  // ---- shared geometries
  let vertexTotal = 0,
    triangleTotal = 0;
  const geometries = new Map<string, Json>();
  const vd = isObject(doc.geometries) ? doc.geometries : {};
  for (const g of [...list(vd.vertexData, 'geometries.vertexData'), ...list(vd.boxes, 'geometries.boxes')])
    if (typeof g.id === 'string') geometries.set(g.id, g);

  const buildGeometry = (
    src: Json,
    what: string,
  ): {
    geometry: LoadedGeometry;
    joints?: Uint16Array;
    weights?: Float32Array;
    joints1?: Uint16Array;
    weights1?: Float32Array;
  } | null => {
    const pos = numbers(src.positions, `${what} positions`, 3, maxVertices * 3);
    if (!pos || pos.length === 0) return null;
    const count = pos.length / 3;
    vertexTotal += count;
    if (vertexTotal > maxVertices)
      throw new LoaderError(F, 'limit', `vertex count ${vertexTotal} exceeds the limit of ${maxVertices}`);
    const per = (key: string, width: number, label: string): number[] | undefined => {
      const a = numbers(src[key], `${what} ${label}`, width, count * width);
      if (a && a.length !== count * width)
        syntax(`${what} ${label} has ${a.length / width} entries for ${count} vertices`);
      return a;
    };
    const normals = per('normals', 3, 'normals'),
      uvs = per('uvs', 2, 'uvs'),
      uvs2 = per('uvs2', 2, 'uvs2'),
      colors = per('colors', 4, 'colors');
    let indexList = numbers(src.indices, `${what} indices`, 3, maxTriangles * 3);
    if (!indexList) {
      if (count % 3) syntax(`${what} has no indices and ${count} vertices, not a multiple of 3`);
      indexList = Array.from({ length: count }, (_, i) => i);
    }
    triangleTotal += indexList.length / 3;
    if (triangleTotal > maxTriangles)
      throw new LoaderError(F, 'limit', `triangle count ${triangleTotal} exceeds the limit of ${maxTriangles}`);
    const indices = new Uint32Array(indexList.length);
    for (let i = 0; i < indexList.length; i += 3) {
      const a = indexList[i],
        b = indexList[i + 1],
        c = indexList[i + 2];
      for (const v of [a, b, c])
        if (!Number.isInteger(v) || v < 0 || v >= count)
          throw new LoaderError(F, 'range', `${what}: index ${v} is outside the ${count} vertices`);
      indices[i] = a;
      indices[i + 1] = rh ? c : b;
      indices[i + 2] = rh ? b : c;
    }
    const positions = new Float32Array(pos);
    const nrm = normals ? new Float32Array(normals) : undefined;
    if (rh) {
      for (let i = 2; i < positions.length; i += 3) positions[i] = 0 - positions[i];
      if (nrm) for (let i = 2; i < nrm.length; i += 3) nrm[i] = 0 - nrm[i];
    }
    const geometry: LoadedGeometry = { kind: 'mesh', positions, indices };
    if (nrm) geometry.normals = nrm;
    if (uvs) geometry.uvs = new Float32Array(uvs);
    if (uvs2) geometry.attributes = { uv1: new Float32Array(uvs2) };
    if (colors) {
      const c3 = new Float32Array(count * 3);
      for (let i = 0; i < count; i++) for (let k = 0; k < 3; k++) c3[i * 3 + k] = colors[i * 4 + k];
      geometry.colors = c3;
    }
    const subs = list(src.subMeshes, `${what} subMeshes`);
    if (subs.length) {
      const groups: LoadedGroup[] = [];
      for (const s of subs) {
        const start = num(s.indexStart, 0),
          n = num(s.indexCount, 0);
        if (
          !Number.isInteger(start) ||
          !Number.isInteger(n) ||
          start < 0 ||
          n < 0 ||
          start + n > indices.length ||
          start % 3 ||
          n % 3
        )
          throw new LoaderError(
            F,
            'range',
            `${what}: a subMesh covers indices ${start} to ${start + n} of ${indices.length}`,
          );
        groups.push({ start, count: n, properties: { materialIndex: num(s.materialIndex, 0) } });
      }
      geometry.groups = groups;
    }
    const out: ReturnType<typeof buildGeometry> = { geometry };
    // Bone data: four 8-bit indices packed in one number per vertex, and four weights.
    const skin = (indexKey: string, weightKey: string): [Uint16Array, Float32Array] | undefined => {
      const bi = per(indexKey, 1, indexKey),
        bw = per(weightKey, 4, weightKey);
      if (!bi || !bw) return undefined;
      const j = new Uint16Array(count * 4);
      for (let i = 0; i < count; i++) {
        const packed = bi[i] >>> 0;
        for (let k = 0; k < 4; k++) j[i * 4 + k] = (packed >>> (8 * k)) & 255;
      }
      return [j, new Float32Array(bw)];
    };
    const first = skin('matricesIndices', 'matricesWeights');
    if (first) [out.joints, out.weights] = first;
    const extra = first && skin('matricesIndicesExtra', 'matricesWeightsExtra');
    if (extra) [out.joints1, out.weights1] = extra;
    return out;
  };

  // ---- animations
  const animationsOf = (v: unknown, what: string): BabylonAnimation[] => {
    const out: BabylonAnimation[] = [];
    for (const a of list(v, `${what} animations`)) {
      const property = str(a.property, '');
      if (!['position', 'rotation', 'rotationQuaternion', 'scaling'].includes(property)) continue;
      const keys = list(a.keys, `${what} animation keys`);
      if (keys.length > 1_000_000) throw new LoaderError(F, 'limit', 'an animation has more than 1,000,000 keys');
      const width = property === 'rotationQuaternion' ? 4 : 3;
      out.push({
        name: str(a.name, property),
        property: property === 'rotation' ? 'rotationQuaternion' : property,
        fps: num(a.framePerSecond, 60),
        loop: num(a.loopBehavior, 1) !== 2,
        keys: keys.map((k) => {
          const raw = vec(k.values, width, [], `${what} animation key`),
            frame = num(k.frame, 0);
          if (property === 'position') return { frame, values: P(raw) };
          if (property === 'rotation') return { frame, values: Q(eulerToQuaternion(raw[0], raw[1], raw[2])) };
          if (property === 'rotationQuaternion') return { frame, values: Q(raw) };
          return { frame, values: raw };
        }),
      });
    }
    return out;
  };

  // ---- nodes
  const nodeFields = (n: Json, what: string): BabylonNode => {
    if (
      n.pivotMatrix !== undefined &&
      Array.isArray(n.pivotMatrix) &&
      n.pivotMatrix.some((x, i) => x !== (i % 5 === 0 ? 1 : 0))
    )
      warn(`${what}: pivotMatrix is not applied`);
    const t = vec(n.position, 3, [0, 0, 0], `${what} position`);
    const q = Array.isArray(n.rotationQuaternion)
      ? vec(n.rotationQuaternion, 4, [0, 0, 0, 1], `${what} rotationQuaternion`)
      : (() => {
          const e = vec(n.rotation, 3, [0, 0, 0], `${what} rotation`);
          return eulerToQuaternion(e[0], e[1], e[2]) as number[];
        })();
    const parentId = n.parentId ?? n.parentID;
    return {
      id: str(n.id, str(n.name, `node_${nodeCount}`)),
      name: str(n.name, str(n.id, `node_${nodeCount}`)),
      ...(parentId !== undefined && parentId !== null ? { parentId: str(parentId, '') } : {}),
      translation: P(t),
      rotation: Q(q),
      scale: vec(n.scaling, 3, [1, 1, 1], `${what} scaling`) as [number, number, number],
      visible: flag(n.isVisible, true) && flag(n.isEnabled, true),
      animations: animationsOf(n.animations, what),
    };
  };
  const transformNodes: BabylonTransformNode[] = [];
  for (const n of list(doc.transformNodes, 'transformNodes')) {
    countNode();
    transformNodes.push(nodeFields(n, `transformNode ${str(n.id, '?')}`));
  }
  const meshes: BabylonMesh[] = [];
  const cache = new Map<string, ReturnType<typeof buildGeometry>>();
  for (const m of list(doc.meshes, 'meshes')) {
    countNode();
    const what = `mesh ${str(m.id, str(m.name, '?'))}`;
    const node = nodeFields(m, what);
    if (typeof m.delayLoadingFile === 'string' && m.positions === undefined && m.geometryId === undefined) {
      warn(`${what}: delay-loaded binary data (${m.delayLoadingFile}) is not read`);
      continue;
    }
    const geometryId = typeof m.geometryId === 'string' ? m.geometryId : undefined;
    let built: ReturnType<typeof buildGeometry>;
    if (geometryId !== undefined) {
      const src = geometries.get(geometryId);
      if (!src)
        throw new LoaderError(F, 'range', `${what} names geometry "${geometryId}" which the file does not hold`);
      if (!cache.has(geometryId)) cache.set(geometryId, buildGeometry(src, `geometry ${geometryId}`));
      built = cache.get(geometryId)!;
      // Submeshes belong to the mesh, not the shared vertex data.
      if (built && Array.isArray(m.subMeshes) && m.subMeshes.length) {
        const copy = { ...built, geometry: { ...built.geometry } };
        const subs = list(m.subMeshes, `${what} subMeshes`);
        copy.geometry.groups = subs.map((s) => ({
          start: num(s.indexStart, 0),
          count: num(s.indexCount, 0),
          properties: { materialIndex: num(s.materialIndex, 0) },
        }));
        for (const g of copy.geometry.groups)
          if (g.start < 0 || g.count < 0 || g.start + g.count > copy.geometry.indices!.length)
            throw new LoaderError(F, 'range', `${what}: a subMesh covers indices past the geometry`);
        built = copy;
      }
    } else built = buildGeometry(m, what);
    if (!built) {
      // A mesh with no vertices is a plain parent.
      transformNodes.push(node);
      continue;
    }
    const mesh: BabylonMesh = { ...node, geometry: built.geometry };
    if (typeof m.materialId === 'string') mesh.materialId = m.materialId;
    if (m.skeletonId !== undefined && m.skeletonId !== null && m.skeletonId !== -1)
      mesh.skeletonId = str(m.skeletonId, '');
    if (built.joints) {
      mesh.joints = built.joints;
      mesh.weights = built.weights;
    }
    if (built.joints1) {
      mesh.joints1 = built.joints1;
      mesh.weights1 = built.weights1;
    }
    meshes.push(mesh);
    for (const inst of list(m.instances, `${what} instances`)) {
      countNode();
      const n2 = nodeFields({ ...inst, parentId: m.parentId ?? m.parentID }, `${what} instance`);
      meshes.push({ ...mesh, ...n2, parentId: n2.parentId, instanceOf: mesh.id });
      if (n2.parentId === undefined) delete meshes[meshes.length - 1].parentId;
    }
  }

  // ---- cameras and lights
  const cameras: BabylonCamera[] = [];
  for (const c of list(doc.cameras, 'cameras')) {
    countNode();
    const what = `camera ${str(c.id, '?')}`;
    const className = str(c.type, 'FreeCamera');
    const position = vec(c.position, 3, [0, 0, 0], `${what} position`);
    let target: number[];
    if (/ArcRotate/i.test(className)) {
      const t = vec(c.target, 3, [0, 0, 0], `${what} target`),
        alpha = num(c.alpha, -Math.PI / 2),
        beta = num(c.beta, Math.PI / 2),
        radius = num(c.radius, 10);
      target = t;
      position[0] = t[0] + radius * Math.cos(alpha) * Math.sin(beta);
      position[1] = t[1] + radius * Math.cos(beta);
      position[2] = t[2] + radius * Math.sin(alpha) * Math.sin(beta);
    } else if (Array.isArray(c.target)) target = vec(c.target, 3, [0, 0, 1], `${what} target`);
    else {
      const q = Array.isArray(c.rotationQuaternion)
        ? vec(c.rotationQuaternion, 4, [0, 0, 0, 1], `${what} rotationQuaternion`)
        : eulerToQuaternion(...(vec(c.rotation, 3, [0, 0, 0], `${what} rotation`) as [number, number, number]));
      // Rotate +Z (Babylon looks along +Z) by q.
      const [x, y, z, w] = q;
      target = [
        position[0] + 2 * (x * z + w * y),
        position[1] + 2 * (y * z - w * x),
        position[2] + 1 - 2 * (x * x + y * y),
      ];
    }
    const cam: BabylonCamera = {
      id: str(c.id, str(c.name, `camera_${cameras.length}`)),
      name: str(c.name, str(c.id, `camera_${cameras.length}`)),
      className,
      position: P(position),
      target: P(target),
      fov: num(c.fov, 0.8),
      near: num(c.minZ, 1),
      far: num(c.maxZ, 10000),
    };
    if (c.parentId !== undefined && c.parentId !== null) cam.parentId = str(c.parentId, '');
    if (num(c.mode, 0) === 1)
      cam.orthographic = {
        left: num(c.orthoLeft, -1),
        right: num(c.orthoRight, 1),
        top: num(c.orthoTop, 1),
        bottom: num(c.orthoBottom, -1),
      };
    cameras.push(cam);
  }
  const lights: BabylonLight[] = [];
  const KINDS = ['point', 'directional', 'spot', 'hemispheric'] as const;
  for (const l of list(doc.lights, 'lights')) {
    countNode();
    const what = `light ${str(l.id, '?')}`;
    const type = num(l.type, 0);
    if (!Number.isInteger(type) || type < 0 || type > 3) {
      warn(`${what}: light type ${type} is not read`);
      continue;
    }
    const light: BabylonLight = {
      id: str(l.id, str(l.name, `light_${lights.length}`)),
      name: str(l.name, str(l.id, `light_${lights.length}`)),
      kind: KINDS[type],
      color: rgb(l.diffuse, [1, 1, 1], `${what} diffuse`, false),
      intensity: num(l.intensity, 1),
    };
    if (l.parentId !== undefined && l.parentId !== null) light.parentId = str(l.parentId, '');
    if (type !== 3 && l.position !== undefined) light.position = P(vec(l.position, 3, [0, 0, 0], `${what} position`));
    if (type !== 0 && l.direction !== undefined)
      light.direction = P(vec(l.direction, 3, [0, -1, 0], `${what} direction`));
    if (l.range !== undefined && num(l.range, Infinity) < 1e30) light.range = num(l.range, Infinity);
    if (type === 2) {
      light.angle = num(l.angle, Math.PI / 2);
      if (l.innerAngle !== undefined) light.innerAngle = num(l.innerAngle, 0);
    }
    if (type === 3 && l.groundColor !== undefined)
      light.groundColor = rgb(l.groundColor, [0, 0, 0], `${what} groundColor`, false);
    lights.push(light);
  }

  // ---- skeletons
  const skeletons: BabylonSkeleton[] = list(doc.skeletons, 'skeletons').map((s, i) => {
    const bones = list(s.bones, `skeleton ${i} bones`);
    if (bones.length > 4096) throw new LoaderError(F, 'limit', `skeleton ${i} has ${bones.length} bones, past 4096`);
    return {
      id: str(s.id, String(i)),
      name: str(s.name, `skeleton_${i}`),
      bones: bones.map((b, k) => {
        const m = vec(b.matrix, 16, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], `skeleton ${i} bone ${k} matrix`);
        // Babylon writes row-major with row vectors: the same 16 numbers are the column-vector matrix, column-major.
        if (rh)
          for (let r = 0; r < 16; r++) {
            const row = r & 3,
              col = r >> 2;
            if ((row === 2) !== (col === 2)) m[r] = 0 - m[r]; // S M S, S = diag(1, 1, -1, 1)
          }
        return {
          name: str(b.name, `bone_${k}`),
          index: num(b.index, k),
          parentBoneIndex: num(b.parentBoneIndex, -1),
          matrix: m,
        };
      }),
    };
  });

  // Parent chains must end: a cycle would hang every walk over the nodes.
  const parents = new Map<string, string | undefined>();
  for (const n of [...meshes, ...transformNodes]) if (!parents.has(n.id)) parents.set(n.id, n.parentId);
  for (const start of parents.keys()) {
    let at: string | undefined = start;
    for (let d = 0; at !== undefined && parents.has(at); d++, at = parents.get(at))
      if (d > parents.size) throw new LoaderError(F, 'syntax', `node "${start}" is its own ancestor`);
  }

  const out: LoadedBabylon = {
    meshes,
    transformNodes,
    materials,
    multiMaterials,
    cameras,
    lights,
    skeletons,
    warnings,
  };
  if (Array.isArray(doc.clearColor))
    out.clearColor = vec(doc.clearColor, 3, [0, 0, 0], 'clearColor') as [number, number, number];
  if (Array.isArray(doc.ambientColor))
    out.ambientColor = vec(doc.ambientColor, 3, [0, 0, 0], 'ambientColor') as [number, number, number];
  if (typeof doc.activeCameraID === 'string') out.activeCameraId = doc.activeCameraID;
  if (isObject(doc.producer))
    out.producer = { name: str(doc.producer.name, ''), version: str(doc.producer.version, '') };
  return out;
}

/** Options of {@link flattenBabylon}. */
export interface FlattenBabylonOptions {
  /** Skip meshes the file hides, and their descendants. Default true. */
  onlyVisible?: boolean;
}

function composeTRS(t: number[], q: number[], s: number[]): Float64Array {
  const [x, y, z, w] = q;
  const m = new Float64Array(16);
  m[0] = (1 - 2 * (y * y + z * z)) * s[0];
  m[1] = 2 * (x * y + z * w) * s[0];
  m[2] = 2 * (x * z - y * w) * s[0];
  m[4] = 2 * (x * y - z * w) * s[1];
  m[5] = (1 - 2 * (x * x + z * z)) * s[1];
  m[6] = 2 * (y * z + x * w) * s[1];
  m[8] = 2 * (x * z + y * w) * s[2];
  m[9] = 2 * (y * z - x * w) * s[2];
  m[10] = (1 - 2 * (x * x + y * y)) * s[2];
  m[12] = t[0];
  m[13] = t[1];
  m[14] = t[2];
  m[15] = 1;
  return m;
}
function mul(a: Float64Array, b: Float64Array): Float64Array {
  const o = new Float64Array(16);
  for (let c = 0; c < 4; c++)
    for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) o[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k];
  return o;
}

/**
 * Bakes every mesh's world transform into one geometry: parents, then the mesh's own placement. Each mesh becomes a
 * group (`name`, its material's colour when the material is a plain one). A mirroring transform (a negative scale)
 * flips the winding so faces keep facing out.
 */
export function flattenBabylon(scene: LoadedBabylon, options: FlattenBabylonOptions = {}): LoadedGeometry {
  const onlyVisible = options.onlyVisible ?? true;
  const byId = new Map<string, BabylonNode>();
  for (const n of [...scene.transformNodes, ...scene.meshes]) if (!byId.has(n.id)) byId.set(n.id, n);
  const materials = new Map(scene.materials.map((m) => [m.id, m]));
  const world = (n: BabylonNode): Float64Array | null => {
    let m = composeTRS(n.translation, n.rotation, n.scale);
    let at = n,
      hops = 0;
    if (onlyVisible && !n.visible) return null;
    while (at.parentId !== undefined && hops++ < byId.size + 1) {
      const p = byId.get(at.parentId);
      if (!p) break;
      if (onlyVisible && !p.visible) return null;
      m = mul(composeTRS(p.translation, p.rotation, p.scale), m);
      at = p;
    }
    return m;
  };
  const positions: number[] = [],
    normals: number[] = [],
    uvs: number[] = [],
    indices: number[] = [],
    groups: LoadedGroup[] = [];
  let withNormals = true,
    withUvs = true;
  const placed: { mesh: BabylonMesh; m: Float64Array }[] = [];
  for (const mesh of scene.meshes) {
    const m = world(mesh);
    if (m) placed.push({ mesh, m });
    if (m && !mesh.geometry.normals) withNormals = false;
    if (m && !mesh.geometry.uvs) withUvs = false;
  }
  for (const { mesh, m } of placed) {
    const g = mesh.geometry,
      base = positions.length / 3;
    const det =
      m[0] * (m[5] * m[10] - m[6] * m[9]) - m[4] * (m[1] * m[10] - m[2] * m[9]) + m[8] * (m[1] * m[6] - m[2] * m[5]);
    for (let i = 0; i < g.positions.length; i += 3) {
      const x = g.positions[i],
        y = g.positions[i + 1],
        z = g.positions[i + 2];
      positions.push(
        m[0] * x + m[4] * y + m[8] * z + m[12],
        m[1] * x + m[5] * y + m[9] * z + m[13],
        m[2] * x + m[6] * y + m[10] * z + m[14],
      );
      if (withNormals) {
        // Normals follow the inverse transpose; for TRS that is the rotation with the scale divided out twice.
        const nx = g.normals![i],
          ny = g.normals![i + 1],
          nz = g.normals![i + 2];
        const sx = m[0] ** 2 + m[1] ** 2 + m[2] ** 2 || 1,
          sy = m[4] ** 2 + m[5] ** 2 + m[6] ** 2 || 1,
          sz = m[8] ** 2 + m[9] ** 2 + m[10] ** 2 || 1;
        const vx = (m[0] * nx) / sx + (m[4] * ny) / sy + (m[8] * nz) / sz,
          vy = (m[1] * nx) / sx + (m[5] * ny) / sy + (m[9] * nz) / sz,
          vz = (m[2] * nx) / sx + (m[6] * ny) / sy + (m[10] * nz) / sz;
        const len = Math.hypot(vx, vy, vz) || 1;
        normals.push(vx / len, vy / len, vz / len);
      }
      if (withUvs) uvs.push(g.uvs![(i / 3) * 2], g.uvs![(i / 3) * 2 + 1]);
    }
    const start = indices.length;
    for (let i = 0; i < g.indices!.length; i += 3) {
      const a = g.indices![i] + base,
        b = g.indices![i + 1] + base,
        c = g.indices![i + 2] + base;
      if (det < 0) indices.push(a, c, b);
      else indices.push(a, b, c);
    }
    const material = mesh.materialId ? materials.get(mesh.materialId) : undefined;
    groups.push({
      start,
      count: indices.length - start,
      name: mesh.name,
      // LoadedGroup.color is sRGB; the material's colour is linear, so convert it back (alpha stays as it is).
      ...(material
        ? {
            color: [
              linearToSrgb(material.color[0]),
              linearToSrgb(material.color[1]),
              linearToSrgb(material.color[2]),
              material.color[3],
            ] as [number, number, number, number],
          }
        : {}),
    });
  }
  const out: LoadedGeometry = {
    kind: 'mesh',
    positions: new Float32Array(positions),
    indices: new Uint32Array(indices),
    groups,
  };
  if (withNormals && normals.length) out.normals = new Float32Array(normals);
  if (withUvs && uvs.length) out.uvs = new Float32Array(uvs);
  return out;
}
