// A number field declared before the constructor starts as undefined, so V8 stores it tagged and every write of a
// fraction allocates: 10,000 Spring updates took 0.41 ms and take 0.28 ms without the declarations. The shared tsconfig
// drops them. @margoengine/materials keeps them: Material lists its values with Object.keys(new Material()), so its
// optional fields must exist before they are set. The packages with their own tsconfig are out of scope here.
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import test from 'node:test';

const packages = new URL('../packages/', import.meta.url),
  keeps = new Set(['materials']),
  bare = /\bclass(?:\s+[\w$]+)?(?:\s+extends\s+[\w$.]+)?\s*\{\s*[A-Za-z_$][\w$]*\s*;/;

const scripts = (folder) =>
  readdirSync(folder, { recursive: true })
    .filter((name) => String(name).endsWith('.js'))
    .map((name) => new URL(String(name).replaceAll('\\', '/'), folder));

test('packages on the shared tsconfig build no bare class fields, and only materials opts out', () => {
  assert.match(readFileSync(new URL('gltf/tsconfig.json', packages), 'utf8'), /"useDefineForClassFields":\s*false/);
  let checked = 0;
  for (const name of readdirSync(packages)) {
    const config = new URL(`${name}/tsconfig.json`, packages),
      dist = new URL(`${name}/dist/`, packages);
    if (!existsSync(config)) continue;
    const text = readFileSync(config, 'utf8');
    if (!text.includes('../gltf/tsconfig.json')) continue;
    assert.equal(text.includes('"useDefineForClassFields":true'), keeps.has(name), name);
    if (keeps.has(name) || !existsSync(dist)) continue;
    for (const file of scripts(dist)) assert.doesNotMatch(readFileSync(file, 'utf8'), bare, file.pathname);
    checked++;
  }
  assert.ok(checked > 80, `only ${checked} packages built`);
});
