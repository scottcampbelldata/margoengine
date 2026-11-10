// Bundle the AFM, its optional codecs and their lazy assets locally. No runtime CDN or Python rendering.
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { bundleShareRuntime } from '../packages/sciviz/scripts/bundle-share.mjs';

const runtime = await bundleShareRuntime({ lib: { entry: resolve(import.meta.dirname, 'frontend/notebook.ts'), formats: ['es'] } });
const output = resolve(import.meta.dirname, 'margoengine/static');
await mkdir(output, { recursive: true });
await writeFile(resolve(output, 'sciviz-notebook.js'), runtime);
console.log(`Notebook AFM built locally: ${Buffer.byteLength(runtime)} bytes`);
