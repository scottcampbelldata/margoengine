// Subdivision surfaces, hole faces and concave polygons, by the UsdGeomMesh schema page of OpenUSD's public documentation and
// the Subdivision Surfaces page of OpenSubdiv's (opensubdiv.org/docs).
// Refinement is Catmull and Clark's (Recursively generated B-spline surfaces on arbitrary topological meshes, 1978) or, for
// triangles, Loop's (Smooth subdivision surfaces based on triangles, 1987), with the sharp and semi-sharp rules of DeRose,
// Kass and Truong (Subdivision surfaces in character animation, SIGGRAPH 1998). Each
// level records every new point as a list of parents and weights, so anything linear in the points refines the same way:
// positions, primvars, blend shape offsets and joint weights.
import { triangulate } from '@margoengine/geometry/triangulate';
import type { ExtensionHooks, MeshRead, MeshShape, USDExtension } from './extension.js';

/** Options of {@link subdivision}. */
export interface SubdivisionOptions {
  /** Times each face is split. Default 2. A stage that would pass `maxTriangles` gets fewer, and `issues` says so. */
  level?: number;
}
/** The schema's constant for a perfectly sharp crease or corner. */
const INFINITE = 10;

/** Every new point of one level as a row of parents and weights. */
interface Stencil {
  size: number;
  rows: Uint32Array;
  parents: Uint32Array;
  weights: Float64Array;
}
/** A mesh on its way down: faces and the sharpness that is left on its edges and points. */
interface Cage {
  size: number;
  counts: Uint32Array;
  faces: Uint32Array;
  /** Sharpness by edge key. */
  creases: Map<number, number>;
  corners: Map<number, number>;
  /** Every edge and point counts as sharp: bilinear subdivision, or linear face-varying data. */
  linear: boolean;
  /** Triangles split by Loop's rules. */
  loop: boolean;
}
const edgeKey = (a: number, b: number, size: number) => (a < b ? a * size + b : b * size + a);

/** One level of refinement: the next cage, and how its points come from this one's. */
function refine(cage: Cage): { cage: Cage; stencil: Stencil } {
  const { size, counts, faces, creases, corners, linear, loop } = cage,
    ids = new Map<number, number>(),
    ends: number[] = [],
    sides: number[] = [],
    first: number[] = [],
    second: number[] = [],
    starts = new Uint32Array(counts.length + 1);
  for (let f = 0; f < counts.length; f++) starts[f + 1] = starts[f] + counts[f];
  const edgeOf = new Uint32Array(faces.length);
  for (let f = 0; f < counts.length; f++)
    for (let c = starts[f]; c < starts[f + 1]; c++) {
      const a = faces[c],
        b = faces[c + 1 === starts[f + 1] ? starts[f] : c + 1],
        key = edgeKey(a, b, size);
      let id = ids.get(key);
      if (id === undefined) {
        id = sides.length;
        ids.set(key, id);
        ends.push(a, b);
        sides.push(0);
        first.push(f);
        second.push(f);
      }
      if (sides[id]++ === 1) second[id] = f;
      edgeOf[c] = id;
    }
  const edges = sides.length,
    sharpness = new Float64Array(edges);
  for (const [key, id] of ids) sharpness[id] = linear || sides[id] !== 2 ? Infinity : (creases.get(key) ?? 0);
  // The edges and faces around each point.
  const around = Array.from({ length: size }, () => ({ edges: [] as number[], faces: [] as number[] }));
  for (let e = 0; e < edges; e++) {
    around[ends[e * 2]].edges.push(e);
    around[ends[e * 2 + 1]].edges.push(e);
  }
  for (let f = 0; f < counts.length; f++) for (let c = starts[f]; c < starts[f + 1]; c++) around[faces[c]].faces.push(f);

  const rows: number[] = [0],
    parents: number[] = [],
    weights: number[] = [],
    add = (parent: number, weight: number) => {
      if (!weight) return;
      parents.push(parent);
      weights.push(weight);
    },
    addFace = (f: number, weight: number) => {
      const share = weight / counts[f];
      for (let c = starts[f]; c < starts[f + 1]; c++) add(faces[c], share);
    },
    other = (e: number, v: number) => (ends[e * 2] === v ? ends[e * 2 + 1] : ends[e * 2]);
  /** A point's rule, by how many of `list` are sharp, with `weight` of it in the row. */
  const mask = (v: number, list: number[], corner: boolean, weight: number) => {
    if (corner || list.length > 2) return add(v, weight);
    if (list.length === 2) {
      add(v, 0.75 * weight);
      add(other(list[0], v), 0.125 * weight);
      add(other(list[1], v), 0.125 * weight);
      return;
    }
    const n = around[v].edges.length;
    if (loop) {
      // Loop's beta.
      const middle = 0.375 + 0.25 * Math.cos((2 * Math.PI) / n),
        beta = (0.625 - middle * middle) / n;
      add(v, (1 - n * beta) * weight);
      for (const e of around[v].edges) add(other(e, v), beta * weight);
      return;
    }
    const share = weight / (n * n);
    add(v, ((n - 2) / n) * weight);
    for (const e of around[v].edges) add(other(e, v), share);
    for (const f of around[v].faces) addFace(f, share);
  };
  for (let v = 0; v < size; v++) {
    const { edges: mine } = around[v],
      corner = corners.get(v) ?? 0,
      now = mine.filter((e) => sharpness[e] > 0),
      next = mine.filter((e) => sharpness[e] > 1),
      isCorner = linear || corner > 0,
      staysCorner = linear || corner > 1;
    if (!mine.length) add(v, 1);
    else {
      const same =
        isCorner === staysCorner &&
        Math.min(now.length, 3) === Math.min(next.length, 3);
      if (same || (isCorner && now.length === next.length && staysCorner)) mask(v, now, isCorner, 1);
      else {
        // Between two rules: DeRose, Kass and Truong blend them by the sharpness that runs out at this level.
        const fading = now.filter((e) => sharpness[e] <= 1).map((e) => sharpness[e]);
        if (isCorner && !staysCorner) fading.push(corner);
        const blend = fading.reduce((sum, s) => sum + s, 0) / fading.length;
        mask(v, now, isCorner, blend);
        mask(v, next, staysCorner, 1 - blend);
      }
    }
    rows.push(parents.length);
  }
  for (let e = 0; e < edges; e++) {
    const a = ends[e * 2],
      b = ends[e * 2 + 1],
      s = Math.min(sharpness[e], 1),
      soft = (1 - s) * (loop ? 0.375 : 0.25);
    add(a, s * 0.5 + soft);
    add(b, s * 0.5 + soft);
    if (s < 1) {
      if (loop) {
        for (const f of [first[e], second[e]])
          for (let c = starts[f]; c < starts[f + 1]; c++) if (faces[c] !== a && faces[c] !== b) add(faces[c], (1 - s) * 0.125);
      } else {
        addFace(first[e], soft);
        addFace(second[e], soft);
      }
    }
    rows.push(parents.length);
  }
  if (!loop)
    for (let f = 0; f < counts.length; f++) {
      addFace(f, 1);
      rows.push(parents.length);
    }
  const total = size + edges + (loop ? 0 : counts.length),
    nextCounts = new Uint32Array(loop ? counts.length * 4 : faces.length).fill(loop ? 3 : 4),
    nextFaces = new Uint32Array(loop ? counts.length * 12 : faces.length * 4),
    nextCreases = new Map<number, number>(),
    nextCorners = new Map<number, number>();
  for (let f = 0, at = 0; f < counts.length; f++) {
    for (let c = starts[f]; c < starts[f + 1]; c++) {
      const before = c === starts[f] ? starts[f + 1] - 1 : c - 1;
      nextFaces[at++] = faces[c];
      nextFaces[at++] = size + edgeOf[c];
      if (!loop) nextFaces[at++] = size + edges + f;
      nextFaces[at++] = size + edgeOf[before];
    }
    if (loop) for (let c = starts[f]; c < starts[f + 1]; c++) nextFaces[at++] = size + edgeOf[c];
  }
  for (let e = 0; e < edges; e++) {
    const left = sides[e] === 2 ? sharpness[e] - 1 : 0;
    if (left <= 0) continue;
    nextCreases.set(edgeKey(ends[e * 2], size + e, total), left);
    nextCreases.set(edgeKey(ends[e * 2 + 1], size + e, total), left);
  }
  for (const [v, s] of corners) if (s > 1) nextCorners.set(v, s - 1);
  return {
    cage: { size: total, counts: nextCounts, faces: nextFaces, creases: nextCreases, corners: nextCorners, linear, loop },
    stencil: { size: total, rows: Uint32Array.from(rows), parents: Uint32Array.from(parents), weights: Float64Array.from(weights) },
  };
}
/** A stream of `width` numbers per point, through one level. */
function apply({ size, rows, parents, weights }: Stencil, values: ArrayLike<number>, width: number): Float64Array {
  const out = new Float64Array(size * width);
  for (let v = 0; v < size; v++)
    for (let i = rows[v]; i < rows[v + 1]; i++) {
      const from = parents[i] * width,
        w = weights[i];
      for (let d = 0; d < width; d++) out[v * width + d] += w * values[from + d];
    }
  return out;
}
const numbers = (value: unknown): ArrayLike<number> => (value ?? []) as ArrayLike<number>;
const sharp = (s: number) => (s >= INFINITE ? Infinity : s);

/** Faces of the authored mesh with three or more corners, as a cage with the schema's creases and corners. */
function authored(read: MeshRead, linear: boolean, wantLoop: boolean): { cage: Cage; source: Uint32Array; cornerOf: Uint32Array; dropped: boolean } {
  const { counts, faces, points, value } = read,
    size = points.length / 3,
    keptCounts: number[] = [],
    keptFaces: number[] = [],
    source: number[] = [],
    cornerOf: number[] = [];
  for (let f = 0, at = 0; f < counts.length; at += counts[f++]) {
    if (counts[f] < 3) continue;
    keptCounts.push(counts[f]);
    source.push(f);
    for (let c = 0; c < counts[f]; c++) {
      keptFaces.push(faces[at + c]);
      cornerOf.push(at + c);
    }
  }
  const creases = new Map<number, number>(),
    indices = numbers(value('creaseIndices')),
    lengths = numbers(value('creaseLengths')),
    amounts = numbers(value('creaseSharpnesses')),
    perEdge = amounts.length !== lengths.length;
  for (let crease = 0, at = 0, edge = 0; crease < lengths.length; at += lengths[crease++])
    for (let i = 0; i + 1 < lengths[crease]; i++, edge++) {
      const s = sharp(amounts[perEdge ? edge : crease] ?? 0);
      if (s > 0) creases.set(edgeKey(indices[at + i], indices[at + i + 1], size), s);
    }
  const corners = new Map<number, number>(),
    points2 = numbers(value('cornerIndices')),
    cornerAmounts = numbers(value('cornerSharpnesses'));
  for (let i = 0; i < points2.length; i++) if (cornerAmounts[i] > 0) corners.set(points2[i], sharp(cornerAmounts[i]));
  const loop = wantLoop && keptCounts.every((n) => n === 3);
  if (wantLoop && !loop) read.soft(`${read.path} asks for Loop subdivision, which takes triangles only; it refines as Catmull-Clark`);
  return {
    cage: { size, counts: Uint32Array.from(keptCounts), faces: Uint32Array.from(keptFaces), creases, corners, linear, loop },
    source: Uint32Array.from(source),
    cornerOf: Uint32Array.from(cornerOf),
    dropped: keptCounts.length !== counts.length,
  };
}
/** Points on one face only: the corners of an open mesh, and with them the points on any boundary. */
function boundaryPoints({ size, counts, faces }: Cage) {
  const seen = new Map<number, number>(),
    edge: [number, number][] = [];
  for (let f = 0, at = 0; f < counts.length; at += counts[f++])
    for (let c = 0; c < counts[f]; c++) {
      const a = faces[at + c],
        b = faces[at + ((c + 1) % counts[f])],
        key = edgeKey(a, b, size);
      seen.set(key, (seen.get(key) ?? 0) + 1);
      edge.push([a, b]);
    }
  const onBoundary = new Set<number>();
  for (const [a, b] of edge)
    if (seen.get(edgeKey(a, b, size)) === 1) {
      onBoundary.add(a);
      onBoundary.add(b);
    }
  const facesAt = new Uint32Array(size);
  for (const v of faces) facesAt[v]++;
  return { onBoundary, facesAt };
}
/** Refined corner normals: faces share one across an edge, unless the edge is still sharp. */
function normalsOf(cage: Cage, points: ArrayLike<number>, flip: number): Float32Array {
  const { size, counts, faces, creases, linear } = cage,
    out = new Float32Array(faces.length * 3),
    group = Uint32Array.from(faces, (_, i) => i),
    find = (i: number): number => {
      while (group[i] !== i) i = group[i] = group[group[i]];
      return i;
    },
    joined = (a: number, b: number) => {
      group[find(a)] = find(b);
    },
    owners = new Map<number, number[]>();
  const sum = new Float64Array(faces.length * 3);
  for (let f = 0, at = 0; f < counts.length; at += counts[f++]) {
    let x = 0,
      y = 0,
      z = 0;
    // Newell's sum: the area normal of a face that need not be flat.
    for (let c = 0; c < counts[f]; c++) {
      const p = faces[at + c] * 3,
        q = faces[at + ((c + 1) % counts[f])] * 3;
      x += (points[p + 1] - points[q + 1]) * (points[p + 2] + points[q + 2]);
      y += (points[p + 2] - points[q + 2]) * (points[p] + points[q]);
      z += (points[p] - points[q]) * (points[p + 1] + points[q + 1]);
    }
    for (let c = 0; c < counts[f]; c++) {
      const corner = at + c,
        a = faces[corner],
        next = at + ((c + 1) % counts[f]),
        key = edgeKey(a, faces[next], size);
      sum[corner * 3] = x * flip;
      sum[corner * 3 + 1] = y * flip;
      sum[corner * 3 + 2] = z * flip;
      const list = owners.get(key);
      if (list) list.push(corner, next);
      else owners.set(key, [corner, next]);
    }
  }
  for (const [key, list] of owners) {
    if (linear || creases.has(key) || list.length !== 4) continue;
    // Two faces on one edge: the corners at each end are one smooth group.
    const [a, b, c, d] = list;
    if (faces[a] === faces[c]) {
      joined(a, c);
      joined(b, d);
    } else {
      joined(a, d);
      joined(b, c);
    }
  }
  const total = new Float64Array(faces.length * 3);
  for (let i = 0; i < faces.length; i++) {
    const root = find(i) * 3;
    for (let d = 0; d < 3; d++) total[root + d] += sum[i * 3 + d];
  }
  for (let i = 0; i < faces.length; i++) {
    const root = find(i) * 3,
      length = Math.hypot(total[root], total[root + 1], total[root + 2]) || 1;
    for (let d = 0; d < 3; d++) out[i * 3 + d] = total[root + d] / length;
  }
  return out;
}
/** Splits concave faces into triangles, in the face's own plane. */
function splitConcave(counts: Uint32Array, faces: Uint32Array, points: ArrayLike<number>, source: Uint32Array, cornerOf: Uint32Array) {
  const outCounts: number[] = [],
    outFaces: number[] = [],
    outSource: number[] = [],
    outCorners: number[] = [];
  let split = false;
  for (let f = 0, at = 0; f < counts.length; at += counts[f++]) {
    const n = counts[f],
      keep = () => {
        outCounts.push(n);
        outSource.push(source[f]);
        for (let c = 0; c < n; c++) {
          outFaces.push(faces[at + c]);
          outCorners.push(cornerOf[at + c]);
        }
      };
    if (n < 4) {
      keep();
      continue;
    }
    let x = 0,
      y = 0,
      z = 0;
    for (let c = 0; c < n; c++) {
      const p = faces[at + c] * 3,
        q = faces[at + ((c + 1) % n)] * 3;
      x += (points[p + 1] - points[q + 1]) * (points[p + 2] + points[q + 2]);
      y += (points[p + 2] - points[q + 2]) * (points[p] + points[q]);
      z += (points[p] - points[q]) * (points[p + 1] + points[q + 1]);
    }
    // Drop the normal's largest axis; what is left keeps the polygon's shape, and its turn matches the sum's sign.
    const big = Math.abs(x) >= Math.abs(y) && Math.abs(x) >= Math.abs(z) ? 0 : Math.abs(y) >= Math.abs(z) ? 1 : 2,
      u = (big + 1) % 3,
      v = (big + 2) % 3,
      sign = [x, y, z][big] < 0 ? -1 : 1,
      flat = new Float64Array(n * 2);
    for (let c = 0; c < n; c++) {
      flat[c * 2] = points[faces[at + c] * 3 + u];
      flat[c * 2 + 1] = sign * points[faces[at + c] * 3 + v];
    }
    let concave = false;
    for (let c = 0; c < n && !concave; c++) {
      const a = ((c + n - 1) % n) * 2,
        b = c * 2,
        d = ((c + 1) % n) * 2;
      concave = (flat[b] - flat[a]) * (flat[d + 1] - flat[b + 1]) - (flat[b + 1] - flat[a + 1]) * (flat[d] - flat[b]) < 0;
    }
    if (!concave) {
      keep();
      continue;
    }
    split = true;
    const triangles = triangulate(flat);
    for (let t = 0; t < triangles.length; t += 3) {
      outCounts.push(3);
      outSource.push(source[f]);
      // The clipper's turn is its own: triangles go back in the polygon's.
      const [a, b, c] = [triangles[t], triangles[t + 1], triangles[t + 2]],
        area = (flat[b * 2] - flat[a * 2]) * (flat[c * 2 + 1] - flat[a * 2 + 1]) - (flat[b * 2 + 1] - flat[a * 2 + 1]) * (flat[c * 2] - flat[a * 2]);
      for (const k of area < 0 ? [a, c, b] : [a, b, c]) {
        outFaces.push(faces[at + k]);
        outCorners.push(cornerOf[at + k]);
      }
    }
  }
  return split
    ? { counts: Uint32Array.from(outCounts), faces: Uint32Array.from(outFaces), source: Uint32Array.from(outSource), cornerOf: Uint32Array.from(outCorners) }
    : undefined;
}
const levels = new WeakMap<object, number>();
/** The level the whole stage fits at: faces of all its subdivided meshes, four times more with each level past the first. */
function levelFor(read: MeshRead, wanted: number): number {
  const known = levels.get(read.specs);
  if (known !== undefined) return known;
  let corners = 0;
  for (const path in read.specs) {
    const fields = read.specs[path].fields;
    if (fields.typeName !== 'Mesh') continue;
    if ((read.attr(path, 'subdivisionScheme') ?? 'catmullClark') === 'none') continue;
    corners += numbers(read.attr(path, 'faceVertexIndices')).length;
  }
  let level = wanted;
  while (level > 0 && corners * 2 * 4 ** (level - 1) > read.maxTriangles) level--;
  if (level < wanted) read.soft(`subdivision level ${wanted} would pass maxTriangles; the stage uses level ${level}`);
  levels.set(read.specs, level);
  return level;
}
function shape(read: MeshRead, wanted: number): MeshShape | undefined {
  const scheme = read.value('subdivisionScheme') ?? 'catmullClark',
    holeList = numbers(read.value('holeIndices')),
    smooth = scheme !== 'none',
    level = smooth ? levelFor(read, wanted) : 0;
  if (read.value('triangleSubdivisionRule') === 'smooth') read.soft(`${read.path} asks for the smooth triangle rule; it refines by the standard one`);
  const { cage, source: kept, cornerOf: cornersKept, dropped } = authored(read, scheme === 'bilinear', scheme === 'loop'),
    boundary = read.value('interpolateBoundary') ?? 'edgeAndCorner',
    { onBoundary, facesAt } = boundaryPoints(cage);
  if (smooth && boundary === 'edgeAndCorner') for (const v of onBoundary) if (facesAt[v] === 1) cage.corners.set(v, Infinity);
  const holes = new Set<number>(Array.from(holeList));
  if (smooth && boundary === 'none')
    for (let f = 0, at = 0; f < cage.counts.length; at += cage.counts[f++])
      for (let c = 0; c < cage.counts[f]; c++) if (onBoundary.has(cage.faces[at + c])) holes.add(kept[f]);
  if (!smooth && !holes.size) {
    const split = splitConcave(cage.counts, cage.faces, read.points, kept, cornersKept);
    if (!split && !dropped) return undefined;
  }
  // Each level's faces follow their parent's, so a face's source repeats in order.
  const stencils: Stencil[] = [];
  let now = cage,
    source = kept,
    values: ArrayLike<number> = read.points;
  /** The authored corner behind each corner of the last level, by following first corners down: only level 0 keeps it. */
  for (let i = 0; i < level; i++) {
    const { cage: next, stencil } = refine(now),
      expanded = new Uint32Array(next.counts.length);
    let at = 0;
    for (let f = 0; f < now.counts.length; f++) for (let c = now.loop ? 4 : now.counts[f]; c > 0; c--) expanded[at++] = source[f];
    source = expanded;
    values = apply(stencil, values, 3);
    stencils.push(stencil);
    now = next;
  }
  const spread = (stream: ArrayLike<number>, width: number) => {
    let out = stream;
    for (const stencil of stencils) out = apply(stencil, out, width);
    return Float32Array.from(out);
  };
  // What is left after holes. A level-0 mesh also splits its concave faces.
  let counts = now.counts,
    faces = now.faces,
    cornerOf = level ? undefined : cornersKept;
  if (!level) {
    const split = splitConcave(counts, faces, values, source, cornersKept);
    if (split) ({ counts, faces, source, cornerOf } = split);
  }
  const normalsAll = smooth && level ? normalsOf(now, values, read.flip ? -1 : 1) : undefined,
    sourceAll = source,
    keptFace = (f: number) => !holes.has(source[f]);
  let cornerKeep: Uint32Array | undefined;
  if (holes.size) {
    const listCounts: number[] = [],
      listFaces: number[] = [],
      listSource: number[] = [],
      listCorners: number[] = [];
    for (let f = 0, at = 0; f < counts.length; at += counts[f++]) {
      if (!keptFace(f)) continue;
      listCounts.push(counts[f]);
      listSource.push(source[f]);
      for (let c = 0; c < counts[f]; c++) {
        listFaces.push(faces[at + c]);
        listCorners.push(at + c);
      }
    }
    counts = Uint32Array.from(listCounts);
    faces = Uint32Array.from(listFaces);
    source = Uint32Array.from(listSource);
    cornerKeep = Uint32Array.from(listCorners);
    if (cornerOf) cornerOf = cornerKeep.map((c) => cornerOf![c]);
  }
  const keep = <T extends Float32Array>(perCorner: T, width: number): Float32Array => {
    if (!cornerKeep) return perCorner;
    const out = new Float32Array(cornerKeep.length * width);
    cornerKeep.forEach((c, i) => {
      for (let d = 0; d < width; d++) out[i * width + d] = perCorner[c * width + d];
    });
    return out;
  };
  /** Refined face-varying data: seams between values are boundaries of a cage of their own. */
  const faceVarying = (stream: ArrayLike<number>, width: number, ids: Uint32Array, size: number, varying: boolean) => {
    const rule = varying ? 'all' : (read.value('faceVaryingLinearInterpolation') ?? 'cornersPlus1'),
      fv: Cage = { size, counts: cage.counts, faces: ids, creases: new Map(), corners: new Map(), linear: rule === 'all' || scheme === 'bilinear', loop: cage.loop },
      { onBoundary: seam, facesAt: on } = boundaryPoints(fv);
    // These rules cannot make values smoother than the points, as OpenSubdiv's documentation says: the mesh's sharpness holds here too.
    for (let f = 0, at = 0; f < cage.counts.length; at += cage.counts[f++])
      for (let c = 0; c < cage.counts[f]; c++) {
        const here = at + c,
          next = at + ((c + 1) % cage.counts[f]),
          amount = cage.creases.get(edgeKey(cage.faces[here], cage.faces[next], cage.size));
        if (amount) fv.creases.set(edgeKey(ids[here], ids[next], size), amount);
        const corner = cage.corners.get(cage.faces[here]);
        if (corner) fv.corners.set(ids[here], corner);
      }
    if (rule !== 'none') for (const v of seam) if (rule === 'boundaries' || on[v] === 1) fv.corners.set(v, Infinity);
    if (rule === 'cornersPlus1' || rule === 'cornersPlus2') {
      // Sharp where three or more regions meet, and with the second rule at darts and concave corners. What counts as a concave
      // corner was observed black box on our own stages: the region across from a corner held by one face.
      const seen = new Map<number, Set<number>>();
      cage.faces.forEach((point, c) => {
        const list = seen.get(point);
        if (list) list.add(ids[c]);
        else seen.set(point, new Set([ids[c]]));
      });
      for (const [point, list] of seen) {
        const values = [...list],
          // A seam that ends at this point, and a region across from a lone face's corner.
          dart = values.length === 1 && seam.has(values[0]) && !onBoundary.has(point),
          concave = values.length === 2 && (on[values[0]] === 1 || on[values[1]] === 1);
        if (values.length > 2 || (rule === 'cornersPlus2' && (dart || concave))) for (const v of values) fv.corners.set(v, Infinity);
      }
    }
    let walk = fv,
      data: ArrayLike<number> = stream;
    for (let i = 0; i < level; i++) {
      const { cage: next, stencil } = refine(walk);
      data = apply(stencil, data, width);
      walk = next;
    }
    const out = new Float32Array(walk.faces.length * width);
    walk.faces.forEach((id, c) => {
      for (let d = 0; d < width; d++) out[c * width + d] = data[id * width + d];
    });
    return out;
  };
  const pointCount = read.points.length / 3,
    allCorners = read.faces.length;
  return {
    points: Float32Array.from(values),
    counts,
    faces,
    face: source,
    normals: normalsAll && keep(normalsAll, 3),
    spread: level ? spread : undefined,
    influences: level
      ? (joints, weights, width) => {
          let j: ArrayLike<number> = joints,
            w: ArrayLike<number> = weights;
          for (const { size, rows, parents, weights: share } of stencils) {
            const nextJ = new Uint16Array(size * width),
              nextW = new Float32Array(size * width);
            for (let v = 0; v < size; v++) {
              const sum = new Map<number, number>();
              for (let i = rows[v]; i < rows[v + 1]; i++)
                for (let k = 0; k < width; k++) {
                  const amount = w[parents[i] * width + k] * share[i];
                  if (amount) sum.set(j[parents[i] * width + k], (sum.get(j[parents[i] * width + k]) ?? 0) + amount);
                }
              const best = [...sum].sort((a, b) => b[1] - a[1]).slice(0, width),
                all = [...sum.values()].reduce((total, amount) => total + amount, 0),
                kept = best.reduce((total, item) => total + item[1], 0) || 1;
              best.forEach(([joint, amount], k) => {
                nextJ[v * width + k] = joint;
                nextW[v * width + k] = (amount * all) / kept;
              });
            }
            j = nextJ;
            w = nextW;
          }
          return { joints: j as Uint16Array, weights: w as Float32Array };
        }
      : undefined,
    corners(stream, width, indices, interpolation) {
      const kind =
          interpolation ??
          (stream.length === pointCount * width ? 'vertex' : stream.length === allCorners * width ? 'faceVarying' : stream.length === width ? 'constant' : 'uniform'),
        out = new Float32Array((level ? now.faces.length : faces.length) * width);
      if (level === 0) {
        const count = faces.length,
          flatOut = new Float32Array(count * width);
        let corner = 0;
        for (let f = 0; f < counts.length; f++)
          for (let c = 0; c < counts[f]; c++, corner++) {
            const authoredCorner = cornerOf![corner],
              point = read.faces[authoredCorner],
              slot = kind === 'constant' ? 0 : kind === 'uniform' ? source[f] : kind === 'faceVarying' ? authoredCorner : point,
              at = indices ? indices[slot] : slot;
            for (let d = 0; d < width; d++) flatOut[corner * width + d] = stream[at * width + d];
          }
        return flatOut;
      }
      if (kind === 'constant' || kind === 'uniform') {
        let corner = 0;
        for (let f = 0; f < now.counts.length; f++)
          for (let c = 0; c < now.counts[f]; c++, corner++) {
            const slot = kind === 'constant' ? 0 : sourceAll[f],
              at = indices ? indices[slot] : slot;
            for (let d = 0; d < width; d++) out[corner * width + d] = stream[at * width + d];
          }
        return keep(out, width);
      }
      if (kind === 'vertex') {
        const data = new Float64Array(pointCount * width);
        for (let p = 0; p < pointCount; p++) {
          const at = indices ? indices[p] : p;
          for (let d = 0; d < width; d++) data[p * width + d] = stream[at * width + d];
        }
        const refined = spread(data, width);
        now.faces.forEach((point, c) => {
          for (let d = 0; d < width; d++) out[c * width + d] = refined[point * width + d];
        });
        return keep(out, width);
      }
      // Values shared between faces at a point stay one value: that is what joins them. Equal numbers join too.
      const ids = new Uint32Array(cage.faces.length),
        known = new Map<string, number>(),
        data: number[] = [];
      cornersKept.forEach((authoredCorner, c) => {
        const slot = kind === 'varying' ? read.faces[authoredCorner] : authoredCorner,
          at = indices ? indices[slot] : slot,
          row = Array.from({ length: width }, (_, d) => stream[at * width + d]),
          key = cage.faces[c] + ':' + row.join();
        let id = known.get(key);
        if (id === undefined) {
          id = data.length / width;
          known.set(key, id);
          data.push(...row);
        }
        ids[c] = id;
      });
      return keep(faceVarying(data, width, ids, data.length / width, kind === 'varying'), width);
    },
  };
}

/**
 * Subdivision surfaces, hole faces and concave polygons for the USD readers: pass `extensions: [composition(), subdivision()]`.
 * Meshes refine by their `subdivisionScheme`, which USD defaults to Catmull-Clark, so give polygon models `none`.
 */
export function subdivision(options: SubdivisionOptions = {}): USDExtension {
  const level = options.level ?? 2;
  if (!Number.isInteger(level) || level < 0 || level > 6) throw new RangeError(`subdivision level ${level} is invalid; pass a whole number from 0 to 6`);
  const hook: ExtensionHooks & { options: SubdivisionOptions } = { name: 'subdiv', options, shape: (read) => shape(read, level) };
  return hook;
}
