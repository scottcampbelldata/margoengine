import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';
const c = await openBrowser({ startPath: '/packages/lod/test/imposter-fade-check.html', port: 5285 });
const errors = [];
c.page.on('pageerror', (e) => errors.push(e.message));
const timer = setTimeout(() => {
  console.error('imposter fade exceeded 2 minutes');
  process.exit(1);
}, 120000);
try {
  await c.page.waitForFunction(() => window.ready, null, { timeout: 60000 });
  const r = await c.page.evaluate(() => window.check.run());
  console.log(JSON.stringify(r));
  assert.deepEqual(errors, []);
  assert.deepEqual(r.errors, []);
  assert.ok(r.start.red > 1000);
  for (const [name, from, to] of [
    ['toImposter', 'red', 'green'],
    ['toFrames', 'green', 'blue'],
    ['toMesh', 'blue', 'red'],
  ]) {
    const v = r[name];
    assert.equal(v.active, 1, name);
    assert.equal(v.left, 0, name);
    assert.ok(v.quarter[from] > v.late[from], name + ' outgoing dissolves');
    assert.ok(v.quarter[to] < v.late[to], name + ' incoming grows');
    assert.ok(v.quarter[from] > 100 && v.quarter[to] > 100, name + ' both levels draw');
    assert.equal(v.end[from], 0, name + ' outgoing stops');
    assert.ok(v.end[to] > 1000, name + ' target alone');
  }
  assert.equal(r.toMesh.proxies, 1, 'outgoing imposter has a pick proxy');
  assert.ok(r.toNull.quarter.green > r.toNull.late.green);
  assert.deepEqual(r.toNull.end, { red: 0, green: 0, blue: 0 });
  assert.ok(r.playback.leftGreen>500&&r.playback.rightBlue>500,'shared first images retain independent sequence playback');
  assert.equal(r.playback.leftBlue,0);assert.equal(r.playback.rightGreen,0);
} finally {
  clearTimeout(timer);
  await c.close();
}
