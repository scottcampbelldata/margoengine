// 2D curves, paths and shapes, their triangulation and extrusion: `@margoengine/geometry/shapes`.
export type { Vec } from './math.js';
export { Curve, type FrenetFrames } from './curve.js';
export {
  ArcCurve,
  CatmullRomCurve3,
  CubicBezierCurve,
  CubicBezierCurve3,
  EllipseCurve,
  LineCurve,
  LineCurve3,
  QuadraticBezierCurve,
  QuadraticBezierCurve3,
  SplineCurve,
  type CatmullRomType,
} from './curves.js';
export { CurvePath, Path, Shape } from './path.js';
export { isClockWise, mergeOverlappingPoints, shapeArea, triangulate, triangulateShape } from './triangulate.js';
export { extrudeGeometry, shapeGeometry, type ExtrudeOptions } from './extrude.js';
