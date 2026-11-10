import { copyFileSync } from 'node:fs';
copyFileSync(
  new URL('../src/decomp-kernel.wasm', import.meta.url),
  new URL('../dist/decomp-kernel.wasm', import.meta.url),
);

copyFileSync(new URL('../src/cpu-kernel.wasm', import.meta.url), new URL('../dist/cpu-kernel.wasm', import.meta.url));
copyFileSync(new URL('../src/onnx-kernel.wasm', import.meta.url), new URL('../dist/onnx-kernel.wasm', import.meta.url));
