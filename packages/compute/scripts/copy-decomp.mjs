import { copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { distDir } from '../../../scripts/support/dist-dir.mjs';

// build:packages builds into dist-next and swaps it in (scripts/support/dist-dir.mjs).
const dist = distDir(fileURLToPath(new URL('..', import.meta.url)));
copyFileSync(new URL('../src/decomp-kernel.wasm', import.meta.url), join(dist, 'decomp-kernel.wasm'));

copyFileSync(new URL('../src/cpu-kernel.wasm', import.meta.url), join(dist, 'cpu-kernel.wasm'));
copyFileSync(new URL('../src/onnx-kernel.wasm', import.meta.url), join(dist, 'onnx-kernel.wasm'));
