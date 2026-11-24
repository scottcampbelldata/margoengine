// createStage({ background }) sets the default scene's clear colour once at creation; core reads and validates it
// when the first frame clears, so a bad colour rejects createStage and leaves no canvas behind.
import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createStage } from '@margoengine/stage';
import { webglRenderer } from '@margoengine/webgl2-compat/preview';
import { glDrawHarness } from '../../../tests/support/core-draw-gpu.js';

/** A host element whose canvas is backed by the recording WebGL2 stand-in. */
function rig(t) {
  const h = glDrawHarness(t),
    host = new JSDOM('<body><div id="scene"></div></body>').window.document.querySelector('#scene'),
    colours = [];
  h.gl.clearColor = (...rgba) => colours.push(rgba);
  const create = host.ownerDocument.createElement.bind(host.ownerDocument);
  host.ownerDocument.createElement = (name) => {
    const element = create(name);
    if (name === 'canvas') element.getContext = h.canvas.getContext;
    return element;
  };
  return { host, colours };
}
const options = { controls: false, autoStart: false, fallback: webglRenderer };

test('background sets the default scene clear colour at creation', async (t) => {
  const { host, colours } = rig(t),
    app = await createStage(host, { ...options, background: '#202024' });
  t.after(() => app.engine.dispose());
  assert.equal(app.engine.scene.background, '#202024');
  assert.deepEqual(
    colours.at(-1).map((v) => Math.round(v * 255)),
    [32, 32, 36, 255],
  );
});

test('background null keeps the colour below and an unset background keeps core default', async (t) => {
  const { host } = rig(t),
    none = await createStage(host, { ...options, background: null }),
    unset = await createStage(host, options);
  t.after(() => (none.engine.dispose(), unset.engine.dispose()));
  assert.equal(none.engine.scene.background, null);
  assert.equal(unset.engine.scene.background, undefined);
});

test('an invalid background rejects createStage and removes the canvas it made', async (t) => {
  const { host } = rig(t);
  await assert.rejects(createStage(host, { ...options, background: '#12' }), RangeError);
  await assert.rejects(createStage(host, { ...options, background: 5 }), { name: 'TypeError', message: /errors#arguments/ });
  assert.equal(host.querySelector('canvas'), null);
});
