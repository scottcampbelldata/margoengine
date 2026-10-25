import { execFileSync } from 'node:child_process';
import { copyFile, readFile, writeFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { packageDeclarations, packageRuntime } from '../../../scripts/package-declarations.js';
import { copyLegal } from '../../../scripts/package-legal.js';

// Plain TypeScript emit keeps one module per exporter, so a consumer bundler drops the formats it does not import.
const root = fileURLToPath(new URL('..', import.meta.url));
const repository = resolve(root, '../..');
await rm(resolve(root, 'dist'), { recursive: true, force: true });
await copyLegal(root);
execFileSync(process.execPath, [resolve(root, 'scripts/generate-unity-support.js')], { stdio: 'inherit' });
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
// The untrusted-JSON parser ships the same way (splitGLB parses caller files with it).
await copyFile(resolve(repository, 'packages/shared/json.js'), resolve(root, 'dist/json.js'));
const glb = resolve(root, 'dist/glb.js');
await writeFile(glb, (await readFile(glb, 'utf8')).replace('../../shared/json.js', './json.js'));
// The writers share one CRC-32, shipped beside them.
await copyFile(resolve(repository, 'packages/shared/crc32.js'), resolve(root, 'dist/crc32.js'));
for (const name of ['archive', 'usdz', 'png']) {
  const file = resolve(root, `dist/${name}.js`);
  await writeFile(file, (await readFile(file, 'utf8')).replace('../../shared/crc32.js', './crc32.js'));
}
await packageDeclarations(root);
// Ship the packages/shared modules the emitted JavaScript imports inside dist.
await packageRuntime(root);
