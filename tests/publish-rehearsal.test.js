// scripts/publish-rehearsal.mjs: the tarball audit finds what must not ship, and its stand-in registry can serve an
// install but can never take a publish.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { gzipSync } from 'node:zlib';
import {
  auditTarball,
  exportTargets,
  importsOf,
  packageOf,
  packument,
  rangeAccepts,
  readTarball,
  startRegistry,
} from '../scripts/publish-rehearsal.mjs';

const root = join(import.meta.dirname, '..');

/** One ustar entry, then padding, the way npm writes them. */
function entry(path, text) {
  const body = Buffer.from(text),
    header = Buffer.alloc(512);
  header.write(path, 0, 'latin1');
  header.write(`${body.length.toString(8).padStart(11, '0')}\0`, 124, 'latin1');
  header.write('0', 156, 'latin1');
  header.write('ustar\0', 257, 'latin1');
  return Buffer.concat([header, body, Buffer.alloc((512 - (body.length % 512)) % 512)]);
}

const tarball = (files) =>
  gzipSync(
    Buffer.concat([
      ...Object.entries(files).map(([path, text]) => entry(`package/${path}`, text)),
      Buffer.alloc(1024),
    ]),
  );

const good = (extra = {}, files = {}) =>
  new Map(
    Object.entries({
      'package.json': JSON.stringify({
        name: '@margoengine/x',
        version: '1.0.0',
        exports: { '.': { types: './dist/index.d.ts', import: './dist/index.js' } },
        dependencies: { '@margoengine/y': '^1.0.0' },
        ...extra,
      }),
      LICENSE: 'l',
      NOTICE: 'n',
      'README.md': 'r',
      'dist/index.js': "import './own.js'; import fs from 'node:fs'; export * from '@margoengine/y';",
      'dist/index.d.ts': 'export {};',
      ...files,
    }).map(([path, text]) => [path, Buffer.from(text)]),
  );

const names = { '@margoengine/x': '1.0.0', '@margoengine/y': '1.0.0' };

test('readTarball reads every file of a tarball, without the package/ folder', () => {
  const files = readTarball(tarball({ 'package.json': '{}', 'dist/a.js': 'x'.repeat(700) }));
  assert.deepEqual([...files.keys()], ['package.json', 'dist/a.js']);
  assert.equal(files.get('dist/a.js').length, 700);
});

test('a complete package has no problems', () => {
  assert.deepEqual(auditTarball(good(), names), []);
});

test('the audit reports each thing that must not be published', () => {
  const cases = [
    [good({ private: true }), /"private": true/],
    [good({ version: '0.9.0' }), /not the release version/],
    [good({ scripts: { postinstall: 'node x' } }), /install script "postinstall"/],
    [good({ dependencies: { '@margoengine/y': 'workspace:*' } }), /local spec workspace:\*/],
    [good({ dependencies: { '@margoengine/y': 'file:../y' } }), /local spec file:/],
    [good({ dependencies: { '@margoengine/y': '^2.0.0' } }), /does not accept 1.0.0/],
    [good({ dependencies: { '@margoengine/gone': '^1.0.0' } }), /not in this release/],
    [good({ exports: { './a': { import: './dist/a.js' } } }), /dist\/a.js is named by the manifest/],
    [good({ bin: { x: 'cli.js' } }), /cli.js is named by the manifest/],
    [good({}, { 'tests/a.test.js': '' }), /ships tests\/a.test.js/],
    [good({}, { 'dist/a.test.js': '' }), /ships dist\/a.test.js/],
    [good({}, { '.npmrc': 'token' }), /ships .npmrc/],
    [good({}, { 'dist/b.js': "import('three')" }), /imports three, which the manifest does not declare/],
  ];
  for (const [files, pattern] of cases)
    assert.ok(
      auditTarball(files, names).some((p) => pattern.test(p)),
      String(pattern),
    );
  const noNotice = good();
  noNotice.delete('NOTICE');
  assert.match(auditTarball(noNotice, names).join(), /NOTICE is not in the tarball/);
  assert.match(auditTarball(good({}, { 'dist/c.js': 'const p = "/secret/home";' }), names, ['/secret/home']).join(), /maintainer path/);
});

test('a template folder imports for the new app, not for the package that ships it', () => {
  assert.deepEqual(auditTarball(good({}, { 'templates/web/main.js': "import 'margoengine';" }), names), []);
});

test('importsOf reads static, re-export and dynamic imports, and not text that only looks like one', () => {
  const code = `
    import a from 'a'; import {b} from "b"; export * from 'c'; import 'd'; const e = await import('e');
    // import z from 'comment';
    const text = "import x from ',result.status==,'";
  `;
  assert.deepEqual(importsOf(code).sort(), ['a', 'b', 'c', 'd', 'e']);
});

test('packageOf names the package of a bare import and nothing else', () => {
  assert.equal(packageOf('@margoengine/core/extension'), '@margoengine/core');
  assert.equal(packageOf('sharp/lib'), 'sharp');
  for (const local of ['./a.js', '../b.js', '/c.js', 'node:fs', 'fs', 'https://example.com/a.js'])
    assert.equal(packageOf(local), undefined, local);
});

test('exportTargets walks nested conditions', () => {
  assert.deepEqual(exportTargets({ '.': { node: { import: './a.js' }, default: './b.js' }, './c': null }), [
    './a.js',
    './b.js',
  ]);
});

test('rangeAccepts follows caret ranges', () => {
  assert.ok(rangeAccepts('^1.0.0', '1.2.0'));
  assert.ok(rangeAccepts('1.0.0', '1.0.0'));
  assert.ok(!rangeAccepts('^1.2.0', '1.1.9'));
  assert.ok(!rangeAccepts('^1.0.0', '2.0.0'));
  assert.ok(!rangeAccepts('~1.0.0', '1.0.0'));
});

test('the stand-in registry serves our packages, refuses every write and never asks upstream for ours', async () => {
  const bytes = Buffer.from('tarball'),
    manifest = { name: '@margoengine/x', version: '1.0.0' };
  const registry = await startRegistry(
    new Map([['@margoengine/x', { manifest, bytes }]]),
    'http://127.0.0.1:9', // discard port: any relay to upstream fails
  );
  try {
    const document = await (await fetch(`${registry.url}@margoengine%2fx`)).json();
    assert.equal(document['dist-tags'].latest, '1.0.0');
    const { dist } = document.versions['1.0.0'];
    assert.deepEqual(dist, packument(manifest, dist.tarball, bytes).versions['1.0.0'].dist);
    assert.deepEqual(Buffer.from(await (await fetch(dist.tarball)).arrayBuffer()), bytes);
    assert.equal((await fetch(`${registry.url}margoengine`)).status, 404);
    const write = await fetch(`${registry.url}@margoengine%2fx`, { method: 'PUT', body: '{}' });
    assert.equal(write.status, 405);
    assert.deepEqual(registry.refused, ['PUT /@margoengine%2fx']);
  } finally {
    registry.close();
  }
});

test('the rehearsal never runs a publishing command', () => {
  const source = readFileSync(join(root, 'scripts/publish-rehearsal.mjs'), 'utf8');
  assert.doesNotMatch(source, /['"](publish|unpublish|adduser|login|token|dist-tag|owner|access)['"]/);
});
