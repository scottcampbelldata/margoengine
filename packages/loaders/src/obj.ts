import { LoaderError, type AssetResolver, type LoadedGeometry, type LoadedGroup, type ParseLimits } from './types.js';
import {
  CornerWelder,
  floats,
  limits,
  normalizeColors,
  resolvePath,
  throwIfAborted,
  toText,
  uints,
  type BinaryInput,
  type Limits,
} from './util.js';

const F = 'OBJ';
const NONE = 0xffffffff;

/** A statement kept as written: its keyword, the rest of the line and its 1-based line number. */
export interface OBJStatement {
  keyword: string;
  value: string;
  line: number;
}

/** Options of a texture map statement (`map_Kd -o 0.5 0 -clamp on tex.png`), named as in the MTL specification. */
export interface MTLMapOptions {
  /** `-o u v w` texture offset; missing components are 0. */
  o?: [number, number, number];
  /** `-s u v w` texture scale; missing components are 1. */
  s?: [number, number, number];
  /** `-t u v w` turbulence; missing components are 0. */
  t?: [number, number, number];
  clamp?: boolean;
  blendu?: boolean;
  blendv?: boolean;
  /** `-cc` color correction. */
  cc?: boolean;
  /** `-bm` bump multiplier. */
  bm?: number;
  boost?: number;
  texres?: number;
  /** `-mm base gain`. */
  mm?: [number, number];
  imfchan?: string;
  type?: string;
}

/** One texture map of an MTL material. */
export interface MTLMap {
  /** File name as written, after the options. */
  file: string;
  /** `file` resolved against the MTL file's folder: the path to give the resolver (relative to the OBJ). */
  path: string;
  options: MTLMapOptions;
}

/** One `newmtl` block. Colors are as written (sRGB by convention). */
export interface MTLMaterial {
  name: string;
  Ka?: [number, number, number];
  Kd?: [number, number, number];
  Ks?: [number, number, number];
  Ke?: [number, number, number];
  Ns?: number;
  /** Opacity, 1 = opaque. */
  d?: number;
  /** Transparency as written (usually 1 - d). */
  Tr?: number;
  illum?: number;
  /**
   * Texture maps by statement, in a null-prototype object: `map_Kd`, `map_Ka`, `map_Ks`, `map_Ke`, `map_Ns`, `map_d`,
   * `bump` (also written `map_Bump`), `disp`, `decal`, `refl`, and any other `map_*` as written.
   */
  maps: Record<string, MTLMap>;
  /** Statements this reader does not interpret (`Ni`, `Tf`, `Pr`, spectral colors, unknown map options, ...). */
  extras: OBJStatement[];
}

/** A run of faces with the same object, groups and material. */
export interface OBJGroup extends LoadedGroup {
  /** Name from the last `o` statement. */
  object?: string;
  /** Names from the last `g` statement (one `g` may list several). */
  groupNames: string[];
  /** Material from the last `usemtl` statement. */
  material?: string;
}

/** Options of `parseOBJ`. */
export interface OBJParseOptions extends ParseLimits {
  /** Reads each `mtllib` file, given its path relative to the OBJ folder. Without it `materials` stays empty. */
  resolve?: AssetResolver;
  signal?: AbortSignal;
}

/**
 * A parsed OBJ. Every distinct (v, vt, vn) corner is one vertex, so UV and normal seams are kept; `colors` come from
 * the `v` lines. `uvs` use Margo's convention, v = 1 - vt v (OBJ puts v = 0 at the bottom of the image, Margo and
 * glTF at the top). Faces are fan-triangulated in file order: face f with n = `faceSizes[f]` corners c0..cn-1 gives
 * the triangles (c0, ck, ck+1), so the original polygons can be rebuilt from `indices` and `faceSizes`.
 */
export interface LoadedOBJ extends LoadedGeometry {
  groups: OBJGroup[];
  /** Corner count of each face, in file order. */
  faceSizes: Uint32Array;
  /** `s` smoothing group of each face; 0 is off. */
  smoothingGroups: Uint32Array;
  /** For each vertex, the 0-based `v` it came from: corners that share a position share this even across seams. */
  positionIndices: Uint32Array;
  /** `mtllib` file names in order, without duplicates. */
  materialLibraries: string[];
  /** Materials of those libraries (first definition of a name wins); empty without `resolve`. */
  materials: MTLMaterial[];
  /** Texture paths `materials` use, relative to the OBJ folder and without duplicates: give each to the resolver. */
  images: string[];
  /** Statements this reader does not interpret (`l`, `p`, `vp`, curves, ...), in order. */
  extras: OBJStatement[];
  /** Problems that did not stop the import, such as an MTL file the resolver could not read. */
  warnings: string[];
}

const words = (text: string): string[] => (text ? text.split(/\s+/) : []);
const NUMBER = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

function number(token: string | undefined, format: string, line: number): number {
  const value = Number(token);
  if (token === undefined || token === '' || Number.isNaN(value))
    throw new LoaderError(format, 'syntax', `expected a number on line ${line}, got "${String(token).slice(0, 32)}"`);
  return value;
}

/** Calls `visit` for every non-empty statement, after removing comments and joining `\` line continuations. */
function eachStatement(text: string, visit: (keyword: string, rest: string, line: number) => void): void {
  let line = 0,
    start = 0,
    pending = '',
    pendingLine = 0;
  while (start <= text.length) {
    let end = text.indexOf('\n', start);
    if (end < 0) end = text.length;
    line++;
    let raw = text.slice(start, end);
    start = end + 1;
    const hash = raw.indexOf('#');
    if (hash >= 0) raw = raw.slice(0, hash);
    raw = raw.trimEnd();
    if (raw.endsWith('\\')) {
      if (!pending) pendingLine = line;
      pending += `${raw.slice(0, -1)} `;
      continue;
    }
    const statement = (pending + raw).trim(),
      at = pending ? pendingLine : line;
    pending = '';
    if (!statement) continue;
    const space = statement.search(/\s/);
    if (space < 0) visit(statement, '', at);
    else visit(statement.slice(0, space), statement.slice(space + 1).trim(), at);
  }
}

const MAPS: Record<string, string> = {
  map_kd: 'map_Kd',
  map_ka: 'map_Ka',
  map_ks: 'map_Ks',
  map_ke: 'map_Ke',
  map_ns: 'map_Ns',
  map_d: 'map_d',
  map_bump: 'bump',
  bump: 'bump',
  disp: 'disp',
  decal: 'decal',
  refl: 'refl',
};

/** Parses a map statement's options and file name; null when it uses an option outside the MTL specification. */
function parseMap(tokens: string[], line: number, from: string): MTLMap | null {
  const options: MTLMapOptions = {},
    last = tokens.length - 1;
  let i = 0;
  const value = (): string => {
    if (i >= last) throw new LoaderError('MTL', 'syntax', `map option ${tokens[i - 1]} on line ${line} has no value`);
    return tokens[i++];
  };
  while (i <= last && tokens[i][0] === '-') {
    const name = tokens[i++].slice(1);
    switch (name) {
      case 'o':
      case 's':
      case 't': {
        const fill = name === 's' ? 1 : 0,
          vector: [number, number, number] = [fill, fill, fill];
        for (let k = 0; k < 3 && i < last && NUMBER.test(tokens[i]); k++) vector[k] = Number(tokens[i++]);
        options[name] = vector;
        break;
      }
      case 'mm':
        options.mm = [number(value(), 'MTL', line), number(value(), 'MTL', line)];
        break;
      case 'bm':
      case 'boost':
      case 'texres':
        options[name] = number(value(), 'MTL', line);
        break;
      case 'clamp':
      case 'blendu':
      case 'blendv':
      case 'cc': {
        const flag = value();
        if (flag !== 'on' && flag !== 'off')
          throw new LoaderError('MTL', 'syntax', `map option -${name} on line ${line} must be on or off`);
        options[name] = flag === 'on';
        break;
      }
      case 'imfchan':
      case 'type':
        options[name] = value();
        break;
      default:
        return null;
    }
  }
  const file = tokens.slice(i).join(' ');
  if (!file) throw new LoaderError('MTL', 'syntax', `texture map on line ${line} has no file name`);
  return { file, path: resolvePath(from, file), options };
}

/** Options of `parseMTL`. */
export interface MTLParseOptions {
  /** The MTL file's path relative to the OBJ folder; texture paths resolve against its folder. Default `''`. */
  path?: string;
}

/**
 * Parses a Wavefront MTL library: `newmtl`, `Ka`, `Kd`, `Ks`, `Ke`, `Ns`, `d`, `Tr`, `illum` and every texture map
 * with its options. Statements it does not interpret are kept in each material's `extras`.
 */
export function parseMTL(input: BinaryInput | string, options: MTLParseOptions = {}): MTLMaterial[] {
  const from = options.path ?? '',
    materials: MTLMaterial[] = [];
  let material: MTLMaterial | undefined;
  eachStatement(toText(input, 'MTL'), (keyword, rest, line) => {
    const key = keyword.toLowerCase(),
      tokens = words(rest);
    if (key === 'newmtl') {
      if (!rest) throw new LoaderError('MTL', 'syntax', `newmtl on line ${line} has no name`);
      materials.push((material = { name: rest, maps: Object.create(null), extras: [] }));
      return;
    }
    if (!material) throw new LoaderError('MTL', 'syntax', `${keyword} on line ${line} comes before the first newmtl`);
    switch (key) {
      case 'ka':
      case 'kd':
      case 'ks':
      case 'ke':
        if (NUMBER.test(tokens[0] ?? '')) {
          const r = number(tokens[0], 'MTL', line);
          material[key === 'ka' ? 'Ka' : key === 'kd' ? 'Kd' : key === 'ks' ? 'Ks' : 'Ke'] = [
            r,
            tokens.length > 1 ? number(tokens[1], 'MTL', line) : r,
            tokens.length > 2 ? number(tokens[2], 'MTL', line) : r,
          ];
        } else material.extras.push({ keyword, value: rest, line });
        break;
      case 'ns':
      case 'd':
      case 'tr':
      case 'illum':
        // `d -halo 0.5`: the factor is the last value.
        material[key === 'ns' ? 'Ns' : key === 'tr' ? 'Tr' : key === 'd' ? 'd' : 'illum'] = number(
          tokens[tokens.length - 1],
          'MTL',
          line,
        );
        break;
      default: {
        const name = Object.hasOwn(MAPS, key) ? MAPS[key] : key.startsWith('map_') ? keyword : undefined,
          map = name ? parseMap(tokens, line, from) : null;
        if (name && map) material.maps[name] = map;
        else material.extras.push({ keyword, value: rest, line });
      }
    }
  });
  return materials;
}

function cornerIndex(token: string, count: number, what: string, line: number): number {
  const value = Number(token);
  if (!Number.isSafeInteger(value) || value === 0)
    throw new LoaderError(
      F,
      'syntax',
      `${what} index "${token.slice(0, 16)}" on line ${line} is not a non-zero integer`,
    );
  const index = value < 0 ? count + value : value - 1;
  if (index < 0 || index >= count)
    throw new LoaderError(F, 'range', `${what} index ${value} on line ${line} is outside the ${count} defined so far`);
  return index;
}

function readOBJ(text: string, limit: Limits): LoadedOBJ {
  const positions = floats(),
    colors = floats(),
    uvs = floats(),
    normals = floats(),
    cornerV = uints(),
    cornerT = uints(),
    cornerN = uints(),
    faceSizes = uints(),
    smoothing = uints();
  const groups: OBJGroup[] = [],
    extras: OBJStatement[] = [],
    libraries: string[] = [];
  let anyColor = false,
    object: string | undefined,
    groupNames: string[] = [],
    material: string | undefined,
    smooth = 0,
    triangles = 0;
  eachStatement(text, (keyword, rest, line) => {
    switch (keyword) {
      case 'v': {
        const t = words(rest);
        if (t.length !== 3 && t.length !== 4 && t.length !== 6 && t.length !== 7)
          throw new LoaderError(
            F,
            'syntax',
            `v on line ${line} has ${t.length} values; expected x y z [w] or x y z r g b`,
          );
        if (positions.length / 3 >= limit.maxVertices)
          throw new LoaderError(F, 'limit', `vertex count exceeds the limit of ${limit.maxVertices}`);
        positions.push3(number(t[0], F, line), number(t[1], F, line), number(t[2], F, line));
        if (t.length >= 6) {
          anyColor = true;
          colors.push3(number(t[3], F, line), number(t[4], F, line), number(t[5], F, line));
        } else colors.push3(1, 1, 1);
        break;
      }
      case 'vt': {
        const t = words(rest);
        if (t.length < 1 || t.length > 3)
          throw new LoaderError(F, 'syntax', `vt on line ${line} has ${t.length} values; expected u [v [w]]`);
        uvs.push(number(t[0], F, line));
        uvs.push(t.length > 1 ? number(t[1], F, line) : 0);
        break;
      }
      case 'vn': {
        const t = words(rest);
        if (t.length !== 3) throw new LoaderError(F, 'syntax', `vn on line ${line} has ${t.length} values; expected 3`);
        normals.push3(number(t[0], F, line), number(t[1], F, line), number(t[2], F, line));
        break;
      }
      case 'f': {
        const t = words(rest);
        if (t.length < 3)
          throw new LoaderError(F, 'syntax', `face on line ${line} has ${t.length} corners; a face needs at least 3`);
        if (triangles + t.length - 2 > limit.maxTriangles)
          throw new LoaderError(F, 'limit', `triangle count exceeds the limit of ${limit.maxTriangles}`);
        const last = groups[groups.length - 1];
        if (
          !last ||
          last.object !== object ||
          last.material !== material ||
          last.groupNames.join(' ') !== groupNames.join(' ')
        ) {
          const group: OBJGroup = { start: triangles * 3, count: 0, groupNames };
          const name = groupNames.length ? groupNames.join(' ') : object;
          if (name !== undefined) group.name = name;
          if (object !== undefined) group.object = object;
          if (material !== undefined) group.material = material;
          groups.push(group);
        }
        for (const corner of t) {
          const parts = corner.split('/');
          if (parts.length > 3 || !parts[0])
            throw new LoaderError(
              F,
              'syntax',
              `face corner "${corner.slice(0, 32)}" on line ${line} is not v, v/vt, v//vn or v/vt/vn`,
            );
          cornerV.push(cornerIndex(parts[0], positions.length / 3, 'v', line));
          cornerT.push(parts[1] ? cornerIndex(parts[1], uvs.length / 2, 'vt', line) : NONE);
          cornerN.push(parts[2] ? cornerIndex(parts[2], normals.length / 3, 'vn', line) : NONE);
        }
        faceSizes.push(t.length);
        smoothing.push(smooth);
        triangles += t.length - 2;
        break;
      }
      case 'o':
        object = rest || undefined;
        break;
      case 'g':
        groupNames = words(rest);
        break;
      case 'usemtl':
        material = rest || undefined;
        break;
      case 's': {
        const value = rest === 'off' ? 0 : Number(rest);
        if (!Number.isSafeInteger(value) || value < 0 || value >= NONE)
          throw new LoaderError(
            F,
            'syntax',
            `s on line ${line} must be off or a group number, got "${rest.slice(0, 16)}"`,
          );
        smooth = value;
        break;
      }
      case 'mtllib': {
        // Several names separated by spaces, unless that would split one name with spaces (as Blender writes it).
        const names = words(rest);
        for (const name of names.every((n) => /\.mtl$/i.test(n)) ? names : [rest])
          if (name && !libraries.includes(name)) libraries.push(name);
        break;
      }
      default:
        extras.push({ keyword, value: rest, line });
    }
  });
  if (anyColor) normalizeColors(colors.array.subarray(0, colors.length));
  const result = {
    groups,
    faceSizes: faceSizes.result(),
    smoothingGroups: smoothing.result(),
    materialLibraries: libraries,
    materials: [],
    images: [],
    extras,
    warnings: [],
  };
  if (!triangles)
    return {
      ...result,
      kind: 'points',
      positions: positions.result(),
      positionIndices: Uint32Array.from({ length: positions.length / 3 }, (_, i) => i),
      ...(anyColor ? { colors: colors.result() } : {}),
    };
  const welder = new CornerWelder(positions.length / 3),
    corners = cornerV.length,
    vertexOf = new Uint32Array(corners);
  let hasUV = false,
    hasNormal = false;
  for (let i = 0; i < corners; i++) {
    const t = cornerT.array[i],
      n = cornerN.array[i];
    if (t !== NONE) hasUV = true;
    if (n !== NONE) hasNormal = true;
    vertexOf[i] = welder.weld(cornerV.array[i], t, n, NONE);
  }
  const count = welder.count;
  if (count > limit.maxVertices)
    throw new LoaderError(F, 'limit', `${count} distinct corners exceed the vertex limit of ${limit.maxVertices}`);
  const keys = welder.keys.array,
    outPositions = new Float32Array(count * 3),
    outColors = anyColor ? new Float32Array(count * 3) : undefined,
    outUVs = hasUV ? new Float32Array(count * 2) : undefined,
    outNormals = hasNormal ? new Float32Array(count * 3) : undefined,
    positionIndices = new Uint32Array(count);
  for (let v = 0; v < count; v++) {
    const p = keys[v * 4],
      t = keys[v * 4 + 1],
      n = keys[v * 4 + 2];
    positionIndices[v] = p;
    for (let a = 0; a < 3; a++) {
      outPositions[v * 3 + a] = positions.array[p * 3 + a];
      if (outColors) outColors[v * 3 + a] = colors.array[p * 3 + a];
      if (outNormals && n !== NONE) outNormals[v * 3 + a] = normals.array[n * 3 + a];
    }
    if (outUVs && t !== NONE) {
      outUVs[v * 2] = uvs.array[t * 2];
      outUVs[v * 2 + 1] = 1 - uvs.array[t * 2 + 1];
    }
  }
  const indices = new Uint32Array(triangles * 3),
    sizes = result.faceSizes;
  for (let f = 0, c = 0, o = 0; f < sizes.length; c += sizes[f++])
    for (let k = 2; k < sizes[f]; k++) {
      indices[o++] = vertexOf[c];
      indices[o++] = vertexOf[c + k - 1];
      indices[o++] = vertexOf[c + k];
    }
  for (let g = 0; g < groups.length; g++)
    groups[g].count = (g + 1 < groups.length ? groups[g + 1].start : indices.length) - groups[g].start;
  const loaded: LoadedOBJ = { ...result, kind: 'mesh', positions: outPositions, indices, positionIndices };
  if (outNormals) loaded.normals = outNormals;
  if (outColors) loaded.colors = outColors;
  if (outUVs) loaded.uvs = outUVs;
  return loaded;
}

async function readMaterials(loaded: LoadedOBJ, resolve: AssetResolver, signal: AbortSignal | undefined) {
  const byName = new Map<string, MTLMaterial>();
  for (const library of loaded.materialLibraries) {
    let content: Uint8Array | string;
    try {
      content = await resolve(library);
    } catch (error) {
      throwIfAborted(signal, F);
      loaded.warnings.push(`mtllib "${library}" could not be read (${(error as Error)?.message ?? error})`);
      continue;
    }
    throwIfAborted(signal, F);
    for (const material of parseMTL(content, { path: library }))
      if (!byName.has(material.name)) byName.set(material.name, material);
  }
  loaded.materials = [...byName.values()];
  loaded.images = [...new Set(loaded.materials.flatMap((m) => Object.values(m.maps).map((map) => map.path)))];
  const missing = new Set<string>();
  for (const group of loaded.groups) {
    if (group.material === undefined) continue;
    const material = byName.get(group.material);
    if (material?.Kd) group.color = [...material.Kd, material.d ?? 1];
    else if (!material && !missing.has(group.material)) {
      missing.add(group.material);
      loaded.warnings.push(`usemtl "${group.material}" names no material in the MTL libraries`);
    }
  }
}

/**
 * Parses a Wavefront OBJ: `v` (with optional `w`, or `r g b` vertex colors after xyz), `vt`, `vn`, faces of any size
 * with `v`, `v/vt`, `v//vn`, `v/vt/vn` and negative (relative) indices, `o`, `g`, `s`, `usemtl` and `mtllib`, with
 * `\` line continuations, comments and CRLF. With `resolve` it also reads every MTL library and colors each group
 * with its material's `Kd`. Malformed input throws a `LoaderError` naming the line. A file without faces is a
 * point cloud of its `v` lines.
 */
export async function parseOBJ(input: BinaryInput | string, options: OBJParseOptions = {}): Promise<LoadedOBJ> {
  throwIfAborted(options.signal, F);
  if (options.resolve !== undefined && typeof options.resolve !== 'function')
    throw new TypeError('OBJ resolve option is not a function; pass (path) => Promise<Uint8Array | string>');
  const loaded = readOBJ(toText(input, F), limits(options, F));
  if (options.resolve && loaded.materialLibraries.length) await readMaterials(loaded, options.resolve, options.signal);
  return loaded;
}
