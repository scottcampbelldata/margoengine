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
  // margoengine/stage/gltf routes by asset features (8f4f4db72): an asset with no extension, skin or animation (the
  // basic scene's cube) loads @margoengine/gltf, the chunk the page fetches. @margoengine/gltf-pro and
  // @margoengine/animation stay dynamic imports: the build emits them and their codec assets, the page never fetches them.
  const chunk = (pkg) => Object.keys(manifest).find((key) => key.endsWith(`packages/${pkg}/dist/index.js`));
  const loader = chunk('gltf');
  assert.ok(loader, 'the build has the routed basic @margoengine/gltf chunk');
  const deferred = [chunk('gltf-pro'), chunk('animation')].filter(Boolean),
    entry = staticFiles(manifest, 'index.html'),
    gltf = staticFiles(manifest, loader),
    deferredChunks = new Set(deferred.map((key) => manifest[key].file));
  for (const file of [...entry, ...gltf])
    assert.ok(!deferredChunks.has(file), `${file}, a deferred glTF feature loader, is a static import of the basic scene`);
  return {
    loader,
    entry,
    gltf,
    deferredChunks,
    deferredAssets: new Set([loader, ...deferred].flatMap((key) => [...loaderAssets(manifest, key)])),
    emittedFiles: new Set([...entry, ...emittedFiles(manifest, [loader, ...deferred])]),
  };
}

/**
 * The build check: the files the build emitted (`built`, outDir paths without .vite) must be exactly the page's
 * requests (`expected`) plus the emitted graph of the basic loader and the named deferred loaders. Any other file fails.
 */
export function checkBuilt(built, expected, graph) {
  assert.deepEqual(
    [...built].sort(),
    [...new Set([...expected, ...graph.emittedFiles])].sort(),
    'every emitted file belongs to the selected glTF feature graph',
  );
}

/**
 * The network check: the page's requests (`paths`, outDir paths in request order) must be exactly `expected`, each once.
 * A deferred loader chunk (gltf-pro, animation) fetched by the basic scene is named first.
 */
export function checkFetched(paths, expected, graph) {
  assert.deepEqual(
    paths.filter((path) => graph.deferredChunks.has(path)),
    [],
    'the basic scene fetched a deferred glTF feature loader (gltf-pro or animation)',
  );
  assert.deepEqual([...new Set(paths)].sort(), [...expected].sort(), 'exactly the HTML, entry chunk, glTF chunk and model');
  assert.equal(paths.length, expected.size, 'each file once');
}
