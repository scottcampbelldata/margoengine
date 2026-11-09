import assert from 'node:assert/strict';
import test from 'node:test';
import { Tileset } from '../dist/index.js';
import { memoryFetch, settle } from './generator.js';
import {
  TILES_SCENE,
  buildTilesScene,
  sceneView,
  selectionChecksum,
  tilePath,
} from '../../../scripts/rival-tiles-scene.mjs';

function inside(planes, point) {
  for (let i = 0; i < 6; i++) {
    const signed =
      planes[i * 4] * point[0] + planes[i * 4 + 1] * point[1] + planes[i * 4 + 2] * point[2] + planes[i * 4 + 3];
    if (signed < -1e-3) return false;
  }
  return true;
}

test('the published tiles view keeps the target inside the frustum and a point behind the camera outside', () => {
  const view = sceneView();
  assert.equal(view.planes.length, 24);
  assert.equal(inside(view.planes, TILES_SCENE.camera.target), true);
  assert.equal(inside(view.planes, [0, 80, 800]), false);
});

test('the published quadtree selects the locked frontier at 16 pixels', async () => {
  const scene = buildTilesScene();
  const files = new Map([['tileset.json', scene.jsonBytes]]);
  const walk = (tile) => {
    files.set(tile.content.uri, scene.glb);
    if (tile.children) for (const child of tile.children) walk(child);
  };
  walk(scene.json.root);
  assert.equal(files.size - 1, (4 ** TILES_SCENE.levels - 1) / 3);
  const memory = memoryFetch(files);
  const tileset = await Tileset.load(memory.url, {
    fetch: memory.fetch,
    maximumScreenSpaceError: TILES_SCENE.maximumScreenSpaceError,
  });
  const view = sceneView();
  let frame;
  for (let i = 0; i < 8000; i++) {
    frame = tileset.update(view);
    if (frame.pending === 0 && tileset.progress.loading === 0 && tileset.progress.queued === 0) break;
    await settle(1);
  }
  assert.equal(frame.pending, 0);
  assert.equal(tileset.progress.failed, 0);
  const paths = frame.selected.map((tile) => tilePath(tile.id));
  assert.equal(paths.length, 1120);
  assert.equal(selectionChecksum(paths), 121586381);
  const drawn = new Set(frame.selected);
  for (const tile of frame.selected) {
    assert.ok(
      tile.screenSpaceError <= tileset.maximumScreenSpaceError || tile.children.length === 0,
      `${tile.id} sse ${tile.screenSpaceError}`,
    );
    if (tile.parent) assert.ok(tile.parent.screenSpaceError > tileset.maximumScreenSpaceError);
    for (let parent = tile.parent; parent; parent = parent.parent) assert.equal(drawn.has(parent), false);
  }
});
