// Parser workers are classic IIFE scripts, so they cannot carry import.meta.url. Draco and KTX2 stay in
// @margoengine/decoders. The package entries keep a literal new URL('./workers/….js?no-inline', import.meta.url)
// for the app bundler, without the comment that only silences the package build.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURL('../');
const text = (path) => readFileSync(join(root, path), 'utf8');
function fileURL(path) {
  return fileURLToPath(new URL(path, import.meta.url));
}

test('parser workers do not inline Draco or KTX2', () => {
  for (const path of [
    'packages/gltf-pro/dist/workers/gltf.js',
    'packages/gltf-pro/dist/workers/progressive.js',
    'packages/fbx/dist/workers/fbx.js',
    'packages/usdz/dist/workers/usdz.js',
    'packages/ifc/dist/workers/ifc.js',
    'packages/loaders/dist/workers/usd.js',
  ]) {
    const code = text(path);
    assert.doesNotMatch(code, /\{\}\.url|import\.meta/, path);
    assert.doesNotMatch(code, /data:application\/wasm|data:text\/javascript/, path);
    assert.doesNotMatch(code, /@margoengine\/decoders(?!\/meshopt)/, path);
    assert.equal(existsSync(join(root, path, '..', 'decoder.worker.js')), false, path);
  }
  assert.match(text('packages/gltf-pro/dist/workers/gltf.js'), /EXT_meshopt_compression/);
});

test('published worker URLs stay literal import.meta.url', () => {
  const expected = [
    ['packages/gltf-pro/dist', './workers/gltf.js?no-inline'],
    ['packages/gltf-pro/dist', './workers/progressive.js?no-inline'],
    ['packages/ifc/dist', './workers/ifc.js?no-inline'],
    ['packages/fbx/dist', './workers/fbx.js?no-inline'],
    ['packages/loaders/dist', './workers/usd.js?no-inline'],
    ['packages/usdz/dist', './workers/usdz.js?no-inline'],
    ['packages/machinery/dist', './workers/cad-runtime.js?no-inline'],
    ['packages/machinery/dist', './workers/occt-import-js.js?no-inline'],
    ['packages/machinery/dist', './workers/occt-import-js.wasm?no-inline'],
  ];
  for (const [dir, url] of expected) {
    const files = readdirSync(join(root, dir)).filter((file) => file.endsWith('.js'));
    const hit = files.find((file) => text(join(dir, file)).includes(url));
    assert.ok(hit, `${dir} publishes ${url}`);
    const code = text(join(dir, hit));
    assert.match(code, new RegExp(url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[`\'"],\\s*import\\.meta\\.url'), url);
    assert.doesNotMatch(code, /@vite-ignore/, url);
    assert.doesNotMatch(code, /(?:''|""|``)\s*\+\s*import\.meta\.url/, url);
  }
});
