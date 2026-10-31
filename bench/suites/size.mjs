// Bytes, measured exactly (one run): core + stage (the startup path, with the 25,000 B gzip budget enforced), every
// package entry and worker (examples/package-benchmarks/entry-sizes.mjs), every lazily loaded file, the eager and lazy
// JS of each site demo, and, for each engine from engine-bench that names a `sizeEntry`, its smallest lit-box app built
// the same way. A byte metric regresses on any machine when it grows more than 1%.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { join, resolve } from 'node:path';
import { build } from 'vite';
import { measureEntries } from '../../examples/package-benchmarks/entry-sizes.mjs';
import { compactOutput } from '../../scripts/measure-size.js';
import { root } from '../lib/env.mjs';

const bytes = (primary = false) => ({ unit: 'B', better: 'lower', exact: true, threshold: 0.01, primary });

// Eager JavaScript per demo: the entry chunk plus everything it imports statically, gzip per chunk as served. Lazy
// chunks (dynamic import) are the rest.
const DEMOS = {
  'night-citadel': { root: 'apps/showcase-night-citadel' },
  afterlight: { root: 'examples/gameplay-sandbox' },
  meadow: {
    configFile: false,
    root: 'examples',
    publicDir: false,
    build: { rollupOptions: { input: resolve(root, 'examples/windy-meadow.html') } },
  },
  earth: { configFile: false, root: 'packages/creative/examples/earth' },
  // Budget per gallery page, 120 kB gzip before the first frame: scripts/test-gallery-browser.mjs enforces it.
  'gallery-khronos': {
    configFile: false,
    root: 'examples/gallery',
    publicDir: false,
    build: { rollupOptions: { input: resolve(root, 'examples/gallery/khronos.html') } },
  },
  // What `await addSky(stage)` (margoengine/stage/sky) fetches on top of core + stage.
  'stage-sky': {
    configFile: false,
    publicDir: false,
    build: {
      lib: { entry: resolve(root, 'scripts/support/stage-sky-entry.js'), formats: ['es'] },
      rollupOptions: { external: [/^@margoengine\/core/] },
    },
  },
};

async function demoBytes(config) {
  const result = await build({
    logLevel: 'silent',
    ...config,
    root: config.root && resolve(root, config.root),
    build: { write: false, target: 'es2022', minify: true, ...config.build },
  });
  const chunks = (Array.isArray(result) ? result[0] : result).output.filter((item) => item.type === 'chunk');
  const byName = new Map(chunks.map((chunk) => [chunk.fileName, chunk])),
    eager = new Set();
  // Externals (core, for the stage sky path) appear in imports but are not chunks.
  const visit = (name) => {
    if (eager.has(name) || !byName.has(name)) return;
    eager.add(name);
    for (const next of byName.get(name).imports) visit(next);
  };
  for (const chunk of chunks) if (chunk.isEntry) visit(chunk.fileName);
  const sum = (list) => list.reduce((s, chunk) => s + gzipSync(chunk.code).length, 0);
  return {
    eagerGzip: sum(chunks.filter((c) => eager.has(c.fileName))),
    lazyGzip: sum(chunks.filter((c) => !eager.has(c.fileName))),
  };
}

/** An engine-bench engine's smallest app, built with the same minifier and output options as Margo's size gate. */
async function externalApp(engine) {
  const out = await build({
    configFile: false,
    publicDir: false,
    logLevel: 'silent',
    root: engine.dir,
    resolve: { alias: engine.alias ?? {} },
    build: {
      write: false,
      minify: true,
      target: 'es2022',
      lib: { entry: join(engine.dir, engine.sizeEntry), formats: ['es'] },
      rollupOptions: { output: compactOutput },
    },
  });
  const text = out[0].output
    .filter((item) => item.type === 'chunk')
    .map((item) => item.code)
    .join('\n');
  return { gzip: gzipSync(text).length, raw: Buffer.byteLength(text) };
}

export default {
  name: 'size',
  title: 'Bytes: startup path, package entries, lazy files, demos',
  uses: 'none',
  deterministic: true,
  async cases(ctx) {
    let entries;
    const measured = () => (entries ??= measureEntries({ log: () => {} }));
    const cases = [
      {
        id: 'startup-core-stage',
        title: 'Core + stage, minified and gzipped (the startup path; budget 25,000 B)',
        metrics: { gzip: bytes(true), raw: bytes(), headroom: { unit: 'B', better: 'higher', exact: true } },
        async run() {
          const { coreStage } = await measured();
          return { values: { gzip: coreStage.gzip, raw: coreStage.raw, headroom: coreStage.limit - coreStage.gzip } };
        },
      },
    ];
    // One case per package: a gzip metric per entry and worker (the case's metrics are filled in by its run).
    for (const dir of readdirSync(resolve(root, 'packages')).sort()) {
      const file = resolve(root, 'packages', dir, 'package.json');
      if (!existsSync(file)) continue;
      const name = JSON.parse(readFileSync(file, 'utf8')).name;
      cases.push({
        id: name,
        title: `${name} entries, gzip`,
        metrics: {},
        async run() {
          const report = await measured(),
            list = report.packages[name] ?? {};
          // Metric definitions follow the entries the package actually has.
          this.metrics = Object.fromEntries(Object.keys(list).map((k) => [k, bytes(true)]));
          return { values: Object.fromEntries(Object.entries(list).map(([k, v]) => [k, v.gzip])) };
        },
      });
    }
    cases.push({
      id: 'lazy-files',
      title: 'Lazily loaded files (scripts/lazy-files.js), gzip',
      metrics: {},
      async run() {
        const { lazyFiles } = await measured();
        this.metrics = Object.fromEntries(Object.keys(lazyFiles).map((k) => [k, bytes(true)]));
        return { values: Object.fromEntries(Object.entries(lazyFiles).map(([k, v]) => [k, v.gzip])) };
      },
    });
    for (const [demo, config] of Object.entries(DEMOS))
      cases.push({
        id: `demo-${demo}`,
        title: `${demo}: eager and lazy JS, gzip`,
        metrics: { eagerGzip: bytes(true), lazyGzip: bytes() },
        async run() {
          return { values: await demoBytes(config) };
        },
      });
    for (const [name, engine] of Object.entries(ctx.external ?? {}))
      if (engine.sizeEntry && ctx.engines.includes(name))
        cases.push({
          id: `minimal-app@${name}`,
          title: `${name} ${engine.version ?? ''} smallest lit-box app (engine-bench), gzip`.replace('  ', ' '),
          engine: name,
          metrics: { gzip: bytes(true), raw: bytes() },
          async run() {
            return { values: await externalApp(engine) };
          },
        });
    return cases;
  },
};
