// The bundler matrix: installs the packed packages (test-results/modern-packages, from `npm run modern:test:packages`)
// into a clean project and builds the same tiny app with Vite, webpack, esbuild and Rollup, a Next.js page with
// webpack and Turbopack, and loads it in a browser from a plain import map (margoengine's dist/importmap.json, the CDN
// base pointed at a local server). Each build must contain the stage, core, shadows and orbit controls the app imports
// and none of the packages it does not import.
//   npm run modern:test:bundlers      (after modern:test:packages; installs the bundlers from npm)
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createReadStream, existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { extname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve(import.meta.dirname, '..'),
  archives = join(root, 'test-results/modern-packages'),
  npm = process.env.npm_execpath;
assert.ok(npm, 'Run this through npm run modern:test:bundlers');
const tarballs = (await readdir(archives)).filter((file) => file.endsWith('.tgz'));
assert.ok(
  tarballs.some((file) => file.startsWith('margoengine-')),
  'No packed margoengine in test-results/modern-packages; run npm run modern:test:packages first',
);
// npm pack names: margoengine-1.0.0.tgz, margoengine-shadows-1.0.0.tgz for @margoengine/shadows.
const packed = {};
for (const dir of (await readdir(join(root, 'packages'))).filter((d) =>
  existsSync(join(root, 'packages', d, 'package.json')),
)) {
  const { name, version } = JSON.parse(await readFile(join(root, 'packages', dir, 'package.json'), 'utf8'));
  const file = `${name.replace(/^@/, '').replace('/', '-')}-${version}.tgz`;
  assert.ok(tarballs.includes(file), `${file} missing; run npm run modern:test:packages`);
  packed[name] = `file:${join(archives, file).replaceAll('\\', '/')}`;
}
const version = (name) =>
  JSON.parse(execFileSync(process.execPath, [npm, 'view', name, 'version', '--json'], { encoding: 'utf8' }));

const fixture = await mkdtemp(join(tmpdir(), 'margoengine-bundlers-'));
const results = [];
const check = (bundler, modules) => {
  const packages = new Set(
    modules
      .map((id) => /node_modules[\\/](margoengine|@margoengine[\\/][^\\/]+)/.exec(id)?.[1]?.replace('\\', '/'))
      .filter(Boolean),
  );
  // margoengine's own files are one-line re-exports: they render no code of their own.
  for (const name of ['@margoengine/stage', '@margoengine/core', '@margoengine/shadows', '@margoengine/controls'])
    assert.ok(packages.has(name), `${bundler}: ${name} missing from the bundle`);
  for (const name of [
    '@margoengine/physics',
    '@margoengine/voxel',
    '@margoengine/brep',
    '@margoengine/fbx',
    '@margoengine/splats',
    '@margoengine/react',
  ])
    assert.ok(!packages.has(name), `${bundler}: ${name} is bundled but the app does not import it`);
  results.push(`${bundler}: ${packages.size} packages`);
};
try {
  // One install: margoengine, its packages from the tarballs (overrides make its ^1.0.0 ranges resolve to them),
  // and the bundlers at their current versions.
  const tools = [
    'vite',
    'webpack',
    'esbuild',
    'rollup',
    '@rollup/plugin-node-resolve',
    'next',
    'react',
    'react-dom',
    'playwright',
  ];
  await writeFile(
    join(fixture, 'package.json'),
    JSON.stringify({
      private: true,
      type: 'module',
      dependencies: {
        margoengine: packed.margoengine,
        ...Object.fromEntries(tools.map((name) => [name, version(name)])),
      },
      overrides: Object.fromEntries(Object.entries(packed).filter(([name]) => name !== 'margoengine')),
    }),
  );
  execFileSync(process.execPath, [npm, 'install', '--ignore-scripts', '--no-audit', '--no-fund'], {
    cwd: fixture,
    stdio: 'inherit',
  });
  await mkdir(join(fixture, 'src'));
  await writeFile(
    join(fixture, 'src/app.js'),
    `import { createStage } from 'margoengine';\nimport { Shadows } from 'margoengine/shadows';\nimport { OrbitControls } from 'margoengine/controls/orbit';\nexport const app = [createStage, Shadows, OrbitControls];\n`,
  );
  const entry = join(fixture, 'src/app.js');
  // A tool's ESM entry (its exports' import, or its main): the bundlers mix ESM and CommonJS packages.
  const load = async (name) => {
    const dir = join(fixture, 'node_modules', name),
      manifest = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'));
    const pick = (target) =>
      typeof target === 'string'
        ? target
        : target && pick(target.import ?? target.node ?? target.default ?? target['.']);
    return import(
      pathToFileURL(join(dir, pick(manifest.exports) ?? manifest.module ?? manifest.main ?? 'index.js')).href
    );
  };

  // Vite (Rolldown).
  {
    const { build } = await load('vite');
    const out = await build({
      root: fixture,
      configFile: false,
      logLevel: 'silent',
      build: { write: false, lib: { entry, formats: ['es'] } },
    });
    check(
      'vite',
      out[0].output
        .filter((c) => c.type === 'chunk')
        .flatMap((c) =>
          Object.entries(c.modules)
            .filter(([, m]) => m.renderedLength)
            .map(([id]) => id),
        ),
    );
  }
  // esbuild.
  {
    const esbuild = await load('esbuild');
    const out = await esbuild.build({
      entryPoints: [entry],
      bundle: true,
      format: 'esm',
      splitting: true,
      outdir: join(fixture, 'out/esbuild'),
      metafile: true,
      logLevel: 'silent',
      minify: true,
    });
    check(
      'esbuild',
      Object.values(out.metafile.outputs).flatMap((o) =>
        Object.entries(o.inputs)
          .filter(([, i]) => i.bytesInOutput)
          .map(([id]) => id),
      ),
    );
  }
  // Rollup.
  {
    const { rollup } = await load('rollup');
    const { nodeResolve } = await load('@rollup/plugin-node-resolve');
    const bundle = await rollup({ input: entry, plugins: [nodeResolve({ browser: true })], logLevel: 'silent' });
    const { output } = await bundle.generate({ format: 'es' });
    check(
      'rollup',
      output
        .filter((c) => c.type === 'chunk')
        .flatMap((c) =>
          Object.entries(c.modules)
            .filter(([, m]) => m.renderedLength)
            .map(([id]) => id),
        ),
    );
  }
  // webpack.
  {
    const webpack = (await load('webpack')).default;
    const stats = await new Promise((done, fail) =>
      webpack(
        {
          mode: 'production',
          context: fixture,
          entry,
          output: { path: join(fixture, 'out/webpack'), module: true },
          experiments: { outputModule: true },
        },
        (error, result) => (error ? fail(error) : done(result)),
      ),
    );
    assert.ok(!stats.hasErrors(), `webpack: ${stats.toString('errors-only')}`);
    const json = stats.toJson({ modules: true, nestedModules: true });
    const ids = [];
    const walk = (list) =>
      list?.forEach((m) => {
        if (m.name) ids.push(m.name);
        walk(m.modules);
      });
    walk(json.modules);
    check('webpack', ids);
  }
  // Next.js: a client page with margoengine/react, built with webpack and with Turbopack.
  {
    const app = join(fixture, 'next');
    await mkdir(join(app, 'app'), { recursive: true });
    await writeFile(join(app, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
    await writeFile(
      join(app, 'next.config.mjs'),
      "export default { transpilePackages: ['margoengine', '@margoengine/core', '@margoengine/stage', '@margoengine/react'] };\n",
    );
    await writeFile(
      join(app, 'app/layout.jsx'),
      'export default function Layout({ children }) { return <html lang="en"><body>{children}</body></html>; }\n',
    );
    await writeFile(
      join(app, 'app/page.jsx'),
      '\'use client\';\nimport { Canvas, Mesh, BoxGeometry, PbrMaterial } from \'margoengine/react\';\nexport default function Page() { return <Canvas label="cube"><Mesh><BoxGeometry /><PbrMaterial color="#84d6bd" /></Mesh></Canvas>; }\n',
    );
    for (const flag of ['--webpack', '--turbopack']) {
      await rm(join(app, '.next'), { recursive: true, force: true });
      execFileSync(process.execPath, [join(fixture, 'node_modules/next/dist/bin/next'), 'build', flag], {
        cwd: app,
        stdio: 'pipe',
        env: { ...process.env, NEXT_TELEMETRY_DISABLED: '1' },
      });
      assert.ok(existsSync(join(app, '.next/BUILD_ID')), `next build ${flag}`);
      results.push(`next ${flag}: built`);
    }
  }
  // A plain browser import map: margoengine's dist/importmap.json with its CDN base pointed at this server.
  {
    const map = JSON.parse(await readFile(join(fixture, 'node_modules/margoengine/dist/importmap.json'), 'utf8'));
    const local = {
      imports: Object.fromEntries(
        Object.entries(map.imports).map(([key, url]) => [
          key,
          url.replace(/^https:\/\/cdn\.jsdelivr\.net\/npm\/((?:@[^/]+\/)?[^@/]+)@[^/]+/, '/node_modules/$1'),
        ]),
      ),
    };
    const page = `<!doctype html><script type="importmap">${JSON.stringify(local)}</script><script type="module">
import { createStage } from 'margoengine';
import { Shadows } from 'margoengine/shadows';
import { OrbitControls } from '@margoengine/controls/orbit';
window.result = [typeof createStage, typeof Shadows, typeof OrbitControls].join();
</script>`;
    const types = {
      '.js': 'text/javascript',
      '.html': 'text/html',
      '.wasm': 'application/wasm',
      '.json': 'application/json',
    };
    const server = createServer(async (request, response) => {
      const path = decodeURIComponent(new URL(request.url, 'http://x').pathname);
      if (path === '/') return response.writeHead(200, { 'content-type': 'text/html' }).end(page);
      const file = join(fixture, path);
      if (!file.startsWith(fixture) || !(await stat(file).catch(() => null))?.isFile())
        return response.writeHead(404).end();
      response.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream' });
      createReadStream(file).pipe(response);
    });
    await new Promise((done) => server.listen(0, '127.0.0.1', done));
    const { chromium } = await load('playwright');
    const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL ?? 'msedge' });
    try {
      const tab = await browser.newPage();
      const errors = [];
      tab.on('pageerror', (error) => errors.push(error.message));
      await tab.goto(`http://127.0.0.1:${server.address().port}/`);
      await tab.waitForFunction(() => window.result || null, null, { timeout: 30_000 }).catch(() => {});
      assert.equal(
        await tab.evaluate(() => window.result),
        'function,function,function',
        `import map: ${errors.join('; ')}`,
      );
      results.push('import map: loaded');
    } finally {
      await browser.close();
      server.close();
    }
  }
  console.log(`bundler matrix: ${results.join('; ')}`);
} finally {
  // Windows keeps loaded native modules (rolldown, esbuild) locked until this process exits.
  await rm(fixture, { recursive: true, force: true, maxRetries: 3 }).catch(() =>
    console.warn(`bundler matrix: left ${fixture}`),
  );
}
