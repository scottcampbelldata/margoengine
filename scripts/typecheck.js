import { execFileSync } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repository = fileURLToPath(new URL('..', import.meta.url));
const compiler = resolve(repository, 'node_modules/typescript/bin/tsc');
let checked = 0;

/**
 * The workspace packages whose built declarations are missing. Each package's tsconfig resolves @margoengine/* imports
 * through their dist/*.d.ts, so a run before `npm run build:packages` fails with hundreds of TS2307 errors that name
 * no cause (GitHub CI's lint job typechecked an unbuilt tree from 2026-11-13 to 2026-11-25).
 */
export async function unbuilt(root = repository) {
  const missing = [];
  for (const entry of await readdir(resolve(root, 'packages'), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    let manifest;
    try {
      manifest = JSON.parse(await readFile(resolve(root, 'packages', entry.name, 'package.json'), 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    const types = manifest.types ?? manifest.exports?.['.']?.types;
    if (typeof types !== 'string' || !types.startsWith('./dist/')) continue;
    try {
      await readFile(resolve(root, 'packages', entry.name, types), 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') missing.push(entry.name);
      else throw error;
    }
  }
  return missing;
}

if (import.meta.url !== pathToFileURL(process.argv[1]).href) {
  // Imported (tests/typecheck.test.js): only the helpers above.
} else {
  const missing = await unbuilt();
  if (missing.length) {
    console.error(
      `typecheck: ${missing.length} packages have no built declarations (${missing.slice(0, 5).join(', ')}${missing.length > 5 ? ', ...' : ''}); run npm run build:packages first`,
    );
    process.exitCode = 1;
  } else await checkAll();
}

/** Strict-checks every package that has a tsconfig.json. */
async function checkAll() {
  for (const entry of await readdir(resolve(repository, 'packages'), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const config = resolve(repository, 'packages', entry.name, 'tsconfig.json');
    try {
      await readFile(config, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    execFileSync(process.execPath, [compiler, '-p', config, '--noEmit', '--strict'], {
      cwd: repository,
      stdio: 'inherit',
    });
    checked++;
  }

  console.log(`Strict TypeScript checks passed for all ${checked} packages.`);
}
