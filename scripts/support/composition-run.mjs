// Running C2 composition scenes (scripts/composition-browser-tests.mjs): a hard limit per scene, so a scene that never
// returns fails at once naming itself instead of holding the GPU until the lease monitor reclaims it, and the ANGLE
// backend each row's compatibility pass needs on Windows.

/**
 * Members whose WebGL2 compatibility route does not finish compiling on ANGLE Direct3D 11, Windows' default backend,
 * with the open defect that records it. A row holding one runs its compatibility pass on ANGLE Vulkan on Windows, as
 * the member's own compatibility checks do; the other rows keep the default backend.
 */
export const COMPAT_VULKAN_MEMBERS = new Map([
  ['voxel-pathtracer', 'docs/known-bugs.md, "The path tracer never compiles on ANGLE Direct3D 11 (parked)"'],
]);

/** Browser arguments for the compatibility pass of a row with `members` on `platform`. */
export function compatArgs(members, platform = process.platform) {
  return platform === 'win32' && members.some((m) => COMPAT_VULKAN_MEMBERS.has(m)) ? ['--use-angle=vulkan'] : [];
}

/** `rows` grouped by the browser arguments `argsFor(row)` returns, groups and rows in first-seen order. */
export function groupRows(rows, argsFor) {
  const groups = new Map();
  for (const row of rows) {
    const args = argsFor(row),
      key = JSON.stringify(args);
    if (!groups.has(key)) groups.set(key, { args, rows: [] });
    groups.get(key).rows.push(row);
  }
  return [...groups.values()];
}

/**
 * The most one scene run (both of its pipeline waits and its readbacks) may take: under the GPU lease's 3 minute idle
 * window (scripts/gpu-lock.mjs, MARGO_GPU_IDLE_MIN), so the scene is named before the lease ends the whole run.
 */
export const SCENE_LIMIT_MS = 150_000;

const sleep = (ms) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms).unref?.();
  });

/**
 * Resolves what `run()` resolves. When it has not settled after `limitMs`, rejects with an Error coded
 * ERR_COMPOSITION_STALL naming `label` and the page state `probe()` reports (itself bounded by `probeMs`, since a page
 * blocked in a native call answers nothing). The caller then closes the browser.
 * @template T
 * @param {() => Promise<T>} run
 * @param {{ label: string, limitMs?: number, probe?: () => Promise<string> | string, probeMs?: number }} options
 * @returns {Promise<T>}
 */
export async function runScene(run, { label, limitMs = SCENE_LIMIT_MS, probe = () => '', probeMs = 5_000 }) {
  const pending = Promise.resolve().then(run);
  // Settles after the browser is closed for a stall; that late rejection is not a second failure.
  pending.catch(() => {});
  const stalled = Symbol('stalled');
  let timer;
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => resolve(stalled), limitMs);
  });
  try {
    const result = await Promise.race([pending, deadline]);
    if (result !== stalled) return result;
  } finally {
    clearTimeout(timer);
  }
  const state = await Promise.race([
    Promise.resolve()
      .then(probe)
      .then(
        (s) => String(s),
        (error) => `the probe failed: ${error?.message ?? error}`,
      ),
    sleep(probeMs).then(() => `the page did not answer within ${probeMs / 1000} s`),
  ]);
  throw Object.assign(
    new Error(
      `ERR_COMPOSITION_STALL: ${label} did not finish within ${limitMs / 1000} s; page state: ${state}. ` +
        'See docs/integration-composition.md',
    ),
    { code: 'ERR_COMPOSITION_STALL' },
  );
}
