import test from 'node:test';
import assert from 'node:assert/strict';
import { Ui, UiRenderer } from '../dist/index.js';

// KB-FILM-UI-NODE: UiRenderer.attach with its defaults threw in headless Node ("e.addEventListener is not a function",
// then "reading 'createElement'"): a headless canvas has no pointer events and no document for the accessibility mirror.
const headlessEngine = (canvas) => ({ canvas, backend: 'webgpu', gpu: undefined, sceneOf: () => undefined });

test('UiRenderer sets up on a headless canvas with its default input and mirror', () => {
  const renderer = new UiRenderer(new Ui({ width: 64, height: 32 }));
  assert.doesNotThrow(() => renderer.setup(headlessEngine({ width: 64, height: 32 })));
  assert.doesNotThrow(() => renderer.dispose());
});

test('a canvas with event listeners still gets input, and its listeners go on dispose', () => {
  const added = [],
    removed = [],
    canvas = {
      width: 64,
      height: 32,
      addEventListener: (type) => added.push(type),
      removeEventListener: (type) => removed.push(type),
      hasAttribute: () => false,
      setAttribute() {},
      removeAttribute() {},
    },
    renderer = new UiRenderer(new Ui({ width: 64, height: 32 }));
  renderer.setup(headlessEngine(canvas));
  assert.ok(added.includes('pointerdown'), 'pointer input is attached where the canvas takes listeners');
  renderer.dispose();
  assert.equal(removed.length, added.length, 'every listener is removed again');
});
