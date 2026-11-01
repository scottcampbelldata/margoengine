// VRML97 and X3D XML scenes: both encodings become one node tree, flattened to the package's common geometry.
import { LoaderError, type LoadedGeometry, type LoadedGroup, type ParseLimits } from './types.js';
import { type BinaryInput, floats, limits, toText, uints } from './util.js';
import { readXMLTree, type XMLElement } from './xml.js';

type Value = number[] | string[] | boolean | Node | Node[] | null;
interface Node {
  type: string;
  def?: string;
  fields: Record<string, Value>;
}

/** The result of {@link parseVRML} and {@link parseX3D}: all shapes in world space, one group per Shape. */
export interface VRMLScene extends LoadedGeometry {
  /** Node types the scene holds that were left out, each listed once: other geometry, PROTOs, Inlines, textures. */
  warnings: string[];
}

/** Options of {@link parseVRML} and {@link parseX3D}: the shared size limits and how many nodes a scene may visit. */
export interface VRMLOptions extends ParseLimits {
  /** Most nodes visited, counting each USE again. Default 1,000,000. */
  maxNodes?: number;
}

const MAX_DEPTH = 256;

/**
 * Parses a VRML97 (`#VRML V2.0 utf8`) world: Transform, Group, Shape, Appearance, Material, IndexedFaceSet and DEF/USE.
 * The transforms are baked in, polygons fan-triangulated, and v turned to Margo's convention (v = 0 at the image's top).
 *
 * @param input The file's bytes or text.
 * @param options Limits.
 * @returns A mesh with a group per Shape and what was left out.
 * @throws LoaderError with code `header`, `syntax`, `range`, `limit` or `unsupported`.
 *
 * @example
 * ```ts
 * import { parseVRML } from '@margoengine/loaders/vrml';
 *
 * const scene = parseVRML(`#VRML V2.0 utf8
 * Shape { geometry IndexedFaceSet { coord Coordinate { point [0 0 0, 1 0 0, 0 1 0] } coordIndex [0 1 2 -1] } }`);
 * console.log(scene.positions.length, scene.indices?.length);
 * ```
 */
export function parseVRML(input: BinaryInput | string, options: VRMLOptions = {}): VRMLScene {
  const F = 'VRML',
    text = toText(input, F);
  const header = /^#(VRML|X3D) V(\d)\.\d[^\n]*/.exec(text.replace(/^﻿/, ''));
  if (!header) throw new LoaderError(F, 'header', 'missing #VRML V2.0 utf8 line');
  if (header[1] !== 'VRML' || header[2] !== '2')
    throw new LoaderError(F, 'unsupported', `${header[0].slice(0, 32)} is not supported; pass a VRML97 file`);
  return flatten(readClassic(text, F), F, options);
}

/**
 * Parses an X3D XML scene with the same node set as {@link parseVRML}: children are found by their usual
 * `containerField`, and DEF and USE are attributes.
 *
 * @param input The file's bytes or text.
 * @param options Limits.
 * @returns A mesh with a group per Shape and what was left out.
 * @throws LoaderError with code `header`, `syntax`, `range` or `limit`.
 *
 * @example
 * ```ts
 * import { parseX3D } from '@margoengine/loaders/vrml';
 *
 * const scene = parseX3D(`<X3D><Scene><Shape><IndexedFaceSet coordIndex="0 1 2 -1">
 *   <Coordinate point="0 0 0 1 0 0 0 1 0"/></IndexedFaceSet></Shape></Scene></X3D>`);
 * console.log(scene.groups?.length);
 * ```
 */
export function parseX3D(input: BinaryInput | string, options: VRMLOptions = {}): VRMLScene {
  const F = 'X3D',
    root = readXMLTree(toText(input, F), F);
  const x3d = root.name === 'X3D' ? root : root.children.find((child) => child.name === 'X3D'),
    scene = x3d?.children.find((child) => child.name === 'Scene');
  if (!scene) throw new LoaderError(F, 'header', 'missing <X3D> and <Scene> elements');
  const defs = new Map<string, Node>();
  return flatten(
    scene.children.map((child) => fromXML(child, defs, F)),
    F,
    options,
  );
}

// VRML97 text: a token scanner and a grammar that needs no field types. Commas are white space.
function readClassic(text: string, F: string): Node[] {
  const scan = /(?:[\s,]+|#[^\n]*)*("(?:[^"\\]|\\[\s\S])*"|[[\]{}]|[^\s,"[\]{}#]+)/y;
  let peeked: string | null | undefined;
  const next = (): string | null => {
    if (peeked !== undefined) {
      const token = peeked;
      peeked = undefined;
      return token;
    }
    const from = scan.lastIndex,
      match = scan.exec(text);
    if (match) return match[1];
    if (
      text
        .slice(from)
        .replace(/#[^\n]*/g, '')
        .trim()
    )
      throw new LoaderError(F, 'syntax', 'a string is never closed; close its quote');
    return null;
  };
  const peek = (): string | null => {
    if (peeked === undefined) peeked = next();
    return peeked;
  };
  const need = (what: string): string => {
    const token = next();
    if (token === null) throw new LoaderError(F, 'syntax', `file ends where ${what} should be`);
    return token;
  };
  const defs = new Map<string, Node>();
  const isNumber = (token: string | null) => token !== null && /^[+-]?(\d|\.\d)/.test(token);
  const number = (token: string): number => {
    const value = Number(token);
    if (!Number.isFinite(value)) throw new LoaderError(F, 'syntax', `invalid number "${token.slice(0, 32)}"`);
    return value;
  };
  const skipBlock = (open: string, close: string) => {
    let depth = 0;
    do {
      const token = need(close);
      if (token === open) depth++;
      else if (token === close) depth--;
    } while (depth > 0);
  };
  const node = (depth: number): Node => {
    if (depth > MAX_DEPTH) throw new LoaderError(F, 'limit', `nodes nest deeper than ${MAX_DEPTH}`);
    let token = need('a node');
    if (token === 'USE') {
      const name = need('a USE name'),
        used = defs.get(name);
      if (!used) throw new LoaderError(F, 'syntax', `USE ${name.slice(0, 32)} has no DEF before it`);
      return used;
    }
    let def: string | undefined;
    if (token === 'DEF') {
      def = need('a DEF name');
      token = need('a node');
    }
    if (need('{') !== '{') throw new LoaderError(F, 'syntax', `expected { after ${token.slice(0, 32)}`);
    const result: Node = { type: token, def, fields: Object.create(null) };
    for (;;) {
      const name = need('a field or }');
      if (name === '}') break;
      if (name === 'ROUTE') {
        need('a route');
        need('TO');
        need('a route');
      } else if (name === 'PROTO' || name === 'EXTERNPROTO') {
        need('a name');
        skipBlock('[', ']');
        if (name === 'PROTO') skipBlock('{', '}');
        else if (peek() === '[') skipBlock('[', ']');
        else need('a URL');
      } else result.fields[name] = value(depth);
    }
    if (def !== undefined) defs.set(def, result);
    return result;
  };
  const value = (depth: number): Value => {
    const token = peek();
    if (token === null) throw new LoaderError(F, 'syntax', 'file ends where a field value should be');
    if (token === 'TRUE' || token === 'FALSE') {
      next();
      return token === 'TRUE';
    }
    if (token === 'NULL') {
      next();
      return null;
    }
    if (token[0] === '"') {
      next();
      return [token.slice(1, -1).replace(/\\([\s\S])/g, '$1')];
    }
    if (isNumber(token)) {
      const numbers: number[] = [];
      while (isNumber(peek())) numbers.push(number(next() as string));
      return numbers;
    }
    if (token === '[') {
      next();
      const after = peek();
      if (after === ']') {
        next();
        return [];
      }
      if (isNumber(after)) {
        const numbers: number[] = [];
        while (peek() !== ']') numbers.push(number(need(']')));
        next();
        return numbers;
      }
      if (after?.[0] === '"' || after === 'TRUE' || after === 'FALSE') {
        const strings: string[] = [];
        while (peek() !== ']') strings.push(need(']').replace(/^"|"$/g, ''));
        next();
        return strings;
      }
      const nodes: Node[] = [];
      while (peek() !== ']') nodes.push(node(depth + 1));
      next();
      return nodes;
    }
    return node(depth + 1);
  };
  const nodes: Node[] = [];
  for (let token = peek(); token !== null; token = peek()) {
    if (token === 'ROUTE') {
      next();
      need('a route');
      need('TO');
      need('a route');
    } else if (token === 'PROTO' || token === 'EXTERNPROTO') {
      next();
      need('a name');
      skipBlock('[', ']');
      if (token === 'PROTO') skipBlock('{', '}');
      else if (peek() === '[') skipBlock('[', ']');
      else need('a URL');
    } else nodes.push(node(0));
  }
  return nodes;
}

// X3D's default containerField per element; every other child goes to `children`.
const CONTAINER: Record<string, string> = {
  Appearance: 'appearance',
  Material: 'material',
  IndexedFaceSet: 'geometry',
  Coordinate: 'coord',
  Color: 'color',
  ColorRGBA: 'color',
  Normal: 'normal',
  TextureCoordinate: 'texCoord',
  ImageTexture: 'texture',
};

function fromXML(element: XMLElement, defs: Map<string, Node>, F: string): Node {
  const { USE: use, DEF: def } = element.attributes;
  if (use !== undefined) {
    const used = defs.get(use);
    if (!used) throw new LoaderError(F, 'syntax', `USE ${use.slice(0, 32)} has no DEF before it`);
    return used;
  }
  const result: Node = { type: element.name, def, fields: Object.create(null) };
  for (const [name, text] of Object.entries(element.attributes)) {
    if (name === 'DEF' || name === 'containerField') continue;
    const parts = text.split(/[\s,]+/).filter(Boolean);
    if (/^(true|false)$/i.test(text.trim())) result.fields[name] = /^true$/i.test(text.trim());
    else if (parts.length && parts.every((part) => /^[+-]?(\d|\.\d)/.test(part))) {
      const numbers = parts.map(Number);
      if (!numbers.every(Number.isFinite))
        throw new LoaderError(F, 'syntax', `invalid number in ${name}="${text.slice(0, 32)}"`);
      result.fields[name] = numbers;
    }
  }
  for (const child of element.children) {
    const container = child.attributes.containerField ?? CONTAINER[child.name] ?? 'children',
      item = fromXML(child, defs, F);
    if (container === 'children') ((result.fields.children ??= []) as Node[]).push(item);
    else result.fields[container] = item;
  }
  if (def !== undefined) defs.set(def, result);
  return result;
}

type Matrix = number[];
const IDENTITY: Matrix = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

function multiply(a: Matrix, b: Matrix): Matrix {
  const out = new Array<number>(16);
  for (let c = 0; c < 4; c++)
    for (let r = 0; r < 4; r++)
      out[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
  return out;
}

const translate = (x: number, y: number, z: number): Matrix => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1];

function rotate(r: readonly number[]): Matrix {
  const length = Math.hypot(r[0], r[1], r[2]);
  if (!length || !r[3]) return IDENTITY;
  const x = r[0] / length,
    y = r[1] / length,
    z = r[2] / length,
    c = Math.cos(r[3]),
    s = Math.sin(r[3]),
    t = 1 - c;
  return [
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
  ];
}

const numbers = (node: Node | null | undefined, field: string): number[] | undefined => {
  const value = node?.fields[field];
  return Array.isArray(value) && (value.length === 0 || typeof value[0] === 'number') ? (value as number[]) : undefined;
};
const child = (node: Node | null | undefined, field: string): Node | undefined => {
  const value = node?.fields[field];
  return value && !Array.isArray(value) && typeof value === 'object' ? value : undefined;
};
const flag = (node: Node, field: string, fallback: boolean): boolean => {
  const value = node.fields[field];
  return typeof value === 'boolean' ? value : fallback;
};

function flatten(roots: Node[], F: string, options: VRMLOptions): VRMLScene {
  const { maxVertices, maxTriangles } = limits(options, F),
    maxNodes = options.maxNodes ?? 1_000_000;
  if (!Number.isSafeInteger(maxNodes) || maxNodes < 0)
    throw new LoaderError(F, 'range', 'maxNodes must be a non-negative integer');
  const positions = floats(),
    normals = floats(),
    colors = floats(),
    uvs = floats(),
    indices = uints(),
    groups: LoadedGroup[] = [],
    warnings = new Set<string>();
  let visited = 0,
    allNormals = true,
    anyColor = false,
    anyUV = false;

  const shape = (node: Node, matrix: Matrix) => {
    const geometry = child(node, 'geometry');
    if (!geometry) return;
    if (geometry.type !== 'IndexedFaceSet') {
      warnings.add(geometry.type);
      return;
    }
    const material = child(child(node, 'appearance'), 'material'),
      texture = child(child(node, 'appearance'), 'texture');
    if (texture) warnings.add(texture.type);
    const point = numbers(child(geometry, 'coord'), 'point') ?? [],
      coordIndex = numbers(geometry, 'coordIndex') ?? [],
      normal = numbers(child(geometry, 'normal'), 'vector'),
      colorNode = child(geometry, 'color'),
      color = numbers(colorNode, 'color'),
      colorWidth = colorNode?.type === 'ColorRGBA' ? 4 : 3,
      texCoord = numbers(child(geometry, 'texCoord'), 'point');
    const pick = (field: string, perVertex: boolean) => {
      const own = numbers(geometry, field);
      return own?.length ? own : perVertex ? coordIndex : undefined;
    };
    const colorPerVertex = flag(geometry, 'colorPerVertex', true),
      normalPerVertex = flag(geometry, 'normalPerVertex', true),
      colorIndex = pick('colorIndex', colorPerVertex),
      normalIndex = pick('normalIndex', normalPerVertex),
      texIndex = pick('texCoordIndex', true) as number[];
    // Inverse transpose for normals: the upper 3 x 3's cofactors; only the direction matters.
    const m = matrix,
      inverse = [
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
      determinant = m[0] * inverse[0] + m[1] * inverse[1] + m[2] * inverse[2],
      keepWinding = flag(geometry, 'ccw', true) === determinant >= 0;
    const start = indices.length;
    let first = 0,
      face = 0;
    const read = (list: readonly number[], index: number, width: number, what: string, out: number[]) => {
      if (!Number.isInteger(index) || index < 0 || index * width + width > list.length)
        throw new LoaderError(F, 'range', `${what} index ${index} is outside the ${list.length / width} values`);
      out.length = 0;
      for (let k = 0; k < width; k++) out.push(list[index * width + k]);
      return out;
    };
    const scratch: number[] = [];
    for (let i = 0; i <= coordIndex.length; i++) {
      if (i < coordIndex.length && coordIndex[i] !== -1) continue;
      const corners = i - first;
      if (corners >= 3) {
        const base = positions.length / 3;
        if (base + corners > maxVertices)
          throw new LoaderError(F, 'limit', `vertex count exceeds the limit of ${maxVertices}`);
        if (indices.length / 3 + corners - 2 > maxTriangles)
          throw new LoaderError(F, 'limit', `triangle count exceeds the limit of ${maxTriangles}`);
        for (let c = 0; c < corners; c++) {
          const at = first + c,
            p = read(point, coordIndex[at], 3, 'coord', scratch);
          positions.push3(
            m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
            m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
            m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14],
          );
          if (normal?.length) {
            const n = read(
                normal,
                (normalIndex as number[])?.[normalPerVertex ? at : face] ?? face,
                3,
                'normal',
                scratch,
              ),
              x = inverse[0] * n[0] + inverse[3] * n[1] + inverse[6] * n[2],
              y = inverse[1] * n[0] + inverse[4] * n[1] + inverse[7] * n[2],
              z = inverse[2] * n[0] + inverse[5] * n[1] + inverse[8] * n[2],
              length = Math.hypot(x, y, z) * (determinant < 0 ? -1 : 1) || 1;
            normals.push3(x / length, y / length, z / length);
          } else allNormals = false;
          if (color?.length) {
            const rgb = read(color, colorIndex?.[colorPerVertex ? at : face] ?? face, colorWidth, 'color', scratch);
            colors.push3(rgb[0], rgb[1], rgb[2]);
            anyColor = true;
          } else {
            const diffuse = numbers(material, 'diffuseColor') ?? [1, 1, 1];
            colors.push3(diffuse[0], diffuse[1], diffuse[2]);
          }
          if (texCoord?.length) {
            const uv = read(texCoord, texIndex[at], 2, 'texCoord', scratch);
            uvs.push(uv[0]);
            uvs.push(1 - uv[1]);
            anyUV = true;
          } else {
            uvs.push(0);
            uvs.push(0);
          }
        }
        for (let c = 1; c < corners - 1; c++)
          if (keepWinding) indices.push3(base, base + c, base + c + 1);
          else indices.push3(base, base + c + 1, base + c);
      }
      first = i + 1;
      face++;
    }
    if (indices.length === start) return;
    const group: LoadedGroup = { start, count: indices.length - start };
    const name = node.def ?? geometry.def;
    if (name !== undefined) group.name = name;
    if (material) {
      const diffuse = numbers(material, 'diffuseColor') ?? [0.8, 0.8, 0.8],
        transparency = numbers(material, 'transparency')?.[0] ?? 0;
      group.color = [diffuse[0], diffuse[1], diffuse[2], 1 - transparency];
    }
    groups.push(group);
  };

  const walk = (node: Node, matrix: Matrix, depth: number) => {
    if (++visited > maxNodes) throw new LoaderError(F, 'limit', `node count exceeds the limit of ${maxNodes}`);
    if (depth > MAX_DEPTH) throw new LoaderError(F, 'limit', `nodes nest deeper than ${MAX_DEPTH}`);
    let world = matrix;
    switch (node.type) {
      case 'Shape':
        shape(node, matrix);
        return;
      case 'Transform': {
        const t = numbers(node, 'translation') ?? [0, 0, 0],
          c = numbers(node, 'center') ?? [0, 0, 0],
          r = numbers(node, 'rotation') ?? [0, 0, 1, 0],
          s = numbers(node, 'scale') ?? [1, 1, 1],
          o = numbers(node, 'scaleOrientation') ?? [0, 0, 1, 0];
        // VRML97 6.52: T * C * R * SR * S * -SR * -C.
        const scale: Matrix = [s[0], 0, 0, 0, 0, s[1], 0, 0, 0, 0, s[2], 0, 0, 0, 0, 1];
        for (const part of [
          translate(t[0], t[1], t[2]),
          translate(c[0], c[1], c[2]),
          rotate(r),
          rotate(o),
          scale,
          rotate([o[0], o[1], o[2], -o[3]]),
          translate(-c[0], -c[1], -c[2]),
        ])
          world = multiply(world, part);
        break;
      }
      case 'Group':
      case 'Anchor':
      case 'Collision':
      case 'Billboard':
      case 'StaticGroup':
        break;
      default:
        warnings.add(node.type);
        return;
    }
    const children = node.fields.children;
    if (Array.isArray(children)) for (const item of children as Node[]) walk(item, world, depth + 1);
    else if (children && typeof children === 'object') walk(children, world, depth + 1);
  };
  for (const root of roots) walk(root, IDENTITY, 0);

  const count = positions.length / 3,
    trim = (list: ReturnType<typeof floats>) => list.array.slice(0, list.length);
  return {
    kind: 'mesh',
    positions: trim(positions),
    ...(allNormals && count ? { normals: trim(normals) } : {}),
    ...(anyColor ? { colors: trim(colors) } : {}),
    ...(anyUV ? { uvs: trim(uvs) } : {}),
    indices: indices.array.slice(0, indices.length),
    groups,
    warnings: [...warnings],
  };
}
