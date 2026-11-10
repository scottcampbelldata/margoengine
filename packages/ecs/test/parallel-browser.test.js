import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { launchBrowser } from '../../../scripts/lib/browser.mjs';
const root = fileURLToPath(new URL('../../../', import.meta.url));
const html =
  '<html><head><script type="importmap">{"imports":{"@margoengine/math/errors":"/packages/math/dist/errors.js"}}</script></head><body></body></html>';
const system =
  'export default ({components:c,delta})=>{for(let i=0;i<c.position.count;i++){const e=c.position.entities[i],r=c.velocity.rows[e%c.velocity.stride];if(r>=0&&c.velocity.entities[r]===e)c.position.fields.x[i]+=c.velocity.fields.x[r]*delta;}}';
test('CPU-only browser workers load the packaged asset, share numeric fields and require isolation', {
  timeout: 120000,
}, async () => {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname !== '/unisolated') {
      res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
      res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
    }
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    if (url.pathname === '/' || url.pathname === '/unisolated') {
      res.setHeader('Content-Type', 'text/html');
      res.end(html);
      return;
    }
    if (url.pathname === '/system.js') {
      res.setHeader('Content-Type', 'text/javascript');
      res.end(system);
      return;
    }
    const path = resolve(root, '.' + decodeURIComponent(url.pathname));
    if (!path.startsWith(root.endsWith(sep) ? root : root + sep)) {
      res.statusCode = 403;
      res.end();
      return;
    }
    try {
      const bytes = await readFile(path);
      res.setHeader('Content-Type', 'text/javascript');
      res.end(bytes);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      res.statusCode = 404;
      res.end();
    }
  });
  await new Promise((done, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', done);
  });
  let browser;
  try {
    browser = await launchBrowser({
      needs: 'cpu',
      headless: true,
      args: ['--disable-gpu', '--disable-software-rasterizer'],
      timeout: 30000,
    });
    const page = await browser.newPage();
    page.setDefaultTimeout(30000);
    const base = 'http://127.0.0.1:' + server.address().port;
    await page.goto(base);
    const result = await page.evaluate(async (base) => {
      const { SharedWorld, ParallelSchedule } = await import('/packages/ecs/dist/parallel.js');
      const world = new SharedWorld(4),
        position = world.component({ x: Float32Array }),
        velocity = world.component({ x: Float32Array });
      const a = world.create(),
        b = world.create();
      position.add(a, { x: 3 });
      position.add(b, { x: 7 });
      velocity.add(b, { x: 10 });
      velocity.add(a, { x: 4 });
      const schedule = new ParallelSchedule(world, { position, velocity }, { workers: 2 });
      schedule.add({ name: 'move', module: base + '/system.js', reads: ['velocity'], writes: ['position'] });
      try {
        await schedule.update(0.5);
        return {
          isolated: crossOriginIsolated,
          values: [...position.fields.x.subarray(0, 2)],
          shared: position.fields.x.buffer instanceof SharedArrayBuffer,
        };
      } finally {
        await schedule.stop();
      }
    }, base);
    assert.deepEqual(result, { isolated: true, values: [5, 12], shared: true });
    await page.goto(base + '/unisolated');
    const unsupported = await page.evaluate(async () => {
      const { SharedWorld } = await import('/packages/ecs/dist/parallel.js');
      try {
        new SharedWorld(2);
        return 'unexpected';
      } catch (error) {
        return error.code;
      }
    });
    assert.equal(unsupported, 'unsupported');
  } finally {
    if (browser) await browser.close();
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
  }
});
