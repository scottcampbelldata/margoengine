// Writes library.json at the root of an asset library folder, the index @margoengine/scenes/library reads:
//   node tools/library-index.mjs ../../Assets/blender-library   (the folder that holds the library, relative or absolute)
// Layout it reads: <subject>/<kind>/<id>/<id>_2k.gltf (a model), <subject>/hdri/<id>_2k.hdr (a sky). Textures sit beside
// their model and are not listed. The library folder is never in the repository; only this tool is.
import { readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** The index of the library at `root`: every glTF model and HDR sky, ids unique (a repeat keeps the first and is reported). */
export function indexLibrary(root) {
  const assets = [],
    seen = new Set(),
    repeats = [];
  const add = (asset) => {
    if (seen.has(asset.id)) repeats.push(asset.id);
    else {
      seen.add(asset.id);
      assets.push(asset);
    }
  };
  const dirs = (path) =>
    readdirSync(path, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  for (const subject of dirs(root))
    for (const kind of dirs(join(root, subject))) {
      const base = join(root, subject, kind);
      if (kind === 'hdri') {
        for (const f of readdirSync(base).sort()) {
          const m = /^(.+?)(_[0-9]k)?\.hdr$/.exec(f);
          if (m) add({ id: m[1], subject, kind, type: 'sky', file: `${subject}/${kind}/${f}`, bytes: statSync(join(base, f)).size });
        }
        continue;
      }
      for (const id of dirs(base)) {
        const file = readdirSync(join(base, id))
          .filter((f) => f.endsWith('.gltf'))
          .sort()[0];
        if (file) add({ id, subject, kind, type: 'model', file: `${subject}/${kind}/${id}/${file}`, bytes: statSync(join(base, id, file)).size });
      }
    }
  return { index: { version: 1, assets }, repeats };
}

if (import.meta.url === `file:///${process.argv[1]?.replaceAll('\\', '/')}` || process.argv[1]?.endsWith('library-index.mjs')) {
  const root = process.argv[2] && resolve(process.argv[2]);
  if (!root) {
    console.error('Usage: node tools/library-index.mjs <library folder>');
    process.exitCode = 2;
  } else {
    const { index, repeats } = indexLibrary(root);
    writeFileSync(join(root, 'library.json'), JSON.stringify(index));
    console.log(`${index.assets.length} assets written to ${join(root, 'library.json')}${repeats.length ? `; repeated ids kept once: ${repeats.join(', ')}` : ''}`);
  }
}
