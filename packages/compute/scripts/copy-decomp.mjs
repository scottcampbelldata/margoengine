import { copyFileSync } from 'node:fs';
copyFileSync(
  new URL('../src/decomp-kernel.wasm', import.meta.url),
  new URL('../dist/decomp-kernel.wasm', import.meta.url),
);
