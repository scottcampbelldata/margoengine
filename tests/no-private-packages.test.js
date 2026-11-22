// Scott, 2026-11-13: "there should be no private packages at all now". Everything the kernel repository held came back
// into this repository as public Apache-2.0 packages (brep, cad, machinery, robot-planning, ifc). No package manifest is
// private or unlicensed, no tracked file names that repository's npm scope, and each package that came back imports
// only node built-ins, its own entries and the public engine packages it declares. The scope is written in base64
// here, so this file does not name it either.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import test from 'node:test';

const root = resolve(import.meta.dirname, '..');
const scope = Buffer.from('QG1hcmdvLWVudGVycHJpc2U=', 'base64').toString('utf8');
/** The packages that came back from the kernel repository. */
const RETURNED = ['brep', 'cad', 'machinery', 'robot-planning', 'ifc'];
/** Reviewed third-party peers a returned package may declare (each has its row in scripts/supply-chain.mjs). */
const THIRD_PARTY = new Set(['react', 'web-ifc']);

/** Every file under `dir`, recursively. */
const files = (dir) =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : [path];
  });

/** The bare module specifiers a source imports (static, dynamic and type-only); relative ones are left out. */
function bareImports(source) {
  const found = new Set();
  for (const [, spec] of source.matchAll(/(?:[\s}]from\s*|\bimport\s*\(\s*|^\s*import\s+)['"]([^'"\s]+)['"]/gm))
    if (!spec.startsWith('.')) found.add(spec);
  return [...found];
}

const manifests = readdirSync(join(root, 'packages')).flatMap((dir) => {
  try {
    return [{ dir, manifest: JSON.parse(readFileSync(join(root, 'packages', dir, 'package.json'), 'utf8')) }];
  } catch {
    return [];
  }
});
const publicPackages = new Set(
  manifests.filter(({ manifest }) => !manifest.private).map(({ manifest }) => manifest.name),
);
const packageOf = (spec) => (spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]);

test('the import detector finds static, dynamic and type-only bare imports', () => {
  assert.deepEqual(
    bareImports("import a from './a.js';\nimport type { B } from '@margoengine/b';\nconst c = import('d/e');"),
    ['@margoengine/b', 'd/e'],
  );
});

test('no package is private or unlicensed, and every package is in the @margoengine scope or is the umbrella', () => {
  for (const { dir, manifest } of manifests) {
    assert.equal(manifest.private, undefined, `packages/${dir} is private`);
    assert.notEqual(manifest.license, 'UNLICENSED', `packages/${dir} is unlicensed`);
    assert.ok(manifest.name === 'margoengine' || manifest.name.startsWith('@margoengine/'), manifest.name);
  }
});

test('no tracked file names the kernel repository npm scope', () => {
  // git grep exits 1 when nothing matches.
  const run = spawnSync('git', ['grep', '-I', '-i', '-l', '-F', scope], {
    cwd: root,
    encoding: 'utf8',
    timeout: 60_000,
  });
  assert.equal(run.stdout.trim(), '');
  assert.equal(run.status, 1, run.stderr);
});

for (const pkg of RETURNED) {
  const dir = join(root, 'packages', pkg),
    manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));

  test(`@margoengine/${pkg} is a public Apache-2.0 package that depends only on public engine packages`, () => {
    assert.equal(manifest.name, `@margoengine/${pkg}`);
    assert.equal(manifest.license, 'Apache-2.0');
    assert.ok(manifest.files.includes('NOTICE'));
    for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies', 'devDependencies'])
      for (const name of Object.keys(manifest[field] ?? {}))
        assert.ok(
          publicPackages.has(name) || THIRD_PARTY.has(name),
          `${pkg} ${field}: ${name} is not a public package of this repository`,
        );
  });

  test(`@margoengine/${pkg} sources import only node built-ins and the packages it declares`, () => {
    // A package's own name is declared by definition: the build keeps it an import, so one entry can load another.
    const declared = new Set([
      manifest.name,
      ...Object.keys({ ...manifest.dependencies, ...manifest.peerDependencies }),
    ]);
    for (const file of files(join(dir, 'src')).filter((f) => /\.(ts|tsx|js|mjs)$/.test(f)))
      for (const spec of bareImports(readFileSync(file, 'utf8'))) {
        if (spec.startsWith('node:')) continue;
        const name = packageOf(spec);
        assert.ok(declared.has(name), `${file}: imports ${spec}, which ${pkg} does not declare`);
      }
  });
}
