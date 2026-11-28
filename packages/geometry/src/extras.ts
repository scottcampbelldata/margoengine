// Optional geometries outside the main entry, so the main entry keeps its size.
export { roundedBoxGeometry } from './rounded-box.js';
export { convexGeometry } from './convex.js';
export { parametricGeometry, type ParametricFunction } from './parametric.js';
export {
  kleinBottleGeometry,
  kleinBottleSurface,
  kleinFigure8Surface,
  mobiusStripGeometry,
  mobiusSurface,
  knotGeometry,
  type KleinBottleKind,
  type KleinBottleOptions,
  type MobiusStripOptions,
  type SurfaceGridOptions,
  type KnotName,
  type KnotOptions,
} from './surfaces.js';
export { decalGeometry, type DecalGeometryOptions } from './decal.js';
export {
  geodesicGeometry,
  goldbergGeometry,
  hemisphereGeometry,
  type GeodesicOptions,
  type PolyhedronGeometryData,
} from './polyhedra-extras.js';
export {
  tiledPlaneGeometry,
  tiledBoxGeometry,
  type TilePattern,
  type TiledPlaneOptions,
  type TiledBoxOptions,
} from './tiled.js';
export { trussGeometry, type TrussOptions, type TrussPattern } from './truss.js';
export { chainLinkGeometry, type ChainLinkOptions } from './chain-link.js';
