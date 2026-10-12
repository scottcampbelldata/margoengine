export type GroundPlacement = readonly [x: number, z: number, scale: number, yaw: number];
export type GroundBounds = readonly [minX: number, minZ: number, maxX: number, maxZ: number];
export type GroundCircle = readonly [x: number, z: number, radius: number];
export type Placement = readonly [x: number, y: number, z: number, scale: number, yaw: number];

export function validateExclusions(exclusions: readonly GroundBounds[]): void {
  if (exclusions.length > 1_000_000) throw new RangeError('Too many scatter exclusions');
  for (const bounds of exclusions) {
    const [minX,minZ,maxX,maxZ] = bounds;
    if (bounds.length !== 4 || ![minX,minZ,maxX,maxZ].every(v => Number.isFinite(Math.fround(v))) || Math.fround(minX) >= Math.fround(maxX) || Math.fround(minZ) >= Math.fround(maxZ)) throw new RangeError('Invalid scatter exclusion bounds');
  }
}

function validatePlacements(candidates: readonly GroundPlacement[], radius: number): void {
  if (!Number.isFinite(radius) || radius <= 0) throw new RangeError('Invalid placement radius');
  for (const candidate of candidates) {
    const [x,z,scale,yaw] = candidate;
    if (candidate.length !== 4 || !Number.isFinite(x) || !Number.isFinite(z) || !Number.isFinite(yaw) || !Number.isFinite(scale) || scale <= 0 || !Number.isFinite(radius*scale)) throw new RangeError('Invalid ground placement');
  }
}

/** Conservative world XZ rectangles enclosing every scaled ground footprint. */
export function placementBounds(placements: readonly GroundPlacement[], radius: number): GroundBounds[] {
  validatePlacements(placements,radius);
  const bounds: GroundBounds[] = placements.map(([x,z,scale]) => [x-radius*scale,z-radius*scale,x+radius*scale,z+radius*scale]);
  validateExclusions(bounds); return bounds;
}

/** Rejects whole scaled footprints touching world-space XZ exclusion rectangles. */
export function clearPlacements(candidates: readonly GroundPlacement[], radius: number, exclusions: readonly (GroundBounds | GroundCircle)[], gap = 0): GroundPlacement[] {
  validatePlacements(candidates,radius);
  if (!Number.isFinite(gap) || gap < 0 || exclusions.length > 1_000_000) throw new RangeError('Invalid placement gap or exclusions');
  for (const e of exclusions) {
    if (e.length === 3) {const [x,z,radius] = e; if (![x,z,radius].every(v => Number.isFinite(Math.fround(v))) || radius < 0) throw new RangeError('Invalid scatter exclusion circle');}
    else validateExclusions([e as GroundBounds]);
  }
  return candidates.filter(([x,z,scale]) => exclusions.every(e => (e.length === 3 ? Math.hypot(x-e[0],z-e[1])-e[2] : Math.hypot(x-Math.max(e[0],Math.min(e[2],x)),z-Math.max(e[1],Math.min(e[3],z)))) > radius*scale+gap));
}

/** Initialization-only footprint filtering; preserves candidate order and leaves inputs unchanged. */
export function spacePlacements(candidates: readonly GroundPlacement[], radius: number, gap = 0.3): GroundPlacement[] {
  validatePlacements(candidates,radius);
  if (!Number.isFinite(gap) || gap < 0) throw new RangeError('Invalid placement gap');
  const placements: GroundPlacement[] = [];
  // shortcut: quadratic filtering suits small initialization sets; use a spatial grid for large scatters.
  for (const candidate of candidates) {
    const [x,z,scale] = candidate;
    if (!placements.some(([px,pz,ps]) => Math.hypot(x-px,z-pz) < radius*scale+radius*ps+gap)) placements.push(candidate);
  }
  return placements;
}

/** Initialization-only occupancy shared by asset types; accepted footprints reserve a 30 cm gap. */
export class PlacementLayout {
  private readonly bounds: GroundBounds[];
  private readonly occupied: (GroundBounds | GroundCircle)[];
  constructor(exclusions: readonly GroundBounds[] = []) {
    validateExclusions(exclusions);
    this.bounds = exclusions.map(([a,b,c,d]) => [a,b,c,d]);
    this.occupied = this.bounds.slice();
  }
  get exclusions(): readonly GroundBounds[] {return this.bounds;}
  place(candidates: readonly GroundPlacement[], radius: number): GroundPlacement[] {
    const placements = spacePlacements(clearPlacements(candidates,radius,this.occupied,0.3),radius);
    const bounds: GroundBounds[] = placementBounds(placements,radius).map(([a,b,c,d]) => [a-0.3,b-0.3,c+0.3,d+0.3]);
    validateExclusions(bounds);
    for (let i = 0; i < placements.length; i++) {
      const [x,z,scale] = placements[i];
      this.occupied.push([x,z,radius*scale]); this.bounds.push(bounds[i]);
    }
    return placements;
  }
}

/** Column-major yaw/scale/translation matrices for fixed instance batches. */
export function instanceTransforms(placements: readonly Placement[]): Float32Array {
  const transforms = new Float32Array(placements.length*16);
  for (let i = 0; i < placements.length; i++) {
    const p = placements[i];
    if (p.length !== 5 || !p.every(Number.isFinite) || p[3] <= 0) throw new RangeError('Invalid instance placement');
    writeTransform(transforms,i,p[0],p[1],p[2],p[3],p[4]);
  }
  if (!transforms.every(Number.isFinite)) throw new RangeError('Instance transform exceeds float range');
  return transforms;
}

/** Samples each root at world XZ; negative offsetY sinks it into the ground. */
export function groundTransforms(placements: readonly GroundPlacement[], height: (x: number, z: number) => number, offsetY = 0): Float32Array {
  if (typeof height !== 'function' || !Number.isFinite(offsetY)) throw new RangeError('Invalid ground placement height');
  const transforms = new Float32Array(placements.length*16);
  for (let i = 0; i < placements.length; i++) {
    const p = placements[i];
    if (p.length !== 4 || !p.every(Number.isFinite) || p[2] <= 0) throw new RangeError('Invalid ground placement');
    const y = height(p[0],p[1]) + offsetY;
    if (!Number.isFinite(y)) throw new RangeError('Ground placement height must be finite');
    writeTransform(transforms,i,p[0],y,p[1],p[2],p[3]);
  }
  if (!transforms.every(Number.isFinite)) throw new RangeError('Instance transform exceeds float range');
  return transforms;
}

function writeTransform(transforms: Float32Array, i: number, x: number, y: number, z: number, scale: number, yaw: number): void {
  const c = Math.cos(yaw)*scale, s = Math.sin(yaw)*scale, k = i*16;
  transforms[k] = c; transforms[k+2] = -s; transforms[k+5] = scale; transforms[k+8] = s; transforms[k+10] = c;
  transforms[k+12] = x; transforms[k+13] = y; transforms[k+14] = z; transforms[k+15] = 1;
}
