import { copyFileSync } from 'node:fs';
copyFileSync(new URL('../src/fallback.wasm', import.meta.url), new URL('../dist/fallback.wasm', import.meta.url));
