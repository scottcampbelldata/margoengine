// GPU progress of a running browser-check case, so a stall fails fast and names its case and step instead of using up
// the suite's whole time limit in silence. On an Intel Arc 140V the denoise case started at 172 s and printed nothing
// until the test runner killed it at 900 s: it traces six 480 x 300 references at 16384 samples (about 15,400
// submissions, 170 s of GPU work on an RTX A6000), so a slow GPU and a GPU wait that never resolves looked the same.
// - The page counts finished GPU work (onSubmittedWorkDone and mapAsync that settle, compiled pipelines, finished
//   renderImage calls) and remembers the last renderImage it started and any lost device or uncaptured WebGPU error.
// - While a case runs, Node reads that count every second: a case whose count does not move for MARGO_GPU_STALL_S
//   (120 s) fails, naming the case, its last `progress` step, the render and how long it waited.
// - `--stall-in-render=<k>` (the stand-in tests/stall-check.mjs uses): once the case's k-th renderImage has started, no
//   GPU wait settles (onSubmittedWorkDone and mapAsync never resolve), as on a device that stopped answering without
//   being lost.

/** Page side, run once after the page is ready: the counters in `window.__progress` and the stall stand-in. */
export async function installProgress(page, { stallInRender = 0 } = {}) {
  await page.evaluate(async (stallInRender) => {
    const p = (window.__progress = { events: 0, submits: 0, renders: 0, rendered: 0, stage: '', lost: '', error: '' });
    const never = new Promise(() => {}),
      stalled = () => stallInRender > 0 && p.renders >= stallInRender,
      tick = (value) => {
        p.events++;
        return value;
      };
    const queue = GPUQueue.prototype,
      { submit, onSubmittedWorkDone } = queue,
      { mapAsync } = GPUBuffer.prototype,
      { createCommandEncoder } = GPUDevice.prototype,
      seen = new WeakSet();
    queue.submit = function (buffers) {
      p.submits++;
      return submit.call(this, buffers);
    };
    queue.onSubmittedWorkDone = function () {
      return stalled() ? never : onSubmittedWorkDone.call(this).then(tick);
    };
    GPUBuffer.prototype.mapAsync = function (...args) {
      return stalled() ? never : mapAsync.apply(this, args).then(tick);
    };
    // Every device that records work: its loss and its uncaptured errors (the page's own handlers stay).
    GPUDevice.prototype.createCommandEncoder = function (...args) {
      if (!seen.has(this)) {
        seen.add(this);
        this.lost.then((info) => (p.lost = `${info.reason}: ${info.message}`));
        this.addEventListener('uncapturederror', (e) => (p.error = e.error.message));
      }
      return createCommandEncoder.apply(this, args);
    };
    const { VoxelPathTracer } = await import('/packages/voxel-pathtracer/dist/index.js'),
      { renderImage } = VoxelPathTracer.prototype;
    VoxelPathTracer.prototype.renderImage = function (o) {
      p.renders++;
      p.stage = `renderImage ${o.width}x${o.height} ${o.samples} spp${o.denoise ? ' denoised' : ''} (#${p.renders})`;
      return renderImage.call(this, o).finally(() => p.rendered++);
    };
  }, stallInRender);
}

const POLL_MS = 1000;

/** The page's progress, or undefined when it does not answer within 5 polls (its thread busy or gone). */
async function snapshot(page) {
  let timer;
  const late = new Promise((resolve) => (timer = setTimeout(resolve, 5 * POLL_MS))),
    read = page
      .evaluate(() => {
        const p = window.__progress,
          pipelines = globalThis.__margoPipelines;
        return {
          ...p,
          compiling: pipelines?.pending ?? 0,
          count: p.events + p.rendered + (pipelines ? pipelines.created - pipelines.pending : 0),
        };
      })
      .catch(() => undefined);
  try {
    return await Promise.race([read, late]);
  } finally {
    clearTimeout(timer);
  }
}

/** Seconds from MARGO_GPU_STALL_S (default 120). */
export function stallLimitMs(value = process.env.MARGO_GPU_STALL_S) {
  const seconds = Number(value ?? 120);
  if (!(seconds > 0))
    throw new RangeError(`MARGO_GPU_STALL_S must be a positive number of seconds, such as 120; got ${value}`);
  return seconds * 1000;
}

/**
 * Resolves `work` (a case's page.evaluate) while the page makes GPU progress; rejects naming `name` and `step()` (the
 * case's last progress line) when nothing finishes on the GPU for `stallMs`. `gaps.longestMs` is set to the longest
 * time the case went without finished GPU work (the margin against the limit).
 */
export async function watched(page, name, work, { stallMs = stallLimitMs(), step = () => name, gaps = {} } = {}) {
  const t0 = performance.now();
  let outcome;
  const settled = work.then(
    (value) => (outcome = { value }),
    (error) => (outcome = { error }),
  );
  let last,
    lastChange = t0;
  gaps.longestMs = 0;
  for (;;) {
    if (outcome) break;
    // The next poll, or the case's end, whichever comes first (a short case is not held to a whole poll).
    let timer;
    await Promise.race([settled, new Promise((resolve) => (timer = setTimeout(resolve, POLL_MS)))]); // fixed-wait: watchdog poll interval
    clearTimeout(timer);
    if (outcome) break;
    const s = await snapshot(page),
      now = performance.now();
    if (outcome) break;
    if (s && s.count !== last?.count) {
      gaps.longestMs = Math.max(gaps.longestMs, now - lastChange);
      lastChange = now;
    }
    if (s) last = s;
    if (now - lastChange > stallMs) {
      const state = last
        ? `${last.stage || 'no renderImage yet'}; ${last.rendered} of ${last.renders} renders done, ${last.submits} submissions, ${last.compiling} pipelines compiling${last.lost ? `; device lost (${last.lost})` : ''}${last.error ? `; uncaptured WebGPU error: ${last.error}` : ''}`
        : 'the page never answered';
      throw new Error(
        `${name}: GPU stall, no GPU work finished for ${Math.round((now - lastChange) / 1000)} s (limit ${stallMs / 1000} s, ${Math.round((now - t0) / 1000)} s into the case) at step "${step()}": ${state}${s ? '' : '; the page is not answering'}`,
      );
    }
  }
  gaps.longestMs = Math.max(gaps.longestMs, performance.now() - lastChange);
  if (outcome.error) throw outcome.error;
  return outcome.value;
}
