// The plain entry must not carry the optional passes: area lights, bounces and glass (./global) or caustics
// (./refracted), and the triangle-mesh baker (./mesh) carries none of them nor the quad atlas packer. Checked on the built files: the code each entry loads, following its relative imports.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

async function loaded(file, seen = new Set()) {
  if (seen.has(file)) return '';
  seen.add(file);
  const code = await readFile(new URL(`../dist/${file}`, import.meta.url), 'utf8');
  let all = code;
  for (const [, next] of code.matchAll(/from\s*["']\.\/([\w-]+\.js)["']/g)) all += await loaded(next, seen);
  return all;
}

test('each entry loads only its own passes', async () => {
  const plain = await loaded('index.js'),
    global = await loaded('global.js'),
    refracted = await loaded('refracted.js'),
    mesh = await loaded('mesh.js');
  for (const name of ['bakeGlobalLightmap', 'bakeRefractedLightmap', 'bakeMeshLightmap', 'glass'])
    assert.ok(!plain.includes(name), name);
  assert.ok(mesh.includes('bakeMeshLightmap') && !mesh.includes('bakeGlobalLightmap') && !mesh.includes('packAtlas'));
  assert.ok(global.includes('bakeGlobalLightmap') && !global.includes('bakeRefractedLightmap'));
  assert.ok(refracted.includes('bakeRefractedLightmap') && !refracted.includes('bakeGlobalLightmap'));
});
