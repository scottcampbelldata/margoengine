// Type-checks every Margo snippet (```ts block) in docs/from-threejs.md against the built packages, so the guide
// fails the unit run when an API it shows is renamed or removed. Needs `npm run build:packages` first.
import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {resolve} from 'node:path';

const root = resolve(import.meta.dirname, '..');
const doc = readFileSync(resolve(root, 'docs/from-threejs.md'), 'utf8');
const snippets = [...doc.matchAll(/```ts\r?\n([\s\S]*?)```/g)].map(match => ({code: match[1], line: doc.slice(0, match.index).split('\n').length + 1}));

test('docs/from-threejs.md Margo snippets type-check against the built packages', () => {
  assert.ok(snippets.length >= 20, `expected the guide's snippets, found ${snippets.length}`);
  for (const {code, line} of snippets) for (const [, from] of code.matchAll(/from '([^']+)'/g))
    assert.match(from, /^(margoengine|@margoengine\/[a-z0-9-]+(\/[a-z0-9-]+)?)$/, `snippet at line ${line} imports ${from}`);
  // Inside the repository so package resolution finds node_modules; test-results is git-ignored.
  const dir = resolve(root, 'test-results/from-threejs-snippets');
  rmSync(dir, {recursive: true, force: true}); mkdirSync(dir, {recursive: true});
  writeFileSync(resolve(dir, 'globals.d.ts'), [
    "import type {EngineKernel, Mesh} from '@margoengine/core';",
    "import type {PBRModel} from '@margoengine/gltf-pro';",
    '// Names the guide uses without declaring them; a snippet that declares its own shadows these.',
    'declare global {const engine: EngineKernel; const canvas: HTMLCanvasElement; const mesh: Mesh; const model: PBRModel;}',
    'export {};', ''].join('\n'));
  snippets.forEach(({code, line}) => writeFileSync(resolve(dir, `line-${line}.ts`), code + 'export {};\n'));
  writeFileSync(resolve(dir, 'tsconfig.json'), JSON.stringify({compilerOptions: {strict: false, target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler',
    lib: ['ES2022', 'DOM', 'DOM.Iterable'], types: [], noEmit: true, skipLibCheck: true}, include: ['*.ts']}));
  try {
    execFileSync(process.execPath, [resolve(root, 'node_modules/typescript/bin/tsc'), '-p', resolve(dir, 'tsconfig.json')], {cwd: dir, encoding: 'utf8', stdio: 'pipe'});
  } catch (error) {
    // Errors name line-<N>.ts, where N is the line of the snippet's first code line in docs/from-threejs.md.
    assert.fail(`docs/from-threejs.md snippets do not type-check:\n${error.stdout}${error.stderr}`);
  }
});
