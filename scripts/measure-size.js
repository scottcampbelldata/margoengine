import { build } from 'vite';
import { gzipSync } from 'node:zlib';
import { pathToFileURL } from 'node:url';
import { isAbsolute, resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { checkCoreBudget, CORE_STAGE_GZIP_LIMIT } from './core-budget.js';

export const compactOutput = {
  minify: { compress: { dropDebugger: true }, mangle: true, codegen: true },
  comments: { annotation: true },
};
export const external = [
  '@margoengine/core',
  '@margoengine/core/extension',
  '@margoengine/animation',
  '@margoengine/gltf-pro',
  '@margoengine/blender',
  '@margoengine/gltf',
  '@margoengine/creative',
  '@margoengine/scenery',
  '@margoengine/environment',
  '@margoengine/controls',
  '@margoengine/shadows',
  '@margoengine/decoders',
  '@margoengine/decoders/brotli',
  '@margoengine/decoders/meshopt',
  '@margoengine/decoders/texture',
  'margoengine',
  '@margoengine/stage',
  'react',
  'react/jsx-runtime',
  '@margoengine/creative/particles',
  '@margoengine/creative/post',
  '@margoengine/scenery/sky',
  '@margoengine/vfx',
  '@margoengine/sky',
  /^@margoengine\/(sky|vfx)\//,
];
// The React barrel exposes optional integrations; their separately installed peers are not React's own bytes.
for (const peer of Object.keys(
  JSON.parse(readFileSync(new URL('../packages/react/package.json', import.meta.url), 'utf8')).peerDependencies,
)) {
  if (!peer.startsWith('@margoengine/core'))
    external.push(new RegExp('^' + peer.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?:/|$)'));
}

/** True for a bare import (another package): entry sizes leave those external, as apps share them. */
export const bare = (id) => !id.startsWith('.') && !isAbsolute(id) && !/^[a-z]:[\\/]/i.test(id) && !id.startsWith('\0');

async function bundleChunks(entry, external) {
  const output = await build({
    configFile: false,
    publicDir: false,
    logLevel: 'silent',
    build: {
      write: false,
      minify: true,
      target: 'es2022',
      lib: { entry, formats: ['es'] },
      rollupOptions: { external, output: compactOutput },
    },
  });
  return (Array.isArray(output) ? output[0] : output).output.filter((item) => item.type === 'chunk');
}

/** The minified es2022 bundle of `entry` as build-modern makes it, with `external` imports left out. */
export async function bundleBytes(entry, external = bare) {
  return Buffer.from((await bundleChunks(entry, external)).map((item) => item.code).join('\n'));
}

/**
 * The same bundle split at a lazy boundary: `lazy` matches the file names of the chunks an `import()` loads on demand
 * (rollup hashes the names, so it is a pattern such as /^runtime-/). `base` joins every chunk the entry loads without
 * touching a lazy chunk (static imports and the other dynamic imports, which `install()`-style entries make on first
 * call); `lazy` joins the chunks only a lazy chunk reaches. `staticLazy` lists lazy chunks that some chunk imports
 * statically, which would make the boundary a lie.
 */
export async function bundleSplit(entry, lazy, external = bare) {
  const chunks = await bundleChunks(entry, external),
    byName = new Map(chunks.map((chunk) => [chunk.fileName, chunk])),
    isLazy = (name) => lazy.test(name);
  const reach = (starts, skipLazyDynamic) => {
    const seen = new Set(),
      visit = (name) => {
        if (seen.has(name) || !byName.has(name)) return;
        seen.add(name);
        const chunk = byName.get(name);
        for (const next of chunk.imports) visit(next);
        for (const next of chunk.dynamicImports) if (!(skipLazyDynamic && isLazy(next))) visit(next);
      };
    starts.forEach(visit);
    return seen;
  };
  const staticLazy = chunks.flatMap((chunk) =>
    chunk.imports.filter(isLazy).map((name) => `${chunk.fileName} -> ${name}`),
  );
  const base = reach([chunks.find((chunk) => chunk.isEntry).fileName], true),
    lazyOnly = new Set(
      [
        ...reach(
          chunks.filter((chunk) => isLazy(chunk.fileName)).map((chunk) => chunk.fileName),
          false,
        ),
      ].filter((name) => !base.has(name)),
    );
  const join = (names) => Buffer.from([...names].map((name) => byName.get(name).code).join('\n'));
  return {
    base: join(base),
    lazy: join(lazyOnly),
    baseChunks: [...base],
    lazyChunks: [...lazyOnly],
    staticLazy,
    chunks,
  };
}

export async function measureCoreStage() {
  const output = await build({
    configFile: false,
    publicDir: false,
    logLevel: 'silent',
    build: {
      write: false,
      minify: true,
      target: 'es2022',
      lib: { entry: 'packages/stage/dist/index.js', formats: ['es'] },
      rollupOptions: {
        external: external.filter((name) => typeof name !== 'string' || !name.startsWith('@margoengine/core')),
        output: compactOutput,
      },
    },
  });
  const chunks = output[0].output.filter((item) => item.type === 'chunk');
  const code = chunks.map((chunk) => chunk.code).join('\n');
  const gzip = gzipSync(code).length;
  checkCoreBudget(gzip);
  return { raw: Buffer.byteLength(code), gzip, modules: chunks.flatMap((chunk) => Object.keys(chunk.modules)) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { raw, gzip } = await measureCoreStage();
  console.log(
    JSON.stringify(
      { package: 'margoengine', raw, gzip, limit: CORE_STAGE_GZIP_LIMIT, baseline: 19_999, delta: gzip - 19_999 },
      null,
      2,
    ),
  );
}
