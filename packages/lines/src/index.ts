export { Lines } from './lines.js';
export { meshWorldMatrix } from '@margoengine/math/mesh';
export type { LinesOptions } from './lines.js';
export { Line, LineMaterial } from './line.js';
export type { LineOptions, LineMaterialOptions } from './line.js';
export {
  GridHelper,
  PolarGridHelper,
  AxesHelper,
  Box3Helper,
  BoxHelper,
  ArrowHelper,
  CameraHelper,
  PlaneHelper,
  VertexNormalsHelper,
  geometryBounds,
} from './helpers.js';
export type { HelperOptions } from './helpers.js';
export {
  computeLineDistances,
  expandLine,
  triangleArea,
  segmentCount,
  segmentIndices,
  VERTICES_PER_SEGMENT,
} from './geometry.js';
export type { LineMode, LineJoin, LineCap, ExpandLineOptions, SegmentIndices } from './geometry.js';
export { parseColor } from './color.js';
export type { ColorInput } from './color.js';
