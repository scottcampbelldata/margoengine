// What the offline pack tools of the demos share (demos/*/source/tools/pack-*.mjs and sample-*.mjs). The tools run
// against a built public Margo checkout pinned to one commit, so this helper lives here, not in that checkout.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import * as nodeModule from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Throw unless `checkout` is at `revision`. */
export function requireRevision(checkout, revision) {
  const head = execFileSync('git', ['-C', checkout, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  if (head !== revision) throw new Error(`Unexpected Margo checkout: ${head}, expected ${revision}.`);
}

/** The Python 3 the checkout's own finder picks; throws `missing` when there is none. */
export async function findPythonIn(checkout, missing) {
  const { findPython } = await import(pathToFileURL(resolve(checkout, 'scripts/support/find-python.mjs')).href);
  const python = findPython();
  if (!python) throw new Error(missing);
  return python;
}

/** Check the pinned revision, then find Python in the checkout. */
export async function pinnedPython(checkout, revision, missing) {
  requireRevision(checkout, revision);
  return findPythonIn(checkout, missing);
}

/** Make `@margoengine/<package>[/<entry>]` imports resolve to the built packages of `checkout`. */
export function resolveMargoPackages(checkout) {
  const { registerHooks } = nodeModule;
  if (typeof registerHooks !== 'function') throw new Error('This tool needs Node 22.15 or newer (module.registerHooks).');
  registerHooks({
    resolve(specifier, context, next) {
      if (!specifier.startsWith('@margoengine/')) return next(specifier, context);
      const [, name, ...pieces] = specifier.split('/');
      const folder = resolve(checkout, 'packages', name);
      const manifest = JSON.parse(readFileSync(resolve(folder, 'package.json'), 'utf8'));
      const entry = manifest.exports[pieces.length ? './' + pieces.join('/') : '.'];
      if (!entry) throw new Error(`${specifier} is not exported by packages/${name}.`);
      return { url: pathToFileURL(resolve(folder, typeof entry === 'string' ? entry : entry.import)).href, shortCircuit: true };
    },
  });
}
