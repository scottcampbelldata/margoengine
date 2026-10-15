// Type-checks every Margo snippet (```ts block) in docs/from-threejs.md and docs/guides/*.md against the built packages,
// so a guide fails the unit run when an API it shows is renamed or removed. Needs `npm run build:packages` first.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const guides = [
  'docs/from-threejs.md',
  ...readdirSync(resolve(root, 'docs/guides'))
    .filter((name) => name.endsWith('.md'))
    .map((name) => `docs/guides/${name}`),
];

for (const file of guides)
  test(`${file} Margo snippets type-check against the built packages`, () => {
    const doc = readFileSync(resolve(root, file), 'utf8');
    const snippets = [...doc.matchAll(/```ts\r?\n([\s\S]*?)```/g)].map((match) => ({
      code: match[1],
      line: doc.slice(0, match.index).split('\n').length + 1,
    }));
    assert.ok(
      snippets.length >= (file === 'docs/from-threejs.md' ? 20 : 1),
      `expected the guide's snippets, found ${snippets.length}`,
    );
    for (const { code, line } of snippets)
      for (const [, from] of code.matchAll(/from '([^']+)'/g))
        assert.match(
          from,
          /^(margoengine|@margoengine\/[a-z0-9-]+(\/[a-z0-9-]+)?|@dimforge\/rapier3d-compat)$/,
          `snippet at line ${line} imports ${from}`,
        );
    // Inside the repository so package resolution finds node_modules; test-results is git-ignored.
    const dir = resolve(root, 'test-results/snippets', file.replace(/[/.]/g, '-'));
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      resolve(dir, 'globals.d.ts'),
      [
        "import type {EngineKernel, Mesh} from '@margoengine/core';",
        "import type {PBRModel} from '@margoengine/gltf-pro';",
        '// Names the guide uses without declaring them; a snippet that declares its own shadows these.',
        'declare global {const engine: EngineKernel; const canvas: HTMLCanvasElement; const mesh: Mesh; const model: PBRModel;}',
        'export {};',
        '',
      ].join('\n'),
    );
    snippets.forEach(({ code, line }) => writeFileSync(resolve(dir, `line-${line}.ts`), code + 'export {};\n'));
    writeFileSync(
      resolve(dir, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          strict: false,
          target: 'ES2022',
          module: 'ESNext',
          moduleResolution: 'Bundler',
          lib: ['ES2022', 'DOM', 'DOM.Iterable'],
          types: [],
          noEmit: true,
          skipLibCheck: true,
        },
        include: ['*.ts'],
      }),
    );
    try {
      execFileSync(
        process.execPath,
        [resolve(root, 'node_modules/typescript/bin/tsc'), '-p', resolve(dir, 'tsconfig.json')],
        { cwd: dir, encoding: 'utf8', stdio: 'pipe' },
      );
    } catch (error) {
      // Errors name line-<N>.ts, where N is the line of the snippet's first code line in the guide.
      assert.fail(`${file} snippets do not type-check:\n${error.stdout}${error.stderr}`);
    }
  });
