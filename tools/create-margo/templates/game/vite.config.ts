import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    // The game's start-up code (stage, materials and the glTF model they draw, animation, shadows, sky, physics) is
    // about 675 kB minified, 1.35 times Vite's 500 kB advice; Rapier's solver and Wasm are separate files loaded by
    // Physics.load(). The limit sits just above that, so a chunk that grows past it is still flagged.
    chunkSizeWarningLimit: 700,
  },
});
