import { execFileSync } from 'node:child_process';
import { copyFile, readFile, writeFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { packageDeclarations } from '../../../scripts/package-declarations.js';

// Plain TypeScript emit keeps one module per exporter, so a consumer bundler drops the formats it does not import.
const root = fileURLToPath(new URL('..', import.meta.url));
const repository = resolve(root, '../..');
await rm(resolve(root, 'dist'), { recursive: true, force: true });
await copyFile(resolve(repository, 'LICENSE'), resolve(root, 'LICENSE'));
execFileSync(
  process.execPath,
  [resolve(repository, 'node_modules/typescript/bin/tsc'), '-p', resolve(root, 'tsconfig.json')],
  { stdio: 'inherit' },
);
// Ship the small registry with the package. Its global symbol shares identity
// with the loader even when the two packages were built independently.
await copyFile(resolve(repository, 'packages/shared/mesh-source.js'), resolve(root, 'dist/mesh-source.js'));
const scene = resolve(root, 'dist/scene.js');
await writeFile(scene, (await readFile(scene, 'utf8')).replace('../../shared/mesh-source.js', './mesh-source.js'));
await packageDeclarations(root);
