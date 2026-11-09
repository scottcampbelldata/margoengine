import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { Engine, TransformStore } from '../../core/dist/extension.js';
import { LabelRenderer } from '../dist/index.js';
import { MargoError } from '../../math/dist/index.js';

test('test-page 41: duplicate annotation attachment explains the collision without disturbing existing labels', async () => {
  const dom = new JSDOM('<body><canvas width="200" height="200"></canvas></body>');
  const engine = new Engine(
    dom.window.document.querySelector('canvas'),
    await TransformStore.create(4),
    { backend: 'webgl2', add() {}, remove() {}, render() {}, dispose() {} },
    undefined,
    null,
  );
  try {
    const axesLabels = LabelRenderer.attach(engine);
    const text = dom.window.document.createElement('span');
    text.textContent = 'axis';
    axesLabels.add(text, { position: [0, 0, 0] });
    assert.throws(
      () => LabelRenderer.attach(engine, { layout: { update() {} } }),
      (error) =>
        error instanceof MargoError &&
        error.code === 'state' &&
        error.message.includes('margoengine-labels') &&
        error.message.includes('already attached') &&
        error.message.includes('reuse its LabelRenderer') &&
        error.message.includes("LabelRenderer.attach(engine, { name: 'annotations' })") &&
        error.message.includes('https://margoengine.com/errors#state'),
    );
    assert.equal(engine.plugins.get(axesLabels.name), axesLabels);
    assert.equal(text.isConnected, true);
    assert.equal(dom.window.document.querySelectorAll('[data-margoengine-labels]').length, 1);
    const annotations = LabelRenderer.attach(engine, { name: 'annotations' });
    assert.equal(engine.plugins.get('annotations'), annotations);
    assert.throws(
      () => LabelRenderer.attach(engine, { name: 'annotations' }),
      (error) => error instanceof MargoError && error.code === 'state' && error.message.includes('"annotations"'),
    );
    annotations.dispose();
    assert.equal(text.isConnected, true);
    assert.equal(engine.plugins.get(axesLabels.name), axesLabels);
  } finally {
    engine.dispose();
    dom.window.close();
  }
});
