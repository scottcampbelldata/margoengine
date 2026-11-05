import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { assertSourceBundle, sourceAliases } from './source-bundle.mjs';

export async function backendPlacementModuleCode() {
  const result = await build({
    configFile: false,
    publicDir: false,
    logLevel: 'silent',
    // Every package entry from src: with /gpu from dist its own GPU world registry took the backend 'gpu' worlds, and
    // their placement and hydrology ran on the CPU with the same bytes.
    resolve: { alias: sourceAliases() },
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
  assertSourceBundle(result.output[0]);
  return result.output[0].code;
}
