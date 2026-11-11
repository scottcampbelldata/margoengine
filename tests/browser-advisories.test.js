// KBL3c: checks accept Firefox's final-row advisory for exact pixel-buffer uploads, and nothing else, only on the
// Firefox versions it was seen in.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  acceptedAdvisory,
  expectedContextLosses,
  firefoxContextLost,
  watchConsole,
  FIREFOX_FINAL_ROW_LINE,
  FIREFOX_FINAL_ROW_VERSIONS,
} from '../scripts/support/browser-advisories.mjs';

const firefox = (browserVersion) => ({ browserName: 'firefox', browserVersion });

test('the final-row line is accepted on the Firefox versions it was seen in', () => {
  assert.deepEqual({ ...FIREFOX_FINAL_ROW_VERSIONS }, { first: 157, last: 157 });
  assert.equal(acceptedAdvisory(FIREFOX_FINAL_ROW_LINE, firefox('157.0')), true);
  assert.equal(acceptedAdvisory(FIREFOX_FINAL_ROW_LINE, firefox('157.0.1')), true);
  assert.equal(acceptedAdvisory(FIREFOX_FINAL_ROW_LINE, firefox('157')), true);
});

test('the final-row line fails on other browsers and other Firefox versions', () => {
  for (const hardware of [
    firefox('156.0'),
    firefox('158.0'),
    firefox(undefined),
    firefox('nightly'),
    { browserName: 'chromium', browserVersion: '157.0' },
    { browserName: 'webkit', browserVersion: '157.0' },
    undefined,
  ])
    assert.equal(acceptedAdvisory(FIREFOX_FINAL_ROW_LINE, hardware), false, JSON.stringify(hardware));
});

test('every other line still fails on Firefox 157, near copies included', () => {
  for (const text of [
    '[JavaScript Warning: "WebGL context was lost." {file: "http://127.0.0.1:5219/packages/webgl2-compat/dist/index.js" line: 99}]',
    '[JavaScript Warning: "After reporting 32, no further warnings will be reported for this WebGL context."]',
    '[JavaScript Warning: "WebGL warning: texImage: Tex image TEXTURE_2D level 0 is incurring lazy initialization."]',
    FIREFOX_FINAL_ROW_LINE.slice(0, -1),
    FIREFOX_FINAL_ROW_LINE + ' ',
    FIREFOX_FINAL_ROW_LINE.replace('texSubImage', 'texImage'),
    '',
  ])
    assert.equal(acceptedAdvisory(text, firefox('157.0')), false, text);
});

// Firefox (c): the layer probe's deliberate loseContext() is counted, not ignored, so an unplanned loss still fails.
const LOST = '[JavaScript Warning: "WebGL context was lost." {file: "http://127.0.0.1:5219/packages/webgl2-compat/dist/index.js" line: 99}]';

test('Firefox context-loss lines are recognised exactly, on Firefox only', () => {
  assert.equal(firefoxContextLost(LOST, firefox('157.0')), true);
  assert.equal(firefoxContextLost(LOST, { browserName: 'chromium' }), false);
  for (const text of [LOST.replace('lost.', 'lost!'), LOST + ' ', '[JavaScript Warning: "WebGL context was lost."]'])
    assert.equal(firefoxContextLost(text, firefox('157.0')), false, text);
});

test('watchConsole counts losses, drops the accepted advisory and keeps every other problem', () => {
  const page = new EventEmitter(),
    hardware = { ...firefox('157.0'), webgpu: { vendor: 'margo-webgl2' } },
    watch = watchConsole(page, hardware),
    say = (type, text) => page.emit('console', { type: () => type, text: () => text });
  say('warning', LOST);
  say('warning', FIREFOX_FINAL_ROW_LINE);
  say('log', 'plain log');
  say('warning', 'something else');
  say('error', 'an error');
  page.emit('pageerror', new Error('thrown'));
  assert.equal(watch.lost, 1);
  assert.deepEqual(watch.problems, ['something else', 'an error', 'thrown']);
  assert.equal(expectedContextLosses(hardware), 1);
  assert.equal(expectedContextLosses({ ...hardware, webgpu: { vendor: 'nvidia' } }), 0, 'native WebGPU probes nothing');
  assert.equal(expectedContextLosses({ browserName: 'chromium', webgpu: { vendor: 'margo-webgl2' } }), 0);
});
