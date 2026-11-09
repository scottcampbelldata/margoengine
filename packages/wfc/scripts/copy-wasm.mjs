import { copyFile } from 'node:fs/promises';
// The classic worker receives this one package-relative artifact, shared with chunks.
await copyFile(new URL('../src/wfc.wasm', import.meta.url), new URL('../dist/wfc.wasm', import.meta.url));
