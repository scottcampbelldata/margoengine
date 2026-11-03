import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

export async function backendPlacementModuleCode() {
  const result = await build({
    configFile: false,
    publicDir: false,
    logLevel: 'silent',
    resolve: {
      alias: {
        '@margoengine/biomes/toolkit': fileURLToPath(new URL('../src/toolkit.ts', import.meta.url)),
        '@margoengine/biomes/region': fileURLToPath(new URL('../src/region.ts', import.meta.url)),
        '@margoengine/biomes/relief': fileURLToPath(new URL('../src/relief.ts', import.meta.url)),
        '@margoengine/biomes/presets': fileURLToPath(new URL('../src/presets.ts', import.meta.url)),
        '@margoengine/biomes/workers': fileURLToPath(new URL('../src/workers.ts', import.meta.url)),
        '@margoengine/biomes/digest': fileURLToPath(new URL('../src/digest.ts', import.meta.url)),
      },
    },
    build: {
      write: false,
      minify: false,
      target: 'es2022',
      rollupOptions: {
        input: fileURLToPath(new URL('./gpu-backend-placement-source.mjs', import.meta.url)),
        preserveEntrySignatures: 'strict',
        output: { format: 'iife', name: '__margoBackendPlacementProof' },
      },
    },
  });
  assert.ok(
    !Array.isArray(result) && result.output.length === 1 && result.output[0].type === 'chunk',
    'Backend proof must be one browser bundle',
  );
  return result.output[0].code;
}
