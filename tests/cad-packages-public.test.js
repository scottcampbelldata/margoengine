// @margoengine/brep and @margoengine/cad came back from the kernel repository (2026-11-13) while the packages built on
// them there stay out of this repository. Neither may import, depend on or mention those packages or their npm scope:
// every bare import in their sources names a public @margoengine package of this repository that they declare, and
// their sources, READMEs and manifests never name the others. The names are written in base64 here, as
// tests/banned-terms.test.js writes its terms.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import test from 'node:test';

const root = resolve(import.meta.dirname, '..');
const b64 = (text) => Buffer.from(text, 'base64').toString('utf8');
/** The npm scope of the packages that stay out, and their names. */
const scope = b64('QG1hcmdvLWVudGVycHJpc2U='),
  names = ['bWFjaGluZXJ5', 'aWZj', 'cm9ib3QtcGxhbm5pbmc=', 'c3VpdGU='].map(b64);
const PACKAGES = ['brep', 'cad'];

/** Every file under `dir`, recursively. */
const files = (dir) =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : [path];
  });

/** What a text says about the packages that stay out: each hit as `line: name`. */
function outsideMentions(text) {
  const hits = [];
  text.split('\n').forEach((line, i) => {
    if (line.toLowerCase().includes(scope)) hits.push(`${i + 1}: ${scope}`);
    for (const name of names)
      if (new RegExp(`(^|[^a-z0-9])${name}($|[^a-z0-9])`, 'i').test(line)) hits.push(`${i + 1}: ${name}`);
  });
  return hits;
}

/** The bare module specifiers a source imports (static, dynamic and type-only); relative ones are left out. */
function bareImports(source) {
  const found = new Set();
  for (const [, spec] of source.matchAll(/(?:[\s}]from\s*|\bimport\s*\(\s*|^\s*import\s+)['"]([^'"\s]+)['"]/gm))
    if (!spec.startsWith('.')) found.add(spec);
  return [...found];
}

const publicPackages = new Set(
  readdirSync(join(root, 'packages')).flatMap((dir) => {
    try {
      const manifest = JSON.parse(readFileSync(join(root, 'packages', dir, 'package.json'), 'utf8'));
      return manifest.private ? [] : [manifest.name];
    } catch {
      return [];
    }
  }),
);
const packageOf = (spec) => (spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]);

test('the detectors find every name that must stay out, and only as a name', () => {
  for (const name of [scope, ...names]) {
    assert.notDeepEqual(outsideMentions(`import x from '${name}/x';`), [], name);
    assert.notDeepEqual(outsideMentions(`see the ${name.toUpperCase()} package`), [], name);
  }
  assert.deepEqual(outsideMentions('a pursuit of difficult shapes'), []);
  assert.deepEqual(
    bareImports("import a from './a.js';\nimport type { B } from '@margoengine/b';\nconst c = import('d/e');"),
    ['@margoengine/b', 'd/e'],
  );
});

for (const pkg of PACKAGES) {
  const dir = join(root, 'packages', pkg),
    manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));

  test(`@margoengine/${pkg} is a public Apache-2.0 package that depends only on public engine packages`, () => {
    assert.equal(manifest.name, `@margoengine/${pkg}`);
    assert.equal(manifest.license, 'Apache-2.0');
    assert.equal(manifest.private, undefined);
    for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies', 'devDependencies'])
      for (const name of Object.keys(manifest[field] ?? {}))
        assert.ok(publicPackages.has(name), `${pkg} ${field}: ${name} is not a public package of this repository`);
  });

  test(`@margoengine/${pkg} ships a NOTICE that starts with the root NOTICE and carries the Siemens JT notice`, () => {
    const read = (path) => readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
    const notice = read(join(dir, 'NOTICE'));
    assert.ok(notice.startsWith(read(join(root, 'NOTICE'))));
    assert.match(notice.replace(/\s+/g, ' '), /Siemens JT Data Format Reference Patent Clarification Notice/);
    assert.ok(manifest.files.includes('NOTICE'));
  });

  test(`@margoengine/${pkg} sources import only node built-ins and public engine packages it declares`, () => {
    const declared = new Set(Object.keys({ ...manifest.dependencies, ...manifest.peerDependencies }));
    for (const file of files(join(dir, 'src')).filter((f) => /\.(ts|tsx|js|mjs)$/.test(f)))
      for (const spec of bareImports(readFileSync(file, 'utf8'))) {
        if (spec.startsWith('node:')) continue;
        const name = packageOf(spec);
        assert.ok(publicPackages.has(name) && declared.has(name), `${file}: imports ${spec}`);
      }
  });

  test(`@margoengine/${pkg} sources, README and manifest never name the packages that stay out`, () => {
    for (const file of [...files(join(dir, 'src')), join(dir, 'README.md'), join(dir, 'package.json')])
      assert.deepEqual(outsideMentions(readFileSync(file, 'utf8')), [], file);
  });
}
