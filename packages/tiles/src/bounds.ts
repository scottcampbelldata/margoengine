// Bounding volumes of 3D Tiles 1.1 ("Bounding volumes"): box (centre and three half-axes), region (geodetic
// west/south/east/north radians and min/max height) and sphere. All three become one oriented box plus a bounding
// sphere in tileset (ECEF) coordinates, which is what selection needs: distance from the camera and a frustum test.
import { transformDirection, transformPoint } from './matrix.js';
import { cartographicToEcef, eastNorthUpToEcef } from './wgs84.js';

/** A tile's `boundingVolume` as it appears in tileset JSON. */
export interface BoundingVolumeJSON {
  box?: readonly number[];
  region?: readonly number[];
  sphere?: readonly number[];
  extensions?: Record<string, unknown>;
}

/**
 * Reads a bounding volume extension, such as `s2` from `@margoengine/tiles/s2` (3DTILES_bounding_volume_S2). Pass it in
 * `boundingVolumes` of `Tileset.load` or `TilesRenderer.load`; a volume carrying the extension is then read by it,
 * ignoring the tile transform as such extensions specify, and the tileset may list the extension as required.
 */
export interface BoundingVolumeExtension {
  /** The extension's name in `boundingVolume.extensions` and `extensionsRequired`. */
  readonly name: string;
  /** The bounds of the extension object (a box in ECEF, with `split` for implicit tiling). Throws on invalid input. */
  bounds(volume: unknown): TileBounds;
}

/** Bounds of implicit tile (level, x, y, z) below a root volume, for a volume that subdivides its own way. */
export type SplitBounds = (scheme: 'QUADTREE' | 'OCTREE', level: number, x: number, y: number, z: number) => TileBounds;

/** An oriented box (centre, three half-axis vectors) with its bounding sphere, in tileset coordinates. */
export class TileBounds {
  /** Centre, x y z. */
  readonly center: Float64Array;
  /** Half-axes: 9 numbers, axis u then v then w. */
  readonly halfAxes: Float64Array;
  /** Radius of the bounding sphere around `center`. */
  readonly radius: number;
  /** The source region in radians and metres, kept for implicit subdivision; undefined for box and sphere. */
  readonly region?: Float64Array;
  /** True when built from a sphere (its box is the sphere's cube; distance uses the sphere). */
  readonly sphere: boolean;
  /** How an extension volume (such as an S2 cell) subdivides under implicit tiling; undefined for box, region, sphere. */
  readonly split?: SplitBounds;
  private readonly unit = new Float64Array(9);
  private readonly lengths = new Float64Array(3);
  constructor(
    center: ArrayLike<number>,
    halfAxes: ArrayLike<number>,
    options: { region?: ArrayLike<number>; sphere?: number; split?: SplitBounds } = {},
  ) {
    this.center = Float64Array.from(center);
    this.halfAxes = Float64Array.from(halfAxes);
    if (
      this.center.length !== 3 ||
      this.halfAxes.length !== 9 ||
      ![...this.center, ...this.halfAxes].every(Number.isFinite)
    )
      throw new RangeError('Invalid bounding volume; give finite numbers (box: 12, region: 6, sphere: 4)');
    if (options.region) this.region = Float64Array.from(options.region);
    if (options.split) this.split = options.split;
    this.sphere = options.sphere !== undefined;
    for (let i = 0; i < 3; i++) {
      const x = this.halfAxes[i * 3],
        y = this.halfAxes[i * 3 + 1],
        z = this.halfAxes[i * 3 + 2];
      this.lengths[i] = Math.hypot(x, y, z);
    }
    for (let i = 0; i < 3; i++) {
      const l = this.lengths[i];
      if (l > 0) for (let k = 0; k < 3; k++) this.unit[i * 3 + k] = this.halfAxes[i * 3 + k] / l;
    }
    // A flat box (a zero half-axis, as for a single-height region) gets the cross product of the other two as its
    // direction, so the point-to-box distance still measures the offset along it.
    for (let i = 0; i < 3; i++)
      if (!(this.lengths[i] > 0)) {
        const a = ((i + 1) % 3) * 3,
          b = ((i + 2) % 3) * 3,
          u = this.unit;
        const cx = u[a + 1] * u[b + 2] - u[a + 2] * u[b + 1],
          cy = u[a + 2] * u[b] - u[a] * u[b + 2],
          cz = u[a] * u[b + 1] - u[a + 1] * u[b],
          l = Math.hypot(cx, cy, cz);
        if (l > 0) {
          u[i * 3] = cx / l;
          u[i * 3 + 1] = cy / l;
          u[i * 3 + 2] = cz / l;
        }
      }
    this.radius = options.sphere ?? Math.hypot(this.lengths[0], this.lengths[1], this.lengths[2]);
  }

  /** Distance from a point to the volume; 0 inside. */
  distanceTo(point: ArrayLike<number>): number {
    const dx = point[0] - this.center[0],
      dy = point[1] - this.center[1],
      dz = point[2] - this.center[2];
    if (this.sphere) return Math.max(0, Math.hypot(dx, dy, dz) - this.radius);
    let sum = 0;
    for (let i = 0; i < 3; i++) {
      const d =
        Math.abs(dx * this.unit[i * 3] + dy * this.unit[i * 3 + 1] + dz * this.unit[i * 3 + 2]) - this.lengths[i];
      if (d > 0) sum += d * d;
    }
    return Math.sqrt(sum);
  }

  /** True when the point is inside (or on) the volume. */
  contains(point: ArrayLike<number>): boolean {
    return this.distanceTo(point) === 0;
  }

  /**
   * False only when the volume is entirely outside one of the frustum planes: 24 numbers, 6 planes [a, b, c, d] with
   * a x + b y + c z + d >= 0 inside (the layout of core's `camera.planes`). All-zero planes keep everything.
   */
  intersectsFrustum(planes: ArrayLike<number>): boolean {
    const c = this.center,
      h = this.halfAxes;
    for (let p = 0; p < 6; p++) {
      const a = planes[p * 4],
        b = planes[p * 4 + 1],
        cc = planes[p * 4 + 2],
        d = planes[p * 4 + 3];
      const s = a * c[0] + b * c[1] + cc * c[2] + d;
      const reach = this.sphere
        ? this.radius * Math.hypot(a, b, cc)
        : Math.abs(a * h[0] + b * h[1] + cc * h[2]) +
          Math.abs(a * h[3] + b * h[4] + cc * h[5]) +
          Math.abs(a * h[6] + b * h[7] + cc * h[8]);
      if (s + reach < 0) return false;
    }
    return true;
  }

  /** The 8 corners of the box. */
  corners(): [number, number, number][] {
    const out: [number, number, number][] = [];
    for (let i = 0; i < 8; i++) {
      const sx = i & 1 ? 1 : -1,
        sy = i & 2 ? 1 : -1,
        sz = i & 4 ? 1 : -1,
        h = this.halfAxes;
      out.push([
        this.center[0] + sx * h[0] + sy * h[3] + sz * h[6],
        this.center[1] + sx * h[1] + sy * h[4] + sz * h[7],
        this.center[2] + sx * h[2] + sy * h[5] + sz * h[8],
      ]);
    }
    return out;
  }
}

/** A box volume [cx, cy, cz, ux, uy, uz, vx, vy, vz, wx, wy, wz] under a transform. */
export function boxBounds(box: ArrayLike<number>, transform?: ArrayLike<number>): TileBounds {
  const center = [box[0], box[1], box[2]],
    axes = Array.from({ length: 9 }, (_, i) => box[3 + i]);
  if (!transform) return new TileBounds(center, axes);
  return new TileBounds(transformPoint(transform, center), [
    ...transformDirection(transform, axes.slice(0, 3)),
    ...transformDirection(transform, axes.slice(3, 6)),
    ...transformDirection(transform, axes.slice(6, 9)),
  ]);
}

/** A sphere volume [cx, cy, cz, r] under a transform (the radius grows by the largest axis scale). */
export function sphereBounds(sphere: ArrayLike<number>, transform?: ArrayLike<number>): TileBounds {
  let center: ArrayLike<number> = [sphere[0], sphere[1], sphere[2]],
    r = sphere[3];
  if (!(r >= 0)) throw new RangeError('Invalid bounding sphere; give a radius of 0 or more');
  if (transform) {
    center = transformPoint(transform, center);
    r *= Math.max(
      Math.hypot(transform[0], transform[1], transform[2]),
      Math.hypot(transform[4], transform[5], transform[6]),
      Math.hypot(transform[8], transform[9], transform[10]),
    );
  }
  return new TileBounds(center, [r, 0, 0, 0, r, 0, 0, 0, r], { sphere: r });
}

/**
 * A region [west, south, east, north, minimumHeight, maximumHeight] (radians, metres above WGS84) as an oriented box
 * in ECEF. The box is aligned with the east-north-up frame at the region's centre and holds a 9 x 9 grid of surface
 * samples at both heights, padded by the chord sag between samples, so it always contains the curved region. Regions
 * ignore tile transforms (3D Tiles 1.1, "Region").
 */
export function regionBounds(region: ArrayLike<number>): TileBounds {
  let [west, south, east, north, minH, maxH] = Array.from(region).slice(0, 6) as number[];
  if (![west, south, east, north, minH, maxH].every(Number.isFinite) || south > north || minH > maxH)
    throw new RangeError(
      'Invalid bounding region; give [west, south, east, north, minHeight, maxHeight] with south <= north',
    );
  if (east < west) east += 2 * Math.PI; // crosses the antimeridian
  const lon = (west + east) / 2,
    lat = (south + north) / 2,
    origin = cartographicToEcef(lon, lat, (minH + maxH) / 2),
    enu = eastNorthUpToEcef(origin[0], origin[1], origin[2]);
  const axes = [
    [enu[0], enu[1], enu[2]],
    [enu[4], enu[5], enu[6]],
    [enu[8], enu[9], enu[10]],
  ];
  const lo = [Infinity, Infinity, Infinity],
    hi = [-Infinity, -Infinity, -Infinity],
    steps = 8;
  for (let i = 0; i <= steps; i++)
    for (let j = 0; j <= steps; j++)
      for (const h of [minH, maxH]) {
        const p = cartographicToEcef(west + ((east - west) * i) / steps, south + ((north - south) * j) / steps, h);
        for (let k = 0; k < 3; k++) {
          const a = axes[k],
            d = (p[0] - origin[0]) * a[0] + (p[1] - origin[1]) * a[1] + (p[2] - origin[2]) * a[2];
          if (d < lo[k]) lo[k] = d;
          if (d > hi[k]) hi[k] = d;
        }
      }
  // Between two samples an arc of angle t on a sphere of radius R bulges R (1 - cos(t / 2)) past the chord.
  const step = Math.max(east - west, north - south) / steps,
    sag = (6378137 + Math.max(Math.abs(minH), Math.abs(maxH))) * (1 - Math.cos(Math.min(step, Math.PI) / 2));
  const center = [...origin],
    half: number[] = [];
  for (let k = 0; k < 3; k++) {
    const mid = (lo[k] + hi[k]) / 2,
      extent = (hi[k] - lo[k]) / 2 + sag,
      a = axes[k];
    for (let c = 0; c < 3; c++) center[c] += a[c] * mid;
    half.push(a[0] * extent, a[1] * extent, a[2] * extent);
  }
  return new TileBounds(center, half, { region: [west, south, east, north, minH, maxH] });
}

/** Builds the bounds of a `boundingVolume` under a tile's computed transform. */
export function createBounds(
  volume: BoundingVolumeJSON | undefined,
  transform?: ArrayLike<number>,
  extensions: readonly BoundingVolumeExtension[] = [],
): TileBounds {
  if (!volume || typeof volume !== 'object')
    throw new TypeError('Tile has no boundingVolume; give it a box, region or sphere');
  for (const extension of extensions) {
    const value = volume.extensions?.[extension.name];
    if (value !== undefined) return extension.bounds(value);
  }
  const check = (array: unknown, length: number, kind: string): readonly number[] => {
    if (
      !Array.isArray(array) ||
      array.length !== length ||
      !array.every((v) => typeof v === 'number' && Number.isFinite(v))
    )
      throw new TypeError(`Invalid boundingVolume.${kind}; give ${length} finite numbers`);
    return array;
  };
  if (volume.box) return boxBounds(check(volume.box, 12, 'box'), transform);
  if (volume.region) return regionBounds(check(volume.region, 6, 'region'));
  if (volume.sphere) return sphereBounds(check(volume.sphere, 4, 'sphere'), transform);
  throw new TypeError(
    volume.extensions?.['3DTILES_bounding_volume_S2'] !== undefined
      ? "S2 bounding volumes need their reader: import { s2 } from '@margoengine/tiles/s2' and pass { boundingVolumes: [s2] }"
      : 'Unsupported boundingVolume; give a box, region or sphere',
  );
}
