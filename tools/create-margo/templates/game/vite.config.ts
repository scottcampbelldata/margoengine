import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    // Rapier ships its WebAssembly inside its JavaScript (about 4.3 MB, 1.7 MB gzip). It is its own chunk, loaded only
    // when the game creates a physics world, so Vite's 500 kB advice does not apply to it. Lower this limit if you
    // drop physics, so a large chunk of your own code is flagged again.
    chunkSizeWarningLimit: 4500,
  },
});
