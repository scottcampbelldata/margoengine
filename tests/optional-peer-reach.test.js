// Regression (2026-10-27): `@margoengine/react` installed alone did not build with webpack or Turbopack. Both resolve
// every string-literal import() in every module they reach, called or not, and the stage class and the React root
// entry reached 39 module names in 19 optional packages. This test walks the source module graph of each entry (static
// and dynamic runtime imports; `import type` is erased) and fails when an entry reaches a package that its users are
// not told to install: for the stage and React roots, any optional peer at all.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parseSync } from 'rolldown/utils';

const root = resolve(import.meta.dirname, '..');
const manifest = (name) => JSON.parse(readFileSync(join(root, 'packages', name, 'package.json'), 'utf8'));
const packageOf = (specifier) => specifier.match(/^(@[^/]+\/[^/]+|[^/]+)/)[1];

/** Every bare package a source module reaches at runtime, following relative imports. */
function reach(entry) {
  const seen = new Set(),
    packages = new Map();
  const visit = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    const text = readFileSync(file, 'utf8'),
      parsed = parseSync(file, text);
    assert.deepEqual(parsed.errors, [], file);
    const found = [];
    const walk = (node) => {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) return node.forEach(walk);
      if (
        (node.type === 'ImportDeclaration' && node.importKind !== 'type') ||
        ((node.type === 'ExportNamedDeclaration' || node.type === 'ExportAllDeclaration') &&
          node.source &&
          node.exportKind !== 'type')
      )
        found.push(node.source.value);
      if (node.type === 'ImportExpression' && node.source.type === 'Literal') found.push(node.source.value);
      for (const [key, value] of Object.entries(node)) if (key !== 'parent') walk(value);
    };
    walk(parsed.program);
    for (const specifier of found) {
      if (specifier.startsWith('.')) {
        const base = resolve(dirname(file), specifier);
        const next = [base.replace(/\.js$/, '.ts'), base.replace(/\.js$/, '.tsx'), base].find(existsSync);
        // Shared helpers outside the package (packages/shared) are plain JavaScript bundled with it.
        if (next) visit(next);
        else assert.fail(`${file}: cannot resolve ${specifier}`);
      } else {
        const name = packageOf(specifier);
        if (!packages.has(name)) packages.set(name, `${file.slice(root.length + 1)} imports ${specifier}`);
      }
    }
  };
  visit(entry);
  return packages;
}

/** What a user of `name` always has installed: its dependencies and its required (non-optional) peers. */
function installed(name) {
  const m = manifest(name);
  return new Set([
    m.name,
    ...Object.keys(m.dependencies ?? {}),
    ...Object.keys(m.peerDependencies ?? {}).filter((peer) => !m.peerDependenciesMeta?.[peer]?.optional),
  ]);
}

test('the stage root reaches no optional package', () => {
  const always = installed('stage'),
    reached = reach(join(root, 'packages/stage/src/index.ts'));
  for (const [name, where] of reached) assert.ok(always.has(name), `stage root: ${where}`);
});

// Each React subpath is named after the optional package it needs; these are the others it may reach.
const REACT_EXTRA = {
  './xr-pointer': ['@margoengine/xr'],
  './devtools': ['@margoengine/inspector', '@margoengine/stats'],
  './fbx': ['@margoengine/gltf-pro'],
  './geometry': ['@margoengine/materials'],
  './textures': ['@margoengine/materials', '@margoengine/decoders'],
  './animation': ['@margoengine/animator'],
  './materials': ['@margoengine/gltf-pro'],
  './dof': ['@margoengine/post'],
  './tonemap': ['@margoengine/post'],
  './taa': ['@margoengine/post'],
  './ui': ['@margoengine/audio', '@margoengine/sprites', '@margoengine/sciviz'],
  './controls-extra': ['@margoengine/controls'],
  './portals': ['@margoengine/materials'],
  './effects-extra': ['@margoengine/points', '@margoengine/lines', '@margoengine/geometry', '@margoengine/materials'],
  './offscreen': ['@margoengine/worker'],
  './test': ['@margoengine/headless'],
};
test('the React root reaches no optional package, and each subpath only the packages its name says', () => {
  const m = manifest('react'),
    // React itself is the app's (an optional peer only so a server build may leave react-dom out).
    always = new Set([...installed('react'), 'react', 'react-dom']);
  for (const [subpath, { import: target }] of Object.entries(m.exports)) {
    const file = join(root, 'packages/react', target.replace('./dist/', 'src/').replace(/\.js$/, ''));
    const entry = [`${file}.ts`, `${file}.tsx`].find(existsSync);
    assert.ok(entry, `${subpath}: no source for ${target}`);
    const allowed = new Set(always);
    if (subpath !== '.') allowed.add(`@margoengine/${subpath.slice(2)}`);
    for (const extra of REACT_EXTRA[subpath] ?? []) allowed.add(extra);
    for (const [name, where] of reach(entry))
      assert.ok(allowed.has(name), `@margoengine/react${subpath.slice(1)}: ${where}`);
  }
});
