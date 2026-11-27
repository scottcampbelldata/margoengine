import { defineConfig } from 'vite';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';
import { films } from './films.js';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../..');
const base = pathToFileURL(resolve(here, 'package.json')).href;

export default defineConfig({
  root: resolve(repo, 'examples'),
  publicDir: false,
  base: './',
  plugins: [
    {
      name: 'published-margo-0.1.0',
      enforce: 'pre',
      async resolveId(source) {
        const published =
          source === 'margoengine' ||
          source === 'web-ifc' ||
          source.startsWith('web-ifc/') ||
          source.startsWith('@margoengine/');
        if (!published) return null;
        try {
          return fileURLToPath(import.meta.resolve(source, base));
        } catch {
          return null;
        }
      },
    },
  ],
  build: {
    outDir: resolve(repo, 'site/dist/examples'),
    emptyOutDir: false,
    target: 'es2022',
    rollupOptions: {
      input: Object.fromEntries(films.map((film) => [`${film.id}/index`, resolve(repo, film.entry)])),
    },
  },
});
