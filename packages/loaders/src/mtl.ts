import type { EngineKernel } from '@margoengine/core';
import {
  Material,
  type MaterialMesh,
  type MaterialOptions,
  type MeshGeometry,
  type Texture,
  type TextureOptions,
  createMesh,
  loadTexture as loadMaterialTexture,
} from '@margoengine/materials';
import { SRGBToLinear } from '@margoengine/math/color';
import { type FetchOptions, fetchBytes } from './load.js';
import { type LoadedOBJ, type MTLMapOptions, type MTLMaterial, parseOBJ } from './obj.js';
import { LoaderError, type ParseLimits } from './types.js';
import { resolvePath } from './util.js';

/**
 * Loads one texture for `createMTLMaterials`: the URL and the texture options the map needs, with the `signal` and
 * `fetch` given to createMTLMaterials (`fetch` only when one was given).
 */
export type MTLTextureLoader = (
  url: string,
  options: TextureOptions & { signal?: AbortSignal; fetch?: typeof fetch },
) => Promise<Texture>;

/** Options of `createMTLMaterials`. */
export interface MTLMaterialsOptions {
  /**
   * URL that map paths are relative to: the .mtl URL for `parseMTL` output, the .obj URL for `parseOBJ`'s
   * `materials` (their paths already include the library folder). Default: the page URL.
   */
  baseUrl?: string | URL;
  /** Texture loader. Default: materials' `loadTexture` (http(s), blob: and data: URLs). */
  loadTexture?: MTLTextureLoader;
  /**
   * What `bump` / `map_Bump` holds: `'height'` (the MTL meaning, scaled by `-bm`) or `'normal'` (a tangent-space
   * normal map, as many exporters write). Default `'height'`.
   */
  bump?: 'height' | 'normal';
  /** Draw both faces. Default false. */
  doubleSided?: boolean;
  /** Aborts texture loading; the promise then rejects with a `LoaderError` with code `'aborted'`. */
  signal?: AbortSignal;
  /**
   * Fetch handed to the texture loader for every map, for example an AssetCache's or a LoadingManager's `fetch`
   * (loadOBJ passes its own). Default: the loader's own (`globalThis.fetch` for materials' `loadTexture`).
   */
  fetch?: typeof fetch;
}

/** The materials `createMTLMaterials` built, and the textures they use. */
export interface MTLMaterialSet {
  /** One material per `newmtl` name, in input order. */
  materials: Map<string, Material>;
  /** Every texture loaded, once per (file, colour space, wrap mode). */
  textures: Texture[];
  /** Maps that failed to load and MTL values with no Margo equivalent. */
  warnings: string[];
  /** Disposes every material and texture of the set. */
  dispose(): void;
}

const F = 'MTL';

/** Map statements with a material slot; every other map key is reported as unused. */
const SLOTTED_MAPS = new Set(['map_Kd', 'map_Ke', 'map_d', 'bump']);
/** PBR-extension statements read from `extras` (compared in lower case); other extras are reported as unused. */
const READ_EXTRAS = new Set(['norm', 'pr', 'pm']);

type Slot = 'map' | 'alphaMap' | 'emissiveMap' | 'bumpMap' | 'normalMap';
interface MapUse {
  slot: Slot;
  path: string;
  options: MTLMapOptions;
  colorSpace: 'srgb' | 'linear';
}

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));
/** One sRGB channel as written in the file to linear light: non-finite becomes 0, then clamped to [0, 1]. */
const linear = (v: number | undefined): number => SRGBToLinear(Number.isFinite(v) ? clamp01(v as number) : 0);
const linear3 = (c: readonly number[]): [number, number, number] => [linear(c[0]), linear(c[1]), linear(c[2])];

/** Value of the first extension statement named `keyword` (any case), or undefined. */
function extra(m: MTLMaterial, keyword: string): string | undefined {
  return m.extras?.find((s) => s.keyword.toLowerCase() === keyword)?.value;
}

/** First number of an extension statement's value, or NaN. */
function extraNumber(m: MTLMaterial, keyword: string): number {
  const value = extra(m, keyword);
  return value === undefined ? Number.NaN : Number(value.trim().split(/\s+/)[0]);
}

/**
 * Roughness from the Phong exponent Ns. Walter, Marschner, Li and Torrance, "Microfacet Models for Refraction
 * through Rough Surfaces" (EGSR 2007) §5.2 match Blinn-Phong exponent Ns to a Beckmann width alpha with
 * alpha^2 = 2 / (Ns + 2); glTF 2.0 metallic-roughness uses alpha = roughness^2, so roughness = (2 / (Ns + 2))^(1/4).
 * Ns 0 gives 1, 10 about 0.64, 100 about 0.37, 1000 about 0.21.
 */
const roughnessFromNs = (ns: number): number => clamp01((2 / (Math.max(0, ns) + 2)) ** 0.25);

/** The folder of the material's library, recovered from a map whose resolved path ends with its file name. */
function libraryFolder(m: MTLMaterial): string {
  for (const map of Object.values(m.maps ?? {})) {
    const file = resolvePath('_', map.file);
    if (file && map.path.endsWith(file)) return map.path.slice(0, map.path.length - file.length);
  }
  return '';
}

/** Reads a `norm` statement like a map statement: `-bm n`, `-o u [v [w]]`, `-s u [v [w]]`, `-clamp on|off`, file. */
function parseNorm(value: string): { file: string; options: MTLMapOptions } {
  const tokens = value.trim().split(/\s+/).filter(Boolean),
    options: MTLMapOptions = {};
  let i = 0;
  const numbers = (fill: number): [number, number, number] => {
    const out: [number, number, number] = [fill, fill, fill];
    for (let k = 0; k < 3 && i < tokens.length && Number.isFinite(Number(tokens[i])); k++) out[k] = Number(tokens[i++]);
    return out;
  };
  while (i < tokens.length && tokens[i].startsWith('-')) {
    const option = tokens[i++];
    if (option === '-bm') options.bm = Number(tokens[i++]);
    else if (option === '-o') options.o = numbers(0);
    else if (option === '-s') options.s = numbers(1);
    else if (option === '-clamp') options.clamp = tokens[i++] === 'on';
    else i++; // an option this reader does not use: skip its value
  }
  return { file: tokens.slice(i).join(' '), options };
}

/** The `new Material` options of one MTL material (section "MTL material format", illumination models included). */
function materialOptions(m: MTLMaterial, doubleSided: boolean): MaterialOptions {
  const unlit = m.illum === 0,
    options: MaterialOptions = { doubleSided };
  if (unlit) options.shading = 'basic';
  options.color = m.Kd ? linear3(m.Kd) : [1, 1, 1];
  const written = m.d !== undefined ? m.d : m.Tr !== undefined ? 1 - m.Tr : 1,
    opacity = Number.isFinite(written) ? clamp01(written) : 1;
  options.opacity = opacity;
  if (opacity < 1 || m.maps?.map_d) options.transparent = true;
  if (unlit) return options;
  const emit = m.Ke ? [...m.Ke] : m.maps?.map_Ke ? [1, 1, 1] : undefined;
  if (emit) {
    const peak = Math.max(emit[0], emit[1], emit[2]);
    if (peak > 1) {
      for (let k = 0; k < 3; k++) emit[k] /= peak;
      options.emissive = linear3(emit);
      options.emissiveIntensity = peak;
    } else options.emissive = linear3(emit);
  }
  const pr = extraNumber(m, 'pr');
  if (Number.isFinite(pr)) options.roughness = clamp01(pr);
  else if (m.illum === 1 || (m.Ks && m.Ks.every((c) => c <= 0)) || m.Ns === undefined || !Number.isFinite(m.Ns))
    options.roughness = 1;
  else options.roughness = roughnessFromNs(m.Ns);
  const pm = extraNumber(m, 'pm');
  options.metalness = Number.isFinite(pm) ? clamp01(pm) : 0;
  return options;
}

/** The maps a material uses, in slot (and load) order: map, alphaMap, emissiveMap, bump or normal, norm. */
function mapUses(m: MTLMaterial, bump: 'height' | 'normal'): MapUse[] {
  const maps = m.maps ?? {},
    uses: MapUse[] = [];
  const add = (
    slot: Slot,
    map: { path: string; options: MTLMapOptions } | undefined,
    colorSpace: 'srgb' | 'linear',
  ) => {
    if (map) uses.push({ slot, path: map.path, options: map.options ?? {}, colorSpace });
  };
  add('map', maps.map_Kd, 'srgb');
  add('alphaMap', maps.map_d, 'linear');
  if (m.illum === 0) return uses;
  add('emissiveMap', maps.map_Ke, 'srgb');
  add(bump === 'normal' ? 'normalMap' : 'bumpMap', maps.bump, 'linear');
  const norm = extra(m, 'norm');
  if (norm !== undefined) {
    const { file, options } = parseNorm(norm);
    if (file) add('normalMap', { path: resolvePath(`${libraryFolder(m)}_`, file), options }, 'linear');
  }
  return uses;
}

/** What a material says that Margo materials cannot show, as warnings. */
function unusedWarnings(m: MTLMaterial): string[] {
  const out: string[] = [];
  for (const key of Object.keys(m.maps ?? {}))
    if (!SLOTTED_MAPS.has(key)) out.push(`${key} has no Margo material slot; it is not used`);
  for (const s of m.extras ?? [])
    if (!READ_EXTRAS.has(s.keyword.toLowerCase()))
      out.push(`${s.keyword} has no Margo material equivalent; it is not used`);
  if (m.Ka) out.push('Ka (ambient colour) has no Margo material equivalent; it is not used');
  if (m.Ks && m.Ks.some((c) => c > 0) && m.illum !== 0)
    out.push('Ks (specular colour) only sets whether there is a highlight; roughness comes from Ns');
  return out;
}

/**
 * Builds one materials `Material` per `newmtl` of `parseMTL` output (or `parseOBJ`'s `materials`), mapped to
 * metallic-roughness: `Kd` is the base colour (sRGB in the file, linear in the material), `d` (else 1 - `Tr`) the
 * opacity, `Ke` the emission (a peak above 1 moves into `emissiveIntensity`), and roughness comes from the Phong
 * exponent `Ns` as (2 / (Ns + 2))^(1/4) (Walter et al. 2007's Blinn-Phong to Beckmann match with glTF's
 * alpha = roughness^2). The PBR extension's `Pr`, `Pm` and `norm` are read when present. `illum 0` is unlit.
 * `map_Kd`, `map_d`, `map_Ke`, `bump` and `norm` load as textures, each (file, colour space, wrap) once; their `-o`
 * and `-s` become the slot's UV transform and `-clamp on` a clamped wrap. A map that fails to load is a warning.
 * Rejects with `TypeError` / `RangeError` for bad arguments and with a `LoaderError` (code `'aborted'`) when
 * `signal` aborts; whatever was built is disposed first.
 */
export async function createMTLMaterials(
  mtl: readonly MTLMaterial[],
  options: MTLMaterialsOptions = {},
): Promise<MTLMaterialSet> {
  if (!Array.isArray(mtl))
    throw new TypeError('createMTLMaterials mtl is not an array of materials; pass parseMTL output or obj.materials');
  const opts = options ?? {},
    bump = opts.bump ?? 'height';
  if (bump !== 'height' && bump !== 'normal')
    throw new RangeError(
      `createMTLMaterials bump ${JSON.stringify(bump)} is not 'height' or 'normal'; pass one of them`,
    );
  if (opts.loadTexture !== undefined && typeof opts.loadTexture !== 'function')
    throw new TypeError('createMTLMaterials loadTexture is not a function; pass (url, options) => Promise<Texture>');
  const load: MTLTextureLoader = opts.loadTexture ?? loadMaterialTexture,
    signal = opts.signal,
    get = opts.fetch,
    doubleSided = opts.doubleSided ?? false;

  const materials = new Map<string, Material>(),
    warnings: string[] = [],
    arrived: Texture[] = [];
  let disposed = false;
  const warn = (message: string) => {
    if (!warnings.includes(message)) warnings.push(message);
  };
  const set: MTLMaterialSet = {
    materials,
    textures: [],
    warnings,
    dispose() {
      disposed = true;
      for (const material of materials.values()) material.dispose();
      for (const texture of arrived) texture.dispose();
    },
  };
  const abortError = () => new LoaderError(F, 'aborted', 'aborted while loading textures');

  let base: string | undefined;
  const urlOf = (path: string): string => {
    if (base === undefined) {
      const from = opts.baseUrl ?? (globalThis as { location?: { href?: string } }).location?.href;
      try {
        base = new URL(String(from)).href;
      } catch {
        throw new TypeError(
          `createMTLMaterials baseUrl ${JSON.stringify(String(from))} is not an absolute URL; pass the .mtl (or .obj) URL to resolve maps against`,
        );
      }
    }
    return new URL(path, base).href;
  };

  // One request per (colour space, wrap, URL), in first-use order.
  const requests = new Map<string, { promise: Promise<Texture | undefined>; texture?: Texture }>(),
    assignments: { material: Material; slot: Slot; key: string }[] = [];
  const request = (url: string, colorSpace: 'srgb' | 'linear', wrap: 'clamp' | 'repeat'): string => {
    const key = `${colorSpace} ${wrap} ${url}`;
    if (requests.has(key)) return key;
    const entry: { promise: Promise<Texture | undefined>; texture?: Texture } = {
      promise: Promise.resolve()
        .then(() => load(url, { colorSpace, wrapS: wrap, wrapT: wrap, signal, ...(get ? { fetch: get } : {}) }))
        .then(
          (texture) => {
            if (disposed) {
              texture.dispose();
              return undefined;
            }
            arrived.push(texture);
            entry.texture = texture;
            return texture;
          },
          (error) => {
            if (signal?.aborted) throw abortError();
            warn(`texture ${url} could not be loaded (${(error as Error)?.message ?? error}); its maps are left out`);
            return undefined;
          },
        ),
    };
    requests.set(key, entry);
    return key;
  };

  let stopListening = () => {};
  try {
    for (const m of mtl) {
      if (!m || typeof m.name !== 'string' || materials.has(m.name)) continue;
      const material = new Material(materialOptions(m, doubleSided));
      materials.set(m.name, material);
      for (const message of unusedWarnings(m)) warn(message);
      for (const use of mapUses(m, bump)) {
        const wrap = use.options.clamp ? 'clamp' : 'repeat';
        assignments.push({ material, slot: use.slot, key: request(urlOf(use.path), use.colorSpace, wrap) });
        if (use.slot === 'bumpMap' && Number.isFinite(use.options.bm)) material.bumpScale = use.options.bm as number;
        const [ou = 0, ov = 0] = use.options.o ?? [],
          [su = 1, sv = 1] = use.options.s ?? [];
        if (ou !== 0 || ov !== 0 || su !== 1 || sv !== 1)
          material.setUVTransform({ offset: [ou, ov], scale: [su, sv] }, use.slot);
      }
    }
    const all = Promise.all([...requests.values()].map((r) => r.promise));
    if (signal) {
      const aborted = new Promise<never>((_, reject) => {
        const onAbort = () => reject(abortError());
        if (signal.aborted) onAbort();
        else {
          signal.addEventListener('abort', onAbort, { once: true });
          stopListening = () => signal.removeEventListener('abort', onAbort);
        }
      });
      all.catch(() => {});
      await Promise.race([all, aborted]);
    } else await all;
    for (const { material, slot, key } of assignments) {
      const texture = requests.get(key)?.texture;
      if (texture) material[slot] = texture;
    }
    set.textures = [...requests.values()].flatMap((r) => (r.texture ? [r.texture] : []));
    return set;
  } catch (error) {
    set.dispose();
    throw error;
  } finally {
    stopListening();
  }
}

/** Options of `prepareOBJMesh` and `createOBJMesh`. */
export interface OBJMeshOptions {
  /** Material for groups without `usemtl` or naming an unknown material. Default: a new white `Material`. */
  fallback?: Material;
}

/** A unit normal, or +z for a zero or non-finite one (materials meshes reject zero normals). */
function unit(out: Float32Array, at: number, x: number, y: number, z: number): void {
  const length = Math.hypot(x, y, z);
  if (length > 0 && Number.isFinite(length)) {
    out[at] = x / length;
    out[at + 1] = y / length;
    out[at + 2] = z / length;
  } else {
    out[at] = 0;
    out[at + 1] = 0;
    out[at + 2] = 1;
  }
}

/**
 * Smooth vertex normals per OBJ position: each triangle's area-weighted face normal is summed into the positions its
 * corners came from, so corners split by UV seams share one normal.
 */
function smoothNormals(positions: ArrayLike<number>, indices: ArrayLike<number>, origin?: ArrayLike<number>) {
  const vertices = positions.length / 3,
    from = (v: number) => (origin ? origin[v] : v);
  let slots = 0;
  for (let v = 0; v < vertices; v++) slots = Math.max(slots, from(v) + 1);
  const sums = new Float64Array(slots * 3);
  for (let t = 0; t + 2 < indices.length; t += 3) {
    const a = indices[t] * 3,
      b = indices[t + 1] * 3,
      c = indices[t + 2] * 3,
      e1x = positions[b] - positions[a],
      e1y = positions[b + 1] - positions[a + 1],
      e1z = positions[b + 2] - positions[a + 2],
      e2x = positions[c] - positions[a],
      e2y = positions[c + 1] - positions[a + 1],
      e2z = positions[c + 2] - positions[a + 2],
      nx = e1y * e2z - e1z * e2y,
      ny = e1z * e2x - e1x * e2z,
      nz = e1x * e2y - e1y * e2x;
    for (const corner of [indices[t], indices[t + 1], indices[t + 2]]) {
      const s = from(corner) * 3;
      sums[s] += nx;
      sums[s + 1] += ny;
      sums[s + 2] += nz;
    }
  }
  const normals = new Float32Array(vertices * 3);
  for (let v = 0; v < vertices; v++) {
    const s = from(v) * 3;
    unit(normals, v * 3, sums[s], sums[s + 1], sums[s + 2]);
  }
  return normals;
}

/**
 * Turns a parsed OBJ and its materials into materials-ready geometry plus one material per slot, without a GPU:
 * groups map to materials by their `usemtl` name. Positions and indices are the OBJ's own arrays. Normals are the
 * OBJ's (normalised) or, without them, smooth normals shared across UV seams; zero normals become +z. UVs go back to
 * OBJ's v-up orientation for flipY textures, and vertex colours from sRGB to linear. Throws a `LoaderError` (code
 * `'unsupported'`) for an OBJ without faces and `TypeError` when `materials` is neither a Map nor a set.
 */
export function prepareOBJMesh(
  obj: LoadedOBJ,
  materials: MTLMaterialSet | ReadonlyMap<string, Material>,
  options: OBJMeshOptions = {},
): { geometry: MeshGeometry; materials: Material[] } {
  if (!obj || obj.kind !== 'mesh' || !obj.indices)
    throw new LoaderError(
      'OBJ',
      'unsupported',
      'the OBJ has no faces to draw as a mesh; draw its points with pointsToGeometry instead',
    );
  const lookup: ReadonlyMap<string, Material> | undefined =
    materials instanceof Map
      ? materials
      : materials && (materials as MTLMaterialSet).materials instanceof Map
        ? (materials as MTLMaterialSet).materials
        : undefined;
  if (!lookup)
    throw new TypeError('prepareOBJMesh materials is not a Map or material set; pass createMTLMaterials output');
  const { positions, indices } = obj,
    vertices = positions.length / 3;

  let normals: Float32Array;
  if (obj.normals) {
    normals = new Float32Array(vertices * 3);
    for (let v = 0; v < vertices; v++)
      unit(normals, v * 3, obj.normals[v * 3], obj.normals[v * 3 + 1], obj.normals[v * 3 + 2]);
  } else normals = smoothNormals(positions, indices, obj.positionIndices);

  const geometry: MeshGeometry = { positions, normals, indices };
  if (obj.uvs) {
    const uvs = Float32Array.from(obj.uvs);
    for (let i = 1; i < uvs.length; i += 2) uvs[i] = 1 - uvs[i];
    geometry.uvs = uvs;
  }
  if (obj.colors) geometry.colors = obj.colors.map((c) => linear(c));

  const slots: Material[] = [],
    slotOf = new Map<Material, number>(),
    groups: { start: number; count: number; materialIndex: number }[] = [];
  let fallback = options?.fallback;
  const source = obj.groups?.length ? obj.groups : [{ start: 0, count: indices.length, material: undefined }];
  for (const group of source) {
    if (!group.count) continue;
    let material = group.material === undefined ? undefined : lookup.get(group.material);
    if (!material) material = fallback ??= new Material();
    let index = slotOf.get(material);
    if (index === undefined) {
      index = slots.push(material) - 1;
      slotOf.set(material, index);
    }
    groups.push({ start: group.start, count: group.count, materialIndex: index });
  }
  geometry.groups = groups;
  return { geometry, materials: slots };
}

/**
 * `prepareOBJMesh`, then materials' `createMesh` with one material slot per OBJ material. Dispose the mesh with
 * `destroy()`; the materials stay owned by their set.
 */
export function createOBJMesh(
  engine: EngineKernel,
  obj: LoadedOBJ,
  materials: MTLMaterialSet | ReadonlyMap<string, Material>,
  options: OBJMeshOptions & { renderOrder?: number } = {},
): MaterialMesh<Material[]> {
  const prepared = prepareOBJMesh(obj, materials, options);
  return createMesh(engine, prepared.geometry, prepared.materials, { renderOrder: options?.renderOrder ?? 0 });
}

/** Options of `loadOBJ`: fetching, parse limits, material building and the mesh. */
export interface LoadOBJOptions
  extends FetchOptions,
    ParseLimits,
    Omit<MTLMaterialsOptions, 'baseUrl' | 'signal'>,
    OBJMeshOptions {
  /** Draw order of the mesh. Default 0. */
  renderOrder?: number;
}

/** What `loadOBJ` returns. */
export interface LoadedOBJMesh {
  mesh: MaterialMesh<Material[]>;
  /** The parsed OBJ, with its MTL materials as data. */
  obj: LoadedOBJ;
  materials: MTLMaterialSet;
  /** The OBJ's warnings followed by the material set's. */
  warnings: string[];
  /** Destroys the mesh and disposes the material set (and the fallback material when loadOBJ made it). */
  dispose(): void;
}

/**
 * Loads a textured OBJ in one call: fetches the OBJ, then each `mtllib` relative to it, builds the materials with
 * `createMTLMaterials` (textures relative to their library) and the mesh with `createOBJMesh`. A library that cannot
 * be read is a warning. Throws `TypeError` when `url` is not absolute and there is no page URL, and the
 * `LoaderError` of a failed fetch or parse. When the mesh cannot be built, everything loaded is disposed first.
 */
export async function loadOBJ(
  engine: EngineKernel,
  url: string | URL,
  options: LoadOBJOptions = {},
): Promise<LoadedOBJMesh> {
  const opts = options ?? {};
  let objUrl: string;
  try {
    objUrl = new URL(String(url), (globalThis as { location?: { href?: string } }).location?.href).href;
  } catch {
    throw new TypeError(`loadOBJ url ${JSON.stringify(String(url))} is not an absolute URL; pass the full .obj URL`);
  }
  const fetchOptions: FetchOptions = {
    signal: opts.signal,
    maxBytes: opts.maxBytes,
    fetch: opts.fetch,
    init: opts.init,
  };
  const bytes = await fetchBytes(objUrl, fetchOptions);
  const obj = await parseOBJ(bytes, {
    resolve: (path) => fetchBytes(new URL(path, objUrl), fetchOptions),
    signal: opts.signal,
    maxVertices: opts.maxVertices,
    maxTriangles: opts.maxTriangles,
  });
  const set = await createMTLMaterials(obj.materials, { ...opts, baseUrl: objUrl });
  const ownFallback = opts.fallback ? undefined : new Material(),
    fallback = opts.fallback ?? (ownFallback as Material);
  let mesh: MaterialMesh<Material[]>;
  try {
    mesh = createOBJMesh(engine, obj, set, { fallback, renderOrder: opts.renderOrder ?? 0 });
  } catch (error) {
    set.dispose();
    ownFallback?.dispose();
    throw error;
  }
  return {
    mesh,
    obj,
    materials: set,
    warnings: [...obj.warnings, ...set.warnings],
    dispose() {
      mesh.destroy();
      set.dispose();
      ownFallback?.dispose();
    },
  };
}
