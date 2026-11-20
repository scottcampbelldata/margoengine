import { copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { distDir } from '../../../scripts/support/dist-dir.mjs';

// build:packages builds into dist-next and swaps it in (scripts/support/dist-dir.mjs).
const dist = distDir(fileURLToPath(new URL('..', import.meta.url)));
// The standard build preserves the lazy asset URL. Ship its feature-local artifact beside the entry.
copyFileSync(new URL('../src/poisson.wasm', import.meta.url), join(dist, 'poisson.wasm'));
