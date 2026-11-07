// LDraw models: line types 0 to 5, colour codes, sub-file references, MPD packs and BFC winding.
import { LoaderError, type AssetResolver, type LoadedGeometry, type LoadedGroup, type ParseLimits } from './types.js';
import { floats, limits, resolvePath, throwIfAborted, toText, uints, type BinaryInput, type Growable } from './util.js';

const F = 'LDraw';
/** Metres per LDraw unit. */
const LDU = 0.0004;
const MAIN = 16;
const EDGE = 24;
const DEFAULT_PATHS = ['', 'parts/', 'p/', 'models/', 'unofficial/parts/', 'unofficial/p/'];
const CONFIG_FILE = 'ldconfig.ldr';

/** One colour of {@link LDrawModel.palette}. Colours are sRGB in [0,1]. */
export interface LDrawColor {
  code: number;
  name: string;
  /** `[r, g, b, a]`. */
  color: [number, number, number, number];
  /** `[r, g, b]` of the edge lines drawn in this colour's complement. */
  edge: [number, number, number];
}

/** Options of {@link parseLDraw}. */
export interface LDrawOptions extends ParseLimits {
  /** Reads a part, by its path below the library folder; {@link resolveFromURL} makes one for a hosted library. Without it, only the file's own contents load. */
  resolve?: AssetResolver;
  /** Folders tried in order for each reference, ending in `/`. Default `''`, `parts/`, `p/`, `models/` and the `unofficial/` two. */
  searchPaths?: readonly string[];
  /** The text of `LDConfig.ldr`. Default: read through `resolve`, else the 16 classic colours. */
  config?: string;
  /** `'meters'` (default) scales by 0.4 mm per unit and turns the model Y up; `'file'` keeps LDraw units, -Y up. */
  units?: 'meters' | 'file';
  /** Colour code of the model's main colour 16. Default 7, light grey. */
  color?: number;
  /** Keep edge and conditional lines. Default true. */
  edges?: boolean;
  /** Sub-file nesting limit. Default 64. */
  maxDepth?: number;
  /** Most sub-file references expanded in the model. Default 4,000,000. */
  maxInstances?: number;
  /**
   * Keeps each placed `.dat` part as one geometry with a matrix per placement, in `instances`, so a model of many alike
   * bricks costs each brick once. What is not a placed part stays in the main mesh, and so do mirrored placements. Default
   * false: everything expands into the main mesh.
   */
  instanced?: boolean;
  signal?: AbortSignal;
}

/** One `.dat` part in one colour, placed one or more times: from `instanced`. */
export interface LDrawInstances {
  /** The part's file, as the model names it. */
  file: string;
  /** The colour code the part took from its reference. */
  code: number;
  /** The part in its own LDraw units, with a group per colour, as the main mesh has them. */
  positions: Float32Array;
  indices: Uint32Array;
  groups: LoadedGroup[];
  /** Edge and conditional lines in the part's own units, as on {@link LDrawModel}. */
  lines: Float32Array;
  lineColors: Float32Array;
  conditionalLines: Float32Array;
  /** A column-major 4x4 per placement: part units to the model's units and axes. */
  matrices: Float32Array;
}

/** What {@link parseLDraw} returns: one triangle mesh with a group per colour, plus the model's lines. */
export interface LDrawModel extends LoadedGeometry {
  kind: 'mesh';
  groups: LoadedGroup[];
  /** Two xyz points per edge line: `mode: 'segments'` of `@margoengine/lines`. */
  lines: Float32Array;
  /** rgb per point of `lines`. */
  lineColors: Float32Array;
  /** Four xyz points per conditional line: its two ends, then its two control points. */
  conditionalLines: Float32Array;
  /** With `instanced`: the placed parts, which the main mesh and lines then leave out. Otherwise empty. */
  instances: LDrawInstances[];
  /** The colours the model uses. */
  palette: LDrawColor[];
  /** The first title comment of the main file, when it has one. */
  name?: string;
  /** References that no search path could read, each listed once. */
  missing: string[];
  /** Things the parser moved past, each listed once. */
  warnings: string[];
}

type Matrix = readonly number[];
const IDENTITY: Matrix = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];

interface Reference {
  kind: 1;
  code: number;
  matrix: Matrix;
  file: string;
  invert: boolean;
}
interface Shape {
  kind: 2 | 3 | 4 | 5;
  code: number;
  points: number[];
  /** Reverse the winding. */
  reverse: boolean;
  /** Seen from both sides: no certified winding applies. */
  both: boolean;
}
interface Part {
  commands: (Reference | Shape)[];
  title?: string;
}

const key = (name: string): string => name.trim().replaceAll('\\', '/').toLowerCase();

function hex(value: string): [number, number, number] | undefined {
  const match = /^(?:#|0x)([0-9a-f]{6})$/i.exec(value);
  if (!match) return undefined;
  const number = Number.parseInt(match[1], 16);
  return [(number >> 16) / 255, ((number >> 8) & 255) / 255, (number & 255) / 255];
}

const classic = (code: number, name: string, value: string, edge = '#333333'): LDrawColor => ({
  code,
  name,
  color: [...hex(value)!, 1],
  edge: hex(edge)!,
});

function classicPalette(): Map<number, LDrawColor> {
  const list = [
    classic(0, 'Black', '#05131D', '#595959'),
    classic(1, 'Blue', '#0055BF'),
    classic(2, 'Green', '#257A3E'),
    classic(3, 'Dark_Turquoise', '#00838F'),
    classic(4, 'Red', '#C91A09'),
    classic(5, 'Dark_Pink', '#C870A0'),
    classic(6, 'Brown', '#583927'),
    classic(7, 'Light_Grey', '#9BA19D'),
    classic(8, 'Dark_Grey', '#6D6E5C'),
    classic(9, 'Light_Blue', '#B4D2E3'),
    classic(10, 'Bright_Green', '#4B9F4A'),
    classic(11, 'Light_Turquoise', '#55A5AF'),
    classic(12, 'Salmon', '#F2705E'),
    classic(13, 'Pink', '#FC97AC'),
    classic(14, 'Yellow', '#F2CD37'),
    classic(15, 'White', '#FFFFFF'),
  ];
  return new Map(list.map((entry) => [entry.code, entry]));
}

/** Reads a `0 !COLOUR` line into the palette; a line without a code or value is a syntax error. */
function readColour(words: string[], palette: Map<number, LDrawColor>): void {
  const after = (word: string): string | undefined => {
    const at = words.indexOf(word);
    return at < 0 ? undefined : words[at + 1];
  };
  const code = Number(after('CODE')),
    value = hex(after('VALUE') ?? ''),
    edgeWord = after('EDGE') ?? '',
    alpha = after('ALPHA');
  if (!Number.isSafeInteger(code) || !value) throw new LoaderError(F, 'syntax', `bad colour line for "${words[2]}"`);
  const edge = hex(edgeWord) ?? palette.get(Number(edgeWord))?.color.slice(0, 3);
  palette.set(code, {
    code,
    name: words[2],
    color: [...value, alpha === undefined ? 1 : Number(alpha) / 255],
    edge: (edge as [number, number, number] | undefined) ?? [0.2, 0.2, 0.2],
  });
}

function numbers(words: string[], from: number, count: number, line: number, name: string): number[] {
  if (words.length < from + count)
    throw new LoaderError(F, 'syntax', `line ${line} of ${name.slice(0, 64)} has too few fields`);
  const out = new Array<number>(count);
  for (let i = 0; i < count; i++) {
    const value = Number(words[from + i]);
    if (!Number.isFinite(value))
      throw new LoaderError(F, 'syntax', `line ${line} of ${name.slice(0, 64)} has a bad number`);
    out[i] = value;
  }
  return out;
}

function colourCode(word: string, line: number, name: string): number {
  const value = Number(word);
  if (!Number.isSafeInteger(value) || value < 0)
    throw new LoaderError(F, 'syntax', `line ${line} of ${name.slice(0, 64)} has a bad colour`);
  return value;
}

/** Splits a file into its MPD sub-files; the first is the main one, under `name`. */
function readFile(
  text: string,
  name: string,
  parts: Map<string, Part>,
  palette: Map<number, LDrawColor>,
  warn: (message: string) => void,
): string {
  let current: Part | undefined,
    currentName = name,
    main: string | undefined,
    certified = false,
    clockwise = false,
    clip = true,
    invertNext = false,
    skipping = false,
    lineNumber = 0;
  const open = (fileName: string): void => {
    currentName = fileName;
    current = { commands: [] };
    certified = clockwise = invertNext = skipping = false;
    clip = true;
    const id = key(fileName);
    if (!parts.has(id)) parts.set(id, current);
    main ??= id;
  };
  for (let start = 0; start < text.length; ) {
    let end = text.indexOf('\n', start);
    if (end < 0) end = text.length;
    const line = text.slice(start, end).trim();
    start = end + 1;
    lineNumber++;
    if (!line) continue;
    const words = line.split(/\s+/);
    if (words[0] === '0') {
      const word = words[1] ?? '';
      if (word === 'FILE') {
        open(words.slice(2).join(' '));
        continue;
      }
      if (word === 'NOFILE') {
        skipping = true;
        continue;
      }
      if (word === '!DATA') {
        skipping = true;
        continue;
      }
      if (skipping) continue;
      if (!current) open(name);
      if (word === '!COLOUR') readColour(words, palette);
      else if (word === '!TEXMAP' || word === '!:') warn('texture maps are not read');
      else if (word === 'BFC') {
        for (const option of words.slice(2))
          if (option === 'CERTIFY') certified = true;
          else if (option === 'NOCERTIFY') certified = false;
          else if (option === 'CW') clockwise = true;
          else if (option === 'CCW') clockwise = false;
          else if (option === 'CLIP') clip = true;
          else if (option === 'NOCLIP') clip = false;
          else if (option === 'INVERTNEXT') invertNext = true;
      } else if (current!.title === undefined && word && !word.startsWith('!') && !/^(Name|Author):?$/.test(word))
        current!.title = words.slice(1).join(' ');
      continue;
    }
    if (skipping) continue;
    if (!current) open(name);
    const type = Number(words[0]);
    if (type === 1) {
      const [x, y, z, a, b, c, d, e, f, g, h, i] = numbers(words, 2, 12, lineNumber, currentName),
        file = words.slice(14).join(' ');
      if (!file) throw new LoaderError(F, 'syntax', `line ${lineNumber} of ${currentName.slice(0, 64)} names no file`);
      current!.commands.push({
        kind: 1,
        code: colourCode(words[1], lineNumber, currentName),
        matrix: [a, b, c, d, e, f, g, h, i, x, y, z],
        file,
        invert: invertNext,
      });
      invertNext = false;
    } else if (type === 2 || type === 3 || type === 4 || type === 5) {
      const count = type === 2 ? 6 : type === 3 ? 9 : 12;
      current!.commands.push({
        kind: type,
        code: colourCode(words[1], lineNumber, currentName),
        points: numbers(words, 2, count, lineNumber, currentName),
        reverse: clockwise,
        both: !certified || !clip,
      });
    } else warn(`line type ${words[0].slice(0, 16)} is not part of LDraw`);
  }
  if (!main) open(name);
  return main!;
}

const determinant = (m: Matrix): number =>
  m[0] * (m[4] * m[8] - m[5] * m[7]) - m[1] * (m[3] * m[8] - m[5] * m[6]) + m[2] * (m[3] * m[7] - m[4] * m[6]);

/** Applies `child` first, then `parent`. Rows are `a b c`, `d e f`, `g h i`, then the translation. */
function multiply(parent: Matrix, child: Matrix): Matrix {
  const out = new Array<number>(12);
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++)
      out[r * 3 + c] =
        parent[r * 3] * child[c] + parent[r * 3 + 1] * child[3 + c] + parent[r * 3 + 2] * child[6 + c];
    out[9 + r] =
      parent[r * 3] * child[9] + parent[r * 3 + 1] * child[10] + parent[r * 3 + 2] * child[11] + parent[9 + r];
  }
  return out;
}

/** Options of {@link resolveFromURL}. */
export interface LDrawURLOptions {
  /** Fetch used for each part. Default `globalThis.fetch`. */
  fetch?: typeof fetch;
  /** Cancels the reads in flight. Pass the one you give `parseLDraw`. */
  signal?: AbortSignal;
}

/**
 * A `resolve` for {@link parseLDraw} that reads parts over HTTP from an LDraw library folder you host. The library is
 * the "Complete" download of ldraw.org, unzipped: `LDConfig.ldr`, `parts/` and `p/` directly below `base`.
 * A status other than 2xx rejects, so `parseLDraw` tries the next search path and lists a part found nowhere in `missing`.
 *
 * @param base The library folder, absolute or relative to the page.
 * @example
 * ```ts
 * import { parseLDraw, resolveFromURL } from '@margoengine/loaders/ldraw';
 *
 * const text = await (await fetch('/models/car.ldr')).text();
 * const model = await parseLDraw(text, { resolve: resolveFromURL('/ldraw/') });
 * console.log(model.missing);
 * ```
 */
export function resolveFromURL(
  base: string | URL,
  { fetch: get = globalThis.fetch, signal }: LDrawURLOptions = {},
): AssetResolver {
  const folder = new URL(String(base).replace(/\/*$/, '/'), globalThis.location?.href);
  return async (path) => {
    const response = await get(new URL(path, folder), { signal });
    if (!response.ok) throw new LoaderError(F, 'unsupported', `${path}: HTTP ${response.status}`);
    return new Uint8Array(await response.arrayBuffer());
  };
}

/**
 * Reads an LDraw model (`.ldr`, `.dat` or a multi-part `.mpd`). Sub-file references load through `resolve` and are
 * expanded into one mesh, with a group per colour. Colour 16 takes the parent's colour and 24 its edge colour, `0x2RRGGBB`
 * is a direct colour, and `0 !COLOUR` lines and `LDConfig.ldr` fill the palette. Certified BFC files keep their winding;
 * polygons of an uncertified file are written on both sides, so they draw with back faces culled.
 *
 * @param input The file's bytes or text.
 * @param options The resolver, search paths, units, limits and an AbortSignal.
 * @returns The mesh, its edge and conditional lines, the colours used and any references that could not be read.
 * @throws LoaderError with code `syntax`, `limit`, `range` or `aborted`. A missing part is listed in `missing`, not thrown.
 *
 * @example
 * ```ts
 * import { parseLDraw } from '@margoengine/loaders/ldraw';
 *
 * const model = await parseLDraw('0 BFC CERTIFY CCW\n3 4 0 0 0 10 0 0 0 0 10\n2 24 0 0 0 10 0 0\n');
 * console.log(model.groups[0].color, model.lines.length, model.missing);
 * ```
 */
export async function parseLDraw(input: BinaryInput | string, options: LDrawOptions = {}): Promise<LDrawModel> {
  const text = toText(input, F),
    { maxVertices, maxTriangles } = limits(options, F),
    { resolve, signal } = options,
    maxDepth = options.maxDepth ?? 64,
    maxInstances = options.maxInstances ?? 4_000_000,
    searchPaths = options.searchPaths ?? DEFAULT_PATHS,
    edges = options.edges ?? true,
    instanced = options.instanced ?? false,
    mainColor = options.color ?? 7;
  throwIfAborted(signal, F);
  if (!Number.isSafeInteger(maxDepth) || maxDepth < 0)
    throw new LoaderError(F, 'range', 'maxDepth must be a non-negative integer');
  if (!Number.isSafeInteger(maxInstances) || maxInstances < 0)
    throw new LoaderError(F, 'range', 'maxInstances must be a non-negative integer');
  if (options.units !== undefined && options.units !== 'meters' && options.units !== 'file')
    throw new LoaderError(F, 'range', 'units must be "meters" or "file"');
  // These two mean "the colour above", and the model's main colour has nothing above it.
  if (mainColor === MAIN || mainColor === EDGE) throw new LoaderError(F, 'range', 'color must be a real colour code');

  const warnings = new Set<string>(),
    warn = (message: string): void => void warnings.add(message),
    palette = classicPalette(),
    parts = new Map<string, Part>(),
    missing = new Set<string>();
  const read = async (path: string): Promise<string | undefined> => {
    if (!resolve) return undefined;
    let content: Uint8Array | string;
    try {
      content = await resolve(path);
    } catch {
      throwIfAborted(signal, F);
      return undefined; // Not at this path: the next search path may have it, and `missing` reports it if none does.
    }
    return toText(content, F);
  };
  if (options.config !== undefined) readFile(options.config, CONFIG_FILE, new Map(), palette, warn);
  else if (resolve)
    for (const folder of ['', 'ldraw/']) {
      const config = (await read(`${folder}LDConfig.ldr`)) ?? undefined;
      if (config !== undefined) {
        readFile(config, CONFIG_FILE, new Map(), palette, warn);
        break;
      }
    }
  const main = readFile(text, 'model.ldr', parts, palette, warn);

  // Load every reference, one level of the tree at a time, so the walk below is synchronous.
  const tried = new Set<string>();
  for (let wanted = references(parts, tried); wanted.length; wanted = references(parts, tried)) {
    throwIfAborted(signal, F);
    for (const file of wanted) {
      tried.add(key(file));
      let found: string | undefined;
      for (const folder of searchPaths) {
        found = await read(resolvePath('', `${folder}${key(file)}`));
        throwIfAborted(signal, F);
        if (found !== undefined) break;
      }
      if (found === undefined) missing.add(key(file));
      else readFile(found, file, parts, palette, warn);
    }
  }

  /** Where geometry goes: the main mesh, or a placed part's own. */
  const sink = () => ({
      positions: floats(),
      lines: floats(),
      lineColors: floats(),
      conditional: floats(),
      buckets: new Map<number, Growable<Uint32Array>>(),
      triangles: 0,
    }),
    whole = sink(),
    placed = new Map<string, { file: string; code: number; into: ReturnType<typeof sink>; matrices: number[] }>(),
    used = new Map<number, LDrawColor>(),
    visiting = new Set<Part>();
  let out = whole;
  let triangles = 0,
    instances = 0;

  const color = (code: number, parent: number): LDrawColor => {
    if (code === MAIN) return color(parent, mainColor);
    if (code === EDGE) {
      const owner = color(parent, mainColor);
      return { code: EDGE, name: 'Edge', color: [...owner.edge, 1], edge: owner.edge };
    }
    const known = palette.get(code);
    if (known) return known;
    if (code >= 0x2000000 && code <= 0x2ffffff) {
      const direct: LDrawColor = {
        code,
        name: `#${(code & 0xffffff).toString(16).padStart(6, '0')}`,
        color: [((code >> 16) & 255) / 255, ((code >> 8) & 255) / 255, (code & 255) / 255, 1],
        edge: [0.2, 0.2, 0.2],
      };
      palette.set(code, direct);
      return direct;
    }
    warn(`colour ${code} is not in the palette; it draws as light grey`);
    return palette.get(7)!;
  };
  const point = (to: Growable<Float32Array>, m: Matrix, p: number[], at: number): void =>
    to.push3(
      m[0] * p[at] + m[1] * p[at + 1] + m[2] * p[at + 2] + m[9],
      m[3] * p[at] + m[4] * p[at + 1] + m[5] * p[at + 2] + m[10],
      m[6] * p[at] + m[7] * p[at + 1] + m[8] * p[at + 2] + m[11],
    );
  const polygon = (shape: Shape, m: Matrix, inverted: boolean, parent: number): void => {
    const entry = color(shape.code, parent),
      corners = shape.kind === 3 ? 3 : 4,
      base = out.positions.length / 3,
      count = (corners - 2) * (shape.both ? 2 : 1);
    if (base + corners > maxVertices)
      throw new LoaderError(F, 'limit', `vertex count exceeds the limit of ${maxVertices}`);
    out.triangles += count;
    triangles += count;
    if (triangles > maxTriangles) throw new LoaderError(F, 'limit', `triangle count exceeds the limit of ${maxTriangles}`);
    for (let c = 0; c < corners; c++) point(out.positions, m, shape.points, c * 3);
    let bucket = out.buckets.get(entry.code);
    if (!bucket) out.buckets.set(entry.code, (bucket = uints()));
    used.set(entry.code, entry);
    const flip = shape.reverse !== inverted;
    for (let c = 1; c + 1 < corners; c++) {
      if (shape.both || !flip) bucket.push3(base, base + c, base + c + 1);
      if (shape.both || flip) bucket.push3(base, base + c + 1, base + c);
    }
  };
  const line = (shape: Shape, m: Matrix, parent: number): void => {
    const { lines, lineColors, conditional } = out;
    if (shape.kind === 5) {
      if ((conditional.length + lines.length) / 3 + 4 > maxVertices)
        throw new LoaderError(F, 'limit', `vertex count exceeds the limit of ${maxVertices}`);
      for (let c = 0; c < 4; c++) point(conditional, m, shape.points, c * 3);
      return;
    }
    if ((conditional.length + lines.length) / 3 + 2 > maxVertices)
      throw new LoaderError(F, 'limit', `vertex count exceeds the limit of ${maxVertices}`);
    const [r, g, b] = color(shape.code, parent).color;
    point(lines, m, shape.points, 0);
    point(lines, m, shape.points, 3);
    lineColors.push3(r, g, b);
    lineColors.push3(r, g, b);
  };
  const walk = (part: Part, m: Matrix, inverted: boolean, parent: number, depth: number): void => {
    if (depth > maxDepth) throw new LoaderError(F, 'limit', `sub-files nest deeper than ${maxDepth}`);
    if (visiting.has(part)) throw new LoaderError(F, 'syntax', 'a sub-file refers to itself');
    visiting.add(part);
    for (const command of part.commands) {
      if (command.kind === 1) {
        const child = parts.get(key(command.file));
        if (!child) continue;
        if (++instances > maxInstances)
          throw new LoaderError(F, 'limit', `the model expands to more than ${maxInstances} sub-file references`);
        const flips = determinant(command.matrix) < 0,
          next = multiply(m, command.matrix),
          turned = inverted !== flips !== command.invert,
          code = command.code === MAIN ? parent : command.code === EDGE ? color(EDGE, parent).code : command.code;
        // A mirrored placement stays in the main mesh: a renderer's winding would not follow a mirrored matrix.
        if (instanced && out === whole && key(command.file).endsWith('.dat') && determinant(next) > 0) {
          const id = `${key(command.file)}|${code}|${turned}`;
          let place = placed.get(id);
          if (!place) {
            place = { file: command.file, code, into: sink(), matrices: [] };
            placed.set(id, place);
            out = place.into;
            walk(child, IDENTITY, turned, code, depth + 1);
            out = whole;
          }
          place.matrices.push(
            next[0], next[3], next[6], 0,
            next[1], next[4], next[7], 0,
            next[2], next[5], next[8], 0,
            next[9], next[10], next[11], 1,
          );
        } else walk(child, next, turned, code, depth + 1);
      } else if (command.kind === 3 || command.kind === 4) polygon(command, m, inverted, parent);
      else if (edges) line(command, m, parent);
    }
    visiting.delete(part);
  };
  const root: Matrix = options.units === 'file' ? IDENTITY : [LDU, 0, 0, 0, -LDU, 0, 0, 0, -LDU, 0, 0, 0];
  walk(parts.get(main)!, root, false, mainColor, 0);

  const finish = (from: ReturnType<typeof sink>) => {
    const indices = new Uint32Array(from.triangles * 3),
      groups: LoadedGroup[] = [];
    let start = 0;
    for (const [code, bucket] of from.buckets) {
      const entry = used.get(code)!;
      indices.set(bucket.array.subarray(0, bucket.length), start);
      groups.push({
        start,
        count: bucket.length,
        name: entry.name,
        objectId: String(code),
        color: [...entry.color],
      });
      start += bucket.length;
    }
    return {
      positions: from.positions.result(),
      indices,
      groups,
      lines: from.lines.result(),
      lineColors: from.lineColors.result(),
      conditionalLines: from.conditional.result(),
    };
  };
  const model: LDrawModel = {
    kind: 'mesh',
    ...finish(whole),
    instances: [...placed.values()].map(({ file, code, into, matrices }) => ({
      file,
      code,
      ...finish(into),
      matrices: new Float32Array(matrices),
    })),
    palette: [...used.values()],
    missing: [...missing],
    warnings: [...warnings],
  };
  const title = parts.get(main)!.title;
  if (title !== undefined) model.name = title;
  return model;
}

/** The referenced files that are neither loaded nor tried yet. */
function references(parts: Map<string, Part>, tried: Set<string>): string[] {
  const wanted = new Map<string, string>();
  for (const part of parts.values())
    for (const command of part.commands)
      if (command.kind === 1) {
        const id = key(command.file);
        if (!parts.has(id) && !tried.has(id)) wanted.set(id, command.file);
      }
  return [...wanted.values()];
}
