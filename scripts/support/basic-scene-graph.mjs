// Vite manifest edges: imports load with a module; dynamicImports remain deferred until called.
import assert from 'node:assert/strict';

export function staticFiles(manifest, key) {
  const seen = new Set(),
    files = [];
  const visit = (name) => {
    if (seen.has(name)) return;
    const chunk = manifest[name];
    assert.ok(chunk, `manifest contains dependency ${name}`);
    seen.add(name);
    files.push(chunk.file);
    for (const child of chunk.imports ?? []) visit(child);
  };
  visit(key);
  return files;
}

export function loaderAssets(manifest, key) {
  const seen = new Set(),
    assets = new Set();
  const visit = (name) => {
    if (seen.has(name)) return;
    const chunk = manifest[name];
    assert.ok(chunk, `manifest contains dependency ${name}`);
    seen.add(name);
    for (const asset of chunk.assets ?? []) assets.add(asset);
    for (const child of [...(chunk.imports ?? []), ...(chunk.dynamicImports ?? [])]) visit(child);
  };
  visit(key);
  return assets;
}

function emittedFiles(manifest, roots) {
  const seen = new Set(),
    files = new Set();
  const visit = (key) => {
    if (seen.has(key)) return;
    const chunk = manifest[key];
    assert.ok(chunk, `manifest contains dependency ${key}`);
    seen.add(key);
    files.add(chunk.file);
    for (const file of [...(chunk.assets ?? []), ...(chunk.css ?? [])]) files.add(file);
    for (const child of [...(chunk.imports ?? []), ...(chunk.dynamicImports ?? [])]) visit(child);
  };
  for (const key of roots) visit(key);
  return files;
}

export function sceneGraph(manifest) {
  // Stage/gltf selected the full PBR loader on main in 3d7dd74c9. No runtime API is changed here.
  const loader = Object.keys(manifest).find((key) => /packages\/gltf-pro\/dist\/index\.js$/.test(key));
  assert.ok(loader, 'the build has the selected @margoengine/gltf-pro chunk');
  const animation = Object.keys(manifest).find((key) => /packages\/animation\/dist\/index\.js$/.test(key));
  return {
    loader,
    entry: staticFiles(manifest, 'index.html'),
    gltf: staticFiles(manifest, loader),
    deferredAssets: loaderAssets(manifest, loader),
    emittedFiles: new Set([
      ...staticFiles(manifest, 'index.html'),
      ...emittedFiles(manifest, [loader, ...(animation ? [animation] : [])]),
    ]),
  };
}
