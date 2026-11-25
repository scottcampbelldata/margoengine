// KB0043: a browser driver that loses its page names the cause (renderer exit, close, navigation) and the memory.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { watchPageLoss } from '../scripts/page-loss.mjs';

function fakePage({ cdp = true } = {}) {
  const page = new EventEmitter(),
    session = new EventEmitter(),
    frame = { url: () => 'http://127.0.0.1/tests/modern-extension.html' };
  page.mainFrame = () => frame;
  page.evaluate = async () => 1234;
  session.send = async (method) =>
    method === 'Performance.getMetrics'
      ? {
          metrics: [
            { name: 'JSHeapUsedSize', value: 5e8 },
            { name: 'Nodes', value: 40 },
            { name: 'Other', value: 1 },
          ],
        }
      : {};
  page.context = () => ({
    newCDPSession: async () => {
      if (!cdp) throw new Error('CDP session is only available in Chromium');
      return session;
    },
  });
  return { page, session, frame };
}

test('a renderer exit is recorded with its status and code, and the failure line names it', async () => {
  let t = 0;
  const { page, session, frame } = fakePage(),
    watch = await watchPageLoss(page, { now: () => (t += 10) });
  await watch.sample('lights: the real EnvironmentTest');
  session.emit('Target.targetCrashed', { status: 'oom', errorCode: -536870904 });
  page.emit('crash');
  page.emit('framenavigated', frame);
  page.emit('framenavigated', { url: () => 'about:blank#child' }); // a child frame is not the page
  const line = watch.report(
    'lights: the real EnvironmentTest',
    new Error('page.evaluate: Execution context was destroyed'),
  );
  assert.match(line, /^page-loss /);
  const info = JSON.parse(line.slice('page-loss '.length));
  assert.equal(info.lost, true);
  assert.deepEqual(
    info.events.map((e) => e.event),
    ['renderer exit', 'crash', 'navigated'],
  );
  assert.equal(info.events[0].status, 'oom');
  assert.equal(info.events[0].errorCode, -536870904);
  assert.equal(info.memory[0].JSHeapUsedSize, 5e8);
  assert.equal(info.memory[0].Nodes, 40);
  assert.equal(info.memory[0].Other, undefined);
});

test('without CDP (another browser) the JS heap still comes from the page', async () => {
  const { page } = fakePage({ cdp: false }),
    watch = await watchPageLoss(page);
  assert.equal((await watch.sample('a')).JSHeapUsedSize, 1234);
  page.emit('close');
  const info = JSON.parse(watch.report('a', new Error('pixels differ')).slice(10));
  assert.equal(info.lost, false);
  assert.deepEqual(
    info.events.map((e) => e.event),
    ['close'],
  );
});

test('a sample on a page that cannot answer is kept as unavailable, not thrown', async () => {
  const { page, session } = fakePage();
  const watch = await watchPageLoss(page);
  session.send = async () => {
    throw new Error('Target closed\nstack');
  };
  assert.equal((await watch.sample('b')).unavailable, 'Target closed');
});
