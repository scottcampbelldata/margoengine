import { copyFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = fileURLToPath(new URL('..', import.meta.url));

/** Packages that keep their own tracked NOTICE: the root NOTICE's lines on top, then their own notices. */
export const OWN_NOTICE = new Set(['brep']);

/**
 * Copy the repository's LICENSE (Apache-2.0) and NOTICE into a package folder, so its tarball ships both. A package
 * in {@link OWN_NOTICE} keeps its tracked NOTICE, which starts with the root NOTICE (tests/supply-chain.test.js).
 */
export async function copyLegal(packageRoot) {
  await copyFile(resolve(repository, 'LICENSE'), resolve(packageRoot, 'LICENSE'));
  if (!OWN_NOTICE.has(basename(packageRoot)))
    await copyFile(resolve(repository, 'NOTICE'), resolve(packageRoot, 'NOTICE'));
}
