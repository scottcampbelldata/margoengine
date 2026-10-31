import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Keep WebGPU contexts and Vite builds sequential so shader reloads cannot affect captures.
// Written as `new URL` so check:merge's footprint follows them (scripts/support/affected-gpu.mjs scan).
for (const script of [
  new URL('./gltf-texture-tests.js', import.meta.url),
  new URL('./gltf-ktx2-production-tests.js', import.meta.url),
  new URL('./animation-influences-browser-tests.js', import.meta.url),
  new URL('./gltf-production-assets-tests.js', import.meta.url),
]) {
  execFileSync(process.execPath, [fileURLToPath(script)], { stdio: 'inherit' });
}
