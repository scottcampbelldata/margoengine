// Real-browser check of @margoengine/cache (AC power, after npm run build:packages, under the GPU lock):
//   node scripts/gpu-lock.mjs run --owner=<agent id> -- node examples/package-benchmarks/cache/offline-gpu.mjs [--reps=3] [--quiet-timeout=900]
// For DamagedHelmet (3.6 MB) and a generated 6 x 160k-vertex GLB (about 48 MB; picked when the 62 MB conveyor GLB was not
// loadable by gltf-pro, fixed in HANDOFF 5l.p): loadGLTF with plain fetch (baseline), through an empty cache
// (cold: download + store) and through a filled cache in a new AssetCache (warm: one conditional request, 304, bytes from
// IndexedDB), on localhost and on a throttled "factory Wi-Fi" profile (CDP: 20 Mbit/s, 80 ms). Then DevTools offline
// (context.setOffline): the model loads from the cache with the same geometry digest and the same rendered frame, and a
// Web Worker reads the same file from the cache. Browser HTTP cache disabled throughout. Timings go after
// scripts/quiet-gate.mjs; a run that could not get a quiet machine is labelled "busy" (diagnostic only).
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync, writeFileSync, mkdirSync} from 'node:fs';
import {openBrowser} from '../../../scripts/browser.js';
import {onAC, waitForQuiet} from '../../../scripts/quiet-gate.mjs';
import {bigGLB} from '../../../tests/support/big-glb.js';

const option = (name, fallback) => Number(process.argv.find(a => a.startsWith(`--${name}=`))?.split('=')[1] ?? fallback);
const reps = option('reps', 3);
assert.ok(onAC(), 'run on AC power only');
let machine;
try {machine = await waitForQuiet({timeout: option('quiet-timeout', 900)});}
catch (error) {assert.ok(onAC(), 'run on AC power only'); machine = {busy: true, note: error.message};}
const label = machine.busy ? 'busy (diagnostic timings)' : 'quiet';
const assets = [
  {name: 'DamagedHelmet', url: '/examples/assets/damaged-helmet.glb', file: 'examples/assets/damaged-helmet.glb'},
  {name: 'generated large GLB', url: '/test-results/cache-big.glb', file: 'test-results/cache-big.glb'},
];
mkdirSync('test-results', {recursive: true}); writeFileSync('test-results/cache-big.glb', bigGLB({segments: 400, meshes: 6}));
const wifi = {offline: false, latency: 80, downloadThroughput: 20e6 / 8, uploadThroughput: 5e6 / 8};
const median = values => [...values].sort((a, b) => a - b)[values.length >> 1];
const context = await openBrowser({startPath: '/examples/package-benchmarks/cache/offline.html', port: 5231}), {page, hardware} = context, pageErrors = [];
page.on('pageerror', e => pageErrors.push(e.message)); page.on('console', m => {if (m.type() === 'error') pageErrors.push(m.text());});
const results = {label, machine, gpu: hardware.webgpu, browser: hardware.browserName + ' ' + hardware.browserVersion, wifi, reps, assets: []};
try {
  await page.waitForFunction(() => window.ready, null, {timeout: 60000});
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Network.enable'); await cdp.send('Network.setCacheDisabled', {cacheDisabled: true});
  const network = async throttle => {await page.context().setOffline(false); await cdp.send('Network.emulateNetworkConditions', throttle ?? {offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1});};
  await page.evaluate(() => window.check.startWorker());
  for (const asset of assets) {
    const sha256 = createHash('sha256').update(readFileSync(asset.file)).digest('hex'), record = {name: asset.name, bytes: readFileSync(asset.file).length, sha256, profiles: {}};
    for (const [profile, throttle] of [['localhost', null], ['wifi 20 Mbit/s 80 ms', wifi]]) {
      await network(throttle);
      const runs = {baseline: [], cold: [], storedAfter: [], warm: []};
      let cold, warm;
      for (let i = 0; i < reps; i++) {
        await page.evaluate(() => window.check.reset());
        const base = await page.evaluate(url => window.check.load(url, false), asset.url);
        cold = await page.evaluate(url => window.check.load(url, true), asset.url);
        warm = await page.evaluate(url => window.check.load(url, true), asset.url);
        for (const r of [base, cold, warm]) assert.deepEqual(r.errors, []);
        assert.equal(cold.stats.misses, 1); assert.equal(cold.stats.stored, 1);
        assert.equal(warm.stats.hits, 1, 'warm load served from the cache'); assert.equal(warm.stats.misses, 0);
        assert.equal(base.digest, cold.digest); assert.equal(warm.digest, cold.digest);
        runs.baseline.push(base.ms); runs.cold.push(cold.ms); runs.storedAfter.push(cold.untilStoredMs); runs.warm.push(warm.ms);
      }
      record.profiles[profile] = {medianMs: Object.fromEntries(Object.entries(runs).map(([k, v]) => [k, median(v)])), runsMs: runs, warmStats: warm.stats, usage: warm.usage, triangles: cold.triangles, primitives: cold.primitives};
    }
    // Online reference frame from the cache-filled state, then offline.
    await network(null);
    const online = await page.evaluate(url => window.check.load(url, false), asset.url), onlineFrame = await page.locator('canvas').screenshot();
    await page.context().setOffline(true);
    const offline = await page.evaluate(url => window.check.load(url, true), asset.url), offlineFrame = await page.locator('canvas').screenshot();
    mkdirSync('test-results', {recursive: true}); writeFileSync(`test-results/cache-offline-${record.name.split(' ')[0]}.png`, offlineFrame);
    const inWorker = await page.evaluate(url => window.check.worker(url), asset.url);
    assert.deepEqual(offline.errors, []);
    assert.equal(offline.onLine, false);
    assert.equal(offline.stats.offline, 1, 'offline load served from the cache');
    assert.equal(offline.digest, online.digest, 'identical geometry offline');
    assert.ok(onlineFrame.equals(offlineFrame), 'identical rendered frame offline');
    assert.equal(inWorker.error, undefined, inWorker.error);
    assert.equal(inWorker.sha256, sha256, 'worker read the identical file from the cache');
    assert.equal(inWorker.stats.hits, 1);
    record.offline = {ms: offline.ms, stats: offline.stats, digestMatches: true, frameMatches: true, worker: inWorker};
    await network(null);
    // Worker parsing composes with the cache: bytes from cache.fetch, parsed in gltf-pro's worker (online: its script loads).
    const parsed = await page.evaluate(url => window.check.parseInWorker(url), asset.url);
    assert.deepEqual(parsed.errors, []); assert.equal(parsed.digest, online.digest); assert.equal(parsed.stats.hits, 1);
    record.parseInWorker = parsed;
    results.assets.push(record);
    console.error(JSON.stringify({asset: record.name, profiles: Object.fromEntries(Object.entries(record.profiles).map(([k, v]) => [k, v.medianMs])), offlineMs: offline.ms}));
  }
  assert.deepEqual(pageErrors, []);
} finally {await context.close();}
assert.ok(onAC(), 'still on AC power');
results.acAfter = true;
mkdirSync('examples/package-benchmarks/cache', {recursive: true});
writeFileSync('examples/package-benchmarks/cache/results.json', JSON.stringify(results, null, 2) + '\n');
console.log(JSON.stringify(results.assets.map(a => ({name: a.name, profiles: Object.fromEntries(Object.entries(a.profiles).map(([k, v]) => [k, v.medianMs])), offlineMs: a.offline.ms, workerParseMs: a.parseInWorker.ms})), null, 2));
console.log(`offline asset cache check passed (${label})`);
