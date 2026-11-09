import { copyFileSync } from 'node:fs';
copyFileSync(new URL('../src/erosion.wasm', import.meta.url), new URL('../dist/erosion.wasm', import.meta.url));
