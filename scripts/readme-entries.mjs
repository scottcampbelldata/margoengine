// Which `exports` subpaths of a package its README does not name. tests/package-readmes.test.js holds the line: a new
// undocumented entry fails, and the known list (scripts/support/readme-entries-known.json) only shrinks.
//   node scripts/readme-entries.mjs            print the undocumented entries that are not on the known list
//   node scripts/readme-entries.mjs --shrink   write the known list down to what is still undocumented
// An entry counts as named when the README holds its full import path (`@margoengine/ui/forms`), its umbrella path
// (`margoengine/ui/forms`) or the subpath in backticks (`./forms` or `/forms`).
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = join(import.meta.dirname, '..');
const knownFile = join(root, 'scripts/support/readme-entries-known.json');

/** Every undocumented subpath: { folder: ['./sub', ...] }. The root entry, wildcards and package.json are skipped. */
export function undocumented() {
  const result = {};
  for (const folder of readdirSync(join(root, 'packages')).sort()) {
    const pkgFile = join(root, 'packages', folder, 'package.json'),
      readme = join(root, 'packages', folder, 'README.md');
    if (!existsSync(pkgFile) || !existsSync(readme) || folder === 'margoengine') continue;
    const pkg = JSON.parse(readFileSync(pkgFile, 'utf8')),
      text = readFileSync(readme, 'utf8'),
      missing = Object.keys(pkg.exports ?? {}).filter((key) => {
        if (key === '.' || key === './package.json' || key.includes('*')) return false;
        const sub = key.slice(1);
        return !(
          text.includes(`${pkg.name}${sub}`) ||
          text.includes(`margoengine/${folder}${sub}`) ||
          text.includes(`\`${key}\``) ||
          text.includes(`\`${sub}\``)
        );
      });
    if (missing.length) result[folder] = missing;
  }
  return result;
}

/** The known list as JSON with one package to a line, so a diff shows which package changed. */
export const format = (table) =>
  `{\n${Object.entries(table)
    .map(([folder, keys]) => `  ${JSON.stringify(folder)}: ${JSON.stringify(keys)}`)
    .join(',\n')}\n}\n`;

/** { fresh, gone }: entries undocumented and not known, and known entries that are now named (or no longer exist). */
export function undocumentedEntries() {
  const now = undocumented(),
    known = JSON.parse(readFileSync(knownFile, 'utf8')),
    flat = (table) => Object.entries(table).flatMap(([folder, keys]) => keys.map((key) => `${folder} ${key}`)),
    current = new Set(flat(now)),
    listed = new Set(flat(known));
  return {
    fresh: [...current].filter((entry) => !listed.has(entry)),
    gone: [...listed].filter((entry) => !current.has(entry)),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { fresh, gone } = undocumentedEntries();
  if (process.argv.includes('--shrink')) {
    if (fresh.length) throw new Error(`new undocumented entries, document them first:\n${fresh.join('\n')}`);
    writeFileSync(knownFile, format(undocumented()));
    console.log(`known list: ${gone.length} removed`);
  } else {
    for (const entry of fresh) console.log(`undocumented: ${entry}`);
    console.log(`${fresh.length} new, ${gone.length} now documented`);
  }
}
