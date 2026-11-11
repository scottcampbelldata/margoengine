// Browser side of split-scale-check.mjs: a 2,828 x 2,828 height field (7,997,584 vertices, 15,983,858 triangles, just
// under the parsers' default maxVertices and maxTriangles) through createMeshes, one core Geometry
// since loaders follow core's 11,184,810-vertex cap (before toGeometries a mesh past 1,000,000 vertices could not be drawn).
import { Engine } from '../../core/dist/index.js';
import { createMeshes } from '../dist/index.js';

const errors = [],
  side = 2828;
let engine, result;
function field() {
  const positions = new Float32Array(side * side * 3),
    indices = new Uint32Array((side - 1) * (side - 1) * 6);
  for (let y = 0; y < side; y++)
    for (let x = 0; x < side; x++) {
      const o = (y * side + x) * 3;
      positions[o] = x / side - 0.5;
      positions[o + 1] = Math.sin(x * 0.02) * Math.cos(y * 0.015) * 0.03;
      positions[o + 2] = y / side - 0.5;
    }
  let i = 0;
  for (let y = 0; y < side - 1; y++)
    for (let x = 0; x < side - 1; x++) {
      const a = y * side + x,
        c = a + side;
      indices[i++] = a;
      indices[i++] = c;
      indices[i++] = a + 1;
      indices[i++] = a + 1;
      indices[i++] = c;
      indices[i++] = c + 1;
    }
  return { kind: 'mesh', positions, indices };
}
async function setup() {
  engine = await Engine.create(document.getElementById('a'), {
    camera: { fov: 50, near: 0.01, far: 10, position: [0, 0.8, 0.9], target: [0, 0, 0] },
  });
  engine.gpu.addEventListener('uncapturederror', (ev) => errors.push(ev.error.message));
  engine.stop();
  const loaded = field(),
    start = performance.now();
  result = createMeshes(engine, loaded, { color: '#d9a04d' });
  const buildMs = performance.now() - start;
  const vertices = result.geometries.map((g) => g.vertices.length / 6);
  return {
    buildMs,
    parts: result.meshes.length,
    materials: result.materials.length,
    vertices: vertices.reduce((x, y) => x + y, 0),
    largest: Math.max(...vertices),
    triangles: result.geometries.reduce((x, g) => x + g.indices.length / 3, 0),
    sourceTriangles: loaded.indices.length / 3,
  };
}
async function frames() {
  for (let i = 0; i < 3; i++) {
    engine.render();
    await engine.gpu.queue.onSubmittedWorkDone();
  }
  const wall = [];
  for (let i = 0; i < 9; i++) {
    const start = performance.now();
    engine.render();
    await engine.gpu.queue.onSubmittedWorkDone();
    wall.push(performance.now() - start);
  }
  wall.sort((x, y) => x - y);
  return { wallMs: wall[4] };
}
window.check = { setup, frames, errors };
window.ready = true;
