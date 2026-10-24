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
    ['gtao', 'fn arc(', ['bloom:capture', 'fxaa:capture', 'ssr:gbuffer']],
    ['ssgi', 'ssgi:gbuffer', ['bloom:capture', 'ssao:capture', 'fxaa:capture', 'ssr:gbuffer']],
    ['motion-blur', 'motion-blur:after-taa', ['bloom:capture', 'ssao:capture', 'ssr:gbuffer', 'ssgi:gbuffer']],
    ['lens-flare', 'const GHOSTS', ['bloom:capture', 'ssao:capture', 'ssr:gbuffer', 'motion-blur:after-taa']],
    ['smaa', 'smaa:capture', ['bloom:capture', 'ssao:capture', 'fxaa:capture', 'post:stack:capture']],
    ['glitch', 'tears:array<vec4f,4>', ['bloom:capture', 'ssao:capture', 'fxaa:capture', 'smaa:capture']],
    ['afterimage', 'var<uniform> fade:vec4f', ['bloom:capture', 'ssao:capture', 'smaa:capture', 'tears:array']],
  ]) {
    const code = await staticClosure('@margoengine/post/' + entry);
    assert.ok(code.includes(present), 'Effect implementation was omitted: ' + entry);
    for (const marker of excluded)
      assert.ok(!code.includes(marker), marker + ' entered the native ' + entry + ' import graph');
  }
});

test('Post root and feature subpaths preserve all runtime export identities', async () => {
  const [root, bloom, ssao, fade, stack, fxaa, ssr, gtao, ssgi, motion, flare, image, smaa, glitch, afterimage] =
    await Promise.all(
      [
        '',
        '/bloom',
        '/ssao',
        '/scene-fade',
        '/stack',
        '/fxaa',
        '/ssr',
        '/gtao',
        '/ssgi',
        '/motion-blur',
        '/lens-flare',
        '/image',
        '/smaa',
        '/glitch',
        '/afterimage',
      ].map((path) => import('@margoengine/post' + path)),
    );
  assert.deepEqual(Object.keys(root).sort(), [
    'Afterimage',
    'Bloom',
    'FXAA',
    'GTAO',
    'Glitch',
    'ImagePost',
    'LensFlare',
    'MotionBlur',
    'PostStack',
    'SMAA',
    'SSAO',
    'SSGI',
    'SSR',
    'SceneFade',
    'bloomWeights',
  ]);
  assert.deepEqual(Object.keys(bloom).sort(), ['Bloom', 'bloomWeights']);
  assert.equal(root.bloomWeights, bloom.bloomWeights);
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
  assert.deepEqual(Object.keys(gtao), ['GTAO']);
  assert.equal(root.GTAO, gtao.GTAO);
  assert.ok(new gtao.GTAO() instanceof ssao.SSAO, 'GTAO is an SSAO');
  assert.deepEqual(Object.keys(ssgi), ['SSGI']);
  assert.equal(root.SSGI, ssgi.SSGI);
  assert.deepEqual(Object.keys(motion), ['MotionBlur']);
  assert.equal(root.MotionBlur, motion.MotionBlur);
  assert.deepEqual(Object.keys(flare), ['LensFlare']);
  assert.equal(root.LensFlare, flare.LensFlare);
  assert.deepEqual(Object.keys(image), ['ImagePost']);
  assert.equal(root.ImagePost, image.ImagePost);
  assert.deepEqual(Object.keys(smaa), ['SMAA']);
  assert.equal(root.SMAA, smaa.SMAA);
  assert.deepEqual(Object.keys(glitch), ['Glitch']);
  assert.equal(root.Glitch, glitch.Glitch);
  assert.deepEqual(Object.keys(afterimage), ['Afterimage']);
  assert.equal(root.Afterimage, afterimage.Afterimage);
});
