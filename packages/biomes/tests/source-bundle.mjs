// The hardware checks bundle the package from src. Every `@margoengine/biomes/<entry>` that a source loads by package
// name must resolve to src too: a name left to node_modules pulls in the built dist copy, whose module state (the GPU
// world registry, the erosion hook) is not the one src reads, and a check then passes while the GPU stage it names
// never ran (the Beelink "GPU stage was not exercised: counts" failure, 2026-11-05).
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Vite aliases from every export of package.json to its src file, each matched exactly. */
export function sourceAliases() {
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  return Object.entries(manifest.exports).map(([key, entry]) => {
    const name = entry.import.slice('./dist/'.length, -'.js'.length),
      ts = new URL(`../src/${name}.ts`, import.meta.url),
      specifier = manifest.name + key.slice(1);
    return {
      find: new RegExp('^' + specifier.replace(/[/.]/g, '\\$&') + '$'),
      replacement: fileURLToPath(existsSync(ts) ? ts : new URL(`../src/${name}.tsx`, import.meta.url)),
    };
  });
}

/**
 * Throws when a bundled chunk holds any module of the built package (dist) instead of its source.
 * @param {{ moduleIds?: string[], modules?: object }} chunk A rolldown/rollup output chunk.
 */
export function assertSourceBundle(chunk) {
  const ids = chunk.moduleIds ?? Object.keys(chunk.modules ?? {}),
    built = ids.filter((id) => /[\\/]biomes[\\/]dist[\\/]/.test(id));
  if (!ids.length) throw Error('Bundle lists no modules to check');
  if (built.length)
    throw Error('Hardware check bundle mixes in the built package instead of src: ' + built.slice(0, 4).join(', '));
}
