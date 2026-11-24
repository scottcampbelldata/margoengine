// WebKit sweep (2026-11-11): a binding kept in an automatic layout only by a phony assignment of its pointer
// (`_=&uniforms;`) is left out of the layout by WebKit's WGSL compiler, so getBindGroupLayout gives an invalid layout and
// the material's group fails (inspector test:browser:shaders after a WGSL edit that stopped reading `uniforms`). WGSL
// counts the identifier as a static access either way (WGSL, "Static use"); a phony assignment of the value
// (`_=uniforms;`) works in WebKit too. No package's shader source keeps a binding with the pointer form.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const packages = fileURLToPath(new URL('../..', import.meta.url));
const sources = (dir) =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? sources(path) : /\.(ts|js|wgsl)$/.test(name) ? [path] : [];
  });

test('no package keeps a binding in an automatic layout with a phony pointer assignment', () => {
  const found = [];
  for (const name of readdirSync(packages)) {
    let src;
    try {
      src = sources(join(packages, name, 'src'));
    } catch {
      continue;
    }
    for (const file of src)
      readFileSync(file, 'utf8')
        .split('\n')
        .forEach((line, i) => /\b_\s*=\s*&\s*\w/.test(line) && found.push(`${file.slice(packages.length)}:${i + 1}`));
  }
  assert.deepEqual(found, []);
});

