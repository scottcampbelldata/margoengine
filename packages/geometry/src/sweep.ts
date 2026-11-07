// Sweeping a profile along a curve and lofting between profiles. Both build a grid of points, rows along the length and
// columns around the profile, and share one skinning step: a column is split in two where the profile has a corner, and
// normals are summed from the faces on each side, across the seams, so a smooth surface stays smooth at its first row
// and column.
import { type Curve, perpendicular } from './curve.js';
import type { GeometryData, GeometryGroup } from './data.js';
import { triangulateConstrained } from './delaunay.js';
import { type MutableVec2, type MutableVec3, type Vec, cross, dot, normalize, to3 } from './math.js';
import type { Path, Shape } from './path.js';

/** A ring of `[x, y]` points, a `Shape` (with its holes) or a `Path`. */
export type SweepProfile = readonly MutableVec2[] | Shape | Path;

/** A size along the length: the same on both axes, or `[x, y]`. */
export type SweepScale = number | readonly [number, number];

/** Options shared by {@link sweepGeometry} and {@link loftGeometry}. */
export interface SurfaceOptions {
  /** Close the ends with flat caps. Default true. */
  caps?: boolean;
  /** Corners of the profile sharper than this many degrees get a hard edge. Default 40. */
  creaseAngle?: number;
  /** Points per curve when a profile is a `Shape` or `Path`. Default 12. */
  curveSegments?: number;
}

/** Options of {@link sweepGeometry}. */
export interface SweepOptions extends SurfaceOptions {
  /** Rows along the path. Default 64. */
  steps?: number;
  /** The path is a loop. Scale and twist should then match at both ends. Default false. */
  closed?: boolean;
  /** The profile is a line, not a ring: the result is an open ribbon. Default true. */
  closedProfile?: boolean;
  /** Scale of the profile: one value, or a function of `t`, the share of the path's length from 0 to 1. Default 1. */
  scale?: SweepScale | ((t: number) => SweepScale);
  /** Turn of the profile in radians: the total over the path, or a function of `t`. Default 0. */
  twist?: number | ((t: number) => number);
  /** Keep the profile's +y leaning towards this direction, for rails that must stay level. Default: frames that turn only with the path. */
  up?: readonly [number, number, number];
}

/** A profile placed in space. */
export interface LoftPlacement {
  profile: SweepProfile;
  /** Centre of the profile's plane. Default `[0, 0, i]` for section `i`. */
  position?: readonly [number, number, number];
  /** Direction the plane faces. Default `[0, 0, 1]`. */
  normal?: readonly [number, number, number];
  /** Size of the profile. Default 1. */
  scale?: SweepScale;
}

/** A section of a loft: a profile placed by default, a {@link LoftPlacement}, or a ring of `[x, y, z]` points. */
export type LoftSection = SweepProfile | LoftPlacement | readonly MutableVec3[];

/** Options of {@link loftGeometry}. */
export interface LoftOptions extends SurfaceOptions {
  /** Pass through the sections on a smooth curve instead of straight lines. Default true. */
  smooth?: boolean;
  /** Rows between neighbouring sections. Default 8 when smooth, or else 1. */
  steps?: number;
  /** Join the last section back to the first. Default false. */
  closed?: boolean;
  /** Points around every section, evenly spaced. Default: every point of every section, so all corners stay. */
  segments?: number;
  /** Turn each ring's starting point to the one that twists least against the section before. Default true. */
  align?: boolean;
}

/** Vertices, normals and UVs in the making; caps come first in the result, as in `extrudeGeometry`. */
class Surface {
  positions: number[] = [];
  normals: number[] = [];
  uvs: number[] = [];
  caps: number[] = [];
  walls: number[] = [];

  /**
   * Adds a grid. `rows` hold xyz per column; `u` the texture position of each column, plus one more when the columns
   * wrap; `hard` the columns with an edge; `v` the texture position of each row.
   */
  strip(
    rows: readonly number[][],
    u: readonly number[],
    hard: readonly boolean[],
    wrapColumns: boolean,
    wrapRows: boolean,
    v: readonly number[],
  ): void {
    const count = rows[0].length / 3,
      columns: { column: number; slot: number; u: number }[] = [{ column: 0, slot: 0, u: u[0] }];
    let slots = 1;
    for (let j = 1; j < count; j++) {
      columns.push({ column: j, slot: slots++, u: u[j] });
      if (hard[j]) columns.push({ column: j, slot: slots++, u: u[j] });
    }
    if (wrapColumns) columns.push({ column: 0, slot: hard[0] ? slots++ : 0, u: u[count] });
    const rowSlots = wrapRows ? rows.length - 1 : rows.length,
      sums = new Float64Array(rowSlots * slots * 3),
      first = this.positions.length / 3,
      width = columns.length,
      slotOf = (i: number, k: number) => ((i % rowSlots) * slots + columns[k].slot) * 3;
    rows.forEach((row, i) => {
      for (const { column, u: across } of columns) {
        this.positions.push(row[column * 3], row[column * 3 + 1], row[column * 3 + 2]);
        this.uvs.push(across, v[i]);
      }
    });
    const face = (i0: number, k0: number, i1: number, k1: number, i2: number, k2: number) => {
      const a = (first + i0 * width + k0) * 3,
        b = (first + i1 * width + k1) * 3,
        c = (first + i2 * width + k2) * 3,
        P = this.positions,
        ab: MutableVec3 = [P[b] - P[a], P[b + 1] - P[a + 1], P[b + 2] - P[a + 2]],
        bc: MutableVec3 = [P[c] - P[b], P[c + 1] - P[b + 1], P[c + 2] - P[b + 2]],
        ca: MutableVec3 = [P[a] - P[c], P[a + 1] - P[c + 1], P[a + 2] - P[c + 2]],
        n = cross(ab, bc),
        size = Math.hypot(n[0], n[1], n[2]);
      if (!size) return;
      this.walls.push(a / 3, b / 3, c / 3);
      // Each corner counts by its angle, so how a quad was cut in two does not tilt the normal.
      const corners: readonly [number, MutableVec3, MutableVec3][] = [
        [slotOf(i0, k0), ab, ca],
        [slotOf(i1, k1), bc, ab],
        [slotOf(i2, k2), ca, bc],
      ];
      for (const [s, out, into] of corners) {
        const angle = Math.atan2(size, -dot(out, into)) / size;
        sums[s] += n[0] * angle;
        sums[s + 1] += n[1] * angle;
        sums[s + 2] += n[2] * angle;
      }
    };
    for (let i = 0; i + 1 < rows.length; i++)
      for (let k = 0; k + 1 < width; k++) {
        if (columns[k].column === columns[k + 1].column) continue;
        face(i, k, i, k + 1, i + 1, k + 1);
        face(i, k, i + 1, k + 1, i + 1, k);
      }
    for (let i = 0; i < rows.length; i++)
      for (let k = 0; k < width; k++) {
        // At a point where the profile shrinks to nothing, some columns touch no face: the nearest row speaks for them.
        let s = slotOf(i, k);
        for (let d = 1; !sums[s] && !sums[s + 1] && !sums[s + 2] && d < rows.length; d++)
          s = slotOf(i + d < rows.length ? i + d : Math.max(i - d, 0), k);
        const n = normalize([sums[s], sums[s + 1], sums[s + 2]]);
        this.normals.push(n[0], n[1], n[2]);
      }
  }

  /** Adds a flat cap over the points of `row`, with UVs from the flat points `flat` fitted to the unit square. */
  cap(row: readonly number[], flat: readonly MutableVec2[], triangles: readonly number[], normal: MutableVec3, flip: boolean) {
    let minX = Infinity,
      minY = Infinity,
      maxX = -Infinity,
      maxY = -Infinity;
    for (const [x, y] of flat) {
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
    const first = this.positions.length / 3,
      sizeX = maxX - minX || 1,
      sizeY = maxY - minY || 1;
    flat.forEach(([x, y], i) => {
      this.positions.push(row[i * 3], row[i * 3 + 1], row[i * 3 + 2]);
      this.normals.push(normal[0], normal[1], normal[2]);
      this.uvs.push((x - minX) / sizeX, (y - minY) / sizeY);
    });
    for (let t = 0; t < triangles.length; t += 3)
      if (flip) this.caps.push(first + triangles[t], first + triangles[t + 2], first + triangles[t + 1]);
      else this.caps.push(first + triangles[t], first + triangles[t + 1], first + triangles[t + 2]);
  }

  done(): GeometryData {
    const groups: GeometryGroup[] = [];
    if (this.caps.length) {
      groups.push({ start: 0, count: this.caps.length, materialIndex: 0 });
      groups.push({ start: this.caps.length, count: this.walls.length, materialIndex: 1 });
    }
    const data: GeometryData = {
      positions: Float32Array.from(this.positions),
      normals: Float32Array.from(this.normals),
      uvs: Float32Array.from(this.uvs),
      indices: Uint32Array.from([...this.caps, ...this.walls]),
    };
    if (groups.length) data.groups = groups;
    return data;
  }
}

/** Removes repeated points, including a last point that repeats the first of a ring. */
function distinct<P extends readonly number[]>(points: readonly P[], ring: boolean): P[] {
  const same = (a: P, b: P) => a.every((x, i) => x === b[i]),
    out = points.filter((p, i) => !i || !same(p, points[i - 1]));
  if (ring && out.length > 1 && same(out[0], out[out.length - 1])) out.pop();
  for (const p of out)
    if (!p.every(Number.isFinite)) throw new RangeError('Invalid profile point; pass finite coordinates');
  return out;
}

function flatArea(ring: readonly MutableVec2[]): number {
  let sum = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i],
      b = ring[(i + 1) % ring.length];
    sum += a[0] * b[1] - a[1] * b[0];
  }
  return sum;
}

const facing = (ring: MutableVec2[], sign: number): MutableVec2[] =>
  flatArea(ring) * sign < 0 ? ring.slice().reverse() : ring;

/** A profile's rings: the outline counter-clockwise and any holes clockwise, so walls face out of the solid. */
function profileRings(profile: SweepProfile, segments: number, ring: boolean): MutableVec2[][] {
  let contour: readonly MutableVec2[],
    holes: readonly (readonly MutableVec2[])[] = [];
  if (Array.isArray(profile)) contour = profile as readonly MutableVec2[];
  else if ('extractPoints' in profile) ({ shape: contour, holes } = (profile as Shape).extractPoints(segments));
  else if ('getPoints' in profile) contour = (profile as Path).getPoints(segments);
  else throw new TypeError('Invalid profile; pass a ring of [x, y] points, a Shape or a Path');
  const outline = distinct(contour, ring);
  if (outline.length < (ring ? 3 : 2))
    throw new RangeError(`Profile of ${outline.length} points; pass at least ${ring ? 3 : 2}`);
  if (!ring) return [outline];
  return [facing(outline, 1), ...holes.map((hole) => facing(distinct(hole, true), -1))];
}

/** Share of the way round each point of a line of points, ending at 1. */
function arcShares(points: readonly (readonly number[])[], ring: boolean): number[] {
  const shares = [0],
    last = ring ? points.length : points.length - 1;
  let total = 0;
  for (let i = 0; i < last; i++) {
    const a = points[i],
      b = points[(i + 1) % points.length];
    total += Math.hypot(...a.map((x, k) => x - b[k]));
    shares.push(total);
  }
  return shares.map((s) => s / (total || 1));
}

/** Whether the corner at each point turns further than `limit` radians. */
function corners(points: readonly (readonly number[])[], ring: boolean, limit: number): boolean[] {
  return points.map((b, i) => {
    if (!ring && (i === 0 || i === points.length - 1)) return false;
    const a = points[(i + points.length - 1) % points.length],
      c = points[(i + 1) % points.length],
      p = b.map((x, k) => x - a[k]),
      q = c.map((x, k) => x - b[k]),
      cosine = dot(p, q) / (Math.hypot(...p) * Math.hypot(...q) || 1);
    return Math.acos(Math.min(1, Math.max(-1, cosine))) > limit;
  });
}

function surfaceOptions(options: SurfaceOptions) {
  const { caps = true, creaseAngle = 40, curveSegments = 12 } = options;
  if (!(creaseAngle >= 0)) throw new RangeError('Invalid creaseAngle; pass degrees of 0 or more');
  return { caps, crease: (creaseAngle * Math.PI) / 180, curveSegments };
}

function steady(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 1) throw new RangeError(`Invalid ${name}; pass a whole number of at least 1`);
  return value;
}

function sizeOf(value: SweepScale): readonly [number, number] {
  const size = typeof value === 'number' ? ([value, value] as const) : value;
  if (!(size[0] >= 0 && size[1] >= 0 && Number.isFinite(size[0]) && Number.isFinite(size[1])))
    throw new RangeError('Invalid scale; pass finite values of 0 or more');
  return size;
}

/**
 * Sweeps a profile along a path, with scale and twist that may change along it. The profile's +x and +y follow the
 * path's frames, so a ring drawn around the origin stays centred on the path. Walls are group 1 and caps group 0, as
 * in `extrudeGeometry`. UVs run round the profile in u and along the path in v.
 */
export function sweepGeometry(profile: SweepProfile, path: Curve<Vec>, options: SweepOptions = {}): GeometryData {
  const { steps = 64, closed = false, closedProfile = true, scale = 1, twist = 0, up } = options,
    { caps, crease, curveSegments } = surfaceOptions(options);
  steady(steps, 'steps');
  const rings = profileRings(profile, curveSegments, closedProfile),
    frames = path.computeFrenetFrames(steps, closed),
    sizeAt = (t: number) => sizeOf(typeof scale === 'function' ? scale(t) : scale),
    turnAt = (t: number) => (typeof twist === 'function' ? twist(t) : twist * t),
    towards = up && normalize([up[0], up[1], up[2]] as MutableVec3),
    grids: number[][][] = rings.map(() => []),
    v: number[] = [];
  if (towards && !(dot(towards, towards) > 0.5)) throw new RangeError('Invalid up; pass a finite vector that is not zero');
  let lastSide: MutableVec3 | undefined;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps,
      centre = to3(path.getPointAt(t)),
      [sizeX, sizeY] = sizeAt(t),
      turn = turnAt(t),
      cosine = Math.cos(turn),
      sine = Math.sin(turn),
      tangent = frames.tangents[i];
    if (!Number.isFinite(turn)) throw new RangeError('Invalid twist; pass finite radians');
    let side = frames.normals[i],
      lift = frames.binormals[i];
    if (towards) {
      // Up across the tangent is the profile's +y. Along the tangent itself, the last direction carries on.
      const across = towards.map((x, k) => x - tangent[k] * dot(towards, tangent)) as MutableVec3;
      if (dot(across, across) > 1e-12) {
        lift = normalize(across);
        side = cross(lift, tangent);
      } else if (lastSide) {
        side = perpendicular(lastSide, tangent);
        lift = cross(tangent, side);
      }
      lastSide = side;
    }
    v.push(t);
    rings.forEach((ring, r) => {
      const row: number[] = [];
      for (const [px, py] of ring) {
        const x = px * sizeX,
          y = py * sizeY,
          a = x * cosine - y * sine,
          b = x * sine + y * cosine;
        row.push(
          centre[0] + side[0] * a + lift[0] * b,
          centre[1] + side[1] * a + lift[1] * b,
          centre[2] + side[2] * a + lift[2] * b,
        );
      }
      grids[r].push(row);
    });
  }
  const surface = new Surface();
  rings.forEach((ring, r) =>
    surface.strip(grids[r], arcShares(ring, closedProfile), corners(ring, closedProfile, crease), closedProfile, closed, v),
  );
  if (caps && closedProfile && !closed) {
    const flat = rings.flat(),
      { indices } = triangulateConstrained(rings[0], rings.slice(1)),
      ends = [
        [0, true],
        [steps, false],
      ] as const;
    for (const [i, flip] of ends) {
      const [sizeX, sizeY] = sizeAt(i / steps);
      if (!sizeX || !sizeY) continue;
      const n = frames.tangents[i];
      surface.cap(
        grids.flatMap((grid) => grid[i]),
        flat,
        indices,
        flip ? [-n[0], -n[1], -n[2]] : n,
        flip,
      );
    }
  }
  return surface.done();
}

/** Newell's normal of a ring, its length twice the ring's area. */
function ringNormal(ring: readonly MutableVec3[]): MutableVec3 {
  const n: MutableVec3 = [0, 0, 0];
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i],
      b = ring[(i + 1) % ring.length];
    n[0] += (a[1] - b[1]) * (a[2] + b[2]);
    n[1] += (a[2] - b[2]) * (a[0] + b[0]);
    n[2] += (a[0] - b[0]) * (a[1] + b[1]);
  }
  return n;
}

function centreOf(ring: readonly MutableVec3[]): MutableVec3 {
  const c: MutableVec3 = [0, 0, 0];
  for (const p of ring) for (let k = 0; k < 3; k++) c[k] += p[k] / ring.length;
  return c;
}

/** Two directions across a plane, with `normal` making a right-handed set: x stays +x and y stays +y for a +z normal. */
function planeAxes(normal: MutableVec3): [MutableVec3, MutableVec3] {
  const across = perpendicular(Math.abs(normal[0]) > 0.9 ? [0, 1, 0] : [1, 0, 0], normal);
  return [across, cross(normal, across)];
}

/** A section's rings in space: its outline, then its holes. */
function sectionRings(section: LoftSection, index: number, segments: number): MutableVec3[][] {
  const placed = !Array.isArray(section) && 'profile' in (section as object);
  if (!placed && Array.isArray(section) && (section as readonly number[][])[0]?.length === 3) {
    const ring = distinct(section as readonly MutableVec3[], true);
    if (ring.length < 3) throw new RangeError(`Loft section of ${ring.length} points; pass at least 3`);
    return [ring];
  }
  const { profile, position = [0, 0, index], normal = [0, 0, 1], scale = 1 } = (
    placed ? section : { profile: section }
  ) as LoftPlacement;
  const rings = profileRings(profile, segments, true),
    facingWay = normalize([normal[0], normal[1], normal[2]] as MutableVec3);
  if (!(dot(facingWay, facingWay) > 0.5)) throw new RangeError('Invalid section normal; pass a finite vector that is not zero');
  const [sizeX, sizeY] = sizeOf(scale),
    [across, upward] = planeAxes(facingWay);
  return rings.map((ring) =>
    ring.map(
      ([x, y]) =>
        [0, 1, 2].map((k) => position[k] + across[k] * x * sizeX + upward[k] * y * sizeY) as unknown as MutableVec3,
    ),
  );
}

/** The point a given share of the way round a ring. `shares` is from {@link arcShares}. */
function ringPoint(ring: readonly MutableVec3[], shares: readonly number[], share: number): MutableVec3 {
  let low = 0,
    high = shares.length - 1;
  while (high - low > 1) {
    const mid = (low + high) >> 1;
    if (shares[mid] <= share) low = mid;
    else high = mid;
  }
  const a = ring[low],
    b = ring[high % ring.length],
    t = (share - shares[low]) / (shares[high] - shares[low] || 1);
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

/** `ring` restarted at the point that lies closest to `reference`, with each ring's centre taken out. */
function aligned(ring: MutableVec3[], reference: readonly MutableVec3[]): MutableVec3[] {
  const samples = 64,
    stride = Math.ceil(ring.length / 256),
    from = centreOf(reference),
    to = centreOf(ring),
    referenceShares = arcShares(reference, true),
    targets: MutableVec3[] = [];
  for (let k = 0; k < samples; k++) {
    const p = ringPoint(reference, referenceShares, k / samples);
    targets.push([p[0] - from[0], p[1] - from[1], p[2] - from[2]]);
  }
  let best = ring,
    bestCost = Infinity;
  for (let start = 0; start < ring.length; start += stride) {
    const turned = ring.slice(start).concat(ring.slice(0, start)),
      shares = arcShares(turned, true);
    let cost = 0;
    for (let k = 0; k < samples; k++) {
      const p = ringPoint(turned, shares, k / samples),
        q = targets[k];
      cost += (p[0] - to[0] - q[0]) ** 2 + (p[1] - to[1] - q[1]) ** 2 + (p[2] - to[2] - q[2]) ** 2;
    }
    if (cost < bestCost) {
      bestCost = cost;
      best = turned;
    }
  }
  return best;
}

/** The union of every ring's corners as shares of the way round. */
function sharedShares(allShares: readonly (readonly number[])[]): number[] {
  const all = allShares.flatMap((shares) => shares.slice(0, -1)).sort((a, b) => a - b),
    out: number[] = [];
  for (const share of all) if (!out.length || share - out[out.length - 1] > 1e-9) out.push(share);
  return out;
}

/** Uniform Catmull-Rom through p1 and p2. */
function spline(p0: number, p1: number, p2: number, p3: number, t: number): number {
  return (
    p1 + 0.5 * t * (p2 - p0 + t * (2 * p0 - 5 * p1 + 4 * p2 - p3 + t * (3 * (p1 - p2) + p3 - p0)))
  );
}

/**
 * Skins a surface over sections that may differ in shape and point count: square to circle to star. Points are matched
 * by their share of the way round each ring, from starts chosen to twist least. By default the surface runs smoothly
 * through every section. Sections with holes skin each hole to the same hole of the next section, by their order, so every
 * section needs the same number of them. Walls are group 1 and caps group 0.
 */
export function loftGeometry(sections: readonly LoftSection[], options: LoftOptions = {}): GeometryData {
  const { smooth = true, closed = false, segments, align = true } = options,
    { steps = smooth ? 8 : 1 } = options,
    { caps, crease, curveSegments } = surfaceOptions(options);
  steady(steps, 'steps');
  if (segments !== undefined) steady(segments, 'segments');
  if (sections.length < (closed ? 3 : 2))
    throw new RangeError(`Loft of ${sections.length} sections; pass at least ${closed ? 3 : 2}`);
  const sets = sections.map((section, i) => sectionRings(section, i, curveSegments)),
    centres = sets.map(([outline]) => centreOf(outline)),
    count = sets.length,
    holes = sets[0].length - 1,
    surface = new Surface();
  for (const set of sets)
    if (set.length !== holes + 1)
      throw new RangeError(`Loft sections with ${holes} and ${set.length - 1} holes; pass the same number in every section`);
  /** Skins one ring of every section, and gives the rows of the surface. Holes run the other way, so walls face the solid's outside. */
  const skin = (given: readonly MutableVec3[][], sign: number): number[][] => {
    const rings = given.map((ring) => ring.slice());
    // Every outline runs counter-clockwise seen from the end of the loft, so walls face out.
    rings.forEach((ring, i) => {
      const next = closed ? (i + 1) % count : Math.min(i + 1, count - 1),
        previous = closed ? (i + count - 1) % count : Math.max(i - 1, 0),
        going = centres[next].map((x, k) => x - centres[previous][k]);
      if (dot(ringNormal(ring), going) * sign < 0) ring.reverse();
    });
    if (align) for (let i = 1; i < rings.length; i++) rings[i] = aligned(rings[i], rings[i - 1]);
    const ringShares = rings.map((ring) => arcShares(ring, true)),
      shares = segments
        ? Array.from({ length: segments }, (_, j) => j / segments)
        : sharedShares(ringShares),
      grid = rings.map((ring, r) => shares.map((share) => ringPoint(ring, ringShares[r], share))),
      sharp = grid.map((row) => corners(row, true, crease)),
      hard = shares.map((_, j) => sharp.every((row) => row[j])),
      spans = closed ? count : count - 1,
      rows: number[][] = [],
      point = (i: number, j: number, k: number): number => {
        if (closed) return grid[(i + count) % count][j][k];
        if (i < 0) return 2 * grid[0][j][k] - grid[1][j][k];
        if (i >= count) return 2 * grid[count - 1][j][k] - grid[count - 2][j][k];
        return grid[i][j][k];
      };
    for (let span = 0; span < spans; span++)
      for (let step = 0; step < steps; step++) {
        const t = step / steps,
          row: number[] = [];
        for (let j = 0; j < shares.length; j++)
          for (let k = 0; k < 3; k++)
            row.push(
              smooth
                ? spline(point(span - 1, j, k), point(span, j, k), point(span + 1, j, k), point(span + 2, j, k), t)
                : point(span, j, k) + (point(span + 1, j, k) - point(span, j, k)) * t,
            );
        rows.push(row);
      }
    rows.push(closed ? rows[0] : grid[count - 1].flat());
    surface.strip(
      rows,
      [...shares, 1],
      hard,
      true,
      closed,
      rows.map((_, i) => i / (rows.length - 1)),
    );
    return rows;
  };
  const skins = [skin(sets.map(([outline]) => outline), 1)];
  for (let hole = 1; hole <= holes; hole++) skins.push(skin(sets.map((set) => set[hole]), -1));
  if (caps && !closed)
    for (const [at, flip] of [
      [0, true],
      [-1, false],
    ] as const) {
      const rows = skins.map((rows) => rows.at(at)!),
        rings = rows.map((row) => {
          const ring: MutableVec3[] = [];
          for (let j = 0; j < row.length; j += 3) ring.push([row[j], row[j + 1], row[j + 2]]);
          return ring;
        }),
        facingWay = normalize(ringNormal(rings[0])),
        [across, upward] = planeAxes(facingWay),
        flat = rings.map((ring) => ring.map((p) => [dot(p, across), dot(p, upward)] as MutableVec2)),
        { indices } = triangulateConstrained(flat[0], flat.slice(1));
      surface.cap(rows.flat(), flat.flat(), indices, flip ? [-facingWay[0], -facingWay[1], -facingWay[2]] : facingWay, flip);
    }
  return surface.done();
}
