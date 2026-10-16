// Metrology (HANDOFF 5l.d): float64 measurement through the common ancestor, and snapping to CAD features (feature edges and
// corners), never to triangulation diagonals or face interiors.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine, TransformStore, Geometry, box } from '../../core/dist/extension.js';
import { cylinderGeometry, toGeometry } from '../../geometry/dist/index.js';
import { vertexAnchor, snapAnchor, measureDistance, worldAnchor } from '../dist/index.js';

async function engine(capacity = 16) {
  const store = await TransformStore.create(capacity),
    renderer = { backend: 'webgl2', add() {}, remove() {}, render() {}, dispose() {} };
  return new Engine({ width: 200, height: 200, clientWidth: 200, clientHeight: 200 }, store, renderer, undefined, null);
}
const f = Math.fround,
  close = (a, b, tolerance) => a.every((v, i) => Math.abs(v - b[i]) <= tolerance);

test('measureDistance is float64 through the common ancestor: 1 mm on an assembly 1 km away measures exactly', async () => {
  const e = await engine();
  try {
    // Two points 1 mm apart on one part, and a second part 5 mm away, under a root placed ~1 km from the origin and rotated.
    const points = [0.0101, 0.0202, 0.0303, 0.0111, 0.0202, 0.0303];
    const geometry = new Geometry([...points, 0.02, 0.03, 0.04], [0, 0, 1, 0, 0, 1, 0, 0, 1], [0, 1, 2]);
    const root = e.createMesh().setPosition([1000.3, -20.7, 2000.9]).setRotation([0.3, 1.1, -0.2]);
    const module = e.createMesh(root).setPosition([0.123, 0.456, -0.789]).setRotation([0, 0.5, 0]);
    const a = e.createMesh(module).setGeometry(geometry),
      b = e.createMesh(module).setGeometry(geometry).setPosition([0.005, 0, 0]);
    e.render();
    const exact = Math.hypot(f(0.0111) - f(0.0101), 0, 0),
      measured = measureDistance(vertexAnchor(a, 0), vertexAnchor(a, 1), 'm');
    assert.ok(Math.abs(measured - exact) < 1e-10, `same part: error ${measured - exact} m`);
    // Across parts: their local offsets compose in float64 under the shared module frame. Through each part's float32 world
    // matrix the ~1 km translation rounds separately (float32 spacing there is 61 µm), which is what this fixes.
    const across = measureDistance(vertexAnchor(a, 0), vertexAnchor(b, 0), 'm');
    const p = worldAnchor(vertexAnchor(a, 0)),
      q = worldAnchor(vertexAnchor(b, 0)),
      float32 = Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2]);
    assert.ok(Math.abs(across - f(0.005)) < 1e-10, `across parts: error ${across - f(0.005)} m`);
    assert.ok(Math.abs(float32 - f(0.005)) > 1e-6, `float32 world matrices: error ${float32 - f(0.005)} m`);
    // A world-space anchor still works (full float64 chain to world) and units convert.
    assert.ok(Math.abs(measureDistance({ point: p }, vertexAnchor(a, 0), 'mm')) < 0.1);
    assert.ok(Math.abs(measureDistance(vertexAnchor(a, 0), vertexAnchor(a, 1)) - exact * 1000) < 1e-7);
  } finally {
    e.dispose();
  }
});

test('snapAnchor snaps to CAD corners and feature edges, never to triangulation diagonals or face interiors', async () => {
  const e = await engine();
  try {
    const cube = e
      .createMesh()
      .setGeometry(box(1, 1, 1))
      .setPosition([2, 0, 0]);
    e.render();
    // Near the face diagonal of the +z face: the nearest feature edge is 0.49 away, so nothing within 0.1.
    assert.equal(snapAnchor(cube, [2.01, -0.01, 0.5], { kind: 'edge', maxDistance: 0.1 }), null);
    const edge = snapAnchor(cube, [2.2, 0.49, 0.5], { kind: 'edge', maxDistance: 0.1 });
    assert.ok(edge && close(worldAnchor(edge), [2.2, 0.5, 0.5], 1e-6), 'closest point on the top front edge');
    const corner = snapAnchor(cube, [2.48, 0.47, 0.49], { kind: 'vertex', maxDistance: 0.1 });
    assert.ok(corner && close(worldAnchor(corner), [2.5, 0.5, 0.5], 1e-6), 'cube corner');
    // A finely tessellated cylinder has rims (feature edges) but no corners; the cap centre vertex is not a feature.
    const cylinder = e.createMesh().setGeometry(toGeometry(cylinderGeometry(0.5, 0.5, 1, 32)));
    e.render();
    assert.equal(snapAnchor(cylinder, [0.001, 0.5, 0.001], { kind: 'vertex', maxDistance: 0.2 }), null);
    const rim = snapAnchor(cylinder, [0.47, 0.52, 0], { kind: 'edge', maxDistance: 0.1 });
    assert.ok(
      rim &&
        Math.abs(worldAnchor(rim)[1] - 0.5) < 1e-6 &&
        Math.abs(Math.hypot(worldAnchor(rim)[0], worldAnchor(rim)[2]) - 0.5) < 0.01,
      'on the top rim',
    );
    assert.throws(() => snapAnchor(cube, [0, 0, 0], { kind: 'corner' }), /Invalid snap/);
  } finally {
    e.dispose();
  }
});
