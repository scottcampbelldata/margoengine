import type { EngineKernel } from '@margoengine/core';
import {
  Material,
  createMesh,
  loadTexture as loadMaterialTexture,
  type MapSlot,
  type MaterialMesh,
  type MaterialOptions,
  type MeshGeometry,
  type Texture,
  type TextureOptions,
} from '@margoengine/materials';
import { SRGBToLinear } from '@margoengine/math/color';
import { fetchBytes, type FetchOptions } from './load.js';
import { parseOBJ, type LoadedOBJ, type MTLMap, type MTLMaterial } from './obj.js';
import { LoaderError, type ParseLimits } from './types.js';
import { resolvePath } from './util.js';

const F = 'MTL';

/** Loads one texture for `createMTLMaterials`: the URL and the texture options the map needs. */
export type MTLTextureLoader = (url: string, options: TextureOptions & { signal?: AbortSignal }) => Promise<Texture>;

/** Options of `createMTLMaterials`. */
export interface MTLMaterialsOptions {
  /**
   * URL the maps' `path`s are relative to: the .mtl file's URL for `parseMTL` output, the .obj file's URL for the
   * `materials` of `parseOBJ` (their paths already include the library's folder). Default the page's URL.
   */
  baseUrl?: string | URL;
  /** Texture loader. Default materials `loadTexture` (http(s), blob: and data: URLs). */
  loadTexture?: MTLTextureLoader;
  /**
   * What `bump` / `map_Bump` holds: `'height'` (the MTL specification: a bump map, scaled by `-bm`) or `'normal'`
   * (a tangent-space normal map, as many exporters write it). Default `'height'`.
   */
  bump?: 'height' | 'normal';
  /** Draws both faces. Default false (front faces, like three.js `MTLLoader`). */
  doubleSided?: boolean;
  signal?: AbortSignal;
}

/** Materials built by `createMTLMaterials`. */
export interface MTLMaterialSet {
  /** Materials by `newmtl` name. */
  materials: Map<string, Material>;
  /** Every texture loaded, once per file, colour space and wrap mode. */
  textures: Texture[];
  /** Maps that failed to load and MTL values with no Margo equivalent. */
  warnings: string[];
  /** Disposes every material and texture of the set. */
  dispose(): void;
}

const linear = (rgb: readonly number[]): [number, number, number] =>
  rgb.map((v) => SRGBToLinear(Math.min(1, Math.max(0, Number.isFinite(v) ? v : 0)))) as [number, number, number];

/** Maps and extension statements `createMTLMaterials` uses; it reports the others. */
const USED_MAPS = new Set(['map_Kd', 'map_Ke', 'map_d', 'bump']);
const USED_EXTRAS = new Set(['norm', 'pr', 'pm']);

/** Value of an extension statement (`Pr 0.4`), or undefined. */
const extra = (m: MTLMaterial, keyword: string): string | undefined =>
  m.extras.find((e) => e.keyword.toLowerCase() === keyword.toLowerCase())?.value;

/**
 * The folder the material's library lives in, relative to where its map paths point: recovered from another map's
 * `file` and `path` (`path` = folder + `file`), or '' when no map tells.
 */
function libraryFolder(m: MTLMaterial): string {
  for (const map of Object.values(m.maps)) {
    const file = resolvePath('', map.file);
    if (!map.file.includes('..') && !/^(\/|[a-z][a-z\d+.-]*:)/i.test(file) && map.path.endsWith(file))
      return map.path.slice(0, map.path.length - file.length);
  }
  return '';
}

/** The `norm` statement (PBR extension), which `parseMTL` keeps in `extras`, as a map. */
function normMap(m: MTLMaterial): MTLMap | undefined {
  const value = extra(m, 'norm');
  if (!value) return undefined;
  const tokens = value.split(/\s+/),
    options: MTLMap['options'] = {};
  let i = 0;
  while (i < tokens.length - 1 && tokens[i][0] === '-') {
    const name = tokens[i++].slice(1);
    if (name === 'bm') options.bm = Number(tokens[i++]);
    else if (name === 'o' || name === 's') {
      const fill = name === 's' ? 1 : 0,
        v: [number, number, number] = [fill, fill, fill];
      for (let k = 0; k < 3 && i < tokens.length - 1 && Number.isFinite(Number(tokens[i])); k++)
        v[k] = Number(tokens[i++]);
      options[name] = v;
    } else if (name === 'clamp') options.clamp = tokens[i++] === 'on';
    else i++;
  }
  const file = tokens.slice(i).join(' ');
  return file ? { file, path: resolvePath(`${libraryFolder(m)}library.mtl`, file), options } : undefined;
}

/**
 * Roughness for a Blinn-Phong exponent: Beckmann alpha = sqrt(2 / (Ns + 2)) (Walter et al. 2007), roughness =
 * sqrt(alpha). Ns 0 gives 1, Ns 10 0.64, Ns 100 0.37, Ns 1000 0.21.
 */
const roughnessOf = (ns: number): number => Math.min(1, Math.max(0, (2 / (Math.max(0, ns) + 2)) ** 0.25));

/**
 * Material options for one MTL material, without textures: `Kd` colour (sRGB to linear), `d` (or 1 - `Tr`) opacity,
 * `Ke` emission, roughness from `Ns` (1 when `illum` is 1 or `Ks` is black), the PBR extension's `Pr` roughness and
 * `Pm` metalness when present, and unlit shading for `illum 0`.
 */
function materialOptions(m: MTLMaterial, doubleSided: boolean): MaterialOptions {
  const options: MaterialOptions = { doubleSided };
  if (m.illum === 0) options.shading = 'basic';
  options.color = m.Kd ? linear(m.Kd) : [1, 1, 1];
  const opacity = m.d ?? (m.Tr !== undefined ? 1 - m.Tr : 1);
  options.opacity = Math.min(1, Math.max(0, Number.isFinite(opacity) ? opacity : 1));
  if (options.opacity < 1 || m.maps.map_d) options.transparent = true;
  if (m.illum === 0) return options;
  const emissive = m.Ke ?? (m.maps.map_Ke ? [1, 1, 1] : undefined);
  if (emissive) {
    const peak = Math.max(...emissive);
    // Emission brighter than 1 keeps its colour and moves the excess into emissiveIntensity.
    options.emissive = linear(peak > 1 ? emissive.map((v) => v / peak) : emissive);
    if (peak > 1) options.emissiveIntensity = peak;
  }
  const pr = parseFloat(extra(m, 'Pr') ?? ''),
    pm = parseFloat(extra(m, 'Pm') ?? ''),
    noHighlight = m.illum === 1 || (m.Ks !== undefined && Math.max(...m.Ks) <= 0);
  options.roughness = Number.isFinite(pr)
    ? Math.min(1, Math.max(0, pr))
    : noHighlight || m.Ns === undefined
      ? 1
      : roughnessOf(m.Ns);
  options.metalness = Number.isFinite(pm) ? Math.min(1, Math.max(0, pm)) : 0;
  return options;
}

/**
 * Builds materials `Material`s from MTL data (three.js `MTLLoader.MaterialCreator`): metallic-roughness materials with
 * `Kd`, `d`/`Tr`, `Ke`, `Ns` (see `MTLMaterialsOptions`) and the maps `map_Kd` (colour), `map_Ke` (emission),
 * `bump`/`map_Bump` (bump or normal map, `-bm` as the bump scale), `norm` (normal map) and `map_d` (opacity, makes the
 * material transparent), each with its `-o`/`-s` offset and scale as the slot's UV transform and `-clamp` as clamped
 * wrapping. `illum 0` is unlit, `illum 1` has no highlight. Everything else (`Ka`, the `Ks` colour, `Ni`, `Tf`,
 * `map_Ka`, `map_Ks`, `map_Ns`, `disp`, `decal`, `refl`, ...) has no Margo equivalent and is named in `warnings`, as is
 * any map that fails to load (that material is built without it). Texture URLs resolve against `baseUrl`.
 */
export async function createMTLMaterials(
  mtl: readonly MTLMaterial[],
  options: MTLMaterialsOptions = {},
): Promise<MTLMaterialSet> {
  if (!Array.isArray(mtl)) throw new TypeError('createMTLMaterials input is not an array; pass parseMTL output');
  const bump = options.bump ?? 'height';
  if (bump !== 'height' && bump !== 'normal') throw new RangeError(`bump "${String(bump)}" is not height or normal`);
  const load = options.loadTexture ?? loadMaterialTexture;
  if (typeof load !== 'function') throw new TypeError('loadTexture is not a function; pass (url, options) => Texture');
  let base: URL | undefined;
  const resolve = (path: string): string => {
    try {
      base ??= new URL(options.baseUrl ?? '', globalThis.location?.href);
    } catch {
      throw new TypeError(
        `baseUrl "${String(options.baseUrl)}" is not an absolute URL; pass the .mtl (or .obj) URL to resolve maps against`,
      );
    }
    return new URL(path, base).href;
  };
  const warnings: string[] = [],
    warn = (message: string) => {
      if (!warnings.includes(message)) warnings.push(message);
    },
    textures = new Map<string, Promise<Texture | undefined>>(),
    loaded: Texture[] = [],
    built: Material[] = [],
    materials = new Map<string, Material>();
  let disposed = false;
  const dispose = () => {
    disposed = true;
    for (const material of built) material.dispose();
    for (const item of loaded) item.dispose();
  };
  const texture = (map: MTLMap, colorSpace: 'srgb' | 'linear'): Promise<Texture | undefined> => {
    const url = resolve(map.path),
      wrap = map.options.clamp ? 'clamp' : 'repeat',
      key = `${colorSpace} ${wrap} ${url}`;
    let pending = textures.get(key);
    if (!pending) {
      pending = load(url, { colorSpace, wrapS: wrap, wrapT: wrap, signal: options.signal }).then(
        (result) => {
          // A texture that arrives after an abort is freed at once.
          if (disposed) result.dispose();
          else loaded.push(result);
          return result;
        },
        (error: unknown) => {
          if (options.signal?.aborted) throw error;
          warn(`texture ${url} could not be loaded (${(error as Error)?.message ?? error}); its maps are left out`);
          return undefined;
        },
      );
      textures.set(key, pending);
    }
    return pending;
  };
  const assignments: Promise<void>[] = [];
  const build = (m: MTLMaterial) => {
    if (materials.has(m.name)) return;
    const material = new Material(materialOptions(m, options.doubleSided ?? false));
    built.push(material);
    materials.set(m.name, material);
    for (const key of Object.keys(m.maps))
      if (!USED_MAPS.has(key)) warn(`${key} has no Margo material slot; it is not used`);
    for (const { keyword } of m.extras)
      if (!USED_EXTRAS.has(keyword.toLowerCase())) warn(`${keyword} has no Margo material equivalent; it is not used`);
    if (m.Ka) warn('Ka (ambient colour) has no Margo material equivalent; it is not used');
    if (m.Ks && m.illum !== 0 && Math.max(...m.Ks) > 0)
      warn('Ks (specular colour) only sets whether there is a highlight; roughness comes from Ns');
    const slots: [MapSlot | 'alphaMap' | 'bumpMap', MTLMap, 'srgb' | 'linear'][] = [];
    if (m.maps.map_Kd) slots.push(['map', m.maps.map_Kd, 'srgb']);
    if (m.maps.map_d) slots.push(['alphaMap', m.maps.map_d, 'linear']);
    if (m.illum !== 0) {
      if (m.maps.map_Ke) slots.push(['emissiveMap', m.maps.map_Ke, 'srgb']);
      if (m.maps.bump) slots.push([bump === 'normal' ? 'normalMap' : 'bumpMap', m.maps.bump, 'linear']);
      const norm = normMap(m);
      if (norm) slots.push(['normalMap', norm, 'linear']);
    }
    for (const [slot, map, space] of slots)
      assignments.push(
        texture(map, space).then((value) => {
          if (!value || disposed) return;
          if (slot === 'alphaMap') material.alphaMap = value;
          else if (slot === 'bumpMap') {
            material.bumpMap = value;
            if (map.options.bm !== undefined && Number.isFinite(map.options.bm)) material.bumpScale = map.options.bm;
          } else material[slot as 'map' | 'emissiveMap' | 'normalMap'] = value;
          const { o, s } = map.options;
          if ((o && (o[0] || o[1])) || (s && (s[0] !== 1 || s[1] !== 1)))
            material.setUVTransform({ offset: [o?.[0] ?? 0, o?.[1] ?? 0], scale: [s?.[0] ?? 1, s?.[1] ?? 1] }, slot);
        }),
      );
  };
  try {
    for (const m of mtl) build(m);
    await Promise.all(assignments);
  } catch (error) {
    dispose();
    if (options.signal?.aborted) throw new LoaderError(F, 'aborted', 'aborted while loading textures');
    throw error;
  }
  return { materials, textures: loaded, warnings, dispose };
}

/** Options of `prepareOBJMesh` and `createOBJMesh`. */
export interface OBJMeshOptions {
  /** Material of groups without `usemtl` or naming an unknown material. Default a new white `Material`. */
  fallback?: Material;
}

/**
 * The materials mesh input for an OBJ: geometry with `groups` (one slot per distinct material) and the material array
 * in slot order. UVs go back to OBJ/three.js orientation (v up, for `flipY` textures, materials' default), vertex
 * colours from sRGB to linear, and missing normals become smooth normals shared across UV seams (by `positionIndices`).
 * Groups whose `usemtl` names no material use `options.fallback`.
 */
export function prepareOBJMesh(
  obj: LoadedOBJ,
  materials: MTLMaterialSet | ReadonlyMap<string, Material>,
  options: OBJMeshOptions = {},
): { geometry: MeshGeometry; materials: Material[] } {
  if (!obj || obj.kind !== 'mesh' || !obj.indices?.length)
    throw new LoaderError('OBJ', 'unsupported', 'the OBJ has no faces; draw its points with pointsToGeometry');
  const byName = materials instanceof Map ? materials : (materials as MTLMaterialSet).materials;
  if (!(byName instanceof Map))
    throw new TypeError('prepareOBJMesh materials is not a Map or createMTLMaterials result');
  const { positions, indices } = obj,
    count = positions.length / 3;
  let normals = obj.normals;
  if (!normals) {
    // Smooth normals per OBJ position, so vertices split by UV seams share them.
    let positionsInFile = 0;
    for (const p of obj.positionIndices) if (p >= positionsInFile) positionsInFile = p + 1;
    const sums = new Float64Array(positionsInFile * 3);
    for (let t = 0; t + 2 < indices.length; t += 3) {
      const a = indices[t] * 3,
        b = indices[t + 1] * 3,
        c = indices[t + 2] * 3,
        ux = positions[b] - positions[a],
        uy = positions[b + 1] - positions[a + 1],
        uz = positions[b + 2] - positions[a + 2],
        vx = positions[c] - positions[a],
        vy = positions[c + 1] - positions[a + 1],
        vz = positions[c + 2] - positions[a + 2],
        n = [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
      for (const v of [indices[t], indices[t + 1], indices[t + 2]])
        for (let k = 0; k < 3; k++) sums[obj.positionIndices[v] * 3 + k] += n[k];
    }
    normals = new Float32Array(count * 3);
    for (let v = 0; v < count; v++)
      for (let k = 0; k < 3; k++) normals[v * 3 + k] = sums[obj.positionIndices[v] * 3 + k];
  }
  // Materials meshes reject zero normals: unused or degenerate corners face +z.
  const safe = new Float32Array(normals);
  for (let v = 0; v < count; v++) {
    const length = Math.hypot(safe[v * 3], safe[v * 3 + 1], safe[v * 3 + 2]);
    if (length > 0 && Number.isFinite(length)) for (let k = 0; k < 3; k++) safe[v * 3 + k] /= length;
    else safe.set([0, 0, 1], v * 3);
  }
  const geometry: MeshGeometry = { positions, normals: safe, indices };
  if (obj.uvs) {
    const uvs = new Float32Array(obj.uvs);
    for (let i = 1; i < uvs.length; i += 2) uvs[i] = 1 - uvs[i];
    geometry.uvs = uvs;
  }
  if (obj.colors) geometry.colors = obj.colors.map((c) => SRGBToLinear(Math.min(1, Math.max(0, c))));
  const slots: Material[] = [],
    groups: { start: number; count: number; materialIndex: number }[] = [];
  let fallback = options.fallback;
  for (const group of obj.groups.length ? obj.groups : [{ start: 0, count: indices.length, groupNames: [] }]) {
    if (!group.count) continue;
    let material = group.material === undefined ? undefined : byName.get(group.material);
    if (!material) material = fallback ??= new Material();
    let slot = slots.indexOf(material);
    if (slot < 0) slot = slots.push(material) - 1;
    groups.push({ start: group.start, count: group.count, materialIndex: slot });
  }
  geometry.groups = groups;
  return { geometry, materials: slots };
}

/**
 * Creates one materials mesh (`createMesh` with groups) for a parsed OBJ: each `usemtl` group draws with its material
 * from `createMTLMaterials`. See `prepareOBJMesh` for the conversion. The mesh has at most 1,000,000 vertices.
 */
export function createOBJMesh(
  engine: EngineKernel,
  obj: LoadedOBJ,
  materials: MTLMaterialSet | ReadonlyMap<string, Material>,
  options: OBJMeshOptions & { renderOrder?: number } = {},
): MaterialMesh<Material[]> {
  const prepared = prepareOBJMesh(obj, materials, options);
  return createMesh(engine, prepared.geometry, prepared.materials, { renderOrder: options.renderOrder ?? 0 });
}

/** Options of `loadOBJ`: fetch limits and init, parse limits, material options and mesh options. */
export interface LoadOBJOptions
  extends FetchOptions,
    ParseLimits,
    Omit<MTLMaterialsOptions, 'baseUrl' | 'signal'>,
    OBJMeshOptions {
  renderOrder?: number;
}

/** The result of `loadOBJ`. */
export interface LoadedOBJMesh {
  mesh: MaterialMesh<Material[]>;
  /** The parsed OBJ, with its MTL materials as data. */
  obj: LoadedOBJ;
  /** The built materials and textures. */
  materials: MTLMaterialSet;
  /** The OBJ's and the materials' warnings together. */
  warnings: string[];
  /** Destroys the mesh and disposes its materials (the fallback too, when `loadOBJ` made it) and textures. */
  dispose(): void;
}

/**
 * Loads an OBJ with its MTL libraries and textures in one call (three.js `OBJLoader` with `MTLLoader`): fetches the
 * .obj, every `mtllib` next to it, every texture relative to its .mtl file, builds the materials with
 * `createMTLMaterials` and one materials mesh with `createOBJMesh`, each `usemtl` group drawn with its material.
 * A library or texture that fails to load becomes a warning; the OBJ itself failing to load or parse throws a
 * `LoaderError`. Textures load through `options.loadTexture` (default materials `loadTexture`).
 */
export async function loadOBJ(
  engine: EngineKernel,
  url: string | URL,
  options: LoadOBJOptions = {},
): Promise<LoadedOBJMesh> {
  let base: URL;
  try {
    base = new URL(url, globalThis.location?.href);
  } catch {
    throw new TypeError(`OBJ URL "${String(url)}" is not absolute and there is no page URL; pass an absolute URL`);
  }
  const obj = await parseOBJ(await fetchBytes(base, options), {
    resolve: (path) => fetchBytes(new URL(path, base), options),
    signal: options.signal,
    maxVertices: options.maxVertices,
    maxTriangles: options.maxTriangles,
  });
  const set = await createMTLMaterials(obj.materials, { ...options, baseUrl: base }),
    named = new Set(set.materials.values());
  let mesh: MaterialMesh<Material[]>, made: Material | undefined;
  try {
    const prepared = prepareOBJMesh(obj, set, options);
    // The fallback this call made (when options.fallback is absent) is disposed with the mesh.
    made = options.fallback ? undefined : prepared.materials.find((m) => !named.has(m));
    mesh = createMesh(engine, prepared.geometry, prepared.materials, { renderOrder: options.renderOrder ?? 0 });
  } catch (error) {
    set.dispose();
    made?.dispose();
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
      made?.dispose();
    },
  };
}
