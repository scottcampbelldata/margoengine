// 2D curves, paths and shapes: `@margoengine/geometry/shapes`. Triangulation (`@margoengine/geometry/triangulate`) and
// extrusion (`@margoengine/geometry/extrude`) have their own entries, so loading shapes does not load them.
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
export { isClockWise, mergeOverlappingPoints, shapeArea } from './triangulate.js';
