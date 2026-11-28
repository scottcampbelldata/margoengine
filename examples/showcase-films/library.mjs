// The asset folder the Node authoring scripts read and write: MARGO_SHOWCASE_ASSETS, or else the showcase-films folder
// of the asset library (MARGO_ASSET_LIBRARY, default ../../Assets/blender-library from the repository, as
// vite.config.mjs serves it at /asset-library/). Assets never go in git.
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repository = fileURLToPath(new URL('../../', import.meta.url));

/** The showcase-films asset folder on disk. */
export function libraryRoot(env = process.env) {
  if (env.MARGO_SHOWCASE_ASSETS) return resolve(env.MARGO_SHOWCASE_ASSETS);
  return join(
    resolve(env.MARGO_ASSET_LIBRARY || resolve(repository, '../../Assets/blender-library')),
    'showcase-films',
  );
}

/** A file URL for one asset path inside {@link libraryRoot}, for example `technical-films/cedar-hall.ifc`. */
export function libraryFile(path, env = process.env) {
  return pathToFileURL(join(libraryRoot(env), path));
}
