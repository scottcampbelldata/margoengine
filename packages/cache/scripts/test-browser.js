// RangeCache and the eviction index on a real browser: real IndexedDB, real fetch, a real HTTP server that answers
// byte ranges with an ETag, and the browser's own offline mode. gltf-pro's progressive streaming code reads a real
// Khronos sample through RangeCache, again after a reload with the browser offline, and once more online, when it
// revalidates with one conditional request. Writes test-results/cache-browser.json.
//   npm run test:browser --workspace=@margoengine/cache        MARGO_BROWSER=chromium for Playwright's Chromium
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { launchBrowser } from '../../../scripts/lib/browser.mjs';
import { closeAll } from '../../../scripts/support/shutdown.mjs';

const packageRoot = fileURLToPath(new URL('..', import.meta.url)),
  root = resolve(packageRoot, '../..'),
  results = resolve(packageRoot, 'test-results'),
  // A real Khronos sample (THIRD-PARTY-NOTICES.md): 4.1 MB, so the stream reads it in many ranges.
  sample = 'examples/assets/khronos/SheenChair/SheenChair.glb',
  glb = readFileSync(resolve(root, sample)),
  etag = `"${createHash('sha256').update(glb).digest('hex').slice(0, 16)}"`,
  sha = (bytes) => createHash('sha256').update(bytes).digest('hex'),
  json = glb.readUInt32LE(12),
  bin = glb.subarray(28 + json, 28 + json + glb.readUInt32LE(20 + json)),
  stream = readdirSync(resolve(root, 'packages/gltf-pro/dist')).find((name) => /^stream-.*\.js$/.test(name));
// A limit per page call, far past what one takes; the run as a whole is bounded by the check that starts it.
const CALL_LIMIT = 180_000;
assert.ok(stream, 'gltf-pro is built (npm run build --workspace=@margoengine/gltf-pro)');

/** The files the page fetches, and every request that reached the server. */
const files = {
    '/cache-files/chair.glb': glb,
    '/cache-files/a': Buffer.alloc(100, 1),
    '/cache-files/b': Buffer.alloc(100, 2),
    '/cache-files/variants': Buffer.alloc(100, 5),
    '/cache-files/c': Buffer.alloc(100, 3),
    '/cache-files/huge': Buffer.alloc(400, 4),
  },
  log = [];
const fileOf = (path) =>
  files[path] ??
  (/^\/cache-files\/tile\/\d+$/.test(path) ? Buffer.alloc(10, Number(path.split('/').pop()) & 255) : undefined);
let releaseBody;

const server = await createServer({
  root,
  configFile: false,
  logLevel: 'error',
  cacheDir: resolve(results, '.vite'),
  server: { port: 0, host: '127.0.0.1', hmr: false, watch: null, fs: { allow: [root] } },
  optimizeDeps: { noDiscovery: true, include: [] },
  plugins: [
    {
      name: 'cache-files',
      configureServer(vite) {
        vite.middlewares.use((request, response, next) => {
          const path = new URL(request.url, 'http://127.0.0.1').pathname.replace(
            '/packages/cache/test/sw-files/',
            '/cache-files/',
          );
          if (path === '/cache-files/stream-chair.glb') {
            response.setHeader('cache-control', 'max-age=3600');
            response.setHeader('content-length', glb.length);
            response.write(glb.subarray(0, 256));
            releaseBody = () => response.end(glb.subarray(256));
            return;
          }
          const body = fileOf(path);
          if (!body) return next();
          const range = request.headers.range;
          log.push({ path, range, etag: request.headers['if-none-match'] });
          response.setHeader('etag', etag);
          response.setHeader('accept-ranges', 'bytes');
          response.setHeader('content-type', 'application/octet-stream');
          if (path === '/cache-files/variants') response.setHeader('vary', 'Accept-Language');
          if (request.headers['if-none-match'] === etag) {
            response.statusCode = 304;
            return response.end();
          }
          const match = /^bytes=(\d+)-(\d*)$/.exec(range ?? '');
          if (!match) {
            response.setHeader('content-length', body.length);
            return response.end(body);
          }
          const start = Number(match[1]),
            end = Math.min(match[2] ? Number(match[2]) : body.length - 1, body.length - 1);
          response.statusCode = 206;
          response.setHeader('content-range', `bytes ${start}-${end}/${body.length}`);
          response.setHeader('content-length', end - start + 1);
          response.end(body.subarray(start, end + 1));
        });
      },
    },
  ],
});
await server.listen();
const origin = `http://127.0.0.1:${server.httpServer.address().port}`,
  pageURL = `${origin}/packages/cache/test/browser.html?stream=${encodeURIComponent(`/packages/gltf-pro/dist/${stream}`)}`;

let browser;
try {
  browser = await launchBrowser({ headless: true, needs: 'none' });
  const context = await browser.newContext(),
    page = await context.newPage(),
    errors = [];
  // A routed request skips the browser's own HTTP cache, so every request the cache makes reaches the server's log.
  await context.route('**/cache-files/**', (route) => route.continue());
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => message.type() === 'error' && errors.push(message.text()));
  const open = async () => {
    await page.goto(pageURL);
    await page.waitForFunction(() => window.cacheReady === true, undefined, { timeout: 60_000 });
    // Load the streaming code now, so a later offline run needs no module from the server.
    await page.evaluate(() => window.cacheChecks.preload());
  };
  // Each call has a hard limit, so a stuck stream fails the run instead of holding it.
  const call = async (name, ...args) => {
    const started = Date.now();
    let timer;
    try {
      return await Promise.race([
        page.evaluate(([n, a]) => window.cacheChecks[n](...a), [name, args]),
        new Promise(
          (_, reject) =>
            (timer = setTimeout(() => reject(new Error(`${name} took over ${CALL_LIMIT / 1000} s`)), CALL_LIMIT)),
        ),
      ]);
    } finally {
      clearTimeout(timer);
      console.error(`${name}: ${((Date.now() - started) / 1000).toFixed(1)} s`);
    }
  };
  const report = { browser: `${browser.browserType().name()} ${browser.version()}`, sample, bytes: glb.length };

  // 1. Cold: the stream reads the chair in ranges, every one fetched once and stored.
  await open();
  const firstMiss = await call('beginMiss');
  assert.equal(firstMiss.bytes, 256, 'first chunk delivered while the server holds the remainder');
  assert.equal(firstMiss.files, 0, 'an incomplete response is never committed');
  releaseBody();
  const streamedMiss = await page.evaluate(() => window.finishMiss());
  assert.equal(streamedMiss.digest, sha(glb));
  assert.equal(streamedMiss.stored, sha(glb));
  assert.equal(streamedMiss.stats.stored, 1);
  assert.equal(streamedMiss.stats.hits, 1);
  report.streamedMiss = { first: firstMiss, ...streamedMiss };
  const decodedCold = await call('decodedCold');
  assert.equal(decodedCold.decodes, 2);
  assert.equal(decodedCold.vertices, 24);
  assert.equal(decodedCold.format, 'rgba8unorm');
  assert.equal(decodedCold.mips, 6);
  await open();
  const decodedWarm = await call('decodedWarm', decodedCold.keys);
  assert.deepEqual(decodedWarm.digest, decodedCold.digest, 'all real decoded arrays and mip metadata survive reload');
  assert.equal(decodedWarm.hits, 2);
  report.decoded = { ...decodedCold, warmHits: decodedWarm.hits };
  let before = log.length;
  const cold = await call('streamRanges', 'chair', '/cache-files/chair.glb'),
    coldRequests = log.slice(before);
  assert.equal(cold.buffers[0], sha(bin), 'the streamed buffer equals the file');
  assert.ok(coldRequests.length > 2, `streamed in ranges (${coldRequests.length} requests)`);
  assert.ok(
    coldRequests.every((r) => /^bytes=\d+-\d+$/.test(r.range ?? '')),
    'every request is a range',
  );
  assert.equal(cold.usage.bytes, glb.length, 'every byte the stream read is stored');
  report.cold = { requests: coldRequests.length, stats: cold.stats, usage: cold.usage };

  // 2. Offline after a reload: the browser reaches no server, and the stream ends with the same buffer.
  await open();
  await context.setOffline(true);
  before = log.length;
  const offline = await call('streamRanges', 'chair', '/cache-files/chair.glb');
  assert.equal(offline.buffers[0], sha(bin), 'offline, the stored blocks give the same buffer');
  assert.equal(log.length, before, 'offline, no request reached the server');
  assert.equal(offline.stats.misses, 0);
  assert.ok(offline.stats.hits > 2, `answered from the stored blocks (${offline.stats.hits} hits)`);
  assert.equal(offline.stats.offline, 1, 'the one revalidation failed and the blocks were served');
  report.offline = { stats: offline.stats };
  await context.setOffline(false);

  // 3. Online in a new session: one conditional request revalidates the file, then every range comes from the blocks.
  await open();
  before = log.length;
  const warm = await call('streamRanges', 'chair', '/cache-files/chair.glb'),
    warmRequests = log.slice(before);
  assert.equal(warm.buffers[0], sha(bin));
  assert.deepEqual(
    warmRequests,
    [{ path: '/cache-files/chair.glb', range: 'bytes=0-0', etag }],
    'one conditional request',
  );
  assert.equal(warm.stats.misses, 0);
  report.revalidated = { requests: warmRequests, stats: warm.stats };

  // 4. A covered range in a new RangeCache: its bytes come from the blocks; the one request is the revalidation.
  before = log.length;
  const covered = await call('rangeOf', 'chair', '/cache-files/chair.glb', 'bytes=1000-2999');
  assert.equal(covered.status, 206);
  assert.equal(covered.contentRange, `bytes 1000-2999/${glb.length}`);
  assert.equal(covered.digest, sha(glb.subarray(1000, 3000)));
  assert.deepEqual(
    log.slice(before),
    [{ path: '/cache-files/chair.glb', range: 'bytes=0-0', etag }],
    'no request for the range',
  );
  assert.equal(covered.stats.revalidated, 1);

  // 5. Eviction index on the real IndexedDB: least recently used first, and an evicted file is gone offline.
  const order = await call('evictionOrder', 'order');
  assert.deepEqual(order, { evicted: 1, usage: { bytes: 200, files: 2 }, a: 100, b: 'TypeError' });
  report.evictionOrder = order;

  const variants = await call('evictionVariants');
  assert.deepEqual(variants, [
    { bytes: 600, files: 6 },
    { bytes: 100, files: 1 },
    { bytes: 100, files: 1 },
  ]);
  report.evictionVariants = variants;

  const staleTouches = await call('staleTouch');
  assert.equal(staleTouches.length, 4);
  for (const result of staleTouches) {
    assert.deepEqual(result.after, result.before, 'a delayed hit cannot change stored byte/file totals');
    assert.deepEqual(result.old, [100, 1], 'the already-read response remains valid for its caller');
    if (result.mode === 'evict') {
      assert.deepEqual(result.after, { bytes: 100, files: 1 });
      assert.deepEqual(result.restored, { bytes: 100, files: 1 });
      assert.equal(result.b, 'TypeError', 'recreating a must make budget room by evicting b');
    } else {
      assert.deepEqual(result.after, { bytes: 80, files: 1 });
      assert.deepEqual(result.current, [80, 9]);
      assert.equal(result.etag, '"new"');
      assert.equal(result.type, 'application/new');
    }
  }
  report.staleTouches = staleTouches;

  // 6. 2,000 stored files, then 30 more writes under a full budget: the records each write reads.
  const plain = await call('evictionReads', 'plain', false, 2000, 30),
    indexed = await call('evictionReads', 'indexed', true, 2000, 30);
  assert.equal(plain.evicted, 30);
  assert.equal(indexed.evicted, 30);
  assert.equal(indexed.files, plain.files, 'both keep the same files');
  assert.equal(indexed.bytes, plain.bytes);
  // Per write the default reads every entry's record; the index reads the totals, the evicted entry and the cursor's rows.
  assert.ok(plain.reads >= 30 * 2000, `default read ${plain.reads}`);
  assert.ok(indexed.reads <= 30 * 8, `index read ${indexed.reads}`);
  report.evictionReads = { plain, indexed };

  const checkPrefetch = (result) => {
    assert.equal(result.paused.started, 0);
    assert.equal(result.paused.queued, 4);
    assert.deepEqual(result.order, ['/cache-files/c', '/cache-files/b', '/cache-files/a', '/cache-files/chair.glb']);
    assert.ok(result.outcomes.every((item) => item.status === 'done'));
    assert.equal(result.stats.done, 4);
    assert.equal(result.stats.cancelled, 1);
    assert.equal(result.stats.bytes, glb.length + 300);
    assert.equal(result.duplicate[0].status, 'done');
    assert.equal(result.cancelled[0].status, 'cancelled');
    assert.equal(result.sha, sha(glb));
    assert.equal(result.usage.files, 4);
    assert.equal(result.usage.bytes, glb.length + 300);
  };
  const checkThrottle = (result) => {
    assert.ok(result.delays.length >= 2);
    assert.deepEqual(result.delays, result.expected, 'shared byte debt sets the exact requested timer deadlines');
    assert.deepEqual(result.values, [Array(100).fill(1), Array(100).fill(2)]);
  };
  report.prefetchWindow = await call('prefetchProof');
  checkPrefetch(report.prefetchWindow);
  report.throttleWindow = await call('throttleProof');
  checkThrottle(report.throttleWindow);
  assert.equal(await call('serviceWorkerReady'), true);
  report.prefetchWorker = await call('workerProof', 'prefetch');
  checkPrefetch(report.prefetchWorker);
  report.throttleWorker = await call('workerProof', 'throttle');
  checkThrottle(report.throttleWorker);
  assert.equal(report.prefetchWindow.idleAPI, 'function');
  assert.equal(report.prefetchWorker.idleAPI, 'undefined');
  before = log.length;
  const serviceCold = await call('serviceWorkerRange', 'bytes=1000-2999');
  assert.equal(serviceCold.status, 206);
  assert.equal(serviceCold.range, `bytes 1000-2999/${glb.length}`);
  assert.equal(serviceCold.sha, sha(glb.subarray(1000, 3000)));
  assert.ok(log.slice(before).some((item) => item.range === 'bytes=0-4095'));
  const committed = await call('workerProof', 'flush');
  assert.equal(committed.bytes, 4096);
  const originalWorker = await call('workerProof', 'identity');
  await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.getRegistration();
    await registration.unregister();
  });
  await open();
  assert.equal(await call('serviceWorkerReady', 2), true);
  const replacementWorker = await call('workerProof', 'identity');
  assert.notEqual(replacementWorker, originalWorker, 'a distinct worker instance reopens IndexedDB');
  await context.setOffline(true);
  before = log.length;
  const serviceOffline = await call('serviceWorkerRange', 'bytes=1000-2999');
  assert.deepEqual(serviceOffline, serviceCold, 'a restarted service worker reopens its persisted ranges offline');
  assert.equal(log.length, before);
  report.serviceWorker = { cold: serviceCold, offline: serviceOffline, restarted: true };
  await context.setOffline(false);

  assert.deepEqual(errors, []);
  mkdirSync(results, { recursive: true });
  writeFileSync(resolve(results, 'cache-browser.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
} finally {
  await closeAll({ browser, servers: [server] });
}
