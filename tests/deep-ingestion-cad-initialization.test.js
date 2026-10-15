import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { Camera } from '../packages/core/dist/camera.js';
const sourceFile = process.env.DEEP_INGESTION_BASELINE
  ? process.env.DEEP_INGESTION_BASELINE + '/packages/core/src/controls.ts'
  : new URL('../packages/core/src/controls.ts', import.meta.url);
let source = stripTypeScriptTypes(await fs.readFile(sourceFile, 'utf8'), { mode: 'transform' });
source = source.replace(
  "'./camera.js'",
  JSON.stringify(new URL('../packages/core/dist/camera.js', import.meta.url).href),
);
const { CADCameraControls } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
function element(failAt = Infinity) {
  const listeners = new Map(),
    captures = new Set(),
    failure = new Error('Injected listener initialization failure');
  let count = 0;
  return {
    style: { touchAction: 'pan-x' },
    listeners,
    captures,
    failure,
    clientHeight: 100,
    addEventListener(name, listener) {
      if (++count === failAt) throw failure;
      listeners.set(name, listener);
    },
    removeEventListener(name, listener) {
      if (listeners.get(name) === listener) listeners.delete(name);
    },
    setPointerCapture(id) {
      captures.add(id);
    },
    hasPointerCapture(id) {
      return captures.has(id);
    },
    releasePointerCapture(id) {
      captures.delete(id);
    },
  };
}
test('Core CAD initialization releases every partially installed listener and restores touch action', () => {
  for (let failAt = 1; failAt <= 6; failAt++) {
    const target = element(failAt);
    assert.throws(
      () => new CADCameraControls(new Camera(), target),
      (error) => error === target.failure,
    );
    assert.equal(target.listeners.size, 0, 'Partial listeners leaked at registration ' + failAt);
    assert.equal(target.style.touchAction, 'pan-x');
  }
});
test('Core CAD controls retain ordinary navigation and complete listener/pointer cleanup', () => {
  const target = element(),
    camera = new Camera(),
    controls = new CADCameraControls(camera, target);
  assert.equal(target.listeners.size, 6);
  assert.equal(target.style.touchAction, 'none');
  const before = camera.position.slice();
  target.listeners.get('pointerdown')({ button: 0, pointerId: 7, clientX: 10, clientY: 10 });
  assert.ok(target.captures.has(7));
  target.listeners.get('pointermove')({ pointerId: 7, clientX: 20, clientY: 15 });
  assert.notDeepEqual(camera.position, before);
  assert.ok(camera.position.every(Number.isFinite));
  controls.dispose();
  assert.equal(target.listeners.size, 0);
  assert.equal(target.captures.size, 0);
  assert.equal(target.style.touchAction, 'pan-x');
  controls.dispose();
  assert.equal(target.listeners.size, 0);
});
