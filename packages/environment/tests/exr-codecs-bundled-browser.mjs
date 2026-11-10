// Production consumer regression: a real GPU render after bundlers copy the worker, ESM glue and Wasm.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import { build, preview } from 'vite';
import { launchBrowser } from '../../../scripts/lib/browser.mjs';
import { closeAll } from '../../../scripts/support/shutdown.mjs';
import { compatRun, compatShim } from '../../../scripts/support/compat-shim.js';

const pkg = resolve(import.meta.dirname, '..'),
  root = resolve(pkg, 'test-results/exr-production');
await mkdir(root, { recursive: true });
const specifier = (file) => JSON.stringify(relative(root, resolve(pkg, file)).replaceAll('\\', '/'));
await writeFile(
  root + '/index.html',
  '<!doctype html><link rel="icon" href="data:,"><canvas width="32" height="32"></canvas><script type="module" src="./main.js"></script>',
);
await writeFile(
  root + '/main.js',
  `
import {loadEXR} from ${specifier('dist/exr-codecs.js')};
import {Engine} from ${specifier('../core/dist/index.js')};
import {Environment,EnvironmentBackground} from ${specifier('dist/index.js')};
window.runTests=async()=>{
 const image=await loadEXR(new URL(${specifier('tests/fixtures/codecs/venice-half-dwab-tiled.exr')},import.meta.url));
 const engine=await Engine.create(document.querySelector('canvas'),{backend:'webgpu'}),gpu=engine.gpu;
 gpu.pushErrorScope('validation');
 const env=await Environment.attach(engine,image,{size:16,specularSize:16,specularMips:3,samples:16,brdfSize:16,brdfSamples:16});
 EnvironmentBackground.attach(engine,env);engine.render();await gpu.queue.onSubmittedWorkDone();
 const error=await gpu.popErrorScope();engine.dispose();if(error)throw new Error(error.message);
 return {width:image.width,compression:image.compression,storage:image.storage};
};`,
);
await build({
  root,
  configFile: false,
  publicDir: false,
  logLevel: 'warn',
  build: {
    outDir: 'out',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        index: root + '/index.html',
        ...(compatRun() ? { compat: resolve(pkg, '../webgl2-compat/dist/device.js') } : {}),
      },
      output: { entryFileNames: '[name].js' },
    },
  },
});
const server = await preview({
  root,
  configFile: false,
  build: { outDir: 'out' },
  preview: { host: '127.0.0.1', port: 0 },
});
let browser;
try {
  browser = await launchBrowser({ headless: true });
  const page = await browser.newPage();
  if (compatRun()) await page.addInitScript(compatShim, '/compat.js');
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(server.resolvedUrls.local[0]);
  await page.waitForFunction(() => typeof window.runTests === 'function');
  const result = await page.evaluate(() => window.runTests());
  assert.deepEqual(errors, []);
  assert.deepEqual(result, { width: 37, compression: 'dwab', storage: 'tiled' });
  console.log(JSON.stringify(result));
} finally {
  await closeAll({ browser, servers: [server] });
}
