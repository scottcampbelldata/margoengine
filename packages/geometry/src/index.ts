export type { GeometryData, GeometryGroup } from './data.js';
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
export {
  boxGeometry,
  capsuleGeometry,
  circleGeometry,
  coneGeometry,
  cylinderGeometry,
  latheGeometry,
  planeGeometry,
  ringGeometry,
  sphereGeometry,
  torusGeometry,
  torusKnotGeometry,
  tubeGeometry,
  dodecahedronGeometry,
  icosahedronGeometry,
  octahedronGeometry,
  polyhedronGeometry,
  tetrahedronGeometry,
} from './primitives.js';
export { extrudeGeometry, shapeGeometry, type ExtrudeOptions } from './extrude.js';
export {
  applyMatrix4,
  center,
  computeBoundingBox,
  computeBoundingSphere,
  computeTangents,
  computeVertexNormals,
  creasedNormals,
  edgesGeometry,
  mergeGeometries,
  mergeVertices,
  toNonIndexed,
  wireframe,
  wireframePositions,
  type CreasedNormalsOptions,
  type MergeVerticesOptions,
  geometryData,
  toGeometry,
  pbrVertexStream,
  footprintRadius,
} from './utils.js';
export { loopSubdivide } from './subdivide.js';
