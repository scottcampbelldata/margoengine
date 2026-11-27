// A package's lazy loaders get a dist chunk of their own, which no import() target imports back (KB-INL1b,
// scripts/support/lazy-loader-chunks.mjs). Run after `npm run build:packages`.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isLazyLoader } from '../scripts/support/lazy-loader-chunks.mjs';

const root = join(import.meta.dirname, '..');

test('isLazyLoader: import() of two or more relative modules and no runtime static import', () => {
  const two = "export const f = () => import('./a.js');\nexport const g = () => import(`./c.js`);";
  assert.equal(isLazyLoader(`import type { A } from './a.js';\n${two}`), true);
  assert.equal(isLazyLoader(`${two}\nexport type { A };`), true);
  assert.equal(
    isLazyLoader("export const f = () => import('./a.js');\nexport const g = () => import('./a.js');"),
    false,
  );
  assert.equal(
    isLazyLoader("export const f = () => import('@margoengine/a');\nexport const g = () => import('./c.js');"),
    false,
  );
  assert.equal(isLazyLoader(`import { b } from './b.js';\n${two}`), false);
  assert.equal(isLazyLoader(`import './side.js';\n${two}`), false);
  assert.equal(isLazyLoader(`export { b } from './b.js';\n${two}`), false);
  assert.equal(isLazyLoader("// import('./a.js') import('./c.js')\nexport const f = 1;"), false);
});

// Static and dynamic sibling imports of each .js file in a dist folder.
function distGraph(dist) {
  const graph = new Map();
  for (const file of readdirSync(dist).filter((name) => name.endsWith('.js'))) {
    const code = readFileSync(join(dist, file), 'utf8');
    graph.set(file, {
      code,
      static: [...code.matchAll(/(?:from|import)\s*["'`]\.\/([\w.-]+\.js)["'`]/g)].map((m) => m[1]),
      dynamic: [...code.matchAll(/import\(\s*["'`]\.\/([\w.-]+\.js)["'`]\s*\)/g)].map((m) => m[1]),
    });
  }
  return graph;
}

function reaches(graph, from, target, seen = new Set()) {
  for (const next of graph.get(from)?.static ?? [])
    if (next === target || (!seen.has(next) && (seen.add(next), reaches(graph, next, target, seen)))) return true;
  return false;
}

test('every lazy loader in a package source is a dist chunk that none of its import() targets imports back', () => {
  let checked = 0;
  for (const name of readdirSync(join(root, 'packages'))) {
    const src = join(root, 'packages', name, 'src');
    const dist = join(root, 'packages', name, 'dist');
    const manifest = join(root, 'packages', name, 'package.json');
    if (!existsSync(src) || !existsSync(dist) || !existsSync(manifest)) continue;
    const { exports = {}, scripts = {} } = JSON.parse(readFileSync(manifest, 'utf8'));
    // Packages with their own build script, and core, stage and the kits, are not built by the shared package build.
    if (scripts.build || ['core', 'stage', 'margoengine', 'react'].includes(name) || name.endsWith('-kit')) continue;
    const entries = new Set(
      Object.values(exports).map(
        (target) => (typeof target === 'string' ? target : target.import)?.match(/([\w-]+)\.js$/)?.[1],
      ),
    );
    const graph = distGraph(dist);
    const sources = readdirSync(src).filter((f) => f.endsWith('.ts') && !f.endsWith('.d.ts'));
    const code = new Map(sources.map((file) => [file, readFileSync(join(src, file), 'utf8')]));
    for (const file of sources) {
      const module = file.slice(0, -3);
      if (entries.has(module) || !isLazyLoader(code.get(file))) continue;
      // A loader no other source file imports is not in the build.
      const path = new RegExp(String.raw`['"\x60]\./${module}\.js['"\x60]`);
      if (!sources.some((other) => other !== file && path.test(code.get(other)))) continue;
      const chunk = [...graph.keys()].find((f) => new RegExp(String.raw`^${module}-[\w-]{8}\.js$`).test(f));
      assert.ok(chunk, `${name}: the lazy loader src/${file} has no dist chunk of its own`);
      checked++;
      for (const target of graph.get(chunk).dynamic)
        assert.ok(!reaches(graph, target, chunk), `${name}: ${target} imports back ${chunk}, the loader that loads it`);
    }
  }
  assert.ok(checked > 0, 'no lazy loader chunk found; is packages/*/dist built?');
});

test('splats: no dist chunk is imported back by a chunk it loads with import() (KB-INL1b)', () => {
  const graph = distGraph(join(root, 'packages/splats/dist'));
  for (const [file, { dynamic }] of graph)
    for (const target of dynamic) assert.ok(!reaches(graph, target, file), `${target} imports back ${file}`);
});
