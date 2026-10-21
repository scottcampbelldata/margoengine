import { execFileSync } from 'node:child_process';
import { copyFile, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { build } from 'vite';

const root = fileURLToPath(new URL('..', import.meta.url));
const repository = resolve(root, '../..');
await copyFile(resolve(repository, 'LICENSE'), resolve(root, 'LICENSE'));
// One library entry per package export: "./dist/<name>.js" is built from "src/<name>.ts".
const manifest = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
const entry = Object.fromEntries(
  Object.values(manifest.exports).map(({ import: target }) => {
    if (!/^\.\/dist\/[\w-]+\.js$/.test(target)) throw new Error('Unsupported package entry: ' + target);
    const name = target.slice('./dist/'.length, -'.js'.length);
    return [name, resolve(root, `src/${name}.ts`)];
  }),
);
await build({
  root,
  configFile: false,
  publicDir: false,
  logLevel: 'warn',
  build: {
    outDir: resolve(root, 'dist'),
    emptyOutDir: true,
    target: 'es2022',
    lib: { entry, formats: ['es'], fileName: (_, name) => name + '.js' },
    rollupOptions: { external: ['@margoengine/core', '@margoengine/core/extension'] },
  },
});
execFileSync(
  process.execPath,
  [resolve(repository, 'node_modules/typescript/bin/tsc'), '-p', resolve(root, 'tsconfig.json')],
  { stdio: 'inherit' },
);
