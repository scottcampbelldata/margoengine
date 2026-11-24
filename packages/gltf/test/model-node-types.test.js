// KB-GLTF-MESHTYPE1: PBRModel.root and nodes were typed with core/extension's engine Mesh, while engine.createMesh()
// returns core's public Mesh, so `model.root.setParent(engine.createMesh())` failed to type-check (TS2740) though both
// are one object at run time. They are typed ModelNode (both Mesh types) now. This compiles the built declarations
// both ways round, and a control with the old engine-only type, which must still fail, so the check cannot go blind.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

function typeCheck(name, code) {
  // Inside the repository so package resolution finds node_modules; test-results is git-ignored.
  const dir = resolve(root, 'test-results/gltf-model-node-types', name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  writeFileSync(resolve(dir, 'check.ts'), code);
  writeFileSync(
    resolve(dir, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        strict: true,
        target: 'ES2022',
        module: 'ESNext',
        moduleResolution: 'Bundler',
        lib: ['ES2022', 'DOM', 'DOM.Iterable'],
        types: [],
        noEmit: true,
        skipLibCheck: true,
      },
      include: ['check.ts'],
    }),
  );
  try {
    execFileSync(process.execPath, [resolve(root, 'node_modules/typescript/bin/tsc'), '-p', dir], {
      cwd: dir,
      encoding: 'utf8',
      stdio: 'pipe',
      timeout: 120_000,
    });
    return '';
  } catch (error) {
    return `${error.stdout}${error.stderr}`;
  }
}

const header = `import type { EngineKernel } from '@margoengine/core';
import type { PBRModel } from '@margoengine/gltf/pbr';
declare const engine: EngineKernel;
declare const model: PBRModel;
`;

test('a model parents to engine.createMesh() and a created mesh to a model node, with no cast', () => {
  const errors = typeCheck(
    'model-node',
    `${header}const turntable = engine.createMesh();
model.root.setParent(turntable);
engine.createMesh().setParent(model.nodes[0]);
turntable.setParent(model.root);
export {};
`,
  );
  assert.equal(errors, '', errors);
});

test('control: the old engine-only node type still fails, so the check above can see the bug', () => {
  const errors = typeCheck(
    'engine-only',
    `${header}import type { Mesh } from '@margoengine/core/extension';
declare const node: Mesh;
node.setParent(engine.createMesh());
export {};
`,
  );
  assert.match(errors, /TS2740/, 'the engine-only Mesh is not the public Mesh');
});
