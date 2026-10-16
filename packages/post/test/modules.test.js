import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

async function staticClosure(specifier) {
  const seen = new Set(),
    sources = [];
  const visit = async (url) => {
    if (seen.has(url)) return;
    seen.add(url);
    const code = await readFile(new URL(url), 'utf8');
    sources.push(code);
    for (const match of code.matchAll(/(?:\bfrom\s*|\bimport\s*)(['"])([^'"]+)\1/g)) {
      const dependency = match[2];
      if (dependency.startsWith('.')) await visit(new URL(dependency, url).href);
      else
        assert.ok(
          ['@margoengine/core', '@margoengine/core/extension'].includes(dependency),
          'Unexpected effect dependency: ' + dependency,
        );
    }
  };
  await visit(import.meta.resolve(specifier));
  return sources.join('\n');
}

test('native Bloom and SSAO imports exclude the other effects', async () => {
  for (const [entry, present, excluded] of [
    ['bloom', 'bloom:capture', ['ssao:capture', 'post:scene-fade', 'post:stack:capture', 'fxaa:capture']],
    ['ssao', 'ssao:capture', ['bloom:capture', 'post:scene-fade', 'post:stack:capture', 'fxaa:capture']],
    ['stack', 'post:stack:capture', ['bloom:capture', 'ssao:capture', 'fxaa:capture']],
    ['fxaa', 'fxaa:capture', ['bloom:capture', 'ssao:capture', 'post:stack:capture']],
    ['ssr', 'ssr:gbuffer', ['bloom:capture', 'ssao:capture', 'fxaa:capture']],
  ]) {
    const code = await staticClosure('@margoengine/post/' + entry);
    assert.ok(code.includes(present), 'Effect implementation was omitted: ' + entry);
    for (const marker of excluded)
      assert.ok(!code.includes(marker), marker + ' entered the native ' + entry + ' import graph');
  }
});

test('Post root and feature subpaths preserve all runtime export identities', async () => {
  const [root, bloom, ssao, fade, stack, fxaa, ssr] = await Promise.all(
    ['', '/bloom', '/ssao', '/scene-fade', '/stack', '/fxaa', '/ssr'].map((path) => import('@margoengine/post' + path)),
  );
  assert.deepEqual(Object.keys(root).sort(), ['Bloom', 'FXAA', 'PostStack', 'SSAO', 'SSR', 'SceneFade']);
  assert.deepEqual(Object.keys(bloom), ['Bloom']);
  assert.deepEqual(Object.keys(ssao), ['SSAO']);
  assert.deepEqual(Object.keys(stack), ['PostStack']);
  assert.deepEqual(Object.keys(fxaa), ['FXAA']);
  assert.equal(root.Bloom, bloom.Bloom);
  assert.equal(root.SSAO, ssao.SSAO);
  assert.equal(root.SceneFade, fade.SceneFade);
  assert.equal(root.PostStack, stack.PostStack);
  assert.equal(root.FXAA, fxaa.FXAA);
  assert.deepEqual(Object.keys(ssr), ['SSR']);
  assert.equal(root.SSR, ssr.SSR);
});
