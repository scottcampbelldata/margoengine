import { copyFileSync } from 'node:fs';
copyFileSync(new URL('../src/fallback.wasm', import.meta.url), new URL('../dist/fallback.wasm', import.meta.url));
copyFileSync(new URL('../src/flow.wasm', import.meta.url), new URL('../dist/flow.wasm', import.meta.url));
