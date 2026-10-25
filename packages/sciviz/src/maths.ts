// @margoengine/sciviz/maths: the CPU-only parts of sciviz (axis ticks and the marching cubes table), for tests,
// servers and your own plots. No GPU, engine or DOM.
export { formatTick, niceNumber, ticks } from './ticks.js';
export type { Ticks } from './ticks.js';
export { CORNERS, EDGES, MAX_TRIANGLES, caseTriangles, cubeTables } from './cubes.js';
