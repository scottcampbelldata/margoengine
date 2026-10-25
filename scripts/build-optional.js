import { buildWorkers } from './build-workers.js';
import { packageDeclarations } from './package-declarations.js';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { build } from 'vite';
import { copyLegal } from './package-legal.js';

const name = process.argv[2];
assert.ok(/^[a-z][a-z0-9-]*$/.test(name ?? ''), 'Expected an optional package name');
const repository = fileURLToPath(new URL('..', import.meta.url)),
  root = resolve(repository, 'packages', name);
const manifest = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
assert.equal(manifest.name, `@margoengine/${name}`);
const peers = Object.keys({ ...manifest.dependencies, ...manifest.peerDependencies });
// Keep every declared entry coherent, including data-only subpaths that share
// runtime identities with the root entry. A single-entry rebuild must not erase them.
const entries = {};
for (const entry of Object.values(manifest.exports)) {
  const target = entry.import;
  assert.ok(/^\.\/dist\/[\w-]+\.js$/.test(target), 'Unsupported package entry: ' + target);
  const module = target.slice('./dist/'.length, -'.js'.length);
  let source = resolve(root, 'src', module + '.ts');
  try {
    await readFile(source);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    source = resolve(root, 'src', module + '.tsx');
    await readFile(source);
  }
  entries[module] = source;
}
await copyLegal(root);
await build({
  root,
  configFile: false,
  publicDir: false,
  logLevel: 'warn',
  build: {
    outDir: resolve(root, 'dist'),
    emptyOutDir: true,
    target: 'es2022',
    lib: { entry: entries, formats: ['es'], fileName: (_format, name) => name + '.js' },
    // Node built-ins stay imports too (voxel-net's server entry runs in Node).
    rollupOptions: {
      external: (id) => id.startsWith('node:') || peers.some((peer) => id === peer || id.startsWith(peer + '/')),
    },
  },
});
await buildWorkers(root);
execFileSync(
  process.execPath,
  [resolve(repository, 'node_modules/typescript/bin/tsc'), '-p', resolve(root, 'tsconfig.json')],
  { stdio: 'inherit' },
);
await packageDeclarations(root);
