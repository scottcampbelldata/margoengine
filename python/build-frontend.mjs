// Builds the margoengine Python package's browser code from python/frontend:
// - margoengine/labextension/: the JupyterLab prebuilt extension (package.json, static/remoteEntry.js and the ES module
//   static/margo-figure.js with @margoengine/sciviz and its dependencies bundled);
// - margoengine/nbextension/index.js: the same code as a classic AMD module, for VS Code notebooks;
// - margoengine/static/margo-figure.iife.js: the same code as a classic script defining globalThis.MargoFigure, which
//   Figure.save_html inlines into standalone pages.
// Run from the repository root after `npm run build:packages`: node python/build-frontend.mjs
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

const here = dirname(fileURLToPath(import.meta.url)),
  out = resolve(here, 'margoengine'),
  entry = resolve(here, 'frontend/figure.ts');
const common = { configFile: false, publicDir: false, logLevel: 'warn', root: here };
await build({
  ...common,
  build: {
    outDir: resolve(out, 'labextension/static'),
    emptyOutDir: true,
    target: 'es2022',
    lib: { entry, formats: ['es'], fileName: () => 'margo-figure.js' },
    rollupOptions: { output: { inlineDynamicImports: true } },
  },
});
await build({
  ...common,
  build: {
    outDir: resolve(out, 'static'),
    emptyOutDir: true,
    target: 'es2022',
    lib: { entry, formats: ['iife'], name: 'MargoFigure', fileName: () => 'margo-figure.iife.js' },
    rollupOptions: { output: { inlineDynamicImports: true } },
  },
});
await copyFile(resolve(here, 'frontend/remoteEntry.js'), resolve(out, 'labextension/static/remoteEntry.js'));
// The classic AMD module (nbextension layout) that VS Code's notebook widget loader finds in the kernel's environment
// (share/jupyter/nbextensions/@margoengine/jupyter/index.js): the IIFE bundle wrapped in define(), returning the
// widget classes built on the loader's @jupyter-widgets/base.
const iife = await readFile(resolve(out, 'static/margo-figure.iife.js'), 'utf8');
await mkdir(resolve(out, 'nbextension'), { recursive: true });
await writeFile(
  resolve(out, 'nbextension/index.js'),
  `define(['@jupyter-widgets/base'], function (base) {\n${iife}\nreturn MargoFigure.widgetClasses(base);\n});\n`,
);
await mkdir(resolve(out, 'labextension'), { recursive: true });
await writeFile(
  resolve(out, 'labextension/package.json'),
  `${JSON.stringify(
    {
      name: '@margoengine/jupyter',
      version: '1.0.0',
      description: 'Margo Engine figures for JupyterLab (the browser side of the margoengine Python package).',
      license: 'Apache-2.0',
      jupyterlab: { extension: './extension', _build: { load: 'static/remoteEntry.js', extension: './extension' } },
    },
    null,
    2,
  )}\n`,
);
console.log('margoengine frontend built: labextension/ and static/margo-figure.iife.js');
