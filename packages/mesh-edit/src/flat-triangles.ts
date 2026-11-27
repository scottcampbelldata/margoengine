// Removes triangles with no area from a closed mesh without opening it, as the booleans need: a triangle with two
// corners in one point is collapsed, and a triangle with its three corners in a line (a cap) is taken out by splitting
// the face across its longest edge at the middle corner. The two cases and their order follow Botsch and Kobbelt, "A
// robust procedure to eliminate degenerate faces from triangle meshes", Vision, Modeling and Visualization 2001
// (https://www.graphics.rwth-aachen.de/publication/188/).
import type { MutableVec2 } from '@margoengine/math';
import { assertPolygonMesh, faceGeometryError } from './polygon.js';
import type { PolygonFace, PolygonMesh } from './types.js';

/** A mesh without flat triangles, and for each new or changed face the face it came from. */
export interface Flattened {
  mesh: PolygonMesh;
  /** New face ID to input face ID; a face not listed keeps its ID. Absent when nothing changed. */
  origin?: Map<string, string>;
}

interface Face {
  id: string;
  vertices: number[];
  uv: MutableVec2[];
  alive: boolean;
}

const MAX_PASSES = 64;

/**
 * `mesh` with no triangle of zero area (as {@link faceGeometryError} judges it). Vertex positions are kept; corners in
 * one point become one vertex. A closed mesh stays closed. A triangle that cannot be removed (an open or non-manifold
 * edge) stays, so the caller's solid check still refuses it. The input is returned as it is when it has none.
 */
export function withoutFlatTriangles(mesh: PolygonMesh): Flattened {
  assertPolygonMesh(mesh, false);
  const points = mesh.vertices,
    flat = (f: { vertices: readonly number[] }): boolean =>
      f.vertices.length === 3 && faceGeometryError(points, f.vertices) !== null;
  if (!mesh.faces.some(flat)) return { mesh };
  const faces: Face[] = [],
    /** The face on each directed edge. */
    half = new Map<string, Face>(),
    around = new Map<number, Set<Face>>(),
    origin = new Map<string, string>(),
    ids = new Set(mesh.faces.map((f) => f.id)),
    key = (a: number, b: number): string => `${a}>${b}`;
  const link = (face: Face): void => {
    face.vertices.forEach((a, i) => {
      half.set(key(a, face.vertices[(i + 1) % face.vertices.length]), face);
      let list = around.get(a);
      if (!list) around.set(a, (list = new Set()));
      list.add(face);
    });
  };
  const unlink = (face: Face): void => {
    face.vertices.forEach((a, i) => {
      const k = key(a, face.vertices[(i + 1) % face.vertices.length]);
      if (half.get(k) === face) half.delete(k);
      around.get(a)?.delete(face);
    });
  };
  const add = (id: string, vertices: number[], uv: MutableVec2[]): void => {
    const face = { id, vertices, uv, alive: true };
    faces.push(face);
    link(face);
  };
  const drop = (face: Face): void => {
    unlink(face);
    face.alive = false;
  };
  for (const f of mesh.faces)
    add(
      f.id,
      [...f.vertices],
      f.uv.map((uv) => [uv[0], uv[1]]),
    );
  let serial = 0;
  const fresh = (from: string): string => {
    let id: string;
    do id = `${from}~${++serial}`;
    while (ids.has(id));
    ids.add(id);
    origin.set(id, origin.get(from) ?? from);
    return id;
  };
  const length = (a: number, b: number): number =>
    Math.hypot(points[a][0] - points[b][0], points[a][1] - points[b][1], points[a][2] - points[b][2]);

  /** Makes vertex `gone` into `kept`; a face left with a corner twice in a row loses it, and under three corners dies. */
  const collapse = (kept: number, gone: number): void => {
    for (const face of [...(around.get(gone) ?? [])]) {
      unlink(face);
      const vertices: number[] = [],
        uv: MutableVec2[] = [];
      face.vertices.forEach((v, i) => {
        const next = v === gone ? kept : v;
        if (vertices.at(-1) === next) return;
        vertices.push(next);
        uv.push(face.uv[i]);
      });
      if (vertices.length > 1 && vertices[0] === vertices.at(-1)) {
        vertices.pop();
        uv.pop();
      }
      face.vertices = vertices;
      face.uv = uv;
      if (vertices.length < 3) face.alive = false;
      else link(face);
    }
  };

  /** Takes out the cap whose longest edge runs from corner `at`, splitting its neighbor at the third corner. */
  const split = (cap: Face, at: number): boolean => {
    const from = cap.vertices[at],
      to = cap.vertices[(at + 1) % 3],
      middle = cap.vertices[(at + 2) % 3],
      next = half.get(key(to, from));
    if (!next || next === cap) return false;
    const n = next.vertices.length,
      start = next.vertices.findIndex((v, i) => v === to && next.vertices[(i + 1) % n] === from);
    if (next.vertices.includes(middle)) {
      // The same three corners the other way round: a pocket with no volume, and both go.
      if (n !== 3) return false;
      drop(cap);
      drop(next);
      return true;
    }
    if (n >= 64) return false;
    const turn = <T>(list: T[]): T[] => [...list.slice(start), ...list.slice(0, start)],
      vertices = turn(next.vertices),
      uv = turn(next.uv),
      e = [0, 1, 2].map((k) => points[from][k] - points[to][k]),
      dot = [0, 1, 2].reduce((sum, k) => sum + (points[middle][k] - points[to][k]) * e[k], 0),
      t = Math.min(1, Math.max(0, dot / (e[0] ** 2 + e[1] ** 2 + e[2] ** 2))),
      between: MutableVec2 = [uv[0][0] + (uv[1][0] - uv[0][0]) * t, uv[0][1] + (uv[1][1] - uv[0][1]) * t];
    drop(cap);
    drop(next);
    if (n === 3) {
      add(next.id, [vertices[0], middle, vertices[2]], [uv[0], between, uv[2]]);
      add(fresh(next.id), [middle, vertices[1], vertices[2]], [[between[0], between[1]], uv[1], [uv[2][0], uv[2][1]]]);
    } else add(next.id, [vertices[0], middle, ...vertices.slice(1)], [uv[0], between, ...uv.slice(1)]);
    return true;
  };

  for (let pass = 0, changed = true; changed && pass < MAX_PASSES; pass++) {
    changed = false;
    const longest = (f: Face): number => Math.max(...f.vertices.map((a, i) => length(a, f.vertices[(i + 1) % 3])));
    // The longest first: a cap's neighbor across its longest edge is then never a longer cap.
    const todo = faces
      .filter((f) => f.alive && flat(f))
      .map((f) => ({ f, size: longest(f) }))
      .sort((a, b) => b.size - a.size);
    for (const { f } of todo) {
      if (!f.alive || !flat(f)) continue;
      const error = faceGeometryError(points, f.vertices)!;
      const sides = f.vertices.map((a, i) => length(a, f.vertices[(i + 1) % 3]));
      if (error.includes('degenerate geometry')) {
        const at = sides.indexOf(Math.min(...sides));
        collapse(f.vertices[at], f.vertices[(at + 1) % 3]);
        changed = true;
      } else if (split(f, sides.indexOf(Math.max(...sides)))) changed = true;
    }
  }
  const out: PolygonFace[] = faces.filter((f) => f.alive).map(({ id, vertices, uv }) => ({ id, vertices, uv }));
  return { mesh: { vertices: points, faces: out }, origin };
}
