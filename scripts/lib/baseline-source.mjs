// Baseline sources for A/B benchmark scripts. A baseline is every module of a package's src/ as one Git commit had
// it: reading only the entry file from the commit and its siblings from the working tree mixes two revisions.
import { execFileSync } from 'node:child_process';

/** A Vite plugin serving every .ts module under packages/<packageName>/src/ from `commit`; `overrides` maps a
 * src-relative file name to replacement text. */
export function baselineSource({ commit, packageName, overrides = {} }) {
  const marker = `/packages/${packageName}/src/`;
  return {
    name: `${packageName}-baseline-source`,
    enforce: 'pre',
    load(id) {
      const file = id.replaceAll('\\', '/').replace(/\?.*$/, ''),
        at = file.indexOf(marker);
      if (at < 0 || !file.endsWith('.ts')) return;
      const name = file.slice(at + marker.length);
      if (Object.hasOwn(overrides, name)) return overrides[name];
      return execFileSync('git', ['show', `${commit}:packages/${packageName}/src/${name}`], {
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
      });
    },
  };
}

/** The files `entry` reaches through relative `./x.js` imports inside one folder, read with `read(name)`. */
export async function sourceClosure(entry, read) {
  const files = new Map();
  for (const pending = [entry]; pending.length; ) {
    const name = pending.pop();
    if (files.has(name)) continue;
    const text = await read(name);
    files.set(name, text);
    for (const [, local] of text.matchAll(/from\s+['"]\.\/([\w-]+)\.js['"]/g))
      if (!files.has(`${local}.ts`)) pending.push(`${local}.ts`);
  }
  return files;
}
