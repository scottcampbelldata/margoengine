import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { assertSourceBundle, sourceAliases } from './source-bundle.mjs';

export async function backendModuleCode() {
  const result = await build({
    configFile: false,
    publicDir: false,
    logLevel: 'silent',
    // Every package entry from src, so no dist copy brings its own module state (see source-bundle.mjs).
    resolve: { alias: sourceAliases() },
    build: {
      write: false,
      minify: false,
      target: 'es2022',
      rollupOptions: {
        input: fileURLToPath(new URL('./gpu-backend-source.mjs', import.meta.url)),
        preserveEntrySignatures: 'strict',
        output: { format: 'iife', name: '__margoBackendProof', inlineDynamicImports: true },
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
