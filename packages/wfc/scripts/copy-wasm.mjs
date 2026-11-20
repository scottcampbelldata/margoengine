import { copyFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { distDir } from '../../../scripts/support/dist-dir.mjs';

// build:packages builds into dist-next and swaps it in (scripts/support/dist-dir.mjs).
const dist = distDir(fileURLToPath(new URL('..', import.meta.url)));
// The classic worker receives this one package-relative artifact, shared with chunks.
await copyFile(new URL('../src/wfc.wasm', import.meta.url), join(dist, 'wfc.wasm'));
