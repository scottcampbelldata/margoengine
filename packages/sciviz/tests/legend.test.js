import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { Legend } from '../dist/index.js';

test('legend rows remain hidden when its native hidden state is set, then show again', () => {
  const dom = new JSDOM('<div><canvas></canvas></div>');
  const saved = { document: globalThis.document, getComputedStyle: globalThis.getComputedStyle };
  globalThis.document = dom.window.document;
  globalThis.getComputedStyle = dom.window.getComputedStyle;
  const legend = new Legend(document.querySelector('canvas'), {
    text: '#000000', background: '#ffffff', axis: '#333333', grid: '#cccccc',
  });
  try {
    const entries = ['first', 'second'].map(name => ({ name, color: '#ff0000', shape: 'square' }));
    const inset = { top: 0, right: 0, bottom: 0, left: 0 };
    legend.update(entries, 'top-right', inset);
    assert.notEqual(getComputedStyle(legend.element).display, 'none');
    legend.element.hidden = true;
    assert.equal(getComputedStyle(legend.element).display, 'none');
    legend.update(entries, 'top-right', inset);
    assert.equal(legend.element.hidden, false);
    assert.notEqual(getComputedStyle(legend.element).display, 'none');
    legend.update([], 'top-right', inset);
    assert.equal(getComputedStyle(legend.element).display, 'none');
  } finally {
    legend.dispose();
    Object.assign(globalThis, saved);
    dom.window.close();
  }
});
