// The work of the WGSL corpus draw check (corpus-draw-browser.mjs) and its parts. ANGLE's Direct3D shader compiler
// takes 46 to 200 s on a few large kernels (robot-planning's clearance kernels, lightmap's bake), so the whole draw
// needs more than one GPU step's 10 minute limit (KB-COMPAT-CORPUSTIME1). Each part runs as its own package script, so
// each runs every one of its pipelines in full under the limit; the parts together are the whole corpus, each
// pipeline in exactly one (corpus-draw-parts.test.js).

/**
 * Packages whose compute kernels each run in a part of their own, with how many kernels each records: robot-planning's
 * clearance kernels take ANGLE's Direct3D compiler 90 to 200 s each (KB-COMPAT-FXCTIME1), so even two in one step can
 * pass the limit on a busy machine. A kernel recorded beyond the count is in no part and fails the parts test.
 */
export const OWN_COMPUTE_PART = { 'robot-planning': 3 };

/** Every part, in the order a run with no `--part` takes them. */
export const PARTS = [
  'render',
  'compute',
  ...Object.entries(OWN_COMPUTE_PART).flatMap(([name, count]) =>
    Array.from({ length: count }, (_, i) => `compute-${name}-${i + 1}`),
  ),
];

/** The package script that runs a part. */
export const scriptOf = (part) => (part === 'render' ? 'test:browser' : `test:browser:${part}`);

/**
 * The corpus draw's work, from `readCorpus().modules`: every distinct render pipeline (`records`) and compute pipeline
 * (`computes`), each with the `part` it runs in, and the count of the voxel path tracer's compute pipelines, which its
 * own browser-check.mjs --compat runs (ANGLE's Direct3D compiler takes 20 s to several minutes on each).
 */
export function corpusDrawWork(modules) {
  const records = [],
    computes = [],
    seen = new Set();
  let outOfScope = 0;
  for (const m of modules) {
    for (const p of m.pipelines) {
      if (p.compute && p.compute.module === m.key) {
        const id = JSON.stringify(p.compute);
        if (!seen.has(id)) {
          seen.add(id);
          if (m.package === 'voxel-pathtracer') outOfScope++;
          else
            computes.push({
              ...p,
              id: `${m.package} ${m.key} ${p.compute.entryPoint ?? ''}`,
              part: Object.hasOwn(OWN_COMPUTE_PART, m.package) ? m.package : 'compute',
            });
        }
        continue;
      }
      if (p.kind !== 'render' || !p.vertex || p.vertex.module !== m.key) continue;
      const id = JSON.stringify([p.vertex, p.fragment, p.primitive, p.depthStencil, p.multisample]);
      if (seen.has(id)) continue;
      seen.add(id);
      records.push({
        ...p,
        id: `${m.package} ${m.key} ${p.vertex.entryPoint ?? ''}/${p.fragment?.entryPoint ?? ''}`,
        part: 'render',
      });
    }
  }
  // One part each, in the order of their ids: compute-robot-planning-1, -2, ...
  for (const name of Object.keys(OWN_COMPUTE_PART))
    computes
      .filter((r) => r.part === name)
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .forEach((r, i) => (r.part = `compute-${name}-${i + 1}`));
  return { records, computes, outOfScope };
}

/** The parts named by `--part=a,b` in `argv` (every part when there is none); an unknown name throws, naming them. */
export function partsOf(argv) {
  const arg = argv.find((a) => a.startsWith('--part='));
  if (!arg) return PARTS;
  const names = arg.slice('--part='.length).split(',');
  for (const name of names)
    if (!PARTS.includes(name))
      throw new TypeError(`Unknown corpus draw part '${name}'; the parts are ${PARTS.join(', ')}`);
  return names;
}
