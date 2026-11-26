// MARGO_COMPAT not applicable: the page exercises IndexedDB, fetch and byte ranges and makes no GPU calls.
// RangeCache and the eviction index on a real browser: real IndexedDB, real fetch, a real HTTP server that answers
// byte ranges with an ETag, and the browser's own offline mode. gltf/pbr's progressive streaming code reads a real
// Khronos sample through RangeCache, again after a reload with the browser offline, and once more online, when it
// revalidates with one conditional request. Vary keys, asset bundles and Expires and Age freshness run against the
// same server and, for what CORS hides, a second origin. Writes test-results/cache-browser.json.
//   npm run test:browser --workspace=@margoengine/cache        MARGO_BROWSER=chromium for Playwright's Chromium
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createServer as createHTTPServer } from 'node:http';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { noFileWatcher } from '../../../scripts/support/no-file-watcher.js';
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
  stream = readdirSync(resolve(root, 'packages/gltf/dist')).find((name) => /^stream-.*\.js$/.test(name));
// A limit per page call, far past what one takes; the run as a whole is bounded by the check that starts it.
const CALL_LIMIT = 180_000;
assert.ok(stream, 'gltf/pbr is built (npm run build --workspace=@margoengine/gltf)');

/** The files the page fetches, and every request that reached the server. */
const files = {
    '/cache-files/chair.glb': glb,
    '/cache-files/a': Buffer.alloc(100, 1),
    '/cache-files/b': Buffer.alloc(100, 2),
    '/cache-files/variants': Buffer.alloc(100, 5),
    '/cache-files/c': Buffer.alloc(100, 3),
    '/cache-files/huge': Buffer.alloc(400, 4),
  },
  log = [],
  // The `?v=` query of every request that carried one: bundle files are asked for by their hash.
  versions = [];
/**
 * A response whose headers say how long it stays fresh (RFC 9111 section 4.2). A conditional request gets a 304 with
 * the same headers.
 */
const lifetimes = (now) => ({
  expires: { date: new Date(now).toUTCString(), expires: new Date(now + 3_600_000).toUTCString() },
  past: { date: new Date(now).toUTCString(), expires: new Date(now - 10_000).toUTCString() },
  'old-date': { date: new Date(now - 7_200_000).toUTCString(), expires: new Date(now - 3_600_000).toUTCString() },
  young: { 'cache-control': 'max-age=3600', age: '10' },
  aged: { 'cache-control': 'max-age=3600', age: '3600' },
});
const answerFresh = (request, response, headers) => {
  for (const [name, value] of Object.entries(headers)) response.setHeader(name, value);
  response.setHeader('etag', etag);
  if (request.headers['if-none-match'] === etag) {
    response.statusCode = 304;
    return response.end();
  }
  response.end(Buffer.alloc(100, 6));
};
// A second origin: the same lifetime twice, with and without `Age` and `Date` exposed to the page (they are not
// CORS-safelisted response headers, Fetch section 3.2.3).
const crossLog = [];
const cross = createHTTPServer((request, response) => {
  const path = new URL(request.url, 'http://127.0.0.1').pathname;
  response.setHeader('access-control-allow-origin', '*');
  if (request.method === 'OPTIONS') {
    response.setHeader('access-control-allow-headers', 'if-none-match, if-modified-since');
    response.statusCode = 204;
    return response.end();
  }
  crossLog.push(path);
  if (path.endsWith('/exposed')) response.setHeader('access-control-expose-headers', 'Age, Date');
  answerFresh(request, response, lifetimes(Date.now()).aged);
});
await new Promise((listening) => cross.listen(0, '127.0.0.1', listening));
const crossOrigin = `http://127.0.0.1:${cross.address().port}`;
const fileOf = (path) =>
  files[path] ??
  (/^\/cache-files\/tile\/\d+$/.test(path) ? Buffer.alloc(10, Number(path.split('/').pop()) & 255) : undefined);
let released = false;
// While set, the server drops the connection of every service-worker file request: a real network failure that the
// worker sees, on every browser (see the service worker step below for why the browser's offline mode is not used).
let unreachable = false;
const dropped = [];
const held = [];
const releaseBody = () => {
  released = true;
  for (const end of held.splice(0)) end();
};

const server = await createServer({
  root,
  configFile: false,
  logLevel: 'error',
  cacheDir: resolve(results, '.vite'),
  server: { port: 0, host: '127.0.0.1', hmr: false, watch: null, fs: { allow: [root] } },
  optimizeDeps: { noDiscovery: true, include: [] },
  plugins: [
    noFileWatcher(),
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
            // The first request is held after its first chunk until the check releases it. Any later request is
            // answered whole at once, so a copy that was not stored fails an assertion instead of waiting here.
            if (released) return response.end(glb);
            response.write(glb.subarray(0, 256));
            held.push(() => response.end(glb.subarray(256)));
            return;
          }
          const kind = /^\/cache-files\/fresh\/([a-z-]+)$/.exec(path)?.[1];
          if (kind) {
            log.push({ path });
            return answerFresh(request, response, lifetimes(Date.now())[kind]);
          }
          if (path === '/cache-files/lang' || path === '/cache-files/star') {
            log.push({ path });
            response.setHeader('vary', path.endsWith('star') ? '*' : 'Accept-Language');
            response.setHeader('cache-control', 'max-age=3600');
            // Every answer is its own byte, so a stored variant is told apart from any other.
            return response.end(Buffer.alloc(10, log.length & 255));
          }
          const version = new URL(request.url, 'http://127.0.0.1').searchParams.get('v');
          if (version) versions.push([path, version]);
          const body = fileOf(path);
          if (!body) return next();
          if (unreachable && request.url.startsWith('/packages/cache/test/sw-files/')) {
            dropped.push({ path, range: request.headers.range });
            return request.socket.destroy();
          }
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
  pageURL = `${origin}/packages/cache/test/browser.html?stream=${encodeURIComponent(`/packages/gltf/dist/${stream}`)}`;

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
  const limited = async (name, run) => {
    const started = Date.now();
    let timer;
    try {
      return await Promise.race([
        run(),
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
  const call = (name, ...args) =>
    limited(name, () => page.evaluate(([n, a]) => window.cacheChecks[n](...a), [name, args]));
  const report = { browser: `${browser.browserType().name()} ${browser.version()}`, sample, bytes: glb.length };

  // 1. Cold: the stream reads the chair in ranges, every one fetched once and stored.
  await open();
  const firstMiss = await call('beginMiss');
  assert.equal(firstMiss.bytes, 256, 'first chunk delivered while the server holds the remainder');
  assert.equal(firstMiss.files, 0, 'an incomplete response is never committed');
  releaseBody();
  const streamedMiss = await limited('finishMiss', () => page.evaluate(() => window.finishMiss()));
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

  // 7. Vary keys: a variant per Accept-Language, Authorization, credentials mode and partition, each read back with no
  // network; one never stored, and `Vary: *`, are never answered.
  const vary = await call('varyProof');
  assert.equal(new Set(vary.stored).size, 4, 'four requests, four answers');
  assert.deepEqual(vary.read, vary.stored);
  assert.equal(vary.again, vary.stored[0]);
  assert.deepEqual(
    [vary.unseen, vary.otherAuthorization, vary.otherUser, vary.starAway],
    ['TypeError', 'TypeError', 'TypeError', 'TypeError'],
  );
  assert.equal(typeof vary.star, 'number');
  report.vary = vary;

  // 8. Asset bundles: dependencies first, every file asked for by its hash, read offline, wrong bytes refused, and a
  // new release that downloads the one changed file.
  const bundle = await call('bundleProof', sha(glb));
  assert.deepEqual(bundle.progress, [
    [1, 2],
    [2, 2],
  ]);
  assert.deepEqual([bundle.stored.bytes, bundle.stored.files], [glb.length + 100, 2]);
  assert.equal(bundle.shared, 1);
  assert.equal(bundle.chair, sha(glb));
  assert.equal(bundle.wrong, 'failed');
  assert.deepEqual(bundle.update, { dropped: 1, changed: ['level'] });
  assert.deepEqual([bundle.after.bytes, bundle.after.files], [200, 2]);
  assert.deepEqual(
    versions.map(([path]) => path),
    ['/cache-files/a', '/cache-files/chair.glb', '/cache-files/b', '/cache-files/c'],
    'one download per file; the unchanged one is not asked for again',
  );
  assert.equal(versions[1][1], sha(glb).slice(0, versions[1][1].length));
  report.bundles = bundle;

  // 9. Freshness from Expires, Date and Age as the browser's own Headers carry them: a second session asks the server
  // only for what is stale.
  const kinds = ['expires', 'past', 'old-date', 'young', 'aged'],
    urls = kinds.map((kind) => `/cache-files/fresh/${kind}`),
    asked = async (name, freshness) => {
      await call('freshnessRound', name, urls, freshness);
      const from = log.length;
      assert.deepEqual(await call('freshnessRound', name, urls, freshness), Array(5).fill(6));
      return log.slice(from).map((item) => item.path.split('/').pop());
    };
  const http = await asked('fresh-http');
  assert.deepEqual(http, ['past', 'old-date', 'aged']);
  // `max-age` alone: Expires is ignored (so those three are revalidated) and Age with it.
  const maxAge = await asked('fresh-max-age', 'max-age');
  assert.deepEqual(maxAge, ['expires', 'past', 'old-date']);
  const crossed = ['exposed', 'hidden'].map((kind) => `${crossOrigin}/cache-files/fresh/${kind}`);
  await call('freshnessRound', 'fresh-cross', crossed);
  const before9 = crossLog.length;
  await call('freshnessRound', 'fresh-cross', crossed);
  assert.deepEqual(
    crossLog.slice(before9),
    ['/cache-files/fresh/exposed'],
    'cross-origin, Age counts only when the server exposes it',
  );
  report.freshness = { http, maxAge, crossOrigin: crossLog.slice(before9) };

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
  // The window proof ran with the page's own requestIdleCallback where the browser has one (WebKit has none, so the
  // Prefetcher's timer fallback ran there); a service worker never has one.
  assert.equal(report.prefetchWindow.idleAPI, await page.evaluate(() => typeof requestIdleCallback));
  assert.equal(report.prefetchWorker.idleAPI, 'undefined');
  // Routing disables the browser's HTTP cache, and Chromium then hands the service worker every page request with
  // `cache: 'reload'`, which RangeCache honours by going to the network (Fetch request cache modes). A page with no
  // routing sends `default`, so the route goes before the service worker proof.
  await context.unroute('**/cache-files/**');
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
  // The network fails under the worker: the server drops every connection. Playwright's Firefox offline mode
  // (context.setOffline) cancels a page request before the service worker sees it, so no fetch event reaches the
  // worker there and the page gets a NetworkError (KB-FF2); a dropped connection is the same failure on every browser.
  unreachable = true;
  before = log.length;
  const serviceOffline = await call('serviceWorkerRange', 'bytes=1000-2999');
  unreachable = false;
  assert.deepEqual(serviceOffline, serviceCold, 'a restarted service worker reopens its persisted ranges offline');
  assert.equal(log.length, before, 'no byte came from the server');
  // Browsers retry an idempotent request on a reset connection a varying number of times, so only "at least one".
  assert.ok(dropped.length >= 1, 'the worker tried the network (its revalidation) and it failed');
  report.serviceWorker = { cold: serviceCold, offline: serviceOffline, dropped: dropped.length, restarted: true };

  assert.deepEqual(errors, []);
  mkdirSync(results, { recursive: true });
  writeFileSync(resolve(results, 'cache-browser.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
} finally {
  cross.closeAllConnections();
  cross.close();
  await closeAll({ browser, servers: [server] });
}
