// The class of every file in the repository, for `npm run check:merge` (scripts/support/affected-gpu.mjs decides what
// each class runs; session rule 20: check only what a change can affect, never skip a test the change can affect).
// Pure: a repo-relative path and the package graph in, a class out. Checked in this order:
//   inert (first)     any .md file and the quality baselines (read only by `npm run quality`)
//   lock              root package.json, a lock file or .npmrc: everything (a new workspace dependency changes the
//                     lock file too, so it runs everything; accepted for now)
//   floor             core, stage, shared, the margoengine umbrella or the Rust kernel built into core: everything
//   package           a file of one workspace, its own package.json included: that package and its dependents
//   build-config      biome.json, tsconfig*, rust-toolchain.toml, vite.config.*: everything (it changes every build)
//   check-code        check:merge itself and the driver-reset rerun (CHECK_CODE) and every file the build:packages chain reaches: everything
//   runner            the GPU package runner (RUNNER): the pinned RUNNER_SMOKE tests plus what the change affects
//   wgsl-loose        a WGSL file outside any package: everything
//   unit              tests/*.test.js: verify runs every one; no GPU step
//   visual-baseline   tests/visual/**/<demo>-<tier>.png: that demo's visual check
//   visual-record     any other file under tests/visual (manifest.json): the whole visual check
//   fixture           tests/fixtures/**: the checks whose files reach or name it, else the unit tests only
//   root-browser      tests/browser/**: the root suites whose files reach it, else every root suite
//   proof             examples/package-benchmarks/proofs/**: verify runs `proofs --current` (and fresh-clone again)
//   python            python/**: the Python notebook suite
//   asset             examples/assets/**: the checks whose files reach or name it, else everything
//   script            other scripts/, tests/, examples/, bench/ and tools/ files: the checks whose files reach them
//                     (stepClosure in affected-gpu.mjs); a file no check reaches runs nothing beyond verify
//   inert             documents, site pages, records, licences, dotfiles, .github (no local step runs a workflow)
//   unknown           none of these: everything at run time, and the class gate (tests/file-classes.test.js) fails on
//                     any tracked file in it, naming the file and the fix
const posix = (path) => path.replaceAll('\\', '/');

/** Package directories whose change always runs everything: all depend on, or are, the engine's shared floor. */
export const FULL_DIRS = ['packages/core', 'packages/stage', 'packages/shared', 'packages/margoengine'];

/** check:merge's own decision code and verify: a change here can change what any check runs, so everything runs. */
export const CHECK_CODE = [
  'scripts/check-merge.mjs',
  'scripts/support/affected-gpu.mjs',
  'scripts/support/affected-packages.mjs',
  'scripts/support/file-classes.mjs',
  'scripts/verify.mjs',
  // check-merge.mjs and nearly every GPU check (visual, views, depth, wgsl, the tarball test, the package tests)
  // import it to rerun a step after a GPU driver reset, so a change to it can change any of them.
  'scripts/support/driver-resets.mjs',
];

/**
 * The GPU package runner: it plans, limits, locks and heat-guards the tests but does not change what a test draws
 * (pinned by tests/heat-containment.test.js, tests/gpu-timing-lock.test.js, tests/voxel-pathtracer-gpu-split.test.js),
 * so a change here runs RUNNER_SMOKE (scripts/gpu-package-tests.mjs) plus every test the change affects otherwise.
 */
export const RUNNER = [
  'scripts/gpu-package-tests.mjs',
  'scripts/support/run-limited.mjs',
  'scripts/support/heat.mjs',
  'scripts/support/machine-profile.mjs',
  'scripts/support/machine-profiles.json',
];

/** Every class, and whether a file of it with no other hit runs everything. */
export const CLASSES = {
  lock: 'full',
  floor: 'full',
  package: 'package',
  'build-config': 'full',
  'check-code': 'full',
  runner: 'smoke',
  'wgsl-loose': 'full',
  unit: 'none',
  'visual-baseline': 'demo',
  'visual-record': 'all demos',
  fixture: 'none',
  'root-browser': 'all root suites',
  proof: 'none',
  'quality-baseline': 'none',
  python: 'none',
  asset: 'full',
  script: 'none',
  inert: 'none',
  unknown: 'full',
};

/** The workspace whose directory holds `file` (the deepest one), or undefined. */
export function workspaceOf(workspaces, file) {
  let best;
  for (const w of workspaces) if (file.startsWith(`${w.dir}/`) && (!best || w.dir.length > best.dir.length)) best = w;
  return best;
}

/** The quality gate's recorded baselines: data that only `npm run quality` reads, so a new baseline changes no GPU test. */
export const isQualityBaseline = (file) => /^scripts\/quality\/baselines\/[\w.-]+\.json$/.test(file);

const INERT = [
  /^docs\//,
  /^site\//,
  /^private\//,
  /^api\/[\w.-]+\.api\.md$/,
  /^benchmarks\//,
  /^\.github\//,
  /^public\/favicon\.ico$/,
  /^(LICENSE|NOTICE)$/,
  /^\.(gitignore|gitattributes|editorconfig)$/,
];
const SCRIPT_DIRS = /^(scripts|tests|examples|bench|tools)\//;

/**
 * `{ cls, reason? }` for one repo-relative file. `workspaces` is the package graph; `checkCode` the CHECK_CODE files
 * plus the build:packages closure (affected-gpu.mjs buildCheckCode), CHECK_CODE alone when not given. `reason` is set
 * for the classes that run everything.
 */
export function classify(raw, { workspaces = [], checkCode = CHECK_CODE } = {}) {
  const file = posix(raw),
    machine = checkCode instanceof Set ? checkCode : new Set(checkCode);
  // Documents first, wherever they sit (a package README changes that package's README check, not its GPU tests).
  if (isQualityBaseline(file)) return { cls: 'quality-baseline' };
  if (file.endsWith('.md')) return { cls: 'inert' };
  if (file === 'package.json' || /(^|\/)(package-lock|npm-shrinkwrap)\.json$/.test(file) || /(^|\/)\.npmrc$/.test(file))
    return { cls: 'lock', reason: 'root package.json or lock file changed' };
  const floor = FULL_DIRS.find((d) => file.startsWith(`${d}/`));
  if (floor) return { cls: 'floor', reason: `${floor.slice(9)} changed` };
  // The Rust kernel is no workspace: build-modern.js compiles it to the WebAssembly inside core.
  if (file.startsWith('packages/kernel/'))
    return { cls: 'floor', reason: 'the Rust kernel compiled into core changed' };
  if (workspaceOf(workspaces, file)) return { cls: 'package' };
  if (/^(biome|tsconfig[\w.-]*)\.json$/.test(file) || file === 'rust-toolchain.toml' || /^vite\.config\./.test(file))
    return { cls: 'build-config', reason: 'build configuration changed' };
  if (machine.has(file)) return { cls: 'check-code', reason: 'check code or the package build changed' };
  if (RUNNER.includes(file)) return { cls: 'runner' };
  if (file.endsWith('.wgsl')) return { cls: 'wgsl-loose', reason: 'WGSL outside a package changed' };
  if (INERT.some((re) => re.test(file))) return { cls: 'inert' };
  if (/^tests\/[\w.-]+\.test\.js$/.test(file)) return { cls: 'unit' };
  if (/^tests\/visual\/.*\.png$/.test(file)) return { cls: 'visual-baseline' };
  if (file.startsWith('tests/visual/')) return { cls: 'visual-record' };
  if (file.startsWith('tests/fixtures/')) return { cls: 'fixture' };
  if (file.startsWith('tests/browser/')) return { cls: 'root-browser' };
  if (file.startsWith('examples/package-benchmarks/proofs/')) return { cls: 'proof' };
  if (file.startsWith('python/')) return { cls: 'python' };
  if (file.startsWith('examples/assets/')) return { cls: 'asset' };
  if (SCRIPT_DIRS.test(file)) return { cls: 'script' };
  return { cls: 'unknown', reason: `cannot classify ${file}` };
}

/** The one-line fix for a file the map cannot place (the class gate prints it). */
export const unknownFix = (file) =>
  `${file}: no file class places it; add a rule for it to classify() in scripts/support/file-classes.mjs (and a case to tests/file-classes.test.js), or move it under a folder the map knows`;

/**
 * The visual demo id of a baseline png (`tests/visual/**\/<id>-<tier>.png`, the tier one word such as high, light,
 * phone or model), or undefined when the name matches no demo (the caller then runs every demo).
 */
export function baselineDemo(file, ids) {
  const id = /([\w.-]+)-[a-z]+\.png$/.exec(file)?.[1];
  return id && ids.includes(id) ? id : undefined;
}
