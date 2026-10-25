// Every suite, in the order `npm run bench` runs them. Each module's default export is a suite (docs/benchmarking.md
// "Adding a suite"): {name, title, uses: 'none' | 'cpu' | 'gpu', deterministic?, stub?, note?, cases(ctx)}.
export const SUITES = [
  'size',
  'startup',
  'render',
  'objects',
  'scaling',
  'math',
  'gltf',
  'loaders',
  'cad',
  'voxel',
  'physics',
  'memory',
  'compute',
  'viz',
  'react',
];

/** Suites that run only when named (`npm run bench -- features`). */
export const OPT_IN = ['features', 'claims', 'parity'];

export async function loadSuite(name) {
  if (!SUITES.includes(name) && !OPT_IN.includes(name))
    throw new Error(`unknown suite ${name}; one of ${[...SUITES, ...OPT_IN].join(', ')}`);
  return (await import(`./${name}.mjs`)).default;
}
