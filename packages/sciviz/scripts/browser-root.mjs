// Package scripts start in packages/sciviz. Every browser fixture is served from the repository root.
import { fileURLToPath, pathToFileURL } from 'node:url';
import { relative, resolve, sep } from 'node:path';
const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const target = resolve(packageRoot, process.argv[2] ?? '');
if (!relative(packageRoot, target).startsWith(`tests${sep}`) || !target.endsWith('.mjs'))
  throw new TypeError('Pass a tests/*.mjs browser suite relative to the sciviz package');
process.chdir(fileURLToPath(new URL('../../..', import.meta.url)));
await import(pathToFileURL(target).href);
