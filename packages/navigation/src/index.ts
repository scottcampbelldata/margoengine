/// <reference lib="esnext.disposable" preserve="true" />
import type { Vec3Like } from '@margoengine/math';
import { MargoError } from '@margoengine/math/errors';
import { init, type NavMesh, NavMeshQuery, Raw } from 'recast-navigation';
import { generateSoloNavMesh, soloNavMeshGeneratorConfigDefaults } from 'recast-navigation/generators';

/**
 * Recast build settings (recast-navigation's `RecastConfig` names; `tileSize` is not supported: solo navmesh only).
 * "wu" is world units, "vx" voxels (cells of `cs` x `ch`). Every value must be finite and >= 0.
 */
export interface NavigationOptions {
  /** Cell size on the xz-plane, wu, > 0. Default 0.2. Smaller is finer and slower (x * z / cs² must stay <= 16M). */
  cs?: number;
  /** Cell height on the y axis, wu, > 0. Default 0.2. */
  ch?: number;
  /** Non-navigable border around the heightfield, vx. Default 0. */
  borderSize?: number;
  /** Steepest walkable slope in degrees, 0..90 exclusive. Default 60. */
  walkableSlopeAngle?: number;
  /** Minimum floor-to-ceiling clearance, vx (Recast wants >= 3). Default 2. */
  walkableHeight?: number;
  /** Highest ledge an agent steps up, vx. Default 2. */
  walkableClimb?: number;
  /** Agent radius the walkable area is eroded by, vx. Default 0.5. */
  walkableRadius?: number;
  /** Longest contour edge along the mesh border, vx. Default 12. */
  maxEdgeLen?: number;
  /** Furthest a simplified contour may deviate from the raw one, vx. Default 1.3. */
  maxSimplificationError?: number;
  /** Smallest isolated region kept, in cells. Default 8. */
  minRegionArea?: number;
  /** Regions smaller than this many cells merge into larger ones where possible. Default 20. */
  mergeRegionArea?: number;
  /** Most vertices per navmesh polygon, 3..6. Default 6. */
  maxVertsPerPoly?: number;
  /** Detail-mesh height sampling distance, wu (0 or >= 0.9). Default 6. */
  detailSampleDist?: number;
  /** Largest height error of the detail mesh, wu. Default 1. */
  detailSampleMaxError?: number;
  /** Build the BV tree that speeds up queries. Default true. */
  buildBvTree?: boolean;
}

/**
 * Owns a real Recast/Detour navmesh and query (recast-navigation Wasm, loaded on the first `create`). Build one with
 * {@link Navigation.create}, query with {@link Navigation.path}, free the Wasm memory with `dispose()`.
 */
export class Navigation {
  private readonly query: NavMeshQuery;
  private disposed = false;
  private constructor(private readonly navMesh: NavMesh) {
    this.query = new NavMeshQuery(navMesh);
  }
  /**
   * Builds a navmesh from a triangle soup: `positions` are xyz world coordinates (3..3,000,000 numbers, multiple of 3,
   * Float32-finite), `indices` index them (3..6,000,000, multiple of 3).
   * @throws RangeError for invalid geometry or settings, or past the 16M-voxel budget.
   * @throws MargoError `failed` when Recast cannot build a navmesh (the message carries Recast's reason).
   */
  static async create(
    positions: ArrayLike<number>,
    indices: ArrayLike<number>,
    options: NavigationOptions = {},
  ): Promise<Navigation> {
    if (
      positions.length < 9 ||
      positions.length % 3 ||
      positions.length > 3_000_000 ||
      !indices.length ||
      indices.length % 3 ||
      indices.length > 6_000_000
    )
      throw new RangeError('Invalid navigation geometry');
    const min = [Infinity, Infinity, Infinity],
      max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < positions.length; i++) {
      const value = positions[i];
      if (!Number.isFinite(Math.fround(value))) throw new RangeError('Navigation positions must be finite');
      min[i % 3] = Math.min(min[i % 3], value);
      max[i % 3] = Math.max(max[i % 3], value);
    }
    for (let i = 0; i < indices.length; i++)
      if (!Number.isInteger(indices[i]) || indices[i] < 0 || indices[i] >= positions.length / 3)
        throw new RangeError('Invalid navigation indices');
    const config = { ...soloNavMeshGeneratorConfigDefaults, ...options };
    for (const key of Object.keys(options))
      if (!Object.hasOwn(soloNavMeshGeneratorConfigDefaults, key) || key === 'tileSize')
        throw new RangeError('Unsupported Recast config');
    for (const [key, value] of Object.entries(config))
      if (
        key === 'buildBvTree'
          ? typeof value !== 'boolean'
          : typeof value !== 'number' || !Number.isFinite(value) || value < 0
      )
        throw new RangeError('Invalid Recast config');
    if (
      config.cs <= 0 ||
      config.ch <= 0 ||
      config.walkableSlopeAngle >= 90 ||
      config.maxVertsPerPoly < 3 ||
      config.maxVertsPerPoly > 6 ||
      Math.ceil((max[0] - min[0]) / config.cs) * Math.ceil((max[2] - min[2]) / config.cs) > 16_000_000
    )
      throw new RangeError('Recast voxel budget or config exceeded');
    await init();
    const result = generateSoloNavMesh(positions, indices, config);
    Raw.destroy(result.intermediates.buildContext.raw);
    if (!result.success)
      throw new MargoError(
        'failed',
        `Navigation build failed: ${result.error}; check the geometry is walkable at these settings (cs, walkableSlopeAngle)`,
      );
    try {
      return new Navigation(result.navMesh);
    } catch (error) {
      result.navMesh.destroy();
      throw error;
    }
  }
  /**
   * Shortest walkable path from `start` to `end` (world units), as corner points including both ends, or null when
   * Detour finds none.
   * @throws RangeError for a non-finite endpoint.
   * @throws MargoError `disposed` after `dispose()`.
   */
  path(start: Vec3Like, end: Vec3Like): Vec3Like[] | null {
    if (this.disposed) throw new MargoError('disposed', 'Navigation is disposed; create a new Navigation');
    for (const point of [start, end])
      if (![point.x, point.y, point.z].every(Number.isFinite)) throw new RangeError('Invalid path endpoint');
    const result = this.query.computePath(start, end);
    return result.success ? result.path : null;
  }
  /** Frees the navmesh and query Wasm memory. Idempotent; `path` throws afterwards. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.query.destroy();
    this.navMesh.destroy();
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
}
