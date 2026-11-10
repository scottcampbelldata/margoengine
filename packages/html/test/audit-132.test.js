// Regressions for the batch 132 audit of @margoengine/html. Each test fails on the code before the audit.
import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';
import { Engine, TransformStore } from '../../core/dist/extension.js';
import { HTML } from '../dist/index.js';
import { HTMLTexture } from '../dist/texture.js';

globalThis.GPUShaderStage ??= { VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 };

// `engine.removePlugin(name)` acts on the active scene: disposing a plugin attached to another scene removed the
// active scene's same-name plugin (and, for HTMLTexture, left the disposed one registered).
for (const [label, make] of [
  ['HTML', (name) => new HTML({ name, depth: false })],
  ['HTMLTexture', (name) => new HTMLTexture({ name })],
])
  test(`${label}.dispose removes it from its own scene, not the active scene's same-name plugin`, async () => {
    const h = optionalGPU(),
      dom = new JSDOM('<body><canvas width="16" height="16"></canvas></body>'),
      canvas = dom.window.document.querySelector('canvas'),
      engine = new Engine(
        canvas,
        await TransformStore.create(4),
        { backend: 'webgpu', gpu: h.engine.gpu, dispose() {} },
        {},
        null,
      );
    try {
      const other = engine.createScene('other'),
        plugin = make('overlay'),
        kept = { name: 'overlay', disposed: 0, setup() {}, dispose: () => kept.disposed++ };
      other.use(plugin);
      engine.use(kept);
      plugin.dispose();
      assert.equal(engine.plugins.get('overlay'), kept, 'the active scene lost its own plugin');
      assert.equal(kept.disposed, 0);
      assert.equal(other.plugins.has('overlay'), false, 'the disposed plugin stayed in its scene');
    } finally {
      engine.dispose();
      h.cleanup();
      dom.window.close();
    }
  });

// inlineCopy promised live form state but cloneNode resets a <select>'s chosen option to its default, so a texture of
// a form showed the option the page loaded with, not the one the user picked.
test('a copied select keeps the option the user picked, not the default one', async () => {
  const { inlineResources } = await import('../dist/inline.js');
  const dom = new JSDOM(
    '<body><div><select><option value="a" selected>a</option><option value="b">b</option></select></div></body>',
  );
  try {
    const element = dom.window.document.querySelector('div');
    element.querySelector('select').value = 'b';
    const original = element.outerHTML,
      copy = await inlineResources(element),
      options = copy.querySelectorAll('option');
    assert.equal(copy.querySelector('select').value, 'b');
    assert.deepEqual(
      [...options].map((o) => o.hasAttribute('selected')),
      [false, true],
    );
    assert.equal(element.outerHTML, original, 'the live tree was mutated');
  } finally {
    dom.window.close();
  }
});
