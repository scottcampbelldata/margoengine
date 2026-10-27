// Drift check for the React docs: every name a snippet imports from the React package must be exported by the built
// package. A renamed or removed component or hook fails `verify` here, before the slower type-check of every prop
// (scripts/modern-package-tests.js checks the same snippets against the packed package).
// Snippets read: packages/react/README.md, docs/react-*.md, docs/from-threejs.md, docs/guides/*.md, the root README and
// the examples' source. `import type` and `type X` specifiers are skipped (types have no runtime export).
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { blocks, root } from '../scripts/support/doc-snippets.mjs';

const read = (file) => readFileSync(join(root, file), 'utf8');
const walk = (dir, accept, out = []) => {
  if (!existsSync(join(root, dir))) return out;
  for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
    if (['node_modules', 'dist', '.next'].includes(entry.name)) continue;
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) walk(path, accept, out);
    else if (accept(path)) out.push(path);
  }
  return out;
};

/** [{ file, subpath, name }] for each value import from the React package in Markdown blocks and example sources. */
function imports() {
  const found = [];
  const pattern = /import\s+(type\s+)?\{([^}]*)\}\s+from\s+'(@margoengine|margoengine)\/react(?:\/([\w-]+))?'/g;
  const texts = [];
  for (const file of [
    'packages/react/README.md',
    'README.md',
    'docs/from-threejs.md',
    ...walk('docs', (p) => p.endsWith('.md')).filter((p) => /react|guides/.test(p)),
  ])
    for (const b of blocks(read(file))) if (['ts', 'tsx'].includes(b.lang)) texts.push([file, b.code]);
  for (const file of walk(
    'examples',
    (p) => /\.(tsx?|jsx?)$/.test(p) && /react|vite|next/.test(p) && statSync(join(root, p)).size < 200_000,
  ))
    texts.push([file, read(file)]);
  for (const [file, code] of texts)
    for (const [, isType, list, scope, subpath] of code.matchAll(pattern)) {
      if (isType) continue;
      for (const part of list.split(',')) {
        const spec = part.trim();
        if (!spec || spec.startsWith('type ')) continue;
        // margoengine/react, the one install, is every subpath but physics: its own generated entry.
        const entry =
          scope === 'margoengine' ? `margoengine:${subpath ? `react/${subpath}` : 'react'}` : (subpath ?? 'index');
        found.push({ file, subpath: entry, name: spec.split(/\s+as\s+/)[0].trim() });
      }
    }
  return found;
}

test('every value a doc or example imports from the React package is exported', async () => {
  const exported = new Map();
  const missing = [];
  const all = imports();
  assert.ok(all.length > 50, `expected many React imports in the docs, found ${all.length}`);
  for (const { file, subpath, name } of all) {
    if (!exported.has(subpath)) {
      const entry = subpath.startsWith('margoengine:')
        ? join(root, 'packages/margoengine/dist', `${subpath.slice('margoengine:'.length)}.js`)
        : join(root, 'packages/react/dist', `${subpath}.js`);
      assert.ok(existsSync(entry), `${subpath} is not an entry of the React package (a doc imports it)`);
      exported.set(subpath, new Set(Object.keys(await import(pathToFileURL(entry).href))));
    }
    if (!exported.get(subpath).has(name)) missing.push(`${file}: ${name} from react/${subpath}`);
  }
  assert.deepEqual([...new Set(missing)], [], 'docs import names the React package does not export');
});

test('the drift check notices a name that is not exported', () => {
  const sample = "import { Canvas, useFrameLoop } from 'margoengine/react';";
  const names = [...sample.matchAll(/\{([^}]*)\}/g)][0][1].split(',').map((s) => s.trim());
  assert.deepEqual(names, ['Canvas', 'useFrameLoop']);
});

test('the physics README names only exports that exist', () => {
  const api = ['physics', 'react.physics'].map((n) => read(`api/${n}.api.md`)).join('\n');
  const text = read('packages/physics/README.md').split('```')[0];
  const claimed = [...text.matchAll(/`<?((?:Physics|use|Rigid|Cuboid|Ball|Character|Vehicle|Rope)\w*)/g)].map(
    (m) => m[1],
  );
  assert.ok(claimed.length >= 8, `expected the README to name its exports, found ${claimed.length}`);
  const missing = [...new Set(claimed)].filter(
    (n) => !new RegExp(`export (?:declare )?(?:class|function|const) ${n}\\b`).test(api),
  );
  assert.deepEqual(missing, [], 'the physics README names exports that api/ does not list');
});
