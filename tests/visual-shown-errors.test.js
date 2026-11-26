import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { SHOWN_ERROR, shownErrorMessage, shownErrors, shownErrorsGuard } from '../scripts/support/shown-errors.js';

// KB-DEPTHTEX-BLACK1: the depth-texture demo's first frame threw, the demo showed the error, then wrote its ready line
// over it and reported ready, and visual:update took the black canvas as a baseline. A view that showed an error at
// any moment fails its capture.
test('a view that showed an error and then wrote other text over it fails its capture', async () => {
  let observe;
  const TEXT_NODE = 3,
    text = (data) => ({ nodeType: TEXT_NODE, data });
  Object.assign(globalThis, {
    window: {},
    document: {},
    Node: { TEXT_NODE },
    MutationObserver: class {
      constructor(callback) {
        observe = callback;
      }
      observe() {}
    },
  });
  try {
    shownErrorsGuard();
    shownErrorsGuard();
    const page = { evaluate: (read) => read() };
    observe([{ type: 'childList', addedNodes: [text('Starting WebGPU...')] }]);
    assert.equal(shownErrorMessage(await shownErrors(page)), undefined, 'ordinary status text passes');
    observe([
      {
        type: 'childList',
        addedNodes: [text('MargoError: Texture samples 32-bit float texels, which needs float32-filterable')],
      },
    ]);
    observe([{ type: 'characterData', target: text('The water material samples the scene depth.') }]);
    assert.match(shownErrorMessage(await shownErrors(page)), /^the page showed an error: MargoError: Texture samples/);
    assert.equal(window.margoShownErrors.length, 1, 'installing twice records once');
  } finally {
    for (const name of ['window', 'document', 'Node', 'MutationObserver']) delete globalThis[name];
  }
});

test('the pattern matches thrown errors as String(error) shows them, not ordinary words', () => {
  for (const shown of [
    'TypeError: x is not a function',
    'MargoError: unsupported',
    'Error: lost',
    'GPUValidationError: bad',
  ])
    assert.match(shown, SHOWN_ERROR);
  for (const plain of ['Error bars on every point', 'No errors', 'Error:', 'errorTolerance: 0.1'])
    assert.doesNotMatch(plain, SHOWN_ERROR);
  // The init script runs in the page on its own, so it repeats the pattern; the two stay the same.
  assert.ok(shownErrorsGuard.toString().includes(SHOWN_ERROR.source));
});

test('visual-regression installs the guard in every view and fails a capture that showed an error', () => {
  const source = readFileSync(new URL('../scripts/visual-regression.js', import.meta.url), 'utf8');
  assert.match(source, /addInitScript\(shownErrorsGuard\)/);
  assert.match(source, /shownErrorMessage\(await shownErrors\(page\)\)/);
});
