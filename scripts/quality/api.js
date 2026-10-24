// Gate 4, API conventions, from `npm run hygiene`'s full run (gates 6 and 7, test-results/hygiene.json):
// - `tsdoc <package> <name>` -> 1: a public export with no TSDoc comment;
// - `bare-error <file>` -> count: `throw new Error(` beyond scripts/hygiene-allowlist.json's frozen core + stage grant;
// - `no-fix <file>` -> count: throws whose literal message names no fix (docs/conventions.md, Errors).
// attach / dispose / Symbol.dispose are checked with no baseline (0 violations) by tests/api-conventions.test.js.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export function apiGate({ root }) {
  execFileSync(process.execPath, [join(root, 'scripts/hygiene.js')], {
    cwd: root,
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  const report = JSON.parse(readFileSync(join(root, 'test-results/hygiene.json'), 'utf8'));
  const allowlist = JSON.parse(readFileSync(join(root, 'scripts/hygiene-allowlist.json'), 'utf8'));
  const items = {};
  for (const [dir, names] of Object.entries(report.undocumented ?? {}))
    for (const name of names) items[`tsdoc ${dir} ${name}`] = 1;
  for (const [file, { bare, noFix }] of Object.entries(report.throwSites ?? {})) {
    const over = bare - (allowlist.errors?.[file]?.count ?? 0);
    if (over > 0) items[`bare-error ${file}`] = over;
    if (noFix) items[`no-fix ${file}`] = noFix;
  }
  return {
    items,
    summary() {
      const sum = (prefix) => {
        const by = {};
        for (const [k, v] of Object.entries(items))
          if (k.startsWith(prefix)) {
            const pkg = k.split(' ')[1].replace(/^packages\/([^/]+)\/.*$/, '$1');
            by[pkg] = (by[pkg] ?? 0) + v;
          }
        return Object.entries(by)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 6)
          .map(([p, n]) => `${p} ${n}`)
          .join(', ');
      };
      return [
        `  tsdoc (undocumented exports): ${sum('tsdoc ')}`,
        `  bare-error (throw new Error): ${sum('bare-error ')}`,
        `  no-fix (message names no fix): ${sum('no-fix ')}`,
      ];
    },
  };
}
