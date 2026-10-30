// Steady-state frame allocation check (`npm run test:frame-alloc:browser`, part of check:merge through
// check:gpu-packages). Builds tests/fixtures/frame-alloc/index.html with Vite for production, opens each scene in a real
// browser on the GPU and measures the JavaScript heap bytes every frame allocates once the loop is warm.
//
// Method: Chromium with --enable-precise-memory-info, so performance.memory.usedJSHeapSize is V8's exact used heap size
// in bytes, read fresh on every call. The page samples it once per frame from an engine.onFrame callback into a
// preallocated Float64Array, after 600 warm-up frames (JIT tiers settled, pipelines and caches built), for 600 frames.
// Bytes of frame k = heap[k + 1] - heap[k] - one read's own cost (the MemoryInfo object performance.memory returns,
// measured by back-to-back reads). A frame in which V8 collected garbage shows a negative difference; those frames are
// counted and left out. The check fails when a scene's median frame (its steady-state frame) allocates more than its
// floor in FLOORS below; the mean, which also carries the odd frame with a timer or an idle task in it, is reported.
//
// Options: --scenes=basic,instanced,shadowed,post,dynamic (default all), --frames=<n>, --warmup=<n>,
// --profile (adds a V8 sampling heap profile of the recorded frames, through CDP HeapProfiler.startSampling, and prints
// the functions that allocate per frame; diagnosis only, not part of the check), --no-check (print, never fail).
// Results go to test-results/frame-alloc.json. Takes one shared slot of the GPU lock, around the browser only.
import assert from 'node:assert/strict';
import { createReadStream, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'vite';
import { acquire } from './gpu-lock.mjs';
import { closeAll } from './support/shutdown.mjs';
import { browserLabel, launchBrowser } from './lib/browser.mjs';

const root = resolve(import.meta.dirname, '..'),
  fixture = resolve(root, 'tests/fixtures/frame-alloc'),
  page = 'tests/fixtures/frame-alloc/index.html',
  out = resolve(root, 'test-results/frame-alloc');

/**
 * The most a steady-state (median) frame may allocate, in JavaScript heap bytes, per scene: the largest median of three
 * runs at the commit that set it (Edge 156, RTX A6000), with nothing added. What is left, and why, is in
 * docs/limits.md ("Frame allocation"). Lower a floor when a fix lowers the measurement; never raise one.
 */
export const FLOORS = {
  basic: { median: 340 },
  instanced: { median: 292 },
  shadowed: { median: 860 },
  post: { median: 1528 },
  dynamic: { median: 396 },
};

/** Per-frame bytes from per-frame heap samples: { median, mean, max, min, gcFrames, frames }. `read` is subtracted. */
export function frameBytes(heap, read) {
  const bytes = [];
  let gcFrames = 0;
  for (let k = 0; k + 1 < heap.length; k++) {
    const delta = heap[k + 1] - heap[k] - read;
    if (heap[k + 1] < heap[k]) gcFrames++;
    else bytes.push(delta);
  }
  if (!bytes.length) throw new RangeError('Every recorded frame collected garbage; record more frames');
  const sorted = [...bytes].sort((a, b) => a - b),
    middle = sorted.length >> 1;
  return {
    median: sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2,
    mean: Math.round((bytes.reduce((a, b) => a + b, 0) / bytes.length) * 10) / 10,
    min: sorted[0],
    max: sorted.at(-1),
    gcFrames,
    frames: heap.length - 1,
  };
}

/** Failures of `results` ({ scene: frameBytes() }) against `floors`, as messages. */
export function overFloor(results, floors = FLOORS) {
  const failures = [];
  for (const [scene, r] of Object.entries(results)) {
    const floor = floors[scene];
    if (!floor) {
      failures.push(`${scene}: no floor in FLOORS`);
      continue;
    }
    if (r.median > floor.median)
      failures.push(`${scene}: a steady-state frame allocates ${r.median} B, over its floor of ${floor.median} B`);
  }
  return failures;
}

/** Self bytes per function from a sampling heap profile, largest first: [{ name, url, line, bytes }]. */
function profileSites(profile) {
  const sites = new Map();
  const walk = (node) => {
    const { functionName, url, lineNumber, columnNumber } = node.callFrame,
      key = `${functionName}|${url}|${lineNumber}|${columnNumber}`;
    if (node.selfSize) {
      const site = sites.get(key) ?? {
        name: functionName || '(anonymous)',
        url: url.split('/').pop(),
        line: lineNumber + 1,
        column: columnNumber + 1,
        bytes: 0,
      };
      site.bytes += node.selfSize;
      sites.set(key, site);
    }
    for (const child of node.children ?? []) walk(child);
  };
  walk(profile.head);
  return [...sites.values()].sort((a, b) => b.bytes - a.bytes);
}

/** Vite resolver: `margoengine[/x[/y]]` and `@margoengine/x[/y]` to packages/x/src/y.ts (or index.ts). */
function sourcePackages() {
  return {
    name: 'frame-alloc-sources',
    enforce: 'pre',
    resolveId(id) {
      const m = /^(?:@margoengine\/|margoengine\/?)([a-z0-9-]*)(?:\/([a-z0-9-]+))?$/.exec(id);
      if (!m) return null;
      const dir = join(root, 'packages', m[1] || 'stage', 'src'),
        file = join(dir, `${m[2] ?? 'index'}.ts`);
      return existsSync(file) ? file : null;
    },
  };
}

/** A static file server for the built fixture on a free port (the OS picks it, so no suite shares it). */
function serve(dir) {
  const types = {
    '.html': 'text/html',
    '.js': 'text/javascript',
    '.wasm': 'application/wasm',
    '.json': 'application/json',
  };
  const server = createServer((request, response) => {
    const path = decodeURIComponent(new URL(request.url, 'http://x').pathname),
      file = resolve(dir, `.${path === '/' ? '/index.html' : path}`);
    if (!file.startsWith(dir + sep) || !existsSync(file) || !statSync(file).isFile()) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream' });
    createReadStream(file).pipe(response);
  });
  return new Promise((done) => server.listen(0, '127.0.0.1', () => done(server)));
}

async function main() {
  const args = process.argv.slice(2),
    option = (name, fallback) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback,
    scenes = option('scenes', Object.keys(FLOORS).join(',')).split(','),
    frames = Number(option('frames', 600)),
    warmup = Number(option('warmup', 600)),
    profile = args.includes('--profile'),
    check = !args.includes('--no-check');
  for (const scene of scenes) if (!(scene in FLOORS)) throw new TypeError(`Unknown scene ${scene}`);
  await build({
    configFile: false,
    root: fixture,
    base: './',
    publicDir: false,
    logLevel: 'warn',
    // A profile names functions, so its build is not minified and, with --source, bundles the packages' TypeScript
    // sources instead of their minified dist (diagnosis only: the check always measures the dist an app installs).
    build: { outDir: out, emptyOutDir: true, target: 'es2022', minify: !profile },
    plugins: args.includes('--source') ? [sourcePackages()] : [],
  });
  assert.ok(existsSync(join(out, 'index.html')), `built ${page}`);

  const release = await acquire({ owner: 'frame-alloc', poll: 2000 }),
    server = await serve(out),
    results = {},
    sites = {};
  let browser, adapter, version;
  try {
    // --js-flags=<V8 flags> passes through (diagnosis: --no-turbo-inlining names the allocating function itself).
    const jsFlags = args.find((a) => a.startsWith('--js-flags='));
    browser = await launchBrowser({
      headless: true,
      args: ['--enable-precise-memory-info', ...(jsFlags ? [jsFlags] : [])],
    });
    version = browser.version();
    for (const scene of scenes) {
      const context = await browser.newContext({ viewport: { width: 800, height: 600 } }),
        tab = await context.newPage(),
        errors = [];
      tab.on('pageerror', (error) => errors.push(error.message));
      tab.on('console', (message) => message.type() === 'error' && errors.push(message.text()));
      const url = `http://127.0.0.1:${server.address().port}/?scene=${scene}&frames=${frames}&warmup=${warmup}${profile ? '&profile' : ''}`;
      let cdp, sampling;
      if (profile) {
        // The page logs frame-alloc:record on its last warm-up frame; sampling every allocation (interval 1 byte) from
        // there names each allocating function with its bytes. Slow, so diagnosis only.
        cdp = await context.newCDPSession(tab);
        await cdp.send('HeapProfiler.enable');
        tab.on('console', (message) => {
          if (message.text() === 'frame-alloc:record')
            sampling = cdp.send('HeapProfiler.startSampling', {
              samplingInterval: 1,
              includeObjectsCollectedByMajorGC: true,
              includeObjectsCollectedByMinorGC: true,
            });
        });
      }
      await tab.goto(url);
      const result = await tab.evaluate(() => window.frameAlloc);
      if (profile) {
        await sampling;
        const { profile: data } = await cdp.send('HeapProfiler.stopSampling');
        sites[scene] = profileSites(data)
          .slice(0, 40)
          .map((site) => ({ ...site, perFrame: Math.round(site.bytes / frames) }));
      }
      adapter ??= await tab.evaluate(async () => {
        const info = (await navigator.gpu?.requestAdapter())?.info;
        return info ? `${info.vendor} ${info.architecture} ${info.description}`.trim() : null;
      });
      await context.close();
      assert.equal(result.error, undefined, `${scene}: ${result.error}`);
      assert.deepEqual(errors, [], `${scene}: page errors`);
      assert.equal(result.read[0], result.read[1], `${scene}: one heap read costs the same each time`);
      results[scene] = {
        ...frameBytes(result.heap, result.read[0]),
        read: result.read[0],
        drawCalls: result.drawCalls,
      };
      console.log(`${scene}: ${JSON.stringify(results[scene])}`);
      if (profile)
        for (const s of sites[scene].slice(0, 15))
          console.log(`  ${String(s.perFrame).padStart(7)} B/frame  ${s.name} ${s.url}:${s.line}:${s.column}`);
    }
  } finally {
    try {
      // Browser first, then the server's connections and the server, in one time budget (bug 70).
      await closeAll({ browser, servers: [server] });
    } finally {
      release();
    }
  }
  mkdirSync(resolve(root, 'test-results'), { recursive: true });
  writeFileSync(
    resolve(root, 'test-results/frame-alloc.json'),
    `${JSON.stringify({ browser: `${browserLabel()} ${version} headless`, adapter, frames, warmup, results, ...(profile && { sites }) }, null, 2)}\n`,
  );
  const failures = overFloor(results);
  if (failures.length && check) {
    for (const failure of failures) console.error(`FAIL ${failure}`);
    process.exit(1);
  }
  console.log(`frame-alloc: ${Object.keys(results).length} scenes within their floors`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
