import { copyFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = fileURLToPath(new URL('..', import.meta.url));

/**
 * Copy the repository's LICENSE (Apache-2.0) and NOTICE into a package folder, so its tarball ships both.
 */
export async function copyLegal(packageRoot) {
  await copyFile(resolve(repository, 'LICENSE'), resolve(packageRoot, 'LICENSE'));
  await copyFile(resolve(repository, 'NOTICE'), resolve(packageRoot, 'NOTICE'));
}
