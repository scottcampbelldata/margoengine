// A package's lazy loaders get a dist chunk of their own (KB-INL1b).
//
// A lazy loader is a source module that loads two or more of its package's own modules with `import()` and has no
// runtime static import, such as packages/splats/src/compressed.ts. Left to the package build, it lands in the
// shared chunk with the helpers its lazy targets import, so each target imports back the chunk that loads it.
// Rolldown 1.2 (Vite 8.3) in an app build then emits those targets even when nothing uses them (one such target
// alone is dropped; Rolldown 1.3 drops them all), and a module they share with the app's entry moves into a chunk of
// its own, which the entry pays for (264 B gzip for PointsPlugin through margoengine/viz). In a chunk of its own the
// loader is imported by no target, so no import() target can reach back to it.
//
// Only a package that has such a loader gets the option: any codeSplitting groups change how Rolldown splits the
// rest of the package, which costs other packages bytes for nothing.
import { readdirSync, readFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

const STATIC_RUNTIME_IMPORT =
  /^\s*(?:import\s+(?!type\b)[^('"`]*?from\s*|import\s*|export\s+(?!type\b)[^;]*?from\s*)['"`]/m;
const RELATIVE_DYNAMIC_IMPORT = /\bimport\(\s*['"`](\.\.?\/[^'"`]+)['"`]/g;

// True when `code` (TypeScript or JavaScript source) is a lazy loader: import() of two or more relative modules and
// no runtime static import.
export function isLazyLoader(code) {
  const stripped = code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const targets = new Set([...stripped.matchAll(RELATIVE_DYNAMIC_IMPORT)].map((match) => match[1]));
  return targets.size >= 2 && !STATIC_RUNTIME_IMPORT.test(stripped);
}

// The output.codeSplitting option for a package build from `src` with these entries ({ name: source path }), or
// undefined when the package has no lazy loader.
export function lazyLoaderChunks(src, entry) {
  const entries = new Set(Object.values(entry).map((path) => resolve(path)));
  const loaders = new Set(
    readdirSync(src, { recursive: true })
      .filter((file) => /\.[cm]?[jt]s$/.test(file) && !file.endsWith('.d.ts'))
      .map((file) => resolve(join(src, file)))
      .filter((path) => !entries.has(path) && isLazyLoader(readFileSync(path, 'utf8'))),
  );
  if (!loaders.size) return undefined;
  const loader = (id) => !id.startsWith('\0') && loaders.has(resolve(id));
  return {
    groups: [
      {
        debugName: 'lazy loaders',
        name: (id) => (loader(id) ? basename(id).replace(/\.[cm]?[jt]s$/, '') : null),
        test: loader,
      },
    ],
  };
}
