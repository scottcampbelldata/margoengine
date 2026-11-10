import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { HTML } from '../dist/index.js';
import { sceneOwnerEngine } from '../../../tests/support/scene-owner-engine.js';

test('dispose() detaches HTML and its shared scene depth from its own scene, not the default one', async () => {
  const dom = new JSDOM('<body><canvas width="64" height="64"></canvas></body>');
  const { engine, scene, decoy } = await sceneOwnerEngine('html', dom.window.document.querySelector('canvas'));
  try {
    const html = new HTML();
    scene.use(html);
    assert.ok(scene.plugins.has('optional:scene-depth'), 'the depth capture joins the scene that samples it');
    assert.equal(engine.scene.plugins.has('optional:scene-depth'), false);
    // A second overlay in the default scene gets that scene's own capture, not the second scene's.
    const other = new HTML({ name: 'html-default' });
    engine.use(other);
    assert.ok(engine.scene.plugins.has('optional:scene-depth'), 'each scene captures its own depth');
    other.dispose();
    assert.equal(engine.scene.plugins.has('optional:scene-depth'), false);
    assert.ok(scene.plugins.has('optional:scene-depth'), 'releasing one scene keeps the other scene capture');
    html.dispose();
    assert.deepEqual([...scene.plugins.keys()], [], 'a disposed HTML overlay leaves nothing in its scene');
    assert.equal(engine.scene.plugins.get('html'), decoy);
    assert.equal(decoy.disposed, 0);
  } finally {
    engine.dispose();
  }
});
