// Builds examples/tokyo-diorama.html with Vite and checks it in a real WebGPU browser.
import assert from 'node:assert/strict';
import {build} from 'vite';
import {openBrowser} from './browser.js';

const output = await build({configFile: false, logLevel: 'silent', build: {write: false, target: 'es2022', rollupOptions: {input: 'examples/tokyo-diorama.html'}}});
assert.ok(output.output.some(chunk => chunk.type === 'chunk' && chunk.isEntry), 'Tokyo diorama build failed');

const url = 'http://127.0.0.1:5193/examples/tokyo-diorama.html?quality=high';
const {page, close} = await openBrowser({startPath: '/examples/tokyo-diorama.html'});
const errors = [];
page.on('pageerror', e => errors.push(e.message));
page.on('console', m => {if (m.type() === 'error') errors.push(m.text());});
try {
  await page.goto(url);
  await page.waitForSelector('#viewport[data-ready="true"]', {timeout: 60000});
  const result = await page.evaluate(() => {
    const {stage, model, animation, controls} = window.tokyoDemo;
    const tram = model.asset.doc.nodes.findIndex(n => n.name === 'Tram');
    const at = time => {animation.playing = false; animation.seek(time); stage.engine.render(); const m = model.nodes[tram].matrix; return [m[12], m[13], m[14]];};
    const a = at(0.5), b = at(3.5);
    return {tram, distance: Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]), clips: animation.clips.map(c => c.name), autoRotate: controls.autoRotate,
      stats: !!document.querySelector('[data-margo-stats]'), status: document.querySelector('#status').textContent};
  });
  assert.ok(result.tram >= 0, 'Tram node missing');
  assert.deepEqual(result.clips, ['Diorama']);
  assert.ok(result.distance > 1, 'Tram did not move along its track: ' + JSON.stringify(result));
  assert.ok(result.autoRotate, 'Auto-rotate should be on without reduced motion');
  assert.ok(result.stats, 'Stats panel missing');
  assert.equal(result.status, 'Ready');
  await page.screenshot({path: 'test-results/tokyo-diorama.png'});

  // Reduced motion: paused clip, no auto-rotate.
  await page.emulateMedia({reducedMotion: 'reduce'});
  await page.goto(url);
  await page.waitForSelector('#viewport[data-ready="true"]', {timeout: 60000});
  assert.deepEqual(await page.evaluate(() => [window.tokyoDemo.animation.playing, window.tokyoDemo.controls.autoRotate]), [false, false]);
  await page.emulateMedia({reducedMotion: 'no-preference'});

  // Phone viewport: scene stays visible above the controls.
  await page.setViewportSize({width: 390, height: 844});
  await page.goto(url);
  await page.waitForSelector('#viewport[data-ready="true"]', {timeout: 60000});
  const layout = await page.evaluate(() => {const r = document.querySelector('#viewport').getBoundingClientRect(); return {height: r.height, overflowX: document.documentElement.scrollWidth > innerWidth};});
  assert.ok(layout.height >= 300 && !layout.overflowX, 'Phone layout hides the diorama: ' + JSON.stringify(layout));
  await page.screenshot({path: 'test-results/tokyo-diorama-phone.png'});
  await page.setViewportSize({width: 1440, height: 1100});

  // Missing asset: visible error, no blank page.
  await page.route('**/assets/tokyo-diorama.glb', route => route.fulfill({status: 404, body: 'missing'}));
  errors.length = 0;
  await page.goto(url);
  await page.waitForFunction(() => document.querySelector('#status').textContent === 'Unable to load scene');
  assert.ok((await page.textContent('#error')).length > 0, 'Load failure not reported');
  await page.unroute('**/assets/tokyo-diorama.glb');
  errors.length = 0; // the 404 itself logs a console error
} finally {
  await close();
}
assert.deepEqual(errors, [], 'Console errors: ' + errors.join('\n'));
console.log('Tokyo diorama browser check passed');
