/** Offline authoring checks for garments built around an existing character rig. */
export type WardrobePoint = readonly [number, number, number];

/** Indexed garment triangles in one coordinate space. */
export interface GarmentShell {
  readonly positions: ArrayLike<number>;
  readonly indices: ArrayLike<number>;
}

/** Boundary loops and connectivity defects found in a garment shell. */
export interface GarmentTopology {
  /** Closed, simple boundary loops, as indices into the original positions. */
  readonly openings: readonly (readonly number[])[];
  readonly irregularBoundaries: number;
  readonly zeroAreaFaces: number;
  readonly nonManifoldEdges: number;
  readonly inconsistentEdges: number;
}

type Edge = { readonly from: number; readonly to: number; count: number; signedCount: number };

function positionAt(positions: ArrayLike<number>, index: number): WardrobePoint {
  return [positions[index * 3], positions[index * 3 + 1], positions[index * 3 + 2]];
}

function subtract(a: WardrobePoint, b: WardrobePoint): WardrobePoint {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function cross(a: WardrobePoint, b: WardrobePoint): WardrobePoint {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function dot(a: WardrobePoint, b: WardrobePoint): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function unit(v: WardrobePoint): WardrobePoint {
  const length = Math.hypot(...v);
  if (length === 0 || !Number.isFinite(length)) throw new RangeError('Wardrobe direction must be finite and nonzero');
  return [v[0] / length, v[1] / length, v[2] / length];
}

function positionCount(positions: ArrayLike<number>): number {
  if (!Number.isSafeInteger(positions.length) || positions.length % 3 || positions.length === 0) {
    throw new RangeError('Wardrobe positions must contain one or more XYZ triples');
  }
  for (let i = 0; i < positions.length; i++) {
    if (!Number.isFinite(positions[i])) throw new RangeError('Wardrobe positions must be finite');
  }
  return positions.length / 3;
}

/** Inspect indexed triangles. Coincident positions are joined for UV and normal seams. */
export function inspectGarment(shell: GarmentShell): GarmentTopology {
  const { positions, indices } = shell;
  const count = positionCount(positions);
  if (indices.length === 0 || indices.length % 3) throw new RangeError('Wardrobe indices must contain triangles');
  const coincident = new Map<string, number>();
  const welded = new Uint32Array(count);
  for (let i = 0; i < count; i++) {
    const key = positionAt(positions, i).join(',');
    const original = coincident.get(key);
    welded[i] = original ?? i;
    if (original === undefined) coincident.set(key, i);
  }
  const edges = new Map<string, Edge>();
  let zeroAreaFaces = 0;
  for (let face = 0; face < indices.length; face += 3) {
    const triangle = [indices[face], indices[face + 1], indices[face + 2]];
    if (triangle.some((i) => !Number.isInteger(i) || i < 0 || i >= count)) {
      throw new RangeError('Wardrobe triangle indices must refer to an existing position');
    }
    const [a, b, c] = triangle.map((i) => positionAt(positions, i));
    if (Math.hypot(...cross(subtract(b, a), subtract(c, a))) === 0) {
      zeroAreaFaces++;
      continue;
    }
    for (let i = 0; i < 3; i++) {
      const from = welded[triangle[i]],
        to = welded[triangle[(i + 1) % 3]];
      const key = from < to ? from + ':' + to : to + ':' + from;
      const edge = edges.get(key) ?? { from, to, count: 0, signedCount: 0 };
      edge.count++;
      edge.signedCount += from < to ? 1 : -1;
      edges.set(key, edge);
    }
  }
  let nonManifoldEdges = 0,
    inconsistentEdges = 0;
  const neighbours = new Map<number, number[]>();
  for (const edge of edges.values()) {
    if (edge.count > 2) nonManifoldEdges++;
    if (edge.count === 2 && edge.signedCount !== 0) inconsistentEdges++;
    if (edge.count !== 1) continue;
    for (const [a, b] of [
      [edge.from, edge.to],
      [edge.to, edge.from],
    ]) {
      const ring = neighbours.get(a) ?? [];
      ring.push(b);
      neighbours.set(a, ring);
    }
  }
  let irregularBoundaries = 0;
  const openings: number[][] = [];
  const unvisited = new Set(neighbours.keys());
  for (const start of unvisited) {
    const component = [start];
    unvisited.delete(start);
    for (let i = 0; i < component.length; i++) {
      for (const next of neighbours.get(component[i])!) if (unvisited.delete(next)) component.push(next);
    }
    if (component.some((i) => neighbours.get(i)!.length !== 2)) {
      irregularBoundaries++;
      continue;
    }
    const loop = [start];
    do {
      const [first, second] = neighbours.get(loop[loop.length - 1])!;
      loop.push(first === loop[loop.length - 2] ? second : first);
    } while (loop[loop.length - 1] !== start);
    loop.pop();
    openings.push(loop);
  }
  return { openings, irregularBoundaries, zeroAreaFaces, nonManifoldEdges, inconsistentEdges };
}

/** Measurements in mesh units relative to the selected forearm axis. */
export interface CuffMeasurement {
  /** Mean signed displacement of the opening along the forearm, relative to the wrist. */
  readonly axialOffset: number;
  readonly radialOffset: number;
  /** Full spread of the seam along the forearm. */
  readonly axialSpread: number;
  readonly minimumRadius: number;
}

/** Measure the perimeter of a cuff opening against its elbow and wrist landmarks. */
export function measureCuff(
  positions: ArrayLike<number>,
  opening: ArrayLike<number>,
  elbow: WardrobePoint,
  wrist: WardrobePoint,
): CuffMeasurement {
  const count = positionCount(positions);
  if (opening.length < 3 || !wrist.every(Number.isFinite))
    throw new RangeError('Cuff measurement needs a finite wrist and at least three boundary vertices');
  const direction = unit(subtract(wrist, elbow));
  const centre: [number, number, number] = [0, 0, 0];
  const samples: WardrobePoint[] = [];
  const visited = new Set<number>();
  let low = Infinity,
    high = -Infinity;
  for (let i = 0; i < opening.length; i++) {
    const vertex = opening[i];
    if (!Number.isInteger(vertex) || vertex < 0 || vertex >= count || visited.has(vertex)) {
      throw new RangeError('Cuff loop needs distinct vertex indices in range');
    }
    visited.add(vertex);
    const offset = subtract(positionAt(positions, vertex), wrist);
    const depth = dot(offset, direction);
    low = Math.min(low, depth);
    high = Math.max(high, depth);
    samples.push(offset);
  }
  let perimeter = 0;
  for (let i = 0; i < samples.length; i++) {
    const a = samples[i],
      b = samples[(i + 1) % samples.length];
    const length = Math.hypot(...subtract(a, b));
    perimeter += length;
    for (let c = 0; c < 3; c++) centre[c] += (a[c] + b[c]) * 0.5 * length;
  }
  if (!(perimeter > 0) || !Number.isFinite(perimeter))
    throw new RangeError('Cuff loop must have a finite positive perimeter');
  for (let c = 0; c < 3; c++) centre[c] /= perimeter;
  const axialOffset = dot(centre, direction);
  const radialOffset = Math.hypot(...cross(centre, direction));
  let minimumRadius = Infinity;
  for (let i = 0; i < samples.length; i++) {
    const a = cross(subtract(samples[i], centre), direction);
    const b = cross(subtract(samples[(i + 1) % samples.length], centre), direction);
    const edge = subtract(b, a),
      lengthSquared = dot(edge, edge);
    const fraction = lengthSquared > 0 ? Math.max(0, Math.min(1, -dot(a, edge) / lengthSquared)) : 0;
    minimumRadius = Math.min(
      minimumRadius,
      Math.hypot(a[0] + fraction * edge[0], a[1] + fraction * edge[1], a[2] + fraction * edge[2]),
    );
  }
  return { axialOffset, radialOffset, axialSpread: high - low, minimumRadius };
}

/** One fitted elliptical cross section along a sleeve. */
export interface SleeveStation {
  /** Section centre along the bind-pose sleeve. The final station is the outer wrist edge. */
  readonly centre: WardrobePoint;
  readonly radii: readonly [number, number];
  /** Influence of the forearm bone. The remaining weight goes to the upper arm. */
  readonly forearm: number;
}

/** Joint palette indices and the dimensions of the sleeve and folded cuff. */
export interface SleeveOptions {
  /** Vertex segments around each ring, default 24. */
  readonly segments?: number;
  /** Inner fold length along the forearm, in garment units. */
  readonly turnback: number;
  /** Wool thickness at the cuff edge, in garment units. */
  readonly thickness: number;
  readonly upperJoint: number;
  readonly forearmJoint: number;
}

/** Skinned sleeve geometry with UV coordinates and open rims. */
export interface TailoredSleeve {
  readonly positions: Float32Array;
  readonly indices: Uint32Array;
  readonly normals: Float32Array;
  readonly uv: Float32Array;
  readonly joints: Uint16Array;
  readonly weights: Float32Array;
}

/** Build a skinned sleeve with a turned, open cuff from fitted bind-pose stations. */
export function buildSleeve(stations: readonly SleeveStation[], options: SleeveOptions): TailoredSleeve {
  const { thickness, turnback, upperJoint, forearmJoint, segments = 24 } = options;
  const jointIndices = [upperJoint, forearmJoint];
  if (
    !jointIndices.every((index) => Number.isInteger(index) && index >= 0 && index <= 65535) ||
    !Number.isInteger(segments) ||
    segments < 6 ||
    segments > 256 ||
    stations.length < 2 ||
    !Number.isFinite(thickness) ||
    thickness <= 0 ||
    !Number.isFinite(turnback) ||
    turnback <= 0 ||
    stations.some(
      (s) =>
        !s.centre.every(Number.isFinite) ||
        !s.radii.every((r) => Number.isFinite(r) && r > thickness) ||
        !Number.isFinite(s.forearm) ||
        s.forearm < 0 ||
        s.forearm > 1,
    )
  ) {
    throw new RangeError('Sleeve stations, joint indices and cuff dimensions must be within the documented ranges');
  }
  const last = stations[stations.length - 1];
  const forward = unit(subtract(last.centre, stations[0].centre));
  const horizontal = unit(cross(Math.abs(forward[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0], forward));
  const vertical = cross(forward, horizontal);
  const depths = stations.map((s) => dot(subtract(s.centre, stations[0].centre), forward));
  if (depths.some((depth, i) => i > 0 && depth <= depths[i - 1]) || turnback >= depths[depths.length - 1]) {
    throw new RangeError('Sleeve stations must advance toward the cuff and leave room for its turnback');
  }
  const inner: SleeveStation = { ...last, radii: [last.radii[0] - thickness, last.radii[1] - thickness] };
  const folded: SleeveStation = {
    ...inner,
    centre: [
      last.centre[0] - forward[0] * turnback,
      last.centre[1] - forward[1] * turnback,
      last.centre[2] - forward[2] * turnback,
    ],
  };
  const rings = [...stations, inner, folded];
  const stride = segments + 1,
    count = stride * rings.length;
  const positions = new Float32Array(count * 3),
    normals = new Float32Array(count * 3);
  const uv = new Float32Array(count * 2),
    joints = new Uint16Array(count * 4),
    weights = new Float32Array(count * 4);
  const indices = new Uint32Array((rings.length - 1) * segments * 6);
  let tri = 0;
  for (let r = 0; r < rings.length; r++) {
    const { centre, radii, forearm } = rings[r];
    for (let j = 0; j <= segments; j++) {
      const at = r * stride + j;
      const angle = (2 * Math.PI * (j % segments)) / segments;
      const a = Math.cos(angle),
        b = Math.sin(angle);
      const normal = unit([
        (horizontal[0] * a) / radii[0] + (vertical[0] * b) / radii[1],
        (horizontal[1] * a) / radii[0] + (vertical[1] * b) / radii[1],
        (horizontal[2] * a) / radii[0] + (vertical[2] * b) / radii[1],
      ]);
      for (let k = 0; k < 3; k++) {
        positions[at * 3 + k] = centre[k] + horizontal[k] * a * radii[0] + vertical[k] * b * radii[1];
        normals[at * 3 + k] = r < stations.length ? normal[k] : -normal[k];
      }
      uv.set([j / segments, r / (rings.length - 1)], at * 2);
      joints.set(jointIndices, at * 4);
      weights.set([1 - forearm, forearm], at * 4);
      if (r === rings.length - 1 || j === segments) continue;
      indices.set([at, at + 1, at + stride, at + 1, at + stride + 1, at + stride], tri);
      tri += 6;
    }
  }
  return { positions, normals, indices, uv, joints, weights };
}

/** A posed inner surface, compatible with the CPU MeshBVH tree. */
export interface WardrobeCollider {
  raycast(
    ray: { readonly origin: WardrobePoint; readonly direction: WardrobePoint },
    options: { readonly side: 'double'; readonly maxDistance: number },
  ): readonly { readonly distance: number }[];
}

/** Axis, clearance and selected vertices for a radial layer adjustment. */
export interface LayerClearanceOptions {
  readonly origin: WardrobePoint;
  readonly axis: WardrobePoint;
  /** Surface ease. Default 0.01 in mesh units. */
  readonly ease?: number;
  /** Maximum correction from the uncorrected garment, in mesh units. */
  readonly maxPush: number;
  /** Optional per-vertex selection. Use it to exclude sleeves, openings and pins. */
  readonly vertices?: ArrayLike<number>;
}

/** An adjusted pose and counts of vertices moved or limited by the push allowance. */
export interface LayerClearance {
  /** Absolute corrected world positions, with unselected vertices preserved. */
  readonly positions: Float32Array;
  readonly corrected: number;
  /** Selected vertices still lacking clearance because the configured push was insufficient. */
  readonly limited: number;
}

/** Project a layer away from inner posed geometry radially about its longitudinal axis. */
export function clearGarmentLayer(
  positions: ArrayLike<number>,
  collider: WardrobeCollider,
  options: LayerClearanceOptions,
): LayerClearance {
  const count = positionCount(positions);
  const { origin, axis, ease = 0.01, maxPush, vertices } = options;
  if (!origin.every(Number.isFinite) || !Number.isFinite(ease) || ease < 0 || !Number.isFinite(maxPush) || maxPush <= 0)
    throw new RangeError('Layer clearance needs a finite origin, nonnegative ease and positive maximum push');
  const longitudinal = unit(axis);
  const output = Float32Array.from(positions);
  let corrected = 0,
    limited = 0;
  const selection = vertices ? new Set<number>() : undefined;
  for (let i = 0; i < (vertices?.length ?? count); i++) {
    const vertex = vertices ? vertices[i] : i;
    if (!Number.isInteger(vertex) || vertex < 0 || vertex >= count)
      throw new RangeError('Garment vertex selection must contain integer indices within the mesh');
    if (selection?.has(vertex)) throw new RangeError('Garment vertex selection must be unique');
    selection?.add(vertex);
    const point = positionAt(positions, vertex),
      depth = dot(subtract(point, origin), longitudinal);
    const centre: WardrobePoint = [
      origin[0] + depth * longitudinal[0],
      origin[1] + depth * longitudinal[1],
      origin[2] + depth * longitudinal[2],
    ];
    const radial = subtract(point, centre);
    const radius = Math.hypot(...radial);
    if (radius === 0) continue;
    const direction = unit(radial);
    let outermost = 0;
    // The collider may have several surfaces on one ray, for example opposite trouser legs.
    for (const hit of collider.raycast({ origin: centre, direction }, { side: 'double', maxDistance: Infinity })) {
      outermost = Math.max(outermost, hit.distance);
    }
    const distance = outermost + ease - radius;
    if (outermost === 0 || distance <= 0) continue;
    if (distance > maxPush) limited++;
    corrected++;
    const push = Math.min(distance, maxPush);
    for (let c = 0; c < 3; c++) output[vertex * 3 + c] = point[c] + push * direction[c];
  }
  return { positions: output, corrected, limited };
}
