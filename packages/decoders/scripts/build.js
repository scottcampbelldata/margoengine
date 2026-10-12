import {execFileSync} from 'node:child_process';
import {copyFile, mkdir, readdir, rm} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';

// Plain TypeScript emit keeps every `new URL('./…', import.meta.url)` literal intact, so the consuming app's
// bundler (Vite, webpack 5, Next.js) emits the module worker and the Wasm decoders as its own assets.
const root = fileURLToPath(new URL('..', import.meta.url));
const repository = resolve(root, '../..');
const dist = resolve(root, 'dist');
await rm(dist, {recursive: true, force: true});
await copyFile(resolve(repository, 'LICENSE'), resolve(root, 'LICENSE'));
execFileSync(process.execPath, [resolve(repository, 'node_modules/typescript/bin/tsc'), '-p', resolve(root, 'tsconfig.json')], {stdio: 'inherit'});
for (const folder of ['draco', 'basis']) {
  await mkdir(resolve(dist, folder), {recursive: true});
  for (const file of await readdir(resolve(root, 'vendor', folder))) await copyFile(resolve(root, 'vendor', folder, file), resolve(dist, folder, file));
}
await copyFile(resolve(root, 'vendor/NOTICE.md'), resolve(dist, 'THIRD-PARTY-NOTICE.md'));
