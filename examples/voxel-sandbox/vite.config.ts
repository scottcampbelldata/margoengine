import { defineConfig } from 'vite';

// The generator is a module worker (VoxelStreamer starts URL generators with type 'module').
export default defineConfig({
  server: { host: '127.0.0.1' },
  build: { target: 'es2022' },
  worker: { format: 'es' },
});
