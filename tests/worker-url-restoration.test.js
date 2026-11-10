import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { restoreWorkerUrls } from '../scripts/build-workers.js';

test('worker URL restoration preserves runtime import annotations that keep Node codecs out of browser bundles', async () => {
  const base = resolve('test-results');
  await mkdir(base, { recursive: true });
  const dir = await mkdtemp(join(base, 'worker-url-'));
  try {
    const source = `const worker=new URL(/* @vite-ignore */ './worker.js',''+import.meta.url);
const decoder=()=>import(/* @vite-ignore */ /* webpackIgnore: true */ '@margoengine/decoders/image');`;
    await writeFile(join(dir, 'entry.js'), source);
    await restoreWorkerUrls(dir);
    const restored = await readFile(join(dir, 'entry.js'), 'utf8');
    assert.ok(restored.includes("new URL('./worker.js',import.meta.url)"));
    assert.ok(restored.includes("import(/* @vite-ignore */ /* webpackIgnore: true */ '@margoengine/decoders/image')"));
    await restoreWorkerUrls(dir);
    assert.equal(await readFile(join(dir, 'entry.js'), 'utf8'), restored);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
