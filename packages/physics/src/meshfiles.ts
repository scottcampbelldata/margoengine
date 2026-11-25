// Mesh files straight to colliders: binary and ASCII STL, Wavefront OBJ and Collada (DAE), read from the public format descriptions (STL's
// 80 byte header, a count and 50 bytes a triangle, or `facet`/`vertex` text; OBJ's `v` and `f` lines; Collada 1.4's `geometry`, `source`,
// `triangles` and `polylist` elements and its node `matrix`). It runs off the step path, so it may use `Math`.
import type { ColliderOptions } from './shapes.js';
import { child, multiply, numbers, parseXml, type XmlNode } from './xml.js';

/** A triangle mesh read from a file: `vertices` as x, y, z and `indices` three to a triangle. */
export interface MeshFile {
  vertices: Float32Array;
  indices: Uint32Array;
}

/** Which collider to make of a file's mesh. */
export type MeshFileShape = 'trimesh' | 'convexHull';

const text = (input: ArrayBuffer | Uint8Array | string): string =>
  typeof input === 'string'
    ? input
    : new TextDecoder().decode(input instanceof Uint8Array ? input : new Uint8Array(input));

/** Welds triangle corners that sit at the same point, so a closed surface shares its vertices and a trimesh knows its neighbours. */
function weld(corners: number[]): MeshFile {
  const seen = new Map<string, number>(),
    vertices: number[] = [],
    indices: number[] = [];
  for (let i = 0; i < corners.length; i += 3) {
    const key = `${corners[i]},${corners[i + 1]},${corners[i + 2]}`;
    let at = seen.get(key);
    if (at === undefined) {
      at = vertices.length / 3;
      seen.set(key, at);
      vertices.push(corners[i]!, corners[i + 1]!, corners[i + 2]!);
    }
    indices.push(at);
  }
  return { vertices: new Float32Array(vertices), indices: new Uint32Array(indices) };
}

/**
 * Reads an STL file, binary or ASCII, into a welded triangle mesh.
 * @throws RangeError for a file that is neither, or that holds no triangle.
 */
export function parseSTL(input: ArrayBuffer | Uint8Array | string): MeshFile {
  const corners: number[] = [];
  if (typeof input !== 'string') {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    if (bytes.length >= 84) {
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
        count = view.getUint32(80, true);
      if (84 + count * 50 === bytes.length) {
        for (let t = 0; t < count; t++)
          for (let v = 0; v < 3; v++)
            for (let c = 0; c < 3; c++) corners.push(view.getFloat32(84 + t * 50 + 12 + v * 12 + c * 4, true));
        return finish(corners, 'STL');
      }
    }
  }
  for (const line of text(input).split(/\r?\n/)) {
    const part = line.trim().split(/\s+/);
    if (part[0]?.toLowerCase() === 'vertex' && part.length >= 4)
      corners.push(Number(part[1]), Number(part[2]), Number(part[3]));
  }
  return finish(corners, 'STL');
}

/**
 * Reads a Wavefront OBJ file into a triangle mesh: `v` lines are vertices, `f` lines faces of any size (fanned from their first corner),
 * with 1-based or negative (from the end) indices and `v/vt/vn` corners; everything else is ignored.
 * @throws RangeError for a face that names a vertex the file does not have, or a file with no triangle.
 */
export function parseOBJ(input: ArrayBuffer | Uint8Array | string): MeshFile {
  const vertices: number[] = [],
    indices: number[] = [];
  for (const line of text(input).split(/\r?\n/)) {
    const part = line.trim().split(/\s+/);
    if (part[0] === 'v') vertices.push(Number(part[1]), Number(part[2]), Number(part[3]));
    else if (part[0] === 'f') {
      const face = part.slice(1).map((corner) => {
        const n = Number.parseInt(corner.split('/')[0]!, 10),
          have = vertices.length / 3,
          at = n < 0 ? have + n : n - 1;
        if (!(at >= 0 && at < have))
          throw new RangeError(`An OBJ face names vertex ${n}, which the file does not have; fix the face line.`);
        return at;
      });
      for (let k = 1; k + 1 < face.length; k++) indices.push(face[0]!, face[k]!, face[k + 1]!);
    }
  }
  if (!indices.length || !vertices.every(Number.isFinite))
    throw new RangeError('The OBJ file holds no triangle with finite vertices; pass a file with `v` and `f` lines.');
  return { vertices: new Float32Array(vertices), indices: new Uint32Array(indices) };
}

/**
 * Reads a Collada (DAE 1.4) file into a triangle mesh: every `geometry` a `visual_scene` node instances, its `triangles`, `polylist`
 * and `polygons` (faces of any size fanned from their first corner), placed by the node's `matrix`, `translate`, `rotate` and `scale`
 * (nested nodes multiply), scaled by the file's `unit` to metres and turned to Y up from its `up_axis`. A geometry no node instances is
 * read as it lies. Textures, materials, skins and animations are ignored.
 * @throws RangeError for a file that is not Collada, an index the file does not have, or a file with no triangle.
 */
export function parseDAE(input: ArrayBuffer | Uint8Array | string): MeshFile {
  const tree = parseXml(text(input)),
    collada = child(tree, 'COLLADA');
  if (!collada) throw new RangeError('This is not a Collada file: it has no COLLADA element; pass a .dae file.');
  const scale =
      Number(
        child(child(collada, 'asset') ?? { name: '', attrs: {}, children: [], text: '' }, 'unit')?.attrs.meter ?? 1,
      ) || 1,
    up =
      child(child(collada, 'asset') ?? { name: '', attrs: {}, children: [], text: '' }, 'up_axis')?.text.trim() ??
      'Y_UP',
    geometries = new Map<string, XmlNode>();
  for (const library of collada.children.filter((c) => c.name === 'library_geometries'))
    for (const g of library.children.filter((c) => c.name === 'geometry')) geometries.set(g.attrs.id ?? '', g);
  const corners: number[] = [],
    placed = new Set<string>();
  const addGeometry = (g: XmlNode, matrix: number[]): void => {
    const mesh = child(g, 'mesh');
    if (!mesh) return;
    const sources = new Map<string, { data: number[]; stride: number }>();
    for (const source of mesh.children.filter((c) => c.name === 'source')) {
      const array = child(source, 'float_array'),
        accessor = child(child(source, 'technique_common') ?? source, 'accessor');
      if (array)
        sources.set(source.attrs.id ?? '', { data: numbers(array.text), stride: Number(accessor?.attrs.stride ?? 3) });
    }
    const vertexInput = new Map<string, string>();
    for (const v of mesh.children.filter((c) => c.name === 'vertices')) {
      const position = v.children.find((c) => c.name === 'input' && c.attrs.semantic === 'POSITION');
      if (position) vertexInput.set(v.attrs.id ?? '', (position.attrs.source ?? '').slice(1));
    }
    for (const prim of mesh.children.filter(
      (c) => c.name === 'triangles' || c.name === 'polylist' || c.name === 'polygons',
    )) {
      const inputs = prim.children.filter((c) => c.name === 'input'),
        stride = Math.max(...inputs.map((i) => Number(i.attrs.offset ?? 0))) + 1,
        vertex = inputs.find((i) => i.attrs.semantic === 'VERTEX'),
        offset = Number(vertex?.attrs.offset ?? 0),
        id = (vertex?.attrs.source ?? '').slice(1),
        source = sources.get(vertexInput.get(id) ?? id);
      if (!vertex || !source) continue;
      const corner = (index: number): void => {
        if (!(index >= 0 && (index + 1) * source.stride <= source.data.length))
          throw new RangeError(`A Collada face names vertex ${index}, which the file does not have; fix the face.`);
        const [x, y, z] = [
          source.data[index * source.stride]!,
          source.data[index * source.stride + 1]!,
          source.data[index * source.stride + 2]!,
        ];
        corners.push(
          matrix[0]! * x + matrix[1]! * y + matrix[2]! * z + matrix[3]!,
          matrix[4]! * x + matrix[5]! * y + matrix[6]! * z + matrix[7]!,
          matrix[8]! * x + matrix[9]! * y + matrix[10]! * z + matrix[11]!,
        );
      };
      const faces: number[][] = [];
      if (prim.name === 'triangles') {
        const p = numbers(child(prim, 'p')?.text ?? '');
        for (let i = 0; i + 3 * stride <= p.length; i += 3 * stride)
          faces.push([p[i + offset]!, p[i + stride + offset]!, p[i + 2 * stride + offset]!]);
      } else if (prim.name === 'polylist') {
        const p = numbers(child(prim, 'p')?.text ?? ''),
          counts = numbers(child(prim, 'vcount')?.text ?? '');
        let at = 0;
        for (const n of counts) {
          faces.push(Array.from({ length: n }, (_, k) => p[(at + k) * stride + offset]!));
          at += n;
        }
      } else
        for (const p of prim.children.filter((c) => c.name === 'p')) {
          const list = numbers(p.text);
          faces.push(Array.from({ length: Math.floor(list.length / stride) }, (_, k) => list[k * stride + offset]!));
        }
      for (const face of faces)
        for (let k = 1; k + 1 < face.length; k++) for (const at of [face[0]!, face[k]!, face[k + 1]!]) corner(at);
    }
  };
  const visit = (node: XmlNode, parent: number[]): void => {
    let matrix = parent;
    for (const part of node.children) {
      const v = numbers(part.text);
      let m: number[] | null = null;
      if (part.name === 'matrix' && v.length === 16) m = v;
      else if (part.name === 'translate' && v.length === 3)
        m = [1, 0, 0, v[0]!, 0, 1, 0, v[1]!, 0, 0, 1, v[2]!, 0, 0, 0, 1];
      else if (part.name === 'scale' && v.length === 3)
        m = [v[0]!, 0, 0, 0, 0, v[1]!, 0, 0, 0, 0, v[2]!, 0, 0, 0, 0, 1];
      else if (part.name === 'rotate' && v.length === 4) {
        const l = Math.hypot(v[0]!, v[1]!, v[2]!) || 1,
          [x, y, z] = [v[0]! / l, v[1]! / l, v[2]! / l],
          a = (v[3]! * Math.PI) / 180,
          c = Math.cos(a),
          s = Math.sin(a),
          t = 1 - c;
        m = [
          t * x * x + c,
          t * x * y - s * z,
          t * x * z + s * y,
          0,
          t * x * y + s * z,
          t * y * y + c,
          t * y * z - s * x,
          0,
          t * x * z - s * y,
          t * y * z + s * x,
          t * z * z + c,
          0,
          0,
          0,
          0,
          1,
        ];
      }
      if (m) matrix = multiply(matrix, m);
    }
    for (const part of node.children) {
      if (part.name === 'node') visit(part, matrix);
      else if (part.name === 'instance_geometry') {
        const g = geometries.get((part.attrs.url ?? '').slice(1));
        if (g) {
          placed.add(g.attrs.id ?? '');
          addGeometry(g, matrix);
        }
      }
    }
  };
  const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  for (const library of collada.children.filter((c) => c.name === 'library_visual_scenes'))
    for (const scene of library.children.filter((c) => c.name === 'visual_scene')) visit(scene, identity);
  for (const [id, g] of geometries) if (!placed.has(id)) addGeometry(g, identity);
  if (!corners.length || !corners.every(Number.isFinite))
    throw new RangeError(
      'The Collada file holds no triangle with finite vertices; pass a .dae file with triangles or polylists.',
    );
  // Metres, then Y up: Z up turns about x (x, z, -y) and X up about z (-y, x, z).
  const out = corners.slice();
  for (let i = 0; i < out.length; i += 3) {
    let [x, y, z] = [out[i]! * scale, out[i + 1]! * scale, out[i + 2]! * scale];
    if (up === 'Z_UP') [x, y, z] = [x, z, -y];
    else if (up === 'X_UP') [x, y, z] = [-y, x, z];
    [out[i], out[i + 1], out[i + 2]] = [x, y, z];
  }
  return weld(out);
}

function finish(corners: number[], name: string): MeshFile {
  if (!corners.length || !corners.every(Number.isFinite))
    throw new RangeError(
      `The ${name} file holds no triangle with finite vertices; pass a binary or ASCII ${name} file.`,
    );
  return weld(corners);
}

/**
 * The collider options for a mesh file, ready for `physics.addBody`: a `trimesh` of it (the default, for fixed bodies) or the convex
 * hull of its points (for a dynamic body). `format` is read from the file when left out: Collada if it holds a `COLLADA` element, OBJ if it starts with `v`, `#`, `o` or `g`, else STL.
 * @throws RangeError for a file that cannot be read.
 */
export function meshFileCollider(
  input: ArrayBuffer | Uint8Array | string,
  options: { format?: 'stl' | 'obj' | 'dae'; shape?: MeshFileShape } = {},
): ColliderOptions {
  const head = text(
    typeof input === 'string'
      ? input.slice(0, 64)
      : new Uint8Array(input instanceof Uint8Array ? input : new Uint8Array(input)).slice(0, 64),
  );
  const format =
      options.format ?? (/<COLLADA|<\?xml/.test(head) ? 'dae' : /^\s*(v |#|o |g )/.test(head) ? 'obj' : 'stl'),
    mesh = format === 'dae' ? parseDAE(input) : format === 'obj' ? parseOBJ(input) : parseSTL(input);
  if (options.shape === 'convexHull') return { shape: 'convexHull', points: mesh.vertices } as ColliderOptions;
  return { shape: 'trimesh', vertices: mesh.vertices, indices: mesh.indices } as ColliderOptions;
}
