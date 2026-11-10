// Build a self-contained browser runtime from Margo's installed entries. No external source is fetched.
import { build } from 'vite';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** Bundle the portable viewer, including lazy code and binary/worker assets, for exportStandalone(). */
export async function bundleShareRuntime(options = {}) {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const assets = new Map();
  const inline = {
    name: 'margo-inline-assets',
    enforce: 'pre',
    resolveId(id) {
      if (id.startsWith('node:')) return '\0margo-browser-node';
    },
    load(id) {
      if (id === '\0margo-browser-node')
        return 'export const createRequire=()=>{throw new Error("Node APIs are unavailable in a browser")}; export const readFile=()=>{throw new Error("Node APIs are unavailable in a browser")}; export const fileURLToPath=()=>{throw new Error("Node APIs are unavailable in a browser")};';
    },
    async transform(text, id) {
      if (!/\.[cm]?js$/.test(id)) return;
      const matches = [
        ...text.matchAll(/new URL\(\s*(?:\/\*[^]*?\*\/\s*)?(["'])(\.[^"']+)\1\s*,\s*import\.meta\.url\s*\)/g),
      ];
      for (const match of matches) {
        const path = resolve(dirname(id), match[2].split('?')[0]);
        let uri = assets.get(path);
        if (!uri) {
          let bytes;
          if (/\.[cm]?js$/.test(path)) {
            const worker = await bundle(path, 'es');
            bytes = Buffer.from(worker);
          } else bytes = await readFile(path);
          uri = `data:${path.endsWith('.wasm') ? 'application/wasm' : 'text/javascript'};base64,${Buffer.from(bytes).toString('base64')}`;
          assets.set(path, uri);
        }
        text = text.replace(match[0], `new URL(${JSON.stringify(uri)})`);
      }
      // Runtime identity diagnostics retain a stable module URL without leaking the build machine's paths.
      text = text.replace(
        /\bimport\.meta\.url\b/g,
        JSON.stringify('https://margoengine.invalid/inline/' + relative(root, id).replaceAll('\\', '/')),
      );
      return { code: text, map: null };
    },
  };
  async function bundle(entry, format) {
    const result = await build({
      root,
      configFile: false,
      publicDir: false,
      logLevel: 'warn',
      plugins: [inline],
      build: {
        write: false,
        target: 'es2022',
        minify: true,
        lib: { entry, formats: [format], name: 'MargoShare' },
        rollupOptions: { output: { inlineDynamicImports: true } },
        ...options,
      },
    });
    const output = Array.isArray(result) ? result[0].output : result.output;
    const assets = output.filter((item) => item.type === 'asset');
    if (assets.length)
      throw new Error('Standalone runtime contains external assets: ' + assets.map((item) => item.fileName).join(', '));
    return output.find((item) => item.type === 'chunk' && item.isEntry).code;
  }
  return bundle(resolve(root, 'scripts/share-runtime.mjs'), 'iife');
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const output = process.argv[2];
  if (!output) throw new TypeError('Pass an output JavaScript path');
  await writeFile(output, await bundleShareRuntime());
}
