import { execFileSync } from 'node:child_process';
import { copyFile, readFile, writeFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { packageDeclarations, packageRuntime } from '../../../scripts/package-declarations.js';
import { copyLegal } from '../../../scripts/package-legal.js';

// Plain TypeScript emit keeps the `new URL('./bvh.worker.js', import.meta.url)` literal intact, so the consuming app's
// bundler (Vite, webpack 5, Next.js) emits the module worker as its own asset.
const root = fileURLToPath(new URL('..', import.meta.url));
const repository = resolve(root, '../..');
await rm(resolve(root, 'dist'), { recursive: true, force: true });
await copyLegal(root);
execFileSync(
  process.execPath,
  [resolve(repository, 'node_modules/typescript/bin/tsc'), '-p', resolve(root, 'tsconfig.json')],
  { stdio: 'inherit' },
);
// Copy the shared declarations the emitted .d.ts files reference into dist, so the packed package type-checks.
await packageDeclarations(root);
// Keep the registry inside the published package; Symbol.for shares it with independently bundled loaders.
await copyFile(resolve(repository, 'packages/shared/mesh-source.js'), resolve(root, 'dist/mesh-source.js'));
for (const name of ['raycaster.js', 'snapshot-source.js']) {
  const file = resolve(root, 'dist', name);
  await writeFile(file, (await readFile(file, 'utf8')).replace('../../shared/mesh-source.js', './mesh-source.js'));
}
// Ship the packages/shared modules the emitted JavaScript imports inside dist.
await packageRuntime(root);
