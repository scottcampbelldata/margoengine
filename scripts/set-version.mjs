// Sets every published package (packages/*, tools/create-margo, tools/margo-convert and the create-margo template's
// dependencies) to one version, with every internal range `^<version>`. All packages ship in lockstep, so an app never
// mixes versions; tests/versions.test.js fails if they drift. Usage: node scripts/set-version.mjs 1.0.0
import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const version = process.argv[2];
if (!/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version ?? '')) throw new Error('usage: node scripts/set-version.mjs <x.y.z>');
const internal = (name) => name === 'margoengine' || name.startsWith('@margoengine/');
const manifests = ['packages', 'tools']
  .flatMap((dir) => readdirSync(dir).map((name) => join(dir, name, 'package.json')))
  .filter(existsSync)
  .concat('tools/create-margo/template/package.json');
// Workspace apps and examples are not published; only their internal ranges follow.
const consumers = JSON.parse(readFileSync('package.json', 'utf8'))
  .workspaces.filter((w) => !w.startsWith('packages/'))
  .map((w) => join(w, 'package.json'));

for (const path of [...manifests, ...consumers]) {
  const text = readFileSync(path, 'utf8'),
    manifest = JSON.parse(text);
  if (manifests.includes(path) && !path.includes('template')) manifest.version = version;
  for (const field of ['dependencies', 'peerDependencies', 'devDependencies', 'optionalDependencies'])
    for (const name of Object.keys(manifest[field] ?? {})) if (internal(name)) manifest[field][name] = `^${version}`;
  writeFileSync(path, JSON.stringify(manifest, null, 2) + (text.endsWith('\n') ? '\n' : ''));
}
console.log(
  `${manifests.length} manifests at ${version}; run npm install --package-lock-only --offline to refresh the lockfile`,
);
