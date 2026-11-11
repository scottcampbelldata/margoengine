// Running C2 composition scenes (scripts/composition-browser-tests.mjs): a hard limit per scene, so a scene that never
// returns fails at once naming itself instead of holding the GPU until the lease monitor reclaims it. Every row's
// compatibility pass runs on the browser's default ANGLE backend (Direct3D 11 on Windows), the voxel path tracer's
// included since its staged route compiles there (packages/voxel-pathtracer, test:gpu:d3d11).

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
