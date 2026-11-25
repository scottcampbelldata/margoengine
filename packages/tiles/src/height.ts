// Terrain height under a place on a streamed 3D Tiles tileset: a ray straight down the local vertical against the
// tiles drawn now (the bvh Raycaster), for camera clearance, walking and placing things on photogrammetry or terrain
// tiles. Optional entry: the root never imports it.
import type { EngineKernel } from '@margoengine/core';
import { Raycaster, type ModelLike } from '@margoengine/bvh';
import { cartographicToEcef } from '@margoengine/math/geo';
import type { TilesRenderer } from './renderer.js';
import { rangeError } from '../../shared/errors.js';

/** Options of {@link tilesHeightQuery}. */
export interface TilesHeightOptions {
  /** Metres above the ellipsoid each query ray starts from; above the highest ground the tileset holds. Default 9000. */
  top?: number;
  /** Metres below the ellipsoid each ray still looks (ocean floors in bathymetry tiles). Default 12000. */
  bottom?: number;
  /** Raycaster to use (layers, side, filter). Default a new one. */
  raycaster?: Raycaster;
}

/**
 * A height query over a tileset: `(longitude, latitude)` in RADIANS gives the height above the WGS84 ellipsoid, in
 * metres, of the first surface of the tiles drawn now straight below `top`, or undefined where no drawn tile lies (not
 * loaded yet, or a gap). It reads the renderer's current selection each call, so it follows streaming, and it is what
 * `GeospatialControls` takes as `heightAt` for clearance over tiles.
 */
export function tilesHeightQuery(
  engine: EngineKernel,
  renderer: TilesRenderer,
  options: TilesHeightOptions = {},
): (longitude: number, latitude: number) => number | undefined {
  const top = options.top ?? 9000,
    bottom = options.bottom ?? 12000,
    raycaster = options.raycaster ?? new Raycaster();
  if (!Number.isFinite(top) || !(bottom >= 0) || !Number.isFinite(bottom) || !(top > -bottom))
    throw rangeError(
      'tilesHeightQuery needs a finite top above -bottom and a finite bottom >= 0; use the defaults',
      'tiles-height',
    );
  return (longitude, latitude) => {
    if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) return undefined;
    const models: ModelLike[] = [];
    for (const tile of renderer.last.selected) {
      const model = tile.renderable?.model;
      if (model) models.push(model as ModelLike);
    }
    if (!models.length) return undefined;
    const o = renderer.toWorld(cartographicToEcef(longitude, latitude, top)),
      b = renderer.toWorld(cartographicToEcef(longitude, latitude, top - 1)),
      d = [b[0] - o[0], b[1] - o[1], b[2] - o[2]] as [number, number, number],
      // World units per metre of the frame (1 for the usual rigid frames).
      unit = Math.hypot(...d);
    raycaster.set(o, [d[0] / unit, d[1] / unit, d[2] / unit]);
    raycaster.near = 0;
    raycaster.far = (top + bottom) * unit;
    raycaster.firstHitOnly = true;
    const [hit] = raycaster.intersectObjects(engine as Parameters<Raycaster['intersectObjects']>[0], models);
    return hit ? top - hit.distance / unit : undefined;
  };
}
