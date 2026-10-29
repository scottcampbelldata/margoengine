import { margoError } from '../../packages/shared/errors.js';

const unknownIdentity = /^(?:unknown(?:\s.*)?|unavailable|unsupported|none|null|undefined|n\/?a)$/;

function normalizeIdentity(environment) {
  if (!environment || typeof environment !== 'object' || Array.isArray(environment))
    throw new TypeError('Visual baseline environment is missing; capture a known GPU and browser identity');
  const gpu = typeof environment.gpu === 'string' ? environment.gpu.trim().replace(/\s+/g, ' ').toLowerCase() : '',
    gpuSlug = gpu.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  if (!gpuSlug || unknownIdentity.test(gpu))
    throw new TypeError('Visual baseline GPU identity is invalid; capture a known GPU with a nonempty safe name');
  const browser =
      typeof environment.browser === 'string'
        ? /^([a-z][a-z0-9]*(?:-[a-z0-9]+)*)\s+([1-9]\d*(?:\.\d+)*)$/i.exec(environment.browser.trim())
        : null,
    family = browser?.[1].toLowerCase(),
    major = browser ? Number(browser[2].split('.')[0]) : NaN;
  if (!family || unknownIdentity.test(family) || !Number.isSafeInteger(major))
    throw new TypeError('Visual baseline browser identity is invalid; provide a known channel and numeric version');
  return { gpu, gpuSlug, family, major, browser: `${family} ${browser[2]}` };
}

function matches(a, b) {
  return a.gpu === b.gpu && a.family === b.family && a.major === b.major;
}

/** Select the legacy baseline only for the same normalized GPU, browser channel, and browser major version. */
export function selectBaselineProfile(environment, legacyEnvironment) {
  const current = normalizeIdentity(environment),
    legacy = normalizeIdentity(legacyEnvironment);
  if (matches(current, legacy)) return { id: 'legacy', directory: '' };
  const id = `${current.gpuSlug}-${current.family}-${current.major}`;
  return { id, directory: `profiles/${id}` };
}

/** Reject baseline reuse across GPU identities or browser channels/major versions, including colliding safe names. */
export function assertBaselineIdentity(baselineEnvironment, currentEnvironment) {
  if (!matches(normalizeIdentity(baselineEnvironment), normalizeIdentity(currentEnvironment)))
    throw new TypeError(
      'Visual baseline identity differs from this GPU or browser; capture the full view set for this profile',
    );
}

/** Every capture contributing to one noise floor must use the same GPU and exact browser version. */
export function assertCaptureEnvironment(firstEnvironment, currentEnvironment) {
  const first = normalizeIdentity(firstEnvironment),
    current = normalizeIdentity(currentEnvironment);
  if (first.gpu !== current.gpu || first.browser !== current.browser)
    throw margoError(
      'state',
      'Visual capture environment changed during the run; repeat captures on one high-performance GPU and exact browser version',
    );
}

const captureHarnessInputs = new Set([
  'examples/package-benchmarks/parts/power.mjs',
  'examples/package-benchmarks/results/basic-scene-network.json',
  'examples/package-benchmarks/results/entry-sizes.json',
]);

/** Semantic Git diff and untracked NUL path lists, excluding only the capture harness and generated measurements. */
export function renderedInputChanges(...pathLists) {
  const changes = new Set();
  for (const list of pathLists) {
    if (typeof list !== 'string' || (list && !list.endsWith('\0')))
      throw new TypeError('Visual source path records are incomplete; read NUL-terminated Git path lists');
    for (const path of list.split('\0').slice(0, -1))
      if (/^(?:packages|examples|site|apps)\//i.test(path) && !captureHarnessInputs.has(path)) changes.add(path);
  }
  return [...changes];
}

/** Require a complete, unique view set and clean rendered inputs before creating a new visual baseline profile. */
export function assertProfileCreationCoverage(selectedIds, allIds, renderedInputsDirty = false) {
  if (renderedInputsDirty)
    throw margoError(
      'state',
      'Visual profile rendered inputs have uncommitted changes; commit or restore rendered source changes before capturing the reference',
    );
  const validIds = (ids) =>
    Array.isArray(ids) &&
    ids.length > 0 &&
    ids.every((id) => typeof id === 'string' && id.trim().length > 0) &&
    new Set(ids).size === ids.length;
  if (
    !validIds(selectedIds) ||
    !validIds(allIds) ||
    selectedIds.length !== allIds.length ||
    !selectedIds.every((id) => allIds.includes(id))
  )
    throw new TypeError(
      'New profile requires a full view capture; capture every view once without empty or duplicate IDs',
    );
}

/** The failure text when this run's GPU and browser have no committed baseline profile: names the adapter, the committed profiles and the fix. */
export function missingBaselineMessage(profileId, environment, committedProfiles) {
  return (
    `No visual baseline for hardware profile ${profileId}: this run used GPU "${environment.gpu}" in ${environment.browser}, ` +
    `and the committed profiles are ${committedProfiles.length ? committedProfiles.join(', ') : 'none'}. ` +
    'On a PC with two GPUs the adapter depends on whether a Remote Desktop session is connected (Windows lists the GPU that drives the display first). Run with MARGO_GPU=nvidia to use the NVIDIA GPU (MARGO_GPU=default leaves the choice to Windows, so unset it). ' +
    'Only if this hardware is meant to have its own baseline, capture the full committed product reference on it (npm run visual:update)'
  );
}
