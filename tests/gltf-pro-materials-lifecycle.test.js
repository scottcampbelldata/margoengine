import assert from 'node:assert/strict';
import test from 'node:test';

test('material GPU suite preserves its check failure when browser teardown also fails', async (t) => {
  const checkError = new Error('material readback failed');
  const closeError = new Error('client cleanup did not settle');
  const reports = [];
  let closes = 0;
  t.mock.method(console, 'error', (message) => reports.push(message));
  t.mock.module('../scripts/browser.js', {
    namedExports: {
      openBrowser: async () => ({
        page: { on() {}, waitForSelector: async () => {}, evaluate: async () => { throw checkError; } },
        hardware: {},
        close: async () => { closes++; throw closeError; },
      }),
    },
  });
  await assert.rejects(import('../scripts/gltf-pro-materials-gpu-check.js'), (error) => error === checkError);
  assert.equal(closes, 1);
  assert.match(reports.join('\n'), /teardown failed too: client cleanup did not settle/);
});
