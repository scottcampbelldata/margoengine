import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { packageDeclarations } from '../scripts/package-declarations.js';

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
