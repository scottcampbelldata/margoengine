// Packages bundled together (integration J5, docs/integration-packaging.md). An app composes packages from their
// READMEs and its bundler joins them; this checks what no single package's tests can see:
// 1. each group of packages that share a contract (scripts/support/contract-groups.mjs), bundled with its packages
//    imported in two orders, builds the same modules importing the same bindings and, run, prints
//    byte-identical output (every export's kind and value or keys, and the globals importing added). A module's raw
//    bytes are not compared: the bundler orders its hoisted imports by discovery and numbers clashing local aliases
//    (i$1, i$2) by it, so they move with the import order without any package doing anything different;
// 2. a bundle of core plus one package holds only that package, core and what its manifest says it needs;
// 3. core reached by two paths plus the umbrella is one core: one Engine class, one copy of each core module.
// Bundles with Rolldown (Vite's bundler) with nothing external; needs `npm run build:packages` (packages resolve to dist).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import test from 'node:test';
import { rolldown } from 'rolldown';
import { CONTRACT_GROUPS, LEFT_OUT } from '../scripts/support/contract-groups.mjs';

const root = resolve(import.meta.dirname, '..');
const manifests = new Map(),
  folderOf = new Map();
for (const folder of readdirSync(join(root, 'packages'))) {
  const file = join(root, 'packages', folder, 'package.json');
  if (!existsSync(file)) continue;
  const manifest = JSON.parse(readFileSync(file, 'utf8'));
  manifests.set(manifest.name, manifest);
  folderOf.set(realpathSync(join(root, 'packages', folder)), manifest.name);
}

/** The package a bundled module belongs to: a workspace package by folder, a third-party one by its node_modules path. */
function ownerOf(id) {
  if (id.startsWith('\0')) return null;
  const path = id.split('?')[0];
  const nm = path.lastIndexOf(`node_modules${sep}`);
  if (nm >= 0) {
    const parts = path.slice(nm + 'node_modules'.length + 1).split(sep);
    return parts[0].startsWith('@') ? `${parts[0]}/${parts[1]}` : parts[0];
  }
  for (const [dir, name] of folderOf) if (path.startsWith(dir + sep)) return name;
  if (path.startsWith(join(root, 'packages', 'shared') + sep)) return '(packages/shared)';
  return `(outside the packages) ${relative(root, path)}`;
}

/**
 * Rolldown output for `source` as the entry module, generated with `options`. `planted` maps extra module ids to their
 * text (the self-checks below plant faulty packages).
 */
async function bundle(source, options = {}, planted = {}) {
  const build = await rolldown({
    input: 'entry',
    cwd: root,
    logLevel: 'silent',
    plugins: [
      {
        name: 'entry',
        resolveId: (id) => (id === 'entry' ? '\0entry.js' : Object.hasOwn(planted, id) ? `\0planted:${id}` : null),
        load: (id) =>
          id === '\0entry.js' ? source : id.startsWith('\0planted:') ? planted[id.slice('\0planted:'.length)] : null,
      },
    ],
  });
  try {
    return (await build.generate({ format: 'es', ...options })).output.filter((item) => item.type === 'chunk');
  } finally {
    await build.close();
  }
}

/**
 * The bindings a preserved module imports, as sorted "source name" pairs: the bundler orders a module's hoisted imports
 * by discovery and numbers clashing local aliases (i$1, i$2) by it, so only the source and imported name are compared.
 */
function importedBindings(code) {
  const bindings = [];
  for (const [, names, source] of code.matchAll(/^import \{([^}]*)\} from "([^"]+)";$/gm))
    for (const item of names.split(',').map((n) => n.trim()).filter(Boolean))
      bindings.push(`${source} ${item.split(/\s+as\s+/)[0]}`);
  for (const [, source] of code.matchAll(/^import "([^"]+)";$/gm)) bindings.push(`${source} (side effect)`);
  return bindings.sort();
}

/** Runs one ES module text in a fresh Node process; resolves its standard output. */
function run(code, name) {
  mkdirSync(join(root, 'test-results'), { recursive: true });
  const dir = mkdtempSync(join(root, 'test-results', `packaging-${name}-`));
  try {
    writeFileSync(join(dir, 'entry.mjs'), code);
    return execFileSync(process.execPath, [join(dir, 'entry.mjs')], { cwd: dir, encoding: 'utf8', timeout: 60_000 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// The probe imports the packages in the given order and prints, sorted, what each exports (its kind, a primitive's value,
// an object's or class's own keys) and what globals importing added. Imports run before the probe's own code, so the
// globals before them are read by a first planted module. Equal state prints equal bytes whatever the order.
const BEFORE = { 'margo-probe-before': 'export const before = new Set(Reflect.ownKeys(globalThis).map(String));' };
const probe = (order) => `
import { before } from 'margo-probe-before';
const loaded = [];
${order.map((s, i) => `import * as m${i} from '${s}';\nloaded.push(['${s}', m${i}]);`).join('\n')}
const describe = (v) => (v !== null && (typeof v === 'object' || typeof v === 'function') ? Reflect.ownKeys(v).map(String).sort().join(',') : String(v));
const shape = (ns) => Object.keys(ns).sort().map((k) => k + ':' + typeof ns[k] + ':' + describe(ns[k]));
const exports = Object.fromEntries(loaded.map(([s, ns]) => [s, shape(ns)]).sort(([a], [b]) => (a < b ? -1 : 1)));
const globals = Reflect.ownKeys(globalThis).map(String).filter((k) => !before.has(k)).sort();
process.stdout.write(JSON.stringify({ exports, globals }));
`;

/** What differs when `packages` are bundled and run in their order and reversed; empty when nothing does. */
async function orderProblems(packages, planted = {}) {
  const results = [];
  for (const order of [packages, [...packages].reverse()]) {
    const source = probe(order),
      modules = await bundle(source, { preserveModules: true }, { ...BEFORE, ...planted }),
      files = Object.fromEntries(
        modules.filter((m) => !m.isEntry && !m.fileName.includes('planted')).map((m) => [m.fileName, m.code]),
      ),
      [single] = await bundle(source, { codeSplitting: false }, { ...BEFORE, ...planted });
    results.push({ files, output: run(single.code, 'order') });
  }
  const [a, b] = results,
    problems = [];
  const names = Object.keys(a.files).sort();
  if (JSON.stringify(Object.keys(b.files).sort()) !== JSON.stringify(names)) problems.push('different modules');
  for (const name of names)
    if (b.files[name] && JSON.stringify(importedBindings(b.files[name])) !== JSON.stringify(importedBindings(a.files[name])))
      problems.push(`${name}: different imported bindings`);
  if (b.output !== a.output) problems.push(`different output: ${a.output} | ${b.output}`);
  // packages/shared keeps state that every bundled copy of it must share under Symbol.for('margoengine.<name>') keys on
  // globalThis (frame-resources.js, mesh-source.js); any other global is a leak.
  const globals = JSON.parse(a.output).globals.filter((key) => !/^Symbol\(margoengine\.[\w.-]+\)$/.test(key));
  if (globals.length) problems.push(`globals added: ${globals.join(', ')}`);
  return problems;
}

test('every contract group names real public packages, and each group has two or more', () => {
  const grouped = CONTRACT_GROUPS.flatMap((g) => g.packages);
  assert.equal(new Set(grouped).size, grouped.length, 'a package in two groups');
  for (const name of [...grouped, ...Object.keys(LEFT_OUT)]) assert.ok(manifests.has(name), `${name} is no package`);
  for (const group of CONTRACT_GROUPS) assert.ok(group.packages.length >= 2, `${group.name}: a group needs two packages`);
});

test('the order check catches packages whose state depends on import order or that add a global', async () => {
  const planted = {
    'planted-a': "globalThis.__margoFirst ??= 'a';\nexport const first = globalThis.__margoFirst;\n",
    'planted-b': "globalThis.__margoFirst ??= 'b';\nexport const first = globalThis.__margoFirst;\n",
  };
  const problems = await orderProblems(['planted-a', 'planted-b'], planted);
  assert.ok(problems.some((p) => p.startsWith('different output')), problems.join('\n'));
  assert.ok(problems.includes('globals added: __margoFirst'), problems.join('\n'));
  const clean = { 'planted-a': 'export const a = 1;\n', 'planted-b': "export const b = 'two';\n" };
  assert.deepEqual(await orderProblems(['planted-a', 'planted-b'], clean), []);
});

for (const group of CONTRACT_GROUPS)
  test(`the ${group.name} group builds and runs the same with its packages imported in either order`, async () => {
    assert.deepEqual(await orderProblems(group.packages), []);
  });

/**
 * What a package may pull into a bundle: itself, core, its dependencies and required peers, transitively, and the
 * third-party framework peers it declares optional (react and react-dom: optional so that `npm i margoengine` does not
 * install React for apps that never import the React bindings). An optional Margo peer must stay behind import().
 */
function allowed(name) {
  const seen = new Set(['@margoengine/core', '(packages/shared)']),
    visit = (n) => {
      if (seen.has(n)) return;
      seen.add(n);
      const manifest = manifests.get(n) ?? readThirdParty(n);
      if (!manifest) return;
      const optional = manifest.peerDependenciesMeta ?? {};
      for (const dep of Object.keys(manifest.dependencies ?? {})) visit(dep);
      for (const dep of Object.keys(manifest.peerDependencies ?? {}))
        if (!optional[dep]?.optional || !(dep === 'margoengine' || dep.startsWith('@margoengine/'))) visit(dep);
    };
  visit(name);
  return seen;
}
function readThirdParty(name) {
  const file = join(root, 'node_modules', name, 'package.json');
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
}

/** What a bundle of core plus `name` (and `extra` source lines) statically reaches that `name`'s manifest does not allow. */
async function reachProblems(name, extra = '') {
  const chunks = await bundle(`import * as core from '@margoengine/core';
export * as pkg from '${name}';
export { core };
${extra}`),
    byName = new Map(chunks.map((c) => [c.fileName, c])),
    reached = new Set(),
    visit = (file) => {
      if (reached.has(file) || !byName.has(file)) return;
      reached.add(file);
      for (const next of byName.get(file).imports) visit(next); // static imports only: a lazy import() may reach more
    };
  visit(chunks.find((c) => c.isEntry).fileName);
  const ok = allowed(name),
    owners = new Set([...reached].flatMap((f) => byName.get(f).moduleIds.map(ownerOf)).filter(Boolean));
  return [...owners].filter((owner) => !ok.has(owner)).map((owner) => `${name} pulls in ${owner}`);
}

test('the reach check catches a package that statically pulls in one its manifest does not name', async () => {
  assert.deepEqual(await reachProblems('@margoengine/tween'), []);
  assert.deepEqual(await reachProblems('@margoengine/tween', "export * as sky from '@margoengine/sky';"), [
    '@margoengine/tween pulls in @margoengine/sky',
  ]);
});

test('a bundle of core plus one package holds only that package, core and what its manifest needs', async () => {
  const problems = [];
  for (const [name, manifest] of manifests) {
    if (manifest.private || name === 'margoengine' || LEFT_OUT[name] || !manifest.exports?.['.']) continue;
    problems.push(...(await reachProblems(name)));
  }
  assert.deepEqual(problems, [], 'a package bundle reached a package its manifest does not depend on');
});

test('core reached by two paths plus the umbrella is one core with one Engine class', async () => {
  const source = `
import { Engine as root } from '@margoengine/core';
import { Engine as extension } from '@margoengine/core/extension';
import { Engine as stage } from '@margoengine/stage';
import { Engine as umbrella } from 'margoengine';
import { Engine as umbrellaCore } from 'margoengine/core';
const all = { root, extension, stage, umbrella, umbrellaCore };
process.stdout.write(JSON.stringify(Object.fromEntries(Object.entries(all).map(([k, v]) => [k, v === root]))));
`;
  const [single] = await bundle(source, { codeSplitting: false });
  const copies = single.moduleIds.filter((id) => ownerOf(id) === '@margoengine/core').map((id) => relative(root, id));
  assert.equal(new Set(copies).size, copies.length, 'a core module bundled twice');
  assert.ok(copies.some((id) => id.endsWith(join('dist', 'engine.js'))), 'the bundle holds core');
  const want = JSON.stringify({ root: true, extension: true, stage: true, umbrella: true, umbrellaCore: true });
  assert.equal(run(single.code, 'engine'), want, 'bundled: every path gives the same Engine class');
  // Unbundled, as Node resolves the same imports: still one class.
  const dir = mkdtempSync(join(root, 'test-results', 'packaging-node-'));
  try {
    writeFileSync(join(dir, 'entry.mjs'), source);
    assert.equal(
      execFileSync(process.execPath, [join(dir, 'entry.mjs')], { cwd: dir, encoding: 'utf8', timeout: 60_000 }),
      want,
      'Node: every path gives the same Engine class',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
