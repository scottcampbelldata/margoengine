// The packages the quality gate checks: every packages/<dir> with a package.json, and each `exports` entry with its
// built file and its source file (the same mapping hygiene.js uses: dist/x.js <- src/x.ts). margoengine's generated
// aliases are left out.
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isUmbrellaAlias } from '../umbrella.mjs';

export const slash = (p) => p.replaceAll('\\', '/');

/** Tracked and untracked (not ignored) repo files, '/'-separated. */
export function repoFiles(root) {
  return execFileSync('git', ['ls-files', '-co', '--exclude-standard'], { cwd: root, encoding: 'utf8' })
    .split('\n')
    .filter((f) => f && existsSync(join(root, f)));
}

/** [{ dir, name, manifest, entries: [{ subpath, specifier, dist, src }] }] sorted by dir. */
export function packageList(root, files = repoFiles(root)) {
  const known = new Set(files);
  const toSource = (dist) => {
    const stem = dist.replace(/^(packages\/[^/]+)\/dist\//, '$1/src/').replace(/\.(js|mjs)$/, '');
    return [`${stem}.ts`, `${stem}.tsx`, `${stem}.js`, `${stem}.mjs`, `${stem}/index.ts`].find((c) => known.has(c));
  };
  return readdirSync(join(root, 'packages'))
    .filter((dir) => existsSync(join(root, 'packages', dir, 'package.json')))
    .sort()
    .map((dir) => {
      const manifest = JSON.parse(readFileSync(join(root, 'packages', dir, 'package.json'), 'utf8'));
      const entries = [];
      for (const [subpath, target] of Object.entries(manifest.exports ?? {})) {
        const js = typeof target === 'string' ? target : (target.import ?? target.default);
        // margoengine/<x> re-exports the @margoengine/<x> entry, which is gated itself (tests/umbrella.test.js).
        if (!js?.endsWith('.js') || isUmbrellaAlias(manifest.name, subpath)) continue;
        const dist = `packages/${dir}/${js.replace(/^\.\//, '')}`;
        entries.push({ subpath, specifier: manifest.name + subpath.slice(1), dist, src: toSource(dist) });
      }
      return { dir, name: manifest.name, manifest, entries };
    });
}
