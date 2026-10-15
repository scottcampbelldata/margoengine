import assert from 'node:assert/strict';
import {readFile, readdir, writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {PACKAGE_LISTS, withPackageList} from './package-lists.js';

const existingText = await readFile('docs/catalog.json', 'utf8'), existing = JSON.parse(existingText);
const postfxExamples = {
  dof: {example: '../demos/dof/', exampleTitle: 'Circular bokeh', exampleNote: 'Run the optional depth-of-field package with the current Core 0.1 engine. Focus, focal length, aperture and an effect toggle remain interactive.', exampleSource: false},
  tonemap: {example: '../demos/tonemap/', exampleTitle: 'Highlights and color', exampleNote: 'Run the optional tonemapping package with the current Core 0.1 engine. Compare AgX, ACES fitted and Neutral, exposure, contrast and a local 33-cube LUT.', exampleSource: false}
};
// Layers from docs/HANDOFF.md "Release presentation": the catalog and the sizes page list packages in this order.
const layers = {
  'Start here': ['margoengine', 'core'],
  'Setup and diagnostics': ['math', 'quality', 'webgl', 'stats', 'inspector'],
  'Loading and formats': ['gltf', 'gltf-pro', 'loaders', 'decoders', 'fbx', 'usdz', 'usdz-export', 'exporters', 'ifc', 'blender', 'cache', 'splats'],
  'Rendering and lighting': ['materials', 'shader', 'environment', 'clustered', 'shadows', 'sky', 'toon', 'oit', 'lod', 'culling', 'points', 'lines', 'text', 'labels', 'html', 'video', 'xr', 'staging'],
  'Post-processing': ['post', 'tonemap', 'dof', 'taa', 'transitions'],
  'World and effects': ['terrain', 'water', 'scenery', 'scatter', 'road', 'vfx', 'creative', 'procedural', 'wfc', 'splines'],
  'Animation and interaction': ['animation', 'animator', 'tween', 'cinematic', 'controls', 'cameras', 'input', 'gizmo', 'viewcube', 'selection', 'audio'],
  'Simulation and games': ['physics', 'navigation', 'navmesh', 'ecs', 'fsm', 'net'],
  'CAD and engineering': ['machinery', 'bvh', 'geometry'],
  'Frameworks': ['react'],
};
const order = Object.values(layers).flat(), categoryOf = id => Object.keys(layers).find(name => layers[name].includes(id));
const entries = [];
for (const id of await readdir('packages')) {
  let manifest;
  try { manifest = JSON.parse(await readFile(`packages/${id}/package.json`, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') continue; throw error; }
  if (manifest.private) continue;
  const previous = existing.find(entry => entry.id === id);
  const exports = Object.keys(await import(pathToFileURL(resolve(`packages/${id}/dist/index.js`)))).sort();
  assert.ok(exports.length, `${manifest.name} has no runtime exports`);
  // Offline builds keep the last known registry state instead of failing the package build.
  const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(manifest.name)}`).catch(() => null);
  assert.ok(!response || response.ok || response.status === 404, `${manifest.name}: registry returned ${response?.status}`);
  const published = response ? response.ok && !!(await response.json()).versions?.[manifest.version] : previous?.published ?? false;
  const core = manifest.peerDependencies?.['@margoengine/core'], category = categoryOf(id);
  assert.ok(category, `${manifest.name} has no layer: add it to the layers in scripts/build-catalog.js`);
  entries.push({
    ...previous, ...postfxExamples[id], id, title: previous?.title ?? (id === 'margoengine' ? 'Stage facade' : id[0].toUpperCase() + id.slice(1)),
    category, package: manifest.name, version: manifest.version, published,
    description: manifest.description,
    requirements: core ? `Core ${core} · see the package guide for browser and backend requirements` : 'See the package guide for requirements',
    keywords: previous?.keywords ?? id.replaceAll('-', ' '),
    install: `npm install ${core ? `@margoengine/core@${manifest.version} ` : ''}${manifest.name}@${manifest.version}${id === 'react' ? ' react@^19 react-dom@^19' : ''}`,
    imports: previous?.imports ?? `import { ${exports[0]} } from '${manifest.name}';`,
    exports,
  });
}
const missing = order.filter(id => !entries.some(entry => entry.id === id));
assert.deepEqual(missing, [], `layers name packages that are not in packages/: ${missing.join(', ')}`);
entries.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
// Keep the checkout's line endings (CRLF under core.autocrlf) and skip unchanged writes, so a clean tree stays clean.
const text = (JSON.stringify(entries, null, 2) + '\n').replaceAll('\n', existingText.includes('\r\n') ? '\r\n' : '\n');
if (text !== existingText) await writeFile('docs/catalog.json', text);
// README.md and docs/README.md list the packages by the same layers, generated from the catalog so they cannot drift.
for (const [file, packagesPath] of Object.entries(PACKAGE_LISTS)) {
  const markdown = await readFile(file, 'utf8'), updated = withPackageList(markdown, entries, packagesPath);
  if (updated !== markdown) await writeFile(file, updated);
}
console.log(`Catalog: ${entries.length} packages, ${entries.filter(entry => entry.published).length} published on npm.`);
