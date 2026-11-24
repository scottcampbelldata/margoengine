// Opt-in test tool, never shipped: `npm run test:real-files:runtimes -w @margoengine/loaders`.
// Fetches the third-party runtimes test-real-files.mjs compares with into a folder git ignores, at pinned versions and
// with install scripts off. They are not dependencies of any package, so nothing here reaches a user. Then:
//   REAL_FILES_RUNTIMES=test-results/real-files-runtimes npm run test:real-files -w @margoengine/loaders
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const VERSIONS = { rhino3dm: '8.35.0', 'laz-perf': '0.0.7' };

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..'),
  folder = join(root, 'test-results/real-files-runtimes'),
  npm = process.env.npm_execpath;
if (!npm) throw new Error('run this through npm: npm run test:real-files:runtimes -w @margoengine/loaders');
await mkdir(folder, { recursive: true });
await writeFile(join(folder, 'package.json'), `${JSON.stringify({ private: true, dependencies: VERSIONS }, null, 2)}\n`);
execFileSync(process.execPath, [npm, 'install', '--ignore-scripts', '--no-audit', '--no-fund'], {
  cwd: folder,
  stdio: 'inherit',
  timeout: 300_000,
});
console.log(`runtimes ready: REAL_FILES_RUNTIMES=${folder}`);
