import { copyFileSync } from 'node:fs';
copyFileSync(new URL('../src/trees.wasm', import.meta.url), new URL('../dist/trees.wasm', import.meta.url));
