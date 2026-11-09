import { copyFileSync } from 'node:fs';
// The standard build preserves the lazy asset URL. Ship its feature-local artifact beside the entry.
copyFileSync(new URL('../src/poisson.wasm', import.meta.url), new URL('../dist/poisson.wasm', import.meta.url));
