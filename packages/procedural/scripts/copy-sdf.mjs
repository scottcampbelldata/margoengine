import { copyFileSync } from 'node:fs';
copyFileSync(new URL('../src/sdf.wasm', import.meta.url), new URL('../dist/sdf.wasm', import.meta.url));
