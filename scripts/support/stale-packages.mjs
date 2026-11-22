// Build output left behind by a package that is no longer in the workspace (KB-IMPORTMAP-STALE1, 2026-11-16). When a
// package is renamed or folded into another (net into netcode, scenery and the old kits), git removes its tracked files
// but leaves the ignored ones: packages/<old>/dist, the LICENSE and NOTICE copies the build wrote. A checkout that built
// before the rename kept serving those dead entries to whatever reads packages/*/dist (an app's engine resolver found 34
// @margoengine/scenery/* names that way), and api:update stopped on "missing package.json". A full build:packages now
// removes them.
import { existsSync, readFileSync, readdirSync, rmSync, rmdirSync } from 'node:fs';
import { join } from 'node:path';

/** What a build writes into a package folder; nothing else in a stale folder is ever removed. */
const OUTPUTS = ['dist', 'dist-next'];
const LEGAL = ['LICENSE', 'NOTICE'];

const sameFile = (a, b) => existsSync(a) && existsSync(b) && readFileSync(a).equals(readFileSync(b));

/**
 * Removes the build output of every packages/<dir> that is neither a workspace nor holds a package.json: its dist and
 * dist-next, its LICENSE and NOTICE when they are byte-identical to the repository's (the copies the build made), and
 * the folder itself once that leaves it empty. Sources, or anything else someone left there, stay. Returns the folders
 * it cleaned, each with what it removed and whether the folder is gone.
 */
export function removeStalePackageOutputs(repository, workspaces) {
  const kept = new Set(
    workspaces.filter((dir) => dir.startsWith('packages/')).map((dir) => dir.slice('packages/'.length)),
  );
  const cleaned = [];
  for (const entry of readdirSync(join(repository, 'packages'), { withFileTypes: true })) {
    if (!entry.isDirectory() || kept.has(entry.name)) continue;
    const dir = join(repository, 'packages', entry.name);
    if (existsSync(join(dir, 'package.json'))) continue;
    const removed = [];
    for (const name of OUTPUTS)
      if (existsSync(join(dir, name))) {
        rmSync(join(dir, name), { recursive: true, force: true });
        removed.push(name);
      }
    for (const name of LEGAL)
      if (sameFile(join(dir, name), join(repository, name))) {
        rmSync(join(dir, name));
        removed.push(name);
      }
    if (!removed.length) continue;
    const empty = readdirSync(dir).length === 0;
    if (empty) rmdirSync(dir);
    cleaned.push({ dir: `packages/${entry.name}`, removed, folderRemoved: empty });
  }
  return cleaned;
}
