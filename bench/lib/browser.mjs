// Browser side of the CLI: builds the scene page (bench/scenes) with Vite as a production bundle, builds any other
// engine from engine-bench in its own folder, serves both over plain HTTP (no compression, no cache, cross-origin
// isolated for fine timers), and runs one scene per page in headless Edge/Chrome with vsync and the frame cap off.
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, resolve, sep } from 'node:path';
import { chromium } from '@playwright/test';
import { build } from 'vite';
import { SCENES, STANDARD, caseId, sceneParams } from '../scenes/catalog.js';
import { root } from './env.mjs';

export const distDir = resolve(root, 'test-results/bench/dist');
const types = {
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.html': 'text/html',
  '.css': 'text/css',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.hdr': 'application/octet-stream',
  '.webm': 'video/webm',
};

/**
 * Other engines' benchmark implementations, from <engine-bench>/margo-bench/engines.json (written by whoever adds the
 * engine there; docs/benchmarking.md "Comparing engines"). Returns {} when the folder or manifest is missing.
 */
export function externalEngines(engineBench) {
  const manifest = join(engineBench, 'margo-bench', 'engines.json');
  if (!existsSync(manifest)) return {};
  const { engines = {} } = JSON.parse(readFileSync(manifest, 'utf8'));
  for (const [name, e] of Object.entries(engines)) {
    if (!/^[a-z0-9][a-z0-9.-]*$/.test(name)) throw new Error(`engines.json: invalid engine name ${name}`);
    const pkg = e.package && join(engineBench, 'node_modules', e.package, 'package.json');
    e.version = pkg && existsSync(pkg) ? JSON.parse(readFileSync(pkg, 'utf8')).version : null;
    e.root = engineBench;
    e.dir = join(engineBench, 'margo-bench');
  }
  return engines;
}

/** Builds the scene page (Margo bundled) and each requested external engine. */
export async function buildPages({ engines, external, log }) {
  log('bench: building the scene page');
  await build({
    configFile: false,
    publicDir: false,
    logLevel: 'error',
    root: resolve(root, 'bench/scenes'),
    base: '/bench/',
    build: {
      outDir: distDir,
      emptyOutDir: true,
      minify: true,
      target: 'es2022',
      reportCompressedSize: false,
      rollupOptions: { input: resolve(root, 'bench/scenes/page.html') },
    },
  });
  for (const name of engines.filter((e) => e !== 'margo')) {
    const e = external[name];
    if (!e) throw new Error(`engine ${name} is not in engine-bench/margo-bench/engines.json`);
    log(`bench: building ${name} in ${e.dir}`);
    await build({
      configFile: false,
      publicDir: false,
      logLevel: 'warn',
      root: e.dir,
      resolve: { alias: e.alias ?? {} },
      build: {
        outDir: join(e.dir, 'dist', name),
        emptyOutDir: true,
        minify: true,
        target: 'es2022',
        reportCompressedSize: false,
        lib: { entry: join(e.dir, e.entry), formats: ['es'], fileName: () => 'engine.js' },
      },
    });
  }
}

/** Serves /bench/ (the built page), /ext/<engine>/ (engine-bench builds) and the repository (assets). */
export async function serve({ port, external }) {
  const roots = [
    ['/bench/', distDir],
    ...Object.entries(external).map(([name, e]) => [`/ext/${name}/`, join(e.dir, 'dist', name)]),
    // engine-bench itself, for files an engine loads by path at run time (decoder and transcoder binaries).
    ...(Object.values(external)[0] ? [['/engine-bench/', Object.values(external)[0].root]] : []),
    ['/', root],
  ];
  const server = createServer((req, res) => {
    const path = decodeURIComponent(new URL(req.url, 'http://x').pathname),
      [prefix, dir] = roots.find(([p]) => path.startsWith(p)),
      file = resolve(dir, `.${path.slice(prefix.length - 1)}`);
    if (file !== dir && !file.startsWith(dir + sep)) return res.writeHead(403).end();
    try {
      const body = readFileSync(file);
      res
        .writeHead(200, {
          'content-type': types[extname(file)] ?? 'application/octet-stream',
          'cache-control': 'no-store',
          'cross-origin-opener-policy': 'same-origin',
          'cross-origin-embedder-policy': 'require-corp',
        })
        .end(body);
    } catch {
      res.writeHead(404).end();
    }
  });
  await new Promise((r, j) => server.once('error', j).listen(port, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => server.close() };
}

const args = [
  '--disable-gpu-vsync',
  '--disable-frame-rate-limit',
  '--enable-precise-memory-info',
  '--js-flags=--expose-gc',
  '--enable-webgpu-developer-features',
];

/** One browser per case (a fresh one per run for scenes marked fresh: 'browser', such as startup). */
export function browserSession({ channel, base, shots, log }) {
  let browser = null,
    hardware = null;
  const launch = () =>
    chromium.launch({ channel: channel === 'bundled' ? undefined : channel, headless: true, args }).catch((error) => {
      if (channel !== 'msedge') throw error;
      log('bench: msedge not found, using the bundled Chromium');
      return chromium.launch({ headless: true, args });
    });
  return {
    get hardware() {
      return hardware;
    },
    /** Runs one scene once; returns the page's result (window.result). */
    async run({ engine, scene, params, harness, fresh, screenshot }) {
      if (fresh || !browser) {
        await browser?.close();
        browser = await launch();
      }
      const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 }),
        page = await context.newPage(),
        errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
      try {
        const query = new URLSearchParams({ engine, scene, ...params, ...harness });
        await page.goto(`${base}/bench/page.html?${query}`);
        hardware ??= {
          browser: { name: browser.browserType().name(), channel, version: browser.version() },
          ...(await page.evaluate(async () => {
            const a = await navigator.gpu?.requestAdapter({ powerPreference: 'high-performance' }),
              c = document.createElement('canvas').getContext('webgl2'),
              ext = c?.getExtension('WEBGL_debug_renderer_info');
            return {
              webgpu: a
                ? {
                    vendor: a.info.vendor,
                    architecture: a.info.architecture,
                    device: a.info.device,
                    description: a.info.description,
                    fallback: a.info.isFallbackAdapter ?? null,
                  }
                : null,
              webgl: ext ? c.getParameter(ext.UNMASKED_RENDERER_WEBGL) : null,
              userAgent: navigator.userAgent,
            };
          })),
        };
        await page.waitForFunction(() => window.result, null, { timeout: 600_000 });
        const result = await page.evaluate(() => window.result);
        result.pageErrors = errors;
        if (screenshot && !result.error && !result.unsupported) {
          mkdirSync(shots, { recursive: true });
          await page.screenshot({ path: join(shots, `${screenshot}.png`) });
        }
        return result;
      } finally {
        await context.close();
        if (fresh) {
          await browser.close();
          browser = null;
        }
      }
    },
    close: () => browser?.close(),
  };
}

// Metrics read from a page result. primary: decides validity (a noisy primary metric invalidates the run).
const METRICS = {
  cpuMs: { unit: 'ms', better: 'lower', read: (r) => r.throughput?.cpuMs?.median },
  gpuMs: { unit: 'ms', better: 'lower', read: (r) => r.gpu?.gpuMs?.median },
  fps: { unit: 'fps', better: 'higher', read: (r) => r.throughput?.fps },
  serialFrameMs: { unit: 'ms', better: 'lower', read: (r) => r.serialFrameMs?.median },
  loadMs: { unit: 'ms', better: 'lower', read: (r) => r.loadMs },
  firstFrameMs: { unit: 'ms', better: 'lower', read: (r) => r.firstFrameMs },
  createMs: { unit: 'ms', better: 'lower', read: (r) => r.createMs },
  buildMs: { unit: 'ms', better: 'lower', read: (r) => r.buildMs },
  jsHeapMB: { unit: 'MB', better: 'lower', read: (r) => r.jsHeapMB },
  gpuMB: { unit: 'MB', better: 'lower', read: (r) => r.gpuMemory?.liveMB },
  gpuPeakMB: { unit: 'MB', better: 'lower', read: (r) => r.gpuMemory?.peakMB },
  // Task scenes (harness.js runTask): one job per call, then its first (cold) call alone.
  taskMs: { unit: 'ms', better: 'lower', read: (r) => r.task?.ms?.median },
  coldMs: { unit: 'ms', better: 'lower', read: (r) => r.task?.coldMs },
  taskGpuMs: { unit: 'ms', better: 'lower', read: (r) => r.task?.gpuMs?.median },
  jsBytes: { unit: 'B', better: 'lower', exact: true, read: (r) => r.jsBytes },
  drawCalls: { unit: '', better: 'lower', exact: true, read: (r) => r.info?.drawCalls },
};

/**
 * The cases of a browser suite: STANDARD[suite] (or `list`) for every engine. `primary` names the metrics that decide
 * validity for this suite; `keep` limits the metrics recorded (default: all of METRICS).
 */
export function sceneCases(suite, { primary, list = STANDARD[suite], keep } = {}) {
  return (ctx) =>
    ctx.engines.flatMap((engine) =>
      list.map(({ scene, params, primary: own, keep: kept }) => {
        const p = sceneParams(scene, params),
          id = `${caseId(scene, params)}${engine === 'margo' ? '' : `@${engine}`}`,
          names = kept ?? keep ?? Object.keys(METRICS),
          main = own ?? primary;
        return {
          id,
          title: `${SCENES[scene].title} ${Object.entries(params ?? {})
            .map(([k, v]) => `${k}=${v}`)
            .join(' ')}`.trim(),
          engine,
          scene,
          params: p,
          // The same scene in every engine forms one group, which the CLI runs interleaved.
          group: ctx.engines.length > 1 ? `${suite}:${caseId(scene, params)}` : undefined,
          metrics: Object.fromEntries(
            names.map((m) => [m, { ...METRICS[m], primary: main.includes(m), read: undefined }]),
          ),
          async run(runCtx) {
            const r = await ctx.browser().run({
              engine,
              scene,
              params: p,
              harness: ctx.harness,
              fresh: SCENES[scene].fresh === 'browser',
              screenshot: runCtx.first ? `${suite}-${id}` : null,
            });
            if (r.unsupported) return { unsupported: `not implemented by ${engine}` };
            const errors = [...(r.errors ?? []), ...(r.pageErrors ?? [])];
            if (r.error) throw new Error(r.error.split('\n').slice(0, 3).join(' | '));
            return {
              values: Object.fromEntries(names.map((m) => [m, METRICS[m].read(r)])),
              info: {
                drawCalls: r.info?.drawCalls,
                note: r.info?.note,
                canvas: r.canvas,
                samples: r.samples,
                gpuMethod: r.gpu?.method ?? 'none (no timestamp-query)',
                passes: r.gpu?.passes,
                ...(r.task ? { output: r.task.output } : {}),
                scripts: r.resources?.filter((x) => x.name.endsWith('.js')).map((x) => x.name),
                ...(errors.length ? { errors: errors.slice(0, 5) } : {}),
              },
            };
          },
        };
      }),
    );
}
