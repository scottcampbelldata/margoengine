// Every file a package's `exports` map promises, checked on disk. build-modern runs it on the packages it just built and
// fails loudly when one is missing (KB-RM4, 2026-11-11: a full CI run carried on for 40 minutes with no
// packages/web/dist, and the first sign was check:examples-types failing on @margoengine/web imports);
// tests/package-exports.test.js runs it on every package.
import { existsSync, globSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** Every target string in an `exports` value, through conditions, nesting and fallback arrays. */
export function exportTargets(value) {
  if (typeof value === 'string') return [value];
  if (!value) return [];
  return Object.values(value).flatMap(exportTargets);
}

/** The targets of `exports` that `hasFile` says are not there. */
export function missingTargets(exports, hasFile) {
  return exportTargets(exports).filter((target) => !hasFile(target));
}

/** `<package name>: <target>` for every export target missing under the package folder `directory`. */
export function missingPackageTargets(directory) {
  const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
  const hasFile = (target) => {
    const candidates = target.includes('*')
      ? globSync(target, { cwd: directory }).map((path) => join(directory, path))
      : [join(directory, target)];
    return candidates.length > 0 && candidates.every((path) => existsSync(path) && statSync(path).isFile());
  };
  return missingTargets(manifest.exports, hasFile).map((target) => `${manifest.name}: ${target}`);
}
