// The WebGL2 compatibility layer's size is measured as a base and a lazy part (scripts/lazy-files.js,
// LAZY_SPLITS; docs/limits.md). That split is only true while nothing the layer loads without compute imports the
// runtime: the CPU compute tier (packages/webgl2-compat/src/compute/runtime.ts, js.ts and the rest of compute/) must be
// reached through one `import()` in device/device.ts, made on the first compute pipeline. This test walks the source
// module graph from the root entry (static imports and every `import()` except that one) and fails when it reaches
// the compute runtime, which would put its bytes into every page that installs the layer. `import type` is erased.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path, { dirname, join, resolve } from 'node:path';
import { parseSync } from 'rolldown/utils';
import { LAZY_SPLITS } from '../scripts/lazy-files.js';

const root = resolve(import.meta.dirname, '..');
const split = LAZY_SPLITS.find((entry) => entry.package === 'webgl2-compat');
const src = join(root, 'packages/webgl2-compat/src');
const lazyRuntime = join(root, split.source);
const rel = (file) =>
  file
    .slice(root.length + 1)
    .split(path.sep)
    .join('/');

/** The relative imports of a source module: `{ file, dynamic }` for each runtime import and export-from. */
function importsOf(file) {
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
      found.push({ specifier: node.source.value, dynamic: false });
    if (node.type === 'ImportExpression' && node.source.type === 'Literal')
      found.push({ specifier: node.source.value, dynamic: true });
    for (const [key, value] of Object.entries(node)) if (key !== 'parent') walk(value);
  };
  walk(parsed.program);
  return found
    .filter(({ specifier }) => specifier.startsWith('.'))
    .map(({ specifier, dynamic }) => {
      const base = resolve(dirname(file), specifier);
      const next = [base.replace(/\.js$/, '.ts'), base.replace(/\.js$/, '.tsx'), base].find(existsSync);
      assert.ok(next, `${rel(file)}: cannot resolve ${specifier}`);
      return { file: next, dynamic };
    });
}

/** Source modules reached from `entry`; `skip` names modules whose import is not followed (the lazy boundary). */
function reach(entry, skip = new Set()) {
  const seen = new Map(); // file -> the module that first imported it
  const visit = (file, from) => {
    if (seen.has(file)) return;
    seen.set(file, from);
    for (const next of importsOf(file)) if (!skip.has(next.file)) visit(next.file, file);
  };
  visit(entry, null);
  return seen;
}

test('the compute runtime is reached only through the import() in device/device.ts', () => {
  const importers = [];
  for (const file of reach(join(src, 'index.ts')).keys())
    for (const next of importsOf(file))
      if (next.file === lazyRuntime) importers.push({ file: rel(file), dynamic: next.dynamic });
  assert.deepEqual(importers, [{ file: 'packages/webgl2-compat/src/device/device.ts', dynamic: true }]);
});

test('the base entry reaches none of the compute runtime, even through other imports', () => {
  const runtimeSide = reach(lazyRuntime);
  const base = reach(join(src, 'index.ts'), new Set([lazyRuntime]));
  // What only the runtime loads: its own modules and compute/js.ts and the like. Shared modules (glsl, wgsl, device) are base.
  const onlyRuntime = [...runtimeSide.keys()].filter((file) => !base.has(file));
  assert.ok(
    onlyRuntime.map(rel).includes('packages/webgl2-compat/src/compute/js.ts'),
    'the runtime still loads compute/js.ts',
  );
  assert.ok(onlyRuntime.length >= 2, `the lazy side holds ${onlyRuntime.map(rel).join(', ')}`);
  // The public ./compute entry (src/compute.ts) is not part of the base either.
  assert.ok(!base.has(join(src, 'compute.ts')), 'the base reaches the ./compute entry');
  for (const file of base.keys())
    assert.ok(
      !rel(file).startsWith('packages/webgl2-compat/src/compute/'),
      `${rel(file)} is in the base entry (imported by ${rel(base.get(file) ?? '')}); keep compute/ behind the import() in device/device.ts`,
    );
});

test('texture read-back is reached only through the import() in device/device.ts', () => {
  const readback = join(src, 'device/readback.ts'),
    importers = [];
  for (const file of reach(join(src, 'index.ts')).keys())
    for (const next of importsOf(file))
      if (next.file === readback) importers.push({ file: rel(file), dynamic: next.dynamic });
  assert.deepEqual(importers, [{ file: 'packages/webgl2-compat/src/device/device.ts', dynamic: true }]);
});

test('the only import() calls in the layer are index.ts to device.ts and device.ts to compute, read-back and the xr entry', () => {
  // scripts/lazy-files.js picks the lazy chunk by its built file name (split.chunk); any other dynamic import could
  // add or rename a chunk that pattern misses or wrongly catches, so the set of lazy edges is pinned here.
  const edges = [];
  for (const file of reach(join(src, 'index.ts')).keys())
    for (const next of importsOf(file)) if (next.dynamic) edges.push(`${rel(file)} -> ${rel(next.file)}`);
  assert.deepEqual(edges.sort(), [
    'packages/webgl2-compat/src/compute/runtime.ts -> packages/webgl2-compat/src/compute/interpret.ts',
    'packages/webgl2-compat/src/device/device.ts -> packages/webgl2-compat/src/compute/runtime.ts',
    'packages/webgl2-compat/src/device/device.ts -> packages/webgl2-compat/src/device/readback.ts',
    'packages/webgl2-compat/src/device/device.ts -> packages/webgl2-compat/src/xr.ts',
    'packages/webgl2-compat/src/index.ts -> packages/webgl2-compat/src/device.ts',
  ]);
  assert.ok(split.chunk.test('runtime-AbC123.js') && !split.chunk.test('device-AbC123.js'));
  assert.ok(split.chunk.test('readback-AbC123.js'));
  // CompatGPU.xrRoute loads a public entry, built under its own name, so it adds no chunk and stays outside the pattern.
  assert.ok(!split.chunk.test('xr.js'));
});
