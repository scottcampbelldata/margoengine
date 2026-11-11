// package-lock.json must describe every workspace exactly as its package.json does. A package.json that gains a
// dependency or peer while the lock keeps the old set makes `npm install` rewrite the lock in every fresh checkout and
// `npm ci` refuse it (ec2429404 moved dependencies; 29b4a5cea added an optional peer). The fast gate runs hygiene on
// every push, and hygiene calls assertLockInSync, so a stale lock fails before it reaches main.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const FIELDS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];
const optionalPeers = (meta) =>
  Object.entries(meta ?? {})
    .filter(([, flags]) => flags?.optional === true)
    .map(([name]) => name)
    .sort();

// lock: the parsed package-lock.json. readManifest(path): the parsed package.json under that workspace path (''
// for the root), or null when the folder has none. Returns one line per difference.
export function lockProblems(lock, readManifest) {
  const entries = lock.packages ?? {};
  const rootManifest = readManifest('');
  const wrong = [];
  const compare = (path, own, entry) => {
    for (const field of FIELDS)
      for (const name of new Set([...Object.keys(own[field] ?? {}), ...Object.keys(entry[field] ?? {})]))
        if (own[field]?.[name] !== entry[field]?.[name])
          wrong.push(`${path || '(root)'} ${field} ${name}: package.json ${own[field]?.[name]}, lock ${entry[field]?.[name]}`);
    const ownOptional = optionalPeers(own.peerDependenciesMeta).join(', ');
    const lockOptional = optionalPeers(entry.peerDependenciesMeta).join(', ');
    if (ownOptional !== lockOptional)
      wrong.push(`${path || '(root)'} optional peers: package.json [${ownOptional}], lock [${lockOptional}]`);
  };
  if (rootManifest) {
    compare('', rootManifest, entries[''] ?? {});
    for (const path of rootManifest.workspaces ?? [])
      if (!path.includes('*') && readManifest(path) && !entries[path]) wrong.push(`${path}: workspace missing from the lock`);
  }
  for (const [path, entry] of Object.entries(entries)) {
    if (!path || path.includes('node_modules') || entry.link) continue;
    const own = readManifest(path);
    if (own) compare(path, own, entry);
  }
  return wrong;
}

export function assertLockInSync(root) {
  const readManifest = (path) => {
    const file = join(root, path, 'package.json');
    return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
  };
  const wrong = lockProblems(JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8')), readManifest);
  if (wrong.length)
    throw new Error(
      `package-lock.json is stale (run npm install --ignore-scripts --package-lock-only and commit the lock):\n  ${wrong.join('\n  ')}`,
    );
}
