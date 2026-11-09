import { copyFileSync } from 'node:fs';
copyFileSync(new URL('../src/caves.wasm', import.meta.url), new URL('../dist/caves.wasm', import.meta.url));
