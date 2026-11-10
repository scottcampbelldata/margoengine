import assert from 'node:assert/strict';
import test from 'node:test';
import { TilesRenderer } from '../dist/index.js';
import { memoryFetch } from './generator.js';

const encoder = new TextEncoder();

/** Column-major view-projection of an orthographic camera looking down -z with a view `height` and `aspect`. */
function orthographic(height, aspect = 16 / 9, near = 1, far = 10_000) {
  const t = height / 2,
    r = t * aspect;
  // A quarter turn about x (looking straight down), so the view's y row is not the world's y.
  const view = [1, 0, 0, 0, 0, 0, -1, 0, 0, 1, 0, 0, 0, 0, -500, 1];
  const projection = [1 / r, 0, 0, 0, 0, 1 / t, 0, 0, 0, 0, -1 / (far - near), 0, 0, 0, -near / (far - near), 1];
  const out = new Float32Array(16);
  for (let c = 0; c < 4; c++)
    for (let r2 = 0; r2 < 4; r2++) {
      let v = 0;
      for (let k = 0; k < 4; k++) v += projection[k * 4 + r2] * view[c * 4 + k];
      out[c * 4 + r2] = v;
    }
  return out;
}
/** A perspective view-projection (clip w = -z). */
function perspective(fov = 60, aspect = 16 / 9, near = 1, far = 10_000) {
  const f = 1 / Math.tan((fov * Math.PI) / 360);
  return Float32Array.from([
    f / aspect,
    0,
    0,
    0,
    0,
    f,
    0,
    0,
    0,
    0,
    far / (near - far),
    -1,
    0,
    0,
    (near * far) / (near - far),
    0,
  ]);
}

async function renderer(matrix, frame) {
  const json = {
    asset: { version: '1.1' },
    geometricError: 100,
    root: { boundingVolume: { box: [0, 0, 0, 50, 0, 0, 0, 50, 0, 0, 0, 50] }, geometricError: 40 },
  };
  const memory = memoryFetch(new Map([['tileset.json', encoder.encode(JSON.stringify(json))]])),
    engine = {
      camera: { position: [0, 0, 400], fov: 60, planes: new Float32Array(24), matrix },
      canvas: { height: 900 },
      use(p) {
        p.setup?.(this);
      },
      hasPlugin: () => false,
      sceneOf: () => undefined,
      removePlugin() {},
    };
  return TilesRenderer.load(engine, memory.url, { fetch: memory.fetch, frame: frame ?? 'local' });
}

test('ortho: orthographicHeight reads the view height of an orthographic matrix, and none from a perspective one', () => {
  for (const h of [10, 250, 8000])
    assert.ok(Math.abs(TilesRenderer.orthographicHeight(orthographic(h)) - h) < 1e-4 * h, `${h}`);
  assert.equal(TilesRenderer.orthographicHeight(perspective()), undefined);
  // Core's matrix holds zeros until the first frame; an engine without one is read as perspective.
  assert.equal(TilesRenderer.orthographicHeight(new Float32Array(16)), undefined);
  assert.equal(TilesRenderer.orthographicHeight(undefined), undefined);
});

test('ortho: the renderer selects by the orthographic view height, without manual calls', async () => {
  // Before: the renderer passed only the fov, so an orthographic view refined by its eye distance (400 m here).
  for (const h of [50, 400, 3000]) {
    const tiles = await renderer(orthographic(h));
    tiles.update();
    // geometricError x screenHeight / view height, independent of the distance.
    assert.ok(Math.abs(tiles.tileset.root.screenSpaceError - (40 * 900) / h) < 1e-3 * ((40 * 900) / h), `height ${h}`);
    tiles.dispose();
  }
  // A frame that scales the tileset (2 world units per tileset unit) halves the height in tileset units.
  const scaled = await renderer(orthographic(400), [2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 1]);
  scaled.update();
  assert.ok(Math.abs(scaled.tileset.root.screenSpaceError - (40 * 900) / 200) < 1e-3 * 180);
  scaled.dispose();
  // A perspective camera still uses distance and fov.
  const persp = await renderer(perspective());
  persp.update();
  const d = persp.tileset.root.distance;
  assert.ok(Math.abs(persp.tileset.root.screenSpaceError - (40 * 900) / (2 * d * Math.tan(Math.PI / 6))) < 1e-6 * 1000);
  persp.dispose();
});
