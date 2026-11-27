// Evaluates a 3MF boolean shape (https://github.com/3MFConsortium/spec_booleans, chapter 2) with the exact n-ary
// boolean of `@margoengine/mesh-edit`: the base, then each operand in order, where a difference takes the union of the
// operands away. A face keeps the colour of the surface it came from, as the extension asks for all three operations.
import { cornerProperty, type ThreeMFMesh, type ThreeMFModel, type ThreeMFObject } from './threemf.js';
import { LoaderError } from './types.js';
import { floats, uints } from './util.js';

const F = '3MF';
const NONE = 0xffffffff;

/** One input of a boolean shape: an object with triangles, and the transform applied to it first. */
export interface BooleanInput {
  model: ThreeMFModel;
  object: ThreeMFObject;
  transform: ArrayLike<number>;
}

type Point = [number, number, number];
type Color = [number, number, number, number];

/** A closed polygon solid with a colour, or none, at every face corner. */
interface Solid {
  vertices: Point[];
  faces: { id: string; vertices: number[]; uv: [number, number][] }[];
  colours: (Color | undefined)[][];
}

/** Each evaluated shape as its polygons, which a later shape reads without the rounding and splitting of triangles. */
const evaluated = new WeakMap<ThreeMFMesh, Solid>();

const face = (id: number, vertices: number[]): Solid['faces'][number] => ({
  id: String(id),
  vertices,
  uv: vertices.map(() => [0, 0]),
});

function triangleSolid(model: ThreeMFModel, object: ThreeMFObject, mesh: ThreeMFMesh): Solid {
  const source = mesh.vertices.array,
    count = mesh.vertices.length / 3,
    solid: Solid = {
      vertices: Array.from({ length: count }, (_, v) => [...source.subarray(v * 3, v * 3 + 3)] as Point),
      faces: [],
      colours: [],
    };
  for (let t = 0; t < mesh.triangles.length / 3; t++) {
    const corners = [...mesh.triangles.array.subarray(t * 3, t * 3 + 3)];
    if (corners.some((v) => v >= count))
      throw new LoaderError(F, 'range', `a triangle index of object ${object.id} is outside 0..${count - 1}`);
    solid.faces.push(face(t, corners));
    solid.colours.push(
      [0, 1, 2].map((k) => {
        const property = cornerProperty(model, object, mesh, t, k);
        return property && model.properties.get(property.id)?.[property.index];
      }),
    );
  }
  return solid;
}

/** The solid under a 3MF transform; a mirrored one turns its faces back outward. */
function placed({ vertices, faces, colours }: Solid, m: ArrayLike<number>): Solid {
  const mirrored =
    m[0] * (m[4] * m[8] - m[5] * m[7]) - m[1] * (m[3] * m[8] - m[5] * m[6]) + m[2] * (m[3] * m[7] - m[4] * m[6]) < 0;
  const turn = <T>(list: T[]): T[] => (mirrored ? [...list].reverse() : list);
  return {
    vertices: vertices.map(
      ([x, y, z]) => [0, 1, 2].map((k) => x * m[k] + y * m[3 + k] + z * m[6 + k] + m[9 + k]) as Point,
    ),
    faces: faces.map((f, i) => face(i, turn(f.vertices))),
    colours: colours.map(turn),
  };
}

const sub = (a: Point, b: Point): Point => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Point, b: Point): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const doubleArea = (a: Point, b: Point, c: Point): number => {
  const u = sub(b, a),
    v = sub(c, a);
  return Math.hypot(u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]);
};

/** The colour of a flat or linearly shaded source face at a point of its plane. */
function shade({ vertices, faces, colours }: Solid, at: number): ((p: Point) => Color) | undefined {
  const own = colours[at];
  if (!own.every(Boolean)) return undefined;
  const painted = own as Color[];
  if (painted.every((c) => String(c) === String(painted[0]))) return () => painted[0];
  const points = faces[at].vertices.map((v) => vertices[v]);
  // The widest fan triangle carries the face's linear colour.
  let best = 1;
  for (let i = 2; i + 1 < points.length; i++)
    if (doubleArea(points[0], points[i], points[i + 1]) > doubleArea(points[0], points[best], points[best + 1]))
      best = i;
  const [a, b, c] = [points[0], points[best], points[best + 1]],
    u = sub(b, a),
    v = sub(c, a),
    uu = dot(u, u),
    uv = dot(u, v),
    vv = dot(v, v),
    d = uu * vv - uv * uv || 1;
  return (p) => {
    const w = sub(p, a),
      s = (vv * dot(w, u) - uv * dot(w, v)) / d,
      t = (uu * dot(w, v) - uv * dot(w, u)) / d;
    return [0, 1, 2, 3].map(
      (i) => (1 - s - t) * painted[0][i] + s * painted[best][i] + t * painted[best + 1][i],
    ) as Color;
  };
}

/**
 * The triangles of `inputs[0] operation inputs[1..]` in the shape's coordinates and the model's unit, with its colours
 * added to `model`.
 *
 * @throws LoaderError for an input that is not a closed, outward solid, and for more than `maxTriangles`.
 */
export async function booleanMesh(
  model: ThreeMFModel,
  id: string,
  operation: 'union' | 'difference' | 'intersection',
  inputs: readonly BooleanInput[],
  maxTriangles: number,
): Promise<ThreeMFMesh> {
  const { batchBooleanMeshes } = await import('@margoengine/mesh-edit/boolean-batch'),
    label = `boolean shape ${id.slice(0, 32)}`;
  const solids = inputs.map(({ model: owner, object, transform }) =>
    placed(evaluated.get(object.mesh!) ?? triangleSolid(owner, object, object.mesh!), transform),
  );
  let next = 0,
    result;
  try {
    result = batchBooleanMeshes(solids, operation, { createId: () => `f${next++}` });
  } catch (error) {
    throw new LoaderError(F, error instanceof RangeError ? 'limit' : 'syntax', `${label}: ${(error as Error).message}`);
  }
  const points = result.mesh.vertices as Point[],
    shape: Solid = { vertices: points, faces: [], colours: [] },
    vertices = floats(),
    triangles = uints(),
    pids = uints(),
    properties = uints(),
    welded = new Map<string, number>(),
    colors: Color[] = [],
    known = new Map<string, number>();
  let group = -1;
  const colour = (value: Color): number => {
    const key = value.join(',');
    let at = known.get(key);
    if (at === undefined) {
      known.set(key, (at = colors.length));
      colors.push(value);
    }
    return at;
  };
  const vertex = ([x, y, z]: Point): number => {
    const stored = [Math.fround(x), Math.fround(y), Math.fround(z)] as const,
      key = stored.join(',');
    let at = welded.get(key);
    if (at === undefined) {
      welded.set(key, (at = vertices.length / 3));
      vertices.push3(...stored);
    }
    return at;
  };
  for (const piece of result.mesh.faces) {
    const { input, face: from } = result.sources[piece.id],
      paint = shade(solids[input], Number(from)),
      corners = piece.vertices.map((v) => points[v]),
      own = corners.map((p) => paint?.(p));
    shape.faces.push(face(shape.faces.length, [...piece.vertices]));
    shape.colours.push(own);
    if (paint && group < 0) {
      group = model.propertyIds.length;
      const key = `\0boolean ${id}`;
      model.propertyIds.push(key);
      model.properties.set(key, colors);
    }
    // A fan from the first corner; a face with corners in a line fans from its centre, so no triangle is flat.
    let ring = corners,
      shades = own;
    const flat = corners.some((p, i) => i > 1 && !(doubleArea(corners[0], corners[i - 1], p) > 0));
    if (flat) {
      const centre = [0, 1, 2].map((k) => corners.reduce((sum, p) => sum + p[k], 0) / corners.length) as Point,
        shade = paint?.(centre);
      ring = [centre, ...corners, corners[0]];
      shades = [shade, ...own, own[0]];
    }
    const ids = ring.map(vertex),
      painting = shades.map((c) => (c ? colour(c) : NONE));
    for (let i = 1; i + 1 < ids.length; i++) {
      if (ids[0] === ids[i] || ids[i] === ids[i + 1] || ids[i + 1] === ids[0]) continue;
      if (triangles.length / 3 >= maxTriangles)
        throw new LoaderError(F, 'limit', `${label} exceeds ${maxTriangles} triangles; raise maxTriangles`);
      triangles.push3(ids[0], ids[i], ids[i + 1]);
      // A face whose source has no property has none either.
      pids.push(paint ? group : NONE);
      properties.push3(painting[0], painting[i], painting[i + 1]);
    }
  }
  const mesh: ThreeMFMesh = { vertices, triangles, pid: pids, p: properties };
  evaluated.set(mesh, shape);
  return mesh;
}
