import { copyFile, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { distDir } from '../../../scripts/support/dist-dir.mjs';

await import('../../../scripts/build-optional.js');

const root = fileURLToPath(new URL('..', import.meta.url));
const dist = distDir(root);
const nativeAssets = ['mann-fft.wasm', 'surface-energy-kernel.wasm', 'surface-energy-kernel-shared.wasm'];
await Promise.all(nativeAssets.map((file) => copyFile(join(root, 'src', file), join(dist, file))));

// Keep the Wasm external in the package build and in downstream Vite library builds.
// The source ignores the first asset transform. The published URL keeps no-inline for the second.
const chunk = (await readdir(dist)).find((file) => /^turbulence-native-.*\.js$/.test(file));
if (!chunk)
  throw new Error('Weather is missing the Mann FFT loader. Build the turbulence entry with its native chunk.');
const path = join(dist, chunk);
const code = await readFile(path, 'utf8');
const url = /\/\*\s*@vite-ignore\s*\*\/\s*(?=["']\.\/mann-fft\.wasm\?no-inline["'])/g;
const exposed = code.replace(url, '');
if (!exposed.includes('./mann-fft.wasm?no-inline'))
  throw new Error('Weather lost the external Mann FFT URL. Keep its no-inline asset reference in the native chunk.');
if (exposed !== code) await writeFile(path, exposed);
