// Builds the milestone M2 layer (commit bd1fcd0a) into test-results/m2-layer/dist, the baseline perf-browser.mjs
// compares the basic scene with. Run from the repository root: node packages/webgl2-compat/scripts/build-m2-baseline.mjs
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { build } from 'vite';

const root = resolve('test-results/m2-layer');
rmSync(root, { recursive: true, force: true });
const git = (...args) => execFileSync('git', args, { maxBuffer: 1 << 26 });
const files = git('ls-tree', '-r', '--name-only', 'bd1fcd0a', 'packages/webgl2-compat/src')
  .toString()
  .trim()
  .split(/\s+/);
for (const file of [...files, 'packages/shared/errors.js']) {
  mkdirSync(dirname(resolve(root, file)), { recursive: true });
  writeFileSync(resolve(root, file), git('show', `bd1fcd0a:${file}`));
}
const src = resolve(root, 'packages/webgl2-compat/src');
await build({
  configFile: false,
  publicDir: false,
  logLevel: 'warn',
  root: src,
  build: {
    outDir: resolve(root, 'dist'),
    emptyOutDir: true,
    target: 'es2022',
    lib: { entry: { index: resolve(src, 'index.ts') }, formats: ['es'], fileName: (_f, n) => `${n}.js` },
  },
});
