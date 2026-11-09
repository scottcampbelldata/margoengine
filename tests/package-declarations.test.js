import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { OPTIONAL_PEER_GUARD, guardOptionalPeers, packageDeclarations } from '../scripts/package-declarations.js';

const compiler = resolve(import.meta.dirname, '../node_modules/typescript/bin/tsc');

async function fixture(t, files) {
  const repository = await mkdtemp(join(tmpdir(), 'margo-declarations-'));
  t.after(() => rm(repository, { recursive: true, force: true }));
  for (const [name, text] of Object.entries(files)) {
    const file = join(repository, name);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, text);
  }
  return { repository, root: join(repository, 'packages/sample') };
}

test('published declarations retain one shared type identity and their transitive declarations after checkout files disappear', async (t) => {
  const { repository, root } = await fixture(t, {
    'package.json': '{"type":"module"}',
    'packages/sample/dist/index.d.ts':
      "export type { Source } from '../../shared/source.js';\nexport type { Alias } from './nested/other.js';\n",
    'packages/sample/dist/nested/other.d.ts':
      "import type { Source } from '../../../shared/source.js';\nexport type Alias = Source;\n",
    'packages/shared/source.d.ts':
      "/// <reference path='./ambient.d.ts' />\nimport './side-effect.js';\nexport declare const identity: unique symbol;\nexport interface Source { readonly [identity]: true; payload: import('./nested/payload.js').Payload }\n",
    'packages/shared/nested/payload.d.ts':
      "import type { Source } from '../source.js';\nexport interface Payload { parent?: Source; value: string }\n",
    'packages/shared/ambient.d.ts': 'declare const declarationMarker: string;\n',
    'packages/shared/side-effect.d.ts': 'export {};\ndeclare global { const sharedMarker: number; }\n',
    'consumer.ts':
      "import type { Source, Alias } from './packages/sample/dist/index.js';\ndeclare const source: Source;\nconst alias: Alias = source;\nconst marker: string = declarationMarker;\nconst shared: number = sharedMarker;\nvoid [alias, marker, shared];\n",
  });
  await packageDeclarations(root);
  await packageDeclarations(root);
  assert.match(await readFile(join(root, 'dist/index.d.ts'), 'utf8'), /from '\.\/shared\/source\.js'/);
  assert.match(await readFile(join(root, 'dist/nested/other.d.ts'), 'utf8'), /from '\.\.\/shared\/source\.js'/);
  assert.match(await readFile(join(root, 'dist/shared/nested/payload.d.ts'), 'utf8'), /from '\.\.\/source\.js'/);
  await rm(join(repository, 'packages/shared'), { recursive: true });
  execFileSync(
    process.execPath,
    [compiler, '--noEmit', '--strict', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', 'consumer.ts'],
    { cwd: repository, stdio: 'pipe' },
  );
});

test('declaration packaging rejects relative dependencies outside shared instead of silently shipping broken imports', async (t) => {
  const { root } = await fixture(t, {
    'packages/sample/dist/index.d.ts': "export type { Secret } from '../../other/src/secret.js';\n",
    'packages/other/src/secret.d.ts': 'export interface Secret { value: string }\n',
  });
  await assert.rejects(packageDeclarations(root), /Declaration dependency escapes.*other/);
});

test('shared triple-slash paths without a dot prefix are copied with their declarations', async (t) => {
  const { root } = await fixture(t, {
    'packages/sample/dist/index.d.ts': "export type { Source } from '../../shared/source.js';\n",
    'packages/shared/source.d.ts': "/// <reference path='ambient.d.ts' />\nexport interface Source { value: string }\n",
    'packages/shared/ambient.d.ts': 'declare const barePathMarker: string;\n',
  });
  await packageDeclarations(root);
  assert.match(await readFile(join(root, 'dist/shared/ambient.d.ts'), 'utf8'), /barePathMarker/);
  assert.match(await readFile(join(root, 'dist/shared/source.d.ts'), 'utf8'), /path='\.\/ambient\.d\.ts'/);
});

test('declaration packaging leaves documentation and literal types containing import-like text unchanged', async (t) => {
  const text = [
    "/** An example: import('./missing-doc.js').Type; export { Type } from './missing-export.js'; */",
    "// from './missing-comment.js'",
    'export type Explanation = "import(\'./missing-literal.js\')";',
    'export type ReferenceExample = "/// <reference path=\'./missing-reference.d.ts\' />";',
    '',
  ].join('\n');
  const { root } = await fixture(t, { 'packages/sample/dist/index.d.ts': text });
  await packageDeclarations(root);
  assert.equal(await readFile(join(root, 'dist/index.d.ts'), 'utf8'), text);
});

// A strict consumer (skipLibCheck: false) of a package whose declarations import an optional engine peer got TS2307
// for every peer it had not installed (@margoengine/react alone: 41 errors, 2026-10-27).
const peerFixture = {
  'packages/sample/package.json': JSON.stringify({
    name: '@margoengine/sample',
    dependencies: { '@margoengine/math': '^1.0.0' },
    peerDependencies: { '@margoengine/peer': '^1.0.0', react: '^19.0.0' },
    peerDependenciesMeta: { '@margoengine/peer': { optional: true }, react: { optional: true } },
  }),
  'packages/sample/dist/index.d.ts': [
    "import type { PeerOptions } from '@margoengine/peer/options';",
    'export interface SampleProps extends PeerOptions { label?: string }',
    'export type {',
    '  PeerOptions,',
    "} from '@margoengine/peer/options';",
    '',
  ].join('\n'),
  'consumer.ts': [
    "import type { SampleProps } from './packages/sample/dist/index.js';",
    "export const props: SampleProps = { label: 'cube' };",
    '',
  ].join('\n'),
};
// The strict compiler's diagnostics ('' when the consumer type-checks).
const strict = (cwd) =>
  spawnSync(
    process.execPath,
    [compiler, '--noEmit', '--strict', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', 'consumer.ts'],
    { cwd, encoding: 'utf8' },
  ).stdout.trim();

test('declarations importing an optional engine peer type-check strictly without it and use its types with it', async (t) => {
  const { repository, root } = await fixture(t, peerFixture);
  assert.match(strict(repository), /TS2307: Cannot find module '@margoengine\/peer\/options'/);
  await packageDeclarations(root);
  await packageDeclarations(root);
  const text = await readFile(join(root, 'dist/index.d.ts'), 'utf8');
  // Both the import and the multi-line re-export are guarded at the line of their module name, once.
  assert.equal(text.split(OPTIONAL_PEER_GUARD).length - 1, 2);
  assert.match(text, new RegExp(`${OPTIONAL_PEER_GUARD}\\n\\} from '@margoengine/peer/options'`));
  assert.equal(strict(repository), '');
  // Installed, the peer's own types apply: a wrong option is an error again.
  await mkdir(join(repository, 'node_modules/@margoengine/peer'), { recursive: true });
  await writeFile(
    join(repository, 'node_modules/@margoengine/peer/package.json'),
    JSON.stringify({ name: '@margoengine/peer', exports: { './options': { types: './options.d.ts' } } }),
  );
  await writeFile(
    join(repository, 'node_modules/@margoengine/peer/options.d.ts'),
    'export interface PeerOptions { strength?: number }\n',
  );
  const consumer = (strength) =>
    writeFile(
      join(repository, 'consumer.ts'),
      `import type { SampleProps } from './packages/sample/dist/index.js';\nexport const props: SampleProps = { strength: ${strength} };\n`,
    );
  await consumer('2');
  assert.equal(strict(repository), '');
  await consumer("'high'");
  assert.match(strict(repository), /TS2322/);
});

test('declaration packaging rejects types from an undeclared package and inline import() of an optional peer', async (t) => {
  const undeclared = await fixture(t, {
    ...peerFixture,
    'packages/sample/dist/index.d.ts': "export type { Backend } from '@margoengine/missing/mat4';\n",
  });
  await assert.rejects(
    packageDeclarations(undeclared.root),
    /imports types from @margoengine\/missing\/mat4, but @margoengine\/sample does not declare/,
  );
  const inline = await fixture(t, {
    ...peerFixture,
    'packages/sample/dist/index.d.ts': "export type PeerApi = typeof import('@margoengine/peer');\n",
  });
  await assert.rejects(packageDeclarations(inline.root), /inline import\(\) type/);
  // Declared dependencies, the package itself and third-party optional peers (react) are left as they are.
  const text =
    "import type { Backend } from '@margoengine/math/mat4';\nimport type { ReactNode } from 'react';\nexport type Node = ReactNode | import('react').JSX.Element | Backend;\n";
  assert.equal(guardOptionalPeers('index.d.ts', text, JSON.parse(peerFixture['packages/sample/package.json'])), text);
});

// `npm pack` runs each package's own prepack build, not build:packages, so that build must package declarations too
// (environment once shipped dist/capture.d.ts importing ../../shared/msaa.js).
const repository = resolve(import.meta.dirname, '..');
const packages = (await readdir(join(repository, 'packages'), { withFileTypes: true }))
  .filter((entry) => entry.isDirectory() && entry.name !== 'shared')
  .map((entry) => entry.name);

test('every package build that npm pack runs copies shared declarations into dist', async () => {
  const missing = [];
  for (const name of packages) {
    let manifest;
    try {
      manifest = JSON.parse(await readFile(join(repository, 'packages', name, 'package.json'), 'utf8'));
    } catch {
      continue;
    }
    const prepack = manifest.scripts?.prepack ?? '';
    // build:packages runs packageDeclarations after every package (scripts/build-modern.js).
    if (prepack.includes('build:packages')) continue;
    assert.equal(prepack, 'npm run build', `${name} prepack`);
    const script = /^node (\S+\.js)/.exec(manifest.scripts.build)?.[1];
    assert.ok(script, `${name} build runs a node script`);
    const text = await readFile(resolve(repository, 'packages', name, script), 'utf8');
    if (!/\bpackageDeclarations\(/.test(text)) missing.push(`${name} (${script})`);
  }
  assert.deepEqual(missing, []);
});

test('built declarations import nothing outside their package', async () => {
  const escapes = [];
  for (const name of packages) {
    const root = join(repository, 'packages', name),
      dist = join(root, 'dist');
    let files;
    try {
      files = await readdir(dist, { recursive: true });
    } catch {
      continue;
    }
    for (const file of files.filter((f) => /\.d\.[mc]?ts$/.test(f))) {
      const path = join(dist, file);
      for (const [, specifier] of (await readFile(path, 'utf8')).matchAll(/(?:from|import\()\s*['"](\.[^'"]+)['"]/g))
        if (!resolve(dirname(path), specifier).startsWith(root + sep))
          escapes.push(`${name}/dist/${file}: ${specifier}`);
    }
  }
  assert.deepEqual(escapes, []);
});

test('built declarations name only declared packages and guard every optional engine peer', async () => {
  const unguarded = [];
  for (const name of packages) {
    const root = join(repository, 'packages', name),
      dist = join(root, 'dist');
    let files, manifest;
    try {
      manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
      files = await readdir(dist, { recursive: true });
    } catch {
      continue;
    }
    for (const file of files.filter((f) => /\.d\.[mc]?ts$/.test(f))) {
      const path = join(dist, file),
        text = await readFile(path, 'utf8');
      if (guardOptionalPeers(path, text, manifest) !== text) unguarded.push(`${name}/dist/${file}`);
    }
  }
  assert.deepEqual(unguarded, []);
});

test('typed binding parameters remain strict with an optional peer installed or absent', async (t) => {
  const { repository, root } = await fixture(t, {
    ...peerFixture,
    'packages/sample/dist/index.d.ts': [
      "import type { PeerOptions } from '@margoengine/peer/options';",
      'export interface SampleProps extends PeerOptions { label?: string }',
      'export declare function sample({ strength, label }: SampleProps, _arg0: number): void;',
      'export declare const callback: ({ strength }: SampleProps) => void;',
      'export declare function tuple([value]: readonly [PeerOptions]): void;',
      '',
    ].join('\n'),
    'consumer.ts': [
      "import {sample,callback,tuple} from './packages/sample/dist/index.js';",
      "sample({label: 'cube'}, 0); callback({label: 'cube'}); tuple([{}]);",
    ].join('\n'),
  });
  await packageDeclarations(root);
  const packaged = await readFile(join(root, 'dist/index.d.ts'), 'utf8');
  await packageDeclarations(root);
  assert.equal(await readFile(join(root, 'dist/index.d.ts'), 'utf8'), packaged, 'packaging is idempotent');
  assert.equal(strict(repository), '', 'absent optional types do not make binding names library errors');
  await mkdir(join(repository, 'node_modules/@margoengine/peer'), { recursive: true });
  await writeFile(
    join(repository, 'node_modules/@margoengine/peer/package.json'),
    JSON.stringify({
      name: '@margoengine/peer',
      exports: { './options': { types: './options.d.ts' } },
    }),
  );
  await writeFile(
    join(repository, 'node_modules/@margoengine/peer/options.d.ts'),
    'export interface PeerOptions {strength?: number}\n',
  );
  await writeFile(
    join(repository, 'consumer.ts'),
    [
      "import {sample,callback,tuple} from './packages/sample/dist/index.js';",
      'sample({strength: 2}, 0); callback({strength: 2}); tuple([{strength: 2}]);',
    ].join('\n'),
  );
  assert.equal(strict(repository), '', 'the installed peer retains valid types');
  await writeFile(
    join(repository, 'consumer.ts'),
    [
      "import {sample,callback,tuple} from './packages/sample/dist/index.js';",
      "sample({strength: 'high'}, 0); callback({strength: 'high'}); tuple([{strength: 'high'}]);",
    ].join('\n'),
  );
  const diagnostics = strict(repository);
  assert.equal(diagnostics.match(/TS2322/g)?.length, 3, diagnostics);
});
