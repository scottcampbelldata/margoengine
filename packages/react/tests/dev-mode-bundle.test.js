// The guard of dev-mode.ts on what a bundler really produces, run with no global `process`, as on a browser page.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { build } from 'vite';

const dist = (name) => fileURLToPath(new URL(`../dist/${name}`, import.meta.url));
const bundle = async (entry, nodeEnv, format) => {
  const outDir = await mkdtemp(join(tmpdir(), 'margo-dev-mode-'));
  try {
    await build({
      configFile: false,
      logLevel: 'error',
      define: nodeEnv ? { 'process.env.NODE_ENV': JSON.stringify(nodeEnv) } : {},
      build: {
        outDir,
        minify: true,
        lib: { entry, formats: [format], fileName: 'out' },
        rollupOptions: { external: (id) => !/^[./]|^[A-Za-z]:/.test(id) },
      },
    });
    return await readFile(join(outDir, format === 'cjs' ? 'out.cjs' : 'out.js'), 'utf8');
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
};
const flags = async (nodeEnv) => {
  const context = { exports: {}, module: {} };
  context.module.exports = context.exports;
  vm.runInNewContext(await bundle(dist('dev-mode.js'), nodeEnv, 'cjs'), context);
  return { ...context.module.exports };
};

test('a dev server bundle with no global process reads as development', async () => {
  assert.deepEqual(await flags('development'), { envReadable: true, panelsByDefault: true });
});

test('a production bundle with no global process keeps <DevTools> closed', async () => {
  assert.deepEqual(await flags('production'), { envReadable: true, panelsByDefault: false });
});

test('plain ES modules, no bundler and no process: no throw, no hints, panels open', async () => {
  // The expression stays as written only when nothing defines it, so this reads the built file itself.
  const source = (await readFile(dist('dev-mode.js'), 'utf8')).replace(/export const /g, 'var ');
  const context = {};
  vm.runInNewContext(source, context);
  assert.equal(context.envReadable, false);
  assert.equal(context.panelsByDefault, true);
});

test('a production bundle drops both hints and their module', async () => {
  const code = await bundle(dist('index.js'), 'production', 'es');
  assert.doesNotMatch(code, /is a DOM element in React|never fire on the WebGL2 fallback/);
});

test('a development bundle keeps both hints', async () => {
  const code = await bundle(dist('index.js'), 'development', 'es');
  assert.match(code, /is a DOM element in React/);
  assert.match(code, /never fire on the WebGL2 fallback/);
});
