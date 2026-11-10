// Regressions for the batch 132 audit of @margoengine/viewcube. Each test fails on the code before the audit.
import assert from 'node:assert/strict';
import test from 'node:test';
import { ViewCube } from '../dist/index.js';
import { ViewCompass } from '../dist/compass.js';
import { setup } from './support.mjs';

// The engine's plugins as the scene the widget was added to; then another scene becomes the active one.
function switchScene(engine) {
  const owned = engine.plugins,
    first = {
      removePlugin(name) {
        const p = owned.get(name);
        owned.delete(name);
        p?.dispose?.();
      },
    },
    active = new Map();
  engine.sceneOf = (p) => (owned.get(p.name) === p ? first : undefined);
  engine.hasPlugin = (name) => active.has(name);
  engine.removePlugin = (name) => active.delete(name);
  return owned;
}

test('ViewCube.dispose leaves the scene it was added to, not the active scene', () => {
  const { engine } = setup(),
    cube = new ViewCube(engine, { duration: 0 }),
    owned = switchScene(engine);
  assert.ok(owned.has(cube.name));
  cube.dispose();
  assert.equal(owned.has(cube.name), false, 'the cube stayed registered in its scene');
});

test('ViewCompass.dispose leaves the scene it was added to, not the active scene', () => {
  const { engine } = setup(),
    cube = new ViewCube(engine, { duration: 0 }),
    compass = new ViewCompass(cube),
    owned = switchScene(engine);
  assert.ok(owned.has(compass.name));
  compass.dispose();
  assert.equal(owned.has(compass.name), false, 'the compass stayed registered in its scene');
  cube.dispose();
});
