// Git merge driver for generated files (scripts/setup-merge-drivers.mjs registers it; .gitattributes names it).
//   node scripts/merge-driver.mjs <derived|ratchet> <base> <ours> <theirs>
// git passes %O %A %B: the ancestor, the current side (main, during a rebase) and the other side (the commit being
// replayed). The merged result goes into <ours>; exit 0 means merged, anything else leaves a conflict.
//   derived  keeps <ours> untouched: scripts/land-records.mjs regenerates the file from the rebased tree afterwards.
//   ratchet  merges the quality baseline item by item (mergeRatchet): limits only shrink, history is kept.
import { readFileSync, writeFileSync } from 'node:fs';
import { mergeRatchet } from './support/derived-records.mjs';

const [mode, basePath, oursPath, theirsPath] = process.argv.slice(2);
if (mode === 'derived') process.exit(0);
if (mode !== 'ratchet' || !theirsPath) {
  console.error('usage: merge-driver.mjs <derived|ratchet> <base> <ours> <theirs>');
  process.exit(2);
}
try {
  const read = (path) => JSON.parse(readFileSync(path, 'utf8'));
  writeFileSync(
    oursPath,
    JSON.stringify(mergeRatchet(read(basePath), read(oursPath), read(theirsPath)), null, 2) + '\n',
  );
} catch (error) {
  // An unreadable side (a hand edit that broke the JSON) stays a conflict for a person to resolve.
  console.error(`merge-driver: ${error.message}`);
  process.exit(1);
}
