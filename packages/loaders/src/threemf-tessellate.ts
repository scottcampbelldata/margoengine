// Tessellates and moves a 3MF displacement mesh as the Displacement Extension specification defines it
// (https://github.com/3MFConsortium/spec_displacement, chapters 2 to 5). The specification leaves the subdivision to
// the consumer. Here an edge segment is split at its middle until it meets its target, and the target depends only on
// the segment, so both triangles on a segment decide alike and no crack opens: the per-edge factors of Fisher,
// Fatahalian, Boulos, Akeley, Mark and Hanrahan, "DiagSplit: parallel, crack-free, adaptive tessellation for
// micropolygon rendering", ACM Transactions on Graphics 28(5), 2009
// (https://graphics.stanford.edu/~mdfisher/Data/DiagSplit.pdf), applied as the barycentric edge-split patterns of
// Boubekeur and Schlick, "Generic adaptive mesh refinement", GPU Gems 3 chapter 5, 2007
// (https://developer.nvidia.com/gpugems/GPUGems3/gpugems3_ch05.html).
import { cornerProperty, type ThreeMFMesh, type ThreeMFModel, type ThreeMFObject } from './threemf.js';
import { LoaderError } from './types.js';
import { floats, uints } from './util.js';

const F = '3MF';
const NONE = 0xffffffff;
/** The barycentric weight of a corner: midpoints stay exact. */
const ONE = 2 ** 30;
/** Interpolated displacement vectors turn at most this far between two samples. */
const TURN = Math.cos(Math.PI / 12);

/** A decoded height map and how it is read. */
export interface HeightMap {
  width: number;
  height: number;
  /** RGBA, 16 bits a sample, top row first. */
  data: Uint16Array;
  /** 0 to 3 for R, G, B and A. */
  channel: number;
  tileU: string;
  tileV: string;
  nearest: boolean;
}

/** A `disp2dgroup` with its map decoded. */
export interface HeightGroup {
  height: number;
  offset: number;
  /** `u v f` for each coordinate. */
  coordinates: Float32Array;
  /** A unit vector for each coordinate. */
  vectors: Float32Array;
  map: HeightMap;
}

export interface TessellateOptions {
  samplesPerTexel: number;
  maxSegments: number;
  maxTriangles: number;
}

const wrap = (style: string, x: number, size: number): number => {
  if (style === 'clamp') return Math.min(size - 1, Math.max(x, 0));
  if (style === 'none') return x >= 0 && x < size ? x : -1;
  const turns = Math.floor(x / size);
  return style === 'mirror' && turns % 2 !== 0 ? (turns + 1) * size - x - 1 : x - turns * size;
};

/** The displacement at `(u, v)` along a unit vector, in model units (chapter 2). */
export function displacementAt({ map, height, offset }: HeightGroup, u: number, v: number): number {
  const { width, height: rows, data, channel, tileU, tileV } = map;
  if ((tileU === 'none' && (u < 0 || u > 1)) || (tileV === 'none' && (v < 0 || v > 1))) return 0;
  const texel = (i: number, j: number): number => {
    const row = wrap(tileV, i, rows),
      column = wrap(tileU, j, width);
    return row < 0 || column < 0 ? 0 : data[(row * width + column) * 4 + channel] / 65535;
  };
  // Image rows run down from the top, v up from the bottom; texel centres are at halves.
  const i = (1 - v) * rows - 0.5,
    j = u * width - 0.5;
  if (map.nearest) return texel(Math.round(i), Math.round(j)) * height + offset;
  const i0 = Math.floor(i),
    j0 = Math.floor(j),
    a = i - i0,
    b = j - j0;
  return (
    (texel(i0, j0) * (1 - a) * (1 - b) +
      texel(i0, j0 + 1) * (1 - a) * b +
      texel(i0 + 1, j0) * a * (1 - b) +
      texel(i0 + 1, j0 + 1) * a * b) *
      height +
    offset
  );
}

type Weights = [number, number, number];
interface Corner {
  vertex: number;
  /** x, y, z of the base vertex. */
  position: number[];
}
interface Face {
  corners: Corner[];
  group?: HeightGroup;
  /** u, v, f, x, y, z for each corner of a displaced triangle. */
  field: number[][];
}

/**
 * The displaced surface of one mesh as a new triangle mesh in the same object coordinates: welded where triangles meet
 * in one point, and joined where their displaced edges part (section 5.2: directly when both sides use the same
 * vectors, through the base edge when not). `groups[t]` and `corners[3 t + k]` give triangle `t`'s displacement group
 * (-1 for none) and corner coordinates. Property colors follow their base triangle; a colour gradient is interpolated.
 */
export function tessellate(
  model: ThreeMFModel,
  object: ThreeMFObject,
  mesh: ThreeMFMesh,
  groups: readonly (HeightGroup | undefined)[],
  corners: ArrayLike<number>,
  { samplesPerTexel, maxSegments, maxTriangles }: TessellateOptions,
): ThreeMFMesh {
  const vertexCount = mesh.vertices.length / 3,
    triangleCount = mesh.triangles.length / 3,
    depthCap = Math.floor(Math.log2(maxSegments)),
    vertices = floats(),
    triangles = uints(),
    pids = uints(),
    properties = uints(),
    flat: ThreeMFMesh['flat'] = [],
    welded = new Map<string, number>();

  const faces: Face[] = [];
  for (let t = 0; t < triangleCount; t++) {
    const face: Face = { corners: [], group: groups[t], field: [] };
    for (let k = 0; k < 3; k++) {
      const vertex = mesh.triangles.array[t * 3 + k];
      if (vertex >= vertexCount)
        throw new LoaderError(
          F,
          'range',
          `triangle index ${vertex} of object ${object.id} is outside 0..${vertexCount - 1}`,
        );
      face.corners.push({ vertex, position: [...mesh.vertices.array.subarray(vertex * 3, vertex * 3 + 3)] });
      if (face.group) {
        const at = corners[t * 3 + k] * 3,
          { coordinates, vectors } = face.group;
        face.field.push([...coordinates.subarray(at, at + 3), ...vectors.subarray(at, at + 3)]);
      }
    }
    faces.push(face);
  }

  /** `values` of the corners with a weight, summed in the order of their vertices, so both sides of an edge agree. */
  const blend = (face: Face, w: Weights, values: readonly number[][]): number[] => {
    const used = [0, 1, 2].filter((k) => w[k] > 0).sort((a, b) => face.corners[a].vertex - face.corners[b].vertex);
    return values[0].map((_, i) => used.reduce((sum, k) => sum + (w[k] / ONE) * values[k][i], 0));
  };
  const unit = (v: number[]): number[] => {
    const length = Math.hypot(v[3], v[4], v[5]) || 1;
    return [v[3] / length, v[4] / length, v[5] / length];
  };
  /** The vertex at weights `w` of a triangle, on its base or displaced; `shared` ones weld with equal points. */
  const vertex = (face: Face, w: Weights, displaced: boolean, shared: boolean): number => {
    const p = blend(
      face,
      w,
      face.corners.map((c) => c.position),
    );
    if (displaced && face.group) {
      const field = blend(face, w, face.field),
        n = unit(field),
        d = displacementAt(face.group, field[0], field[1]) * field[2];
      for (let k = 0; k < 3; k++) p[k] += d * n[k];
    }
    const x = Math.fround(p[0]),
      y = Math.fround(p[1]),
      z = Math.fround(p[2]);
    if (!Number.isFinite(x + y + z))
      throw new LoaderError(F, 'range', `object ${object.id} displaces a point out of range`);
    const key = shared ? `${x},${y},${z}` : '';
    let id = shared ? welded.get(key) : undefined;
    if (id === undefined) {
      id = vertices.length / 3;
      vertices.push3(x, y, z);
      if (shared) welded.set(key, id);
    }
    return id;
  };

  /** Segments an edge needs for its picture and its turning vectors, as a depth of halvings. */
  const depths = new Map<string, number>(),
    sides = new Map<string, [number, number][]>(),
    edgeKey = (face: Face, k: number): string => {
      const a = face.corners[k].vertex,
        b = face.corners[(k + 1) % 3].vertex;
      return a < b ? `${a}:${b}` : `${b}:${a}`;
    };
  /** The texels between two points of a displaced triangle, times the samples asked for. */
  const texels = ({ map }: HeightGroup, p: number[], q: number[]): number =>
    Math.hypot((p[0] - q[0]) * map.width, (p[1] - q[1]) * map.height) * samplesPerTexel;
  const turns = (p: number[], q: number[]): number => {
    const a = unit(p),
      b = unit(q);
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  };
  faces.forEach((face, t) => {
    for (let k = 0; k < 3; k++) {
      const key = edgeKey(face, k),
        { group, field } = face;
      let depth = 0;
      if (group && (group.height !== 0 || group.offset !== 0)) {
        const p = field[k],
          q = field[(k + 1) % 3],
          angle = Math.acos(Math.max(-1, Math.min(1, turns(p, q)))),
          segments = Math.max(texels(group, p, q), angle / Math.acos(TURN));
        depth = Math.min(depthCap, Math.max(0, Math.ceil(Math.log2(segments) - 1e-6)));
      }
      depths.set(key, Math.max(depths.get(key) ?? 0, depth));
      let list = sides.get(key);
      if (!list) sides.set(key, (list = []));
      list.push([t, k]);
    }
  });

  // Synthetic colours for the points inside a triangle whose corners differ.
  let gradient: { index: number; colors: [number, number, number, number][] } | undefined;
  const colorsOf = (t: number) =>
    [0, 1, 2].map((k) => {
      const property = cornerProperty(model, object, mesh, t, k);
      return property && model.properties.get(property.id)?.[property.index];
    });
  const emit = (ids: number[], t: number, weights?: Weights[]): void => {
    if (ids[0] === ids[1] || ids[1] === ids[2] || ids[2] === ids[0]) return;
    if (triangles.length / 3 >= maxTriangles)
      throw new LoaderError(
        F,
        'limit',
        `the displaced surface of object ${object.id} exceeds ${maxTriangles} triangles; lower samplesPerTexel or maxSegments, or raise maxTriangles`,
      );
    triangles.push3(ids[0], ids[1], ids[2]);
    const colors = colorsOf(t),
      [a, b, c] = colors;
    flat.push(a);
    if (weights && a && b && c && (String(a) !== String(b) || String(a) !== String(c))) {
      if (!gradient) {
        gradient = { index: model.propertyIds.length, colors: [] };
        const id = `\0displaced ${object.id}`;
        model.propertyIds.push(id);
        model.properties.set(id, gradient.colors);
      }
      const first = gradient.colors.length;
      for (const w of weights)
        gradient.colors.push(
          [0, 1, 2, 3].map((i) => (w[0] * a[i] + w[1] * b[i] + w[2] * c[i]) / ONE) as [number, number, number, number],
        );
      pids.push(gradient.index);
      properties.push3(first, first + 1, first + 2);
    } else {
      const p = mesh.p.array[t * 3];
      pids.push(mesh.pid.array[t] ?? NONE);
      properties.push3(p, p, p);
    }
  };

  faces.forEach((face, t) => {
    const cache = new Map<string, number>();
    const at = (w: Weights): number => {
      const key = `${w[1]},${w[2]}`;
      let id = cache.get(key);
      if (id === undefined) cache.set(key, (id = vertex(face, w, true, w.includes(0))));
      return id;
    };
    const split = (p: Weights, q: Weights): Weights | undefined => {
      const extent = Math.max(Math.abs(p[0] - q[0]), Math.abs(p[1] - q[1]), Math.abs(p[2] - q[2])),
        opposite = [0, 1, 2].find((k) => p[k] === 0 && q[k] === 0);
      if (opposite !== undefined) {
        if (extent <= ONE / 2 ** depths.get(edgeKey(face, (opposite + 1) % 3))!) return;
      } else {
        // The inside of an undisplaced or unmoved triangle stays coarse.
        if (!face.group || (!face.group.height && !face.group.offset) || extent <= ONE / 2 ** depthCap) return;
        const a = blend(face, p, face.field),
          b = blend(face, q, face.field);
        if (texels(face.group, a, b) <= 1 + 1e-6 && turns(a, b) >= TURN - 1e-9) return;
      }
      return [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2, (p[2] + q[2]) / 2];
    };
    const length = (p: Weights, q: Weights): number => {
      const base = face.corners.map((c) => c.position),
        a = blend(face, p, base),
        b = blend(face, q, base);
      return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
    };
    const stack: Weights[][] = [
      [
        [ONE, 0, 0],
        [0, ONE, 0],
        [0, 0, ONE],
      ],
    ];
    while (stack.length) {
      let corner = stack.pop()!;
      let middle = corner.map((p, k) => split(p, corner[(k + 1) % 3]));
      const count = middle.filter(Boolean).length;
      if (!count) {
        emit(corner.map(at), t, corner);
        continue;
      }
      if (count === 3) {
        const [a, b, c] = corner,
          [ab, bc, ca] = middle as Weights[];
        stack.push([a, ab, ca], [ab, b, bc], [ca, bc, c], [ab, bc, ca]);
      } else {
        // Turn the triangle so that AB is split and, with two splits, CA is not.
        const first = [0, 1, 2].find((k) => middle[k] && (count === 1 || !middle[(k + 2) % 3]))!,
          turned = <T>(list: T[]): T[] => [...list.slice(first), ...list.slice(0, first)];
        corner = turned(corner);
        middle = turned(middle);
        const [a, b, c] = corner,
          [ab, bc] = middle as Weights[];
        if (count === 1) stack.push([a, ab, c], [ab, b, c]);
        else if (length(a, bc) <= length(ab, c)) stack.push([ab, b, bc], [a, ab, bc], [a, bc, c]);
        else stack.push([ab, b, bc], [a, ab, c], [ab, bc, c]);
      }
    }
  });

  // Join the sides of each edge where their surfaces part.
  for (const [key, list] of sides) {
    if (list.length !== 2) continue;
    const [[t, k], [u, j]] = list,
      one = faces[t],
      two = faces[u],
      from = one.corners[k].vertex,
      to = one.corners[(k + 1) % 3].vertex;
    if (two.corners[j].vertex !== to || two.corners[(j + 1) % 3].vertex !== from) continue;
    const segments = 2 ** depths.get(key)!;
    /** The weights of step `i` along an edge, from corner `a` to corner `b` of its triangle. */
    const step = (a: number, b: number, i: number): Weights => {
      const w: Weights = [0, 0, 0];
      w[a] = ONE - (i * ONE) / segments;
      w[b] = (i * ONE) / segments;
      return w;
    };
    /** The points of triangle `face` from corner `a` to corner `b`. */
    const line = (face: Face, a: number, b: number, displaced: boolean): number[] =>
      Array.from({ length: segments + 1 }, (_, i) => vertex(face, step(a, b, i), displaced, true));
    const left = line(one, k, (k + 1) % 3, true),
      right = line(two, (j + 1) % 3, j, true);
    // A joining triangle takes the colours along the edge of a displaced side.
    const shown = one.group ? t : u,
      colour = (i: number): Weights => (one.group ? step(k, (k + 1) % 3, i) : step((j + 1) % 3, j, i));
    const strip = (x: number[], y: number[]): void => {
      for (let i = 0; i < segments; i++) {
        emit([x[i + 1], x[i], y[i]], shown, [colour(i + 1), colour(i), colour(i)]);
        emit([x[i + 1], y[i], y[i + 1]], shown, [colour(i + 1), colour(i), colour(i + 1)]);
      }
    };
    const alike = (a: number, b: number): boolean => {
      if (!one.group || !two.group) return true;
      const p = unit(one.field[a]),
        q = unit(two.field[b]);
      return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]) < 1e-5;
    };
    if (alike(k, (j + 1) % 3) && alike((k + 1) % 3, j)) {
      if (left.every((id, i) => id === right[i])) continue;
      strip(left, right);
      // The corners of a vertex close over its base point, one cap for each such edge that parts there.
      for (const [i, x, y] of [
        [0, right, left],
        [segments, left, right],
      ] as const) {
        if (x[i] === y[i]) continue;
        const base = vertex(one, step(k, (k + 1) % 3, i), false, true);
        emit([x[i], y[i], base], shown, [colour(i), colour(i), colour(i)]);
      }
    } else {
      const base = line(one, k, (k + 1) % 3, false);
      strip(left, base);
      strip(base, right);
    }
  }
  return { vertices, triangles, pid: pids, p: properties, flat };
}
