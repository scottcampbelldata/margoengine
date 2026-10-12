import assert from 'node:assert/strict';
import {readFile, readdir, writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

const existing = JSON.parse(await readFile('docs/catalog.json', 'utf8'));
const entries = [];
for (const id of await readdir('packages')) {
  let manifest;
  try { manifest = JSON.parse(await readFile(`packages/${id}/package.json`, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') continue; throw error; }
  if (manifest.private) continue;
  const previous = existing.find(entry => entry.id === id);
  const exports = Object.keys(await import(pathToFileURL(resolve(`packages/${id}/dist/index.js`)))).sort();
  assert.ok(exports.length, `${manifest.name} has no runtime exports`);
  const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(manifest.name)}`);
  assert.ok(response.ok || response.status === 404, `${manifest.name}: registry returned ${response.status}`);
  const published = response.ok && !!(await response.json()).versions?.[manifest.version];
  const core = manifest.peerDependencies?.['@margoengine/core'];
  entries.push({
    ...previous, id, title: previous?.title ?? (id === 'margoengine' ? 'Stage facade' : id[0].toUpperCase() + id.slice(1)),
    package: manifest.name, version: manifest.version, published,
    description: manifest.description,
    requirements: core ? `Core ${core} · see the package guide for browser and backend requirements` : 'See the package guide for requirements',
    keywords: previous?.keywords ?? id.replaceAll('-', ' '),
    install: `npm install ${core ? '@margoengine/core@0.1.0 ' : ''}${manifest.name}@${manifest.version}${id === 'react' ? ' react@^19 react-dom@^19' : ''}`,
    imports: previous?.imports ?? `import { ${exports[0]} } from '${manifest.name}';`,
    exports,
  });
}
entries.sort((a, b) => {
  const first = ['margoengine', 'core', 'machinery', 'gltf', 'creative', 'react'];
  return (first.includes(a.id) ? first.indexOf(a.id) : first.length) - (first.includes(b.id) ? first.indexOf(b.id) : first.length) || a.id.localeCompare(b.id);
});
await writeFile('docs/catalog.json', JSON.stringify(entries, null, 2) + '\n');
console.log(`Catalog: ${entries.length} packages, ${entries.filter(entry => entry.published).length} published on npm.`);
