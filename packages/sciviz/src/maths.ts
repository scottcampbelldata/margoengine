// @margoengine/sciviz/maths: the CPU-only parts of sciviz (axis ticks, the marching cubes table, picking and
// selection), for tests, servers and your own plots. No GPU, engine or DOM.
export { formatTick, formatValue, niceNumber, ticks } from './ticks.js';
export type { Ticks } from './ticks.js';
export { CORNERS, EDGES, MAX_TRIANGLES, caseTriangles, cubeTables } from './cubes.js';
export {
  heightAt,
  inRegion,
  nearestPoint,
  pointInPolygon,
  rayHeightField,
  screenRay,
  selectPoints,
} from './pick.js';
export type { HeightGrid, SelectRegion } from './pick.js';
