// No package ships an ineffective dynamic import: a dist module that one file loads with import() while another file
// of the same package imports it statically. The static import already pulls it into the importer's chunk, so the
// import() splits nothing, and Vite prints "dynamic import will not move module into another chunk" for every app that
// links the package from a folder (gltf-pro's Draco module did, 2026-10-26). Run after `npm run build:packages`.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { parseSync } from 'rolldown/utils';

const root = resolve(import.meta.dirname, '..');

/** Relative specifiers a module imports statically (values, not types) and with a string-literal import(). */
export function relativeImports(filename, code) {
  const parsed = parseSync(filename, code);
  assert.equal(parsed.errors.length, 0, `${filename}: ${parsed.errors[0]?.message}`);
  const found = { static: new Set(), dynamic: new Set() };
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) return node.forEach(walk);
    const kind =
      ['ImportDeclaration', 'ExportNamedDeclaration', 'ExportAllDeclaration'].includes(node.type) &&
      node.importKind !== 'type' &&
      node.exportKind !== 'type'
        ? 'static'
        : node.type === 'ImportExpression'
          ? 'dynamic'
          : undefined;
    const value = node.source?.type === 'Literal' ? node.source.value : undefined;
    if (kind && typeof value === 'string' && value.startsWith('.')) found[kind].add(value.replace(/\?.*$/, ''));
    for (const [key, child] of Object.entries(node))
      if (key !== 'comments' && child && typeof child === 'object') walk(child);
  };
  walk(parsed.program);
  return found;
}

/** Every `file is dynamically imported by A but statically by B` within one package's dist folder. */
export async function ineffectiveDynamicImports(dist) {
  const statics = new Map(),
    dynamics = new Map();
  const add = (map, target, from) => map.set(target, [...(map.get(target) ?? []), from]);
  const visit = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = join(directory, entry.name);
      if (entry.isDirectory()) await visit(file);
      else if (/\.m?js$/.test(entry.name)) {
        const { static: s, dynamic: d } = relativeImports(file, await readFile(file, 'utf8'));
        for (const specifier of s) add(statics, resolve(dirname(file), specifier), file);
        for (const specifier of d) add(dynamics, resolve(dirname(file), specifier), file);
      }
    }
  };
  await visit(dist);
  return [...dynamics]
    .filter(([target]) => statics.has(target))
    .map(
      ([target, by]) =>
        `${relative(root, target)} is dynamically imported by ${by.map((f) => relative(root, f)).join(', ')} but statically by ${statics
          .get(target)
          .map((f) => relative(root, f))
          .join(', ')}`,
    );
}

test('the check finds a module that is both dynamically and statically imported', async () => {
  const found = relativeImports(
    'probe.ts',
    "import{a}from'./a.js';import type{T}from'./t.js';export*from'./b.js';const c=()=>import('./c.js?no-inline');",
  );
  assert.deepEqual([...found.static].sort(), ['./a.js', './b.js']);
  assert.deepEqual([...found.dynamic], ['./c.js']);
});

test('no package dist module is both dynamically and statically imported', async () => {
  const problems = [];
  let checked = 0;
  for (const name of await readdir(join(root, 'packages'))) {
    const dist = join(root, 'packages', name, 'dist');
    if (!existsSync(join(root, 'packages', name, 'package.json')) || !existsSync(dist)) continue;
    checked++;
    problems.push(...(await ineffectiveDynamicImports(dist)));
  }
  assert.ok(checked > 50, `found ${checked} built packages; run npm run build:packages first`);
  assert.deepEqual(problems, []);
});
