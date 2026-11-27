// The private compatibility route chunk of a package build: the `compat-*.js` file of `dist` that exports `name`.
// A build can hold two such files, the route (src/compat.ts) and the shared packages/shared/compat.js when two entries
// import it, and their hashes decide which one a directory listing names first.
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** Imports the route chunk of `dist` (a directory URL or path) that exports `name`; throws if none does. */
export async function compatChunk(dist, name) {
  const dir = typeof dist === 'string' ? dist : fileURLToPath(dist);
  for (const file of readdirSync(dir).filter((f) => /^compat-[\w-]+\.js$/.test(f)).sort()) {
    const module = await import(pathToFileURL(join(dir, file)).href);
    if (name in module) return module;
  }
  throw new Error(`no compat-*.js chunk in ${dir} exports ${name}`);
}
