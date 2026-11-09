import { copyFileSync } from 'node:fs';
copyFileSync(new URL('../src/buildings.wasm', import.meta.url), new URL('../dist/buildings.wasm', import.meta.url));
