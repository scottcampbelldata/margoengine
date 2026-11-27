// Sets every published engine package (packages/*, tools/margo-convert, tools/margo-convert-cad) to one version,
// with every internal range `^<version>`. create-margo stays on its own 0.1 line, and its templates keep ^0.1.0 so
// `npm create margo` can install the packages that are on npm. tests/versions.test.js fails if the rest drift.
// Usage: node scripts/set-version.mjs 1.0.0
import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const version = process.argv[2];
if (!/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version ?? '')) throw new Error('usage: node scripts/set-version.mjs <x.y.z>');
const internal = (name) => name === 'margoengine' || name.startsWith('@margoengine/');
const manifests = ['packages', 'tools']
  .flatMap((dir) => readdirSync(dir).map((name) => join(dir, name, 'package.json')))
  .filter(existsSync)
  .concat(
    readdirSync('tools/create-margo/templates')
      .map((name) => join('tools/create-margo/templates', name, 'package.json'))
      .filter(existsSync),
  );
// Workspace apps and examples are not published; only their internal ranges follow.
const consumers = JSON.parse(readFileSync('package.json', 'utf8'))
  .workspaces.filter((w) => !w.startsWith('packages/'))
  .map((w) => join(w, 'package.json'));

for (const path of [...manifests, ...consumers]) {
  // create-margo is published as 0.1.x while these packages stay on one version.
  // Its templates depend on ^0.1.0, the engine release on npm, so a new app can install.
  if (path === 'tools/create-margo/package.json' || path.includes(`${join('create-margo', 'templates')}`)) continue;
  const text = readFileSync(path, 'utf8'),
    manifest = JSON.parse(text);
  if (manifests.includes(path) && !path.includes('templates')) manifest.version = version;
  for (const field of ['dependencies', 'peerDependencies', 'devDependencies', 'optionalDependencies'])
    for (const name of Object.keys(manifest[field] ?? {})) if (internal(name)) manifest[field][name] = `^${version}`;
  writeFileSync(path, JSON.stringify(manifest, null, 2) + (text.endsWith('\n') ? '\n' : ''));
}
console.log(
  `${manifests.length} manifests at ${version}; run npm install --package-lock-only --offline to refresh the lockfile`,
);
