// `npm run dev:examples`: the Vite dev server for the repository's example pages, started from the working directory's
// real path. Vite's file-serving allow list holds the directory it starts in as given and compares it with each file's
// real path, so a checkout reached through a Windows short (8.3) name (C:\DEVELO~1\..., or any clone under os.tmpdir(),
// an 8.3 path inside the home folder here) was refused on every page with 403 "outside of Vite serving allow list". This wrapper
// only changes the directory Vite starts in; the root `vite` command and its arguments are untouched.
// Extra arguments go to Vite: npm run dev:examples -- --port 5180 --strictPort
//
// The example pages import the built packages (packages/*/dist). Started before `npm run build:packages`, every page
// failed in the browser with Vite's "Failed to resolve import margoengine" overlay and the terminal said nothing, so
// the server now refuses to start and names the command to run first.
import { spawn } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cwd = realpathSync.native(process.cwd());
if (!existsSync(join(cwd, 'packages', 'margoengine', 'dist', 'index.js'))) {
  console.error(
    'The packages are not built yet. Run `npm run build:packages` once (no Rust needed), then run this again.',
  );
  process.exitCode = 1;
} else {
  const vite = join(dirname(fileURLToPath(import.meta.resolve('vite/package.json'))), 'bin', 'vite.js');
  const child = spawn(process.execPath, [vite, '--host', '127.0.0.1', ...process.argv.slice(2)], {
    cwd,
    stdio: 'inherit',
  });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
  child.on('exit', (code, signal) => {
    process.exitCode = code ?? (signal ? 1 : 0);
  });
}
