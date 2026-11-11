// The proofs of a standing guarantee ("feature off: identical GPU calls"), each with the packages whose source it
// compares or composes. `npm run proofs -- --current` runs them all (verify); package-guard.mjs, appended to each listed
// package's `test` script, runs the ones naming that package, so a change to a package fails its own tests when it moves
// one of these GPU call logs (16 of 20 broke on main on 2026-11-10 because no package test ran them).
// tests/proof-guards.test.js checks this map against the proof sources and the package scripts.
export const ongoing = {
  'clustered-area-lights': ['clustered', 'gltf-pro'],
  'clustered-light-hooks': ['clustered', 'gltf-pro'],
  'clustered-local-shadows': ['clustered', 'gltf-pro'],
  'color-output': ['dof', 'environment', 'post', 'tonemap'],
  'deformed-shadows': ['animation', 'shadows'],
  'environment-hemisphere': ['environment', 'gltf-pro'],
  'environment-volumetric': ['environment'],
  'gltf-pro-lighting-hooks': ['clustered', 'environment', 'gltf-pro', 'shadows'],
  'lines-perspective': ['lines'],
  'materials-uv-transform': ['gltf-pro', 'materials'],
  'math-consolidation': [
    'animation',
    'animator',
    'bvh',
    'controls',
    'creative',
    'environment',
    'exporters',
    'labels',
    'lines',
    'loaders',
    'math',
    'physics',
    'points',
    'scatter',
    'splats',
    'text',
    'usdz',
  ],
  'oit-detached': ['gltf-pro'],
  'post-ssr': ['post'],
  'post-ssr-models': ['post'],
  'post-stack': ['creative', 'dof', 'post', 'tonemap'],
  'quality-presets': ['clustered', 'environment', 'post', 'quality', 'shadows', 'tonemap', 'vfx'],
  'selection-xray-off': ['selection'],
  'taa-velocity': ['taa'],
  'terrain-ssr': ['terrain'],
  'water-ssr': ['water'],
};

/** The ongoing proofs that compare or compose `name` (a package folder name). */
export const guarding = (name) => Object.keys(ongoing).filter((proof) => ongoing[proof].includes(name));
