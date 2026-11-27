import { writeFile } from 'node:fs/promises';
import { heavyFiles } from './heavy-files.js';
import { films } from './films.js';
import { ASSET_BASE, ASSET_FALLBACK } from './asset-base.js';

const known = heavyFiles.reduce((sum, file) => sum + (file.bytes ?? 0), 0);
const manifest = {
  assetBase: ASSET_BASE,
  fallback: ASSET_FALLBACK,
  note: 'Upload each file to assetBase + key. Nothing in this list is uploaded by the build. Known bytes count only files that were in the source commit. The rest are missing from git, so their sizes are not in this repository. Keep the total under 10 GB.',
  fileCount: heavyFiles.length,
  knownBytes: known,
  unknownSizeCount: heavyFiles.filter((file) => file.bytes == null).length,
  files: heavyFiles,
};

await writeFile(new URL('./assets-manifest.json', import.meta.url), `${JSON.stringify(manifest, null, 2)}\n`);
await writeFile(
  new URL('../../site/examples/catalog.json', import.meta.url),
  `${JSON.stringify({ films }, null, 2)}\n`,
);
console.log(`${manifest.fileCount} files, known bytes ${known}; ${films.length} films`);
