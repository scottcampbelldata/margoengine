import test from 'node:test';
import assert from 'node:assert/strict';
import { Camera } from '@margoengine/core';
import { fakeEngine } from './fake-dom.js';
import { LabelRenderer } from '../dist/index.js';

// Overlay alignment under a CSS scale on the canvas's ancestors. The fake DOM scales rects like a browser with
// transform-origin 0 0: an element's drawn size and its children's offsets are multiplied by every scale above it.
function scene(scale, parent) {
  const engine = fakeEngine(Camera);
  const { canvas, container, document } = engine;
  // A scaled frame at (100, 50) holding the canvas 30 px in, with a 3 px border.
  container.cssScale = scale;
  Object.assign(container.style, { left: '100px', top: '50px' });
  canvas.fixedRect = null;
  Object.assign(canvas.style, { left: '30px', top: '20px', width: '806px', height: '406px' });
  Object.defineProperty(canvas, 'offsetWidth', { get: () => 806 });
  Object.assign(canvas, { clientLeft: 3, clientTop: 3 });
  let host = null;
  if (parent) {
    host = document.body.appendChild(document.createElement('div'));
    Object.assign(host.style, { left: '7px', top: '9px' });
    host.cssScale = parent;
  }
  const renderer = new LabelRenderer(host ? { parent: host } : {});
  renderer.setup(engine);
  renderer.registerPasses(engine.graph);
  return { engine, renderer, canvas };
}
const close = (a, b, epsilon = 0.011) => Math.abs(a - b) <= epsilon;

test('beside a scaled canvas the overlay lands on the content box in one update, at any scale', () => {
  for (const scale of [0.5, 0.75, 1, 1.5, 2, 3, 4]) {
    const { engine, renderer, canvas } = scene(scale);
    engine.frame();
    const target = canvas.getBoundingClientRect(),
      root = renderer.root.getBoundingClientRect();
    assert.ok(close(root.left, target.left + 3 * scale), `scale ${scale}: root left ${root.left}`);
    assert.ok(close(root.top, target.top + 3 * scale), `scale ${scale}: root top ${root.top}`);
    assert.ok(close(root.width, 800 * scale), `scale ${scale}: root width ${root.width}`);
    assert.equal(renderer.root.style.transform, undefined, 'a root beside the canvas needs no scale of its own');
    // A label's offset inside the root is drawn at the canvas's scale.
    assert.equal(root.scale, scale);
    engine.frame();
    assert.equal(renderer.writes, 0, `scale ${scale}: the next update writes nothing`);
  }
});

test('an overlay in another parent is scaled to the canvas and placed on it', () => {
  for (const [scale, parent] of [
    [2, 1],
    [0.75, 1],
    [1, 2],
    [3, 1.5],
  ]) {
    const { engine, renderer, canvas } = scene(scale, parent);
    engine.frame();
    const target = canvas.getBoundingClientRect(),
      root = renderer.root.getBoundingClientRect();
    assert.ok(close(root.left, target.left + 3 * scale), `${scale} / ${parent}: root left ${root.left}`);
    assert.ok(close(root.top, target.top + 3 * scale), `${scale} / ${parent}: root top ${root.top}`);
    assert.ok(close(root.width, 800 * scale, 1e-3), `${scale} / ${parent}: root width ${root.width}`);
    assert.ok(close(root.scale, scale, 1e-6), `${scale} / ${parent}: labels drawn at ${root.scale}`);
    assert.equal(renderer.root.style.transformOrigin, '0 0');
    engine.frame();
    assert.equal(renderer.writes, 0, `${scale} / ${parent}: the next update writes nothing`);
  }
  // Back to equal scales: the root's own scale is cleared.
  const { engine, renderer, canvas } = scene(2, 1);
  engine.frame();
  assert.equal(renderer.root.style.transform, 'scale(2)');
  canvas.parentElement.cssScale = 1;
  engine.frame();
  assert.equal(renderer.root.style.transform, '');
  assert.ok(close(renderer.root.getBoundingClientRect().left, canvas.getBoundingClientRect().left + 3));
});
