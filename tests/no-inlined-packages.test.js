// A package's built entries import the packages it declares; they never carry a copy of them (KB-BUILD-INLINE1). A bare
// specifier missing from scripts/build-modern.js's external list resolved inside the workspace and was bundled:
// blender/dist held its own gltf/physics (and through it physics/decomposition), 28,139 B gzip against a 16,677 B cap,
// and an app that also imported gltf/physics had two copies of it. Workers are left out: a worker is one file that
// bundles what it uses, because a bare specifier does not resolve inside it. Reads the built dists, so it runs after
// `npm run build:packages`.
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { parseSync } from 'rolldown/utils';

const root = resolve(import.meta.dirname, '..');
// Open, with its docs/known-bugs.md row: `<package> <specifier>`. A row that is fixed must leave this list.
const open = new Set([]);

const files = (dir, keep) =>
  existsSync(dir)
    ? readdirSync(dir, { recursive: true, withFileTypes: true })
        .filter((item) => item.isFile() && keep(item.name))
        .map((item) => resolve(item.parentPath, item.name))
    : [];

/** The module specifiers a source loads at run time: value imports, value re-exports and `import()`. */
export function runtimeSpecifiers(source, file = 'module.ts') {
  const { program, errors } = parseSync(file, source);
  assert.deepEqual(errors, [], `${file} did not parse`);
  const found = new Set();
  const types = (list) => list?.length > 0 && list.every((item) => (item.importKind ?? item.exportKind) === 'type');
  const visit = (node) => {
    if (Array.isArray(node)) return node.forEach(visit);
    if (typeof node?.type !== 'string') return;
    if (node.type === 'ImportDeclaration' && node.importKind !== 'type' && !types(node.specifiers))
      found.add(node.source.value);
    else if (/^Export(Named|All)Declaration$/.test(node.type) && node.source && node.exportKind !== 'type') {
      if (!types(node.specifiers)) found.add(node.source.value);
    } else if (node.type === 'ImportExpression') {
      // A string, or a template with nothing in it, as the minifier writes `import(`x`)`.
      const { value, quasis, expressions } = node.source;
      if (typeof value === 'string') found.add(value);
      else if (expressions?.length === 0) found.add(quasis[0].value.cooked);
    }
    Object.values(node).forEach(visit);
  };
  visit(program);
  return found;
}

test('type-only imports load nothing at run time', () => {
  assert.deepEqual(
    [
      ...runtimeSpecifiers(`
        import type { A } from 'a';
        import { type B } from 'b';
        import { type C, d } from 'd';
        export type { E } from 'e';
        export { f } from 'f';
        let g: import('g').G;
        const h = () => import('h');
      `),
    ],
    ['d', 'f', 'h'],
  );
});

test('no built package carries a copy of a package it declares', () => {
  const inlined = [];
  for (const dir of readdirSync(resolve(root, 'packages'))) {
    const manifestPath = resolve(root, 'packages', dir, 'package.json');
    if (!existsSync(manifestPath)) continue;
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const declared = Object.keys({ ...manifest.dependencies, ...manifest.peerDependencies }).filter((name) =>
      name.startsWith('@margoengine/'),
    );
    if (!declared.length) continue;
    const wanted = new Set();
    for (const file of files(resolve(root, 'packages', dir, 'src'), (name) => /(?<!\.d)\.tsx?$/.test(name))) {
      if (/[\\/]workers[\\/]|\.worker\.ts$|-worker\.ts$/.test(file)) continue;
      for (const specifier of runtimeSpecifiers(readFileSync(file, 'utf8'), file))
        if (declared.some((name) => specifier === name || specifier.startsWith(`${name}/`))) wanted.add(specifier);
    }
    if (!wanted.size) continue;
    const built = files(resolve(root, 'packages', dir, 'dist'), (name) => name.endsWith('.js'));
    assert.ok(built.length, `${dir}: no dist; run npm run build:packages first`);
    const imported = new Set(built.flatMap((file) => [...runtimeSpecifiers(readFileSync(file, 'utf8'), file)]));
    for (const specifier of wanted) if (!imported.has(specifier)) inlined.push(`${dir} ${specifier}`);
  }
  assert.deepEqual(
    inlined.filter((row) => !open.has(row)),
    [],
    'add the specifier to the external list in scripts/build-modern.js (or the package build script)',
  );
  assert.deepEqual(
    [...open].filter((row) => !inlined.includes(row)),
    [],
    'fixed: take the row out of the open list and close it in docs/known-bugs.md',
  );
});
