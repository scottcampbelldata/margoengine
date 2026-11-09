import { copyFileSync } from 'node:fs';
copyFileSync(new URL('../src/dungeon.wasm', import.meta.url), new URL('../dist/dungeon.wasm', import.meta.url));
