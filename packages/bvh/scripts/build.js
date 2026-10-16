import { execFileSync } from 'node:child_process';
import { copyFile, readFile, writeFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

// Plain TypeScript emit keeps the `new URL('./bvh.worker.js', import.meta.url)` literal intact, so the consuming app's
// bundler (Vite, webpack 5, Next.js) emits the module worker as its own asset.
const root = fileURLToPath(new URL('..', import.meta.url));
const repository = resolve(root, '../..');
await rm(resolve(root, 'dist'), { recursive: true, force: true });
await copyFile(resolve(repository, 'LICENSE'), resolve(root, 'LICENSE'));
execFileSync(
  process.execPath,
  [resolve(repository, 'node_modules/typescript/bin/tsc'), '-p', resolve(root, 'tsconfig.json')],
  { stdio: 'inherit' },
);
// Keep the registry inside the published package; Symbol.for shares it with independently bundled loaders.
await copyFile(resolve(repository, 'packages/shared/mesh-source.js'), resolve(root, 'dist/mesh-source.js'));
const raycaster = resolve(root, 'dist/raycaster.js');
await writeFile(
  raycaster,
  (await readFile(raycaster, 'utf8')).replace('../../shared/mesh-source.js', './mesh-source.js'),
);
