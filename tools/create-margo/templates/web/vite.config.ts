import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    // Vite adds a polyfill for <link rel="modulepreload"> to every build's start-up code. Chrome 66, Firefox 115,
    // Safari 17 and every browser with WebGPU have it built in. An older browser still loads every module, only without
    // the early fetch.
    modulePreload: { polyfill: false },
  },
});
