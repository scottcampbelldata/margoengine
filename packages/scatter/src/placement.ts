/** A ground candidate: world XZ, uniform scale and yaw (radians about +Y); Y comes from a height sampler later. */
export type GroundPlacement = readonly [x: number, z: number, scale: number, yaw: number];
/** A world XZ rectangle, min corner then max corner (exclusions, placement bounds). */
export type GroundBounds = readonly [minX: number, minZ: number, maxX: number, maxZ: number];
/** A world XZ circle exclusion: centre and radius. */
export type GroundCircle = readonly [x: number, z: number, radius: number];
/**
 * A ground path kept free of instances, such as a road, track or river bed: an XZ polyline (its centreline) and its
 * full width. An instance's footprint stays more than `width / 2` from every segment.
 */
export interface GroundPath {
  /** The centreline, two or more `[x, z]` points. */
  readonly points: readonly (readonly [x: number, z: number])[];
  /** Full width kept clear, above 0. */
  readonly width: number;
}
/** A placed instance: world position, uniform scale and yaw (radians about +Y), packed by `instanceTransforms`. */
export type Placement = readonly [x: number, y: number, z: number, scale: number, yaw: number];

export function validateExclusions(exclusions: readonly GroundBounds[]): void {
  if (exclusions.length > 1_000_000) throw new RangeError('Too many scatter exclusions; pass at most 1000000.');
  for (const bounds of exclusions) {
    const [minX, minZ, maxX, maxZ] = bounds;
    if (
      bounds.length !== 4 ||
      ![minX, minZ, maxX, maxZ].every((v) => Number.isFinite(Math.fround(v))) ||
      Math.fround(minX) >= Math.fround(maxX) ||
      Math.fround(minZ) >= Math.fround(maxZ)
    )
      throw new RangeError(
        'Invalid scatter exclusion bounds; pass [minX, minZ, maxX, maxZ] as finite numbers with min below max.',
      );
  }
}

/** Checks paths and returns their segments as `[ax, az, bx, bz, halfWidth]` rows. */
export function pathSegments(paths: readonly GroundPath[]): number[][] {
  const segments: number[][] = [];
  for (const path of paths) {
    const points = path?.points,
      half = path?.width / 2;
    if (
      !Array.isArray(points) ||
      points.length < 2 ||
      !(half > 0 && Number.isFinite(Math.fround(half))) ||
      points.some((p) => p?.length !== 2 || !p.every((v: number) => Number.isFinite(Math.fround(v))))
    )
      throw new RangeError(
        'Invalid scatter path; pass { points: [[x, z], ...] } with two or more finite points and a finite width above 0.',
      );
    for (let i = 1; i < points.length; i++) segments.push([...points[i - 1], ...points[i], half]);
    if (segments.length > 1_000_000) throw new RangeError('Too many scatter path segments; pass at most 1000000.');
  }
  return segments;
}

/** Distance from (x, z) to the segment from (ax, az) to (bx, bz) (C. Ericson, Real-Time Collision Detection, 2005, 5.1.2). */
export function segmentDistance(x: number, z: number, ax: number, az: number, bx: number, bz: number): number {
  const dx = bx - ax,
    dz = bz - az,
    length = dx * dx + dz * dz,
    t = length > 0 ? Math.min(1, Math.max(0, ((x - ax) * dx + (z - az) * dz) / length)) : 0;
  return Math.hypot(x - ax - dx * t, z - az - dz * t);
}

function validatePlacements(candidates: readonly GroundPlacement[], radius: number): void {
  if (!Number.isFinite(radius) || radius <= 0)
    throw new RangeError('Invalid placement radius; pass a finite radius above 0.');
  for (const candidate of candidates) {
    const [x, z, scale, yaw] = candidate;
    if (
      candidate.length !== 4 ||
      !Number.isFinite(x) ||
      !Number.isFinite(z) ||
      !Number.isFinite(yaw) ||
      !Number.isFinite(scale) ||
      scale <= 0 ||
      !Number.isFinite(radius * scale)
    )
      throw new RangeError('Invalid ground placement; pass [x, z, scale, yaw] as finite numbers with scale above 0.');
  }
}

/** Conservative world XZ rectangles enclosing every scaled ground footprint. */
export function placementBounds(placements: readonly GroundPlacement[], radius: number): GroundBounds[] {
  validatePlacements(placements, radius);
  const bounds: GroundBounds[] = placements.map(([x, z, scale]) => [
    x - radius * scale,
    z - radius * scale,
    x + radius * scale,
    z + radius * scale,
  ]);
  validateExclusions(bounds);
  return bounds;
}

/** Rejects whole scaled footprints touching world-space XZ exclusion rectangles, circles or paths. */
export function clearPlacements(
  candidates: readonly GroundPlacement[],
  radius: number,
  exclusions: readonly (GroundBounds | GroundCircle | GroundPath)[],
  gap = 0,
): GroundPlacement[] {
  const paths = exclusions.filter((e): e is GroundPath => !Array.isArray(e)),
    segments = pathSegments(paths),
    shapes = exclusions.filter((e): e is GroundBounds | GroundCircle => Array.isArray(e));
  validatePlacements(candidates, radius);
  if (!Number.isFinite(gap) || gap < 0 || exclusions.length > 1_000_000)
    throw new RangeError(
      'Invalid placement gap or exclusions; pass a finite gap of 0 or more and at most 1000000 exclusions.',
    );
  for (const e of shapes) {
    if (e.length === 3) {
      const [x, z, radius] = e;
      if (![x, z, radius].every((v) => Number.isFinite(Math.fround(v))) || radius < 0)
        throw new RangeError(
          'Invalid scatter exclusion circle; pass [x, z, radius] as finite numbers with radius of 0 or more.',
        );
    } else validateExclusions([e as GroundBounds]);
  }
  return candidates.filter(
    ([x, z, scale]) =>
      shapes.every(
        (e) =>
          (e.length === 3
            ? Math.hypot(x - e[0], z - e[1]) - e[2]
            : Math.hypot(x - Math.max(e[0], Math.min(e[2], x)), z - Math.max(e[1], Math.min(e[3], z)))) >
          radius * scale + gap,
      ) && segments.every((s) => segmentDistance(x, z, s[0], s[1], s[2], s[3]) - s[4] > radius * scale + gap),
  );
}

/** Initialization-only footprint filtering; preserves candidate order and leaves inputs unchanged. */
export function spacePlacements(candidates: readonly GroundPlacement[], radius: number, gap = 0.3): GroundPlacement[] {
  validatePlacements(candidates, radius);
  if (!Number.isFinite(gap) || gap < 0) throw new RangeError('Invalid placement gap; pass a finite gap of 0 or more.');
  const placements: GroundPlacement[] = [];
  // shortcut: quadratic filtering suits small initialization sets; use a spatial grid for large scatters.
  for (const candidate of candidates) {
    const [x, z, scale] = candidate;
    if (!placements.some(([px, pz, ps]) => Math.hypot(x - px, z - pz) < radius * scale + radius * ps + gap))
      placements.push(candidate);
  }
  return placements;
}

/** Initialization-only occupancy shared by asset types; accepted footprints reserve a 30 cm gap. */
export class PlacementLayout {
  private readonly bounds: GroundBounds[];
  private readonly occupied: (GroundBounds | GroundCircle)[];
  constructor(exclusions: readonly GroundBounds[] = []) {
    validateExclusions(exclusions);
    this.bounds = exclusions.map(([a, b, c, d]) => [a, b, c, d]);
    this.occupied = this.bounds.slice();
  }
  get exclusions(): readonly GroundBounds[] {
    return this.bounds;
  }
  place(candidates: readonly GroundPlacement[], radius: number): GroundPlacement[] {
    const placements = spacePlacements(clearPlacements(candidates, radius, this.occupied, 0.3), radius);
    const bounds: GroundBounds[] = placementBounds(placements, radius).map(([a, b, c, d]) => [
      a - 0.3,
      b - 0.3,
      c + 0.3,
      d + 0.3,
    ]);
    validateExclusions(bounds);
    for (let i = 0; i < placements.length; i++) {
      const [x, z, scale] = placements[i];
      this.occupied.push([x, z, radius * scale]);
      this.bounds.push(bounds[i]);
    }
    return placements;
  }
}

/** Column-major yaw/scale/translation matrices for fixed instance batches. */
export function instanceTransforms(placements: readonly Placement[]): Float32Array {
  const transforms = new Float32Array(placements.length * 16);
  for (let i = 0; i < placements.length; i++) {
    const p = placements[i];
    if (p.length !== 5 || !p.every(Number.isFinite) || p[3] <= 0)
      throw new RangeError(
        'Invalid instance placement; pass [x, y, z, scale, yaw] as finite numbers with scale above 0.',
      );
    writeTransform(transforms, i, p[0], p[1], p[2], p[3], p[4]);
  }
  if (!transforms.every(Number.isFinite))
    throw new RangeError('Instance transform exceeds float range; use smaller positions or scales.');
  return transforms;
}

/** Samples each root at world XZ; negative offsetY sinks it into the ground. */
export function groundTransforms(
  placements: readonly GroundPlacement[],
  height: (x: number, z: number) => number,
  offsetY = 0,
): Float32Array {
  if (typeof height !== 'function' || !Number.isFinite(offsetY))
    throw new RangeError('Invalid ground placement height; pass a height function and a finite offsetY.');
  const transforms = new Float32Array(placements.length * 16);
  for (let i = 0; i < placements.length; i++) {
    const p = placements[i];
    if (p.length !== 4 || !p.every(Number.isFinite) || p[2] <= 0)
      throw new RangeError('Invalid ground placement; pass [x, z, scale, yaw] as finite numbers with scale above 0.');
    const y = height(p[0], p[1]) + offsetY;
    if (!Number.isFinite(y)) throw new RangeError('Ground placement height must be finite');
    writeTransform(transforms, i, p[0], y, p[1], p[2], p[3]);
  }
  if (!transforms.every(Number.isFinite))
    throw new RangeError('Instance transform exceeds float range; use smaller positions or scales.');
  return transforms;
}

function writeTransform(
  transforms: Float32Array,
  i: number,
  x: number,
  y: number,
  z: number,
  scale: number,
  yaw: number,
): void {
  const c = Math.cos(yaw) * scale,
    s = Math.sin(yaw) * scale,
    k = i * 16;
  transforms[k] = c;
  transforms[k + 2] = -s;
  transforms[k + 5] = scale;
  transforms[k + 8] = s;
  transforms[k + 10] = c;
  transforms[k + 12] = x;
  transforms[k + 13] = y;
  transforms[k + 14] = z;
  transforms[k + 15] = 1;
}
