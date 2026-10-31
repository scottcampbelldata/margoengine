// Clear failures when the GPU driver takes a page's WebGPU device away. A driver reset (Windows TDR or a channel reset:
// the System log shows it, for NVIDIA as nvlddmkm event 153) removes the device of every page on that GPU, and for a
// moment after it a new device cannot be created (Dawn's D3D12 backend: "create command queue failed with
// E_OUTOFMEMORY" or DXGI_ERROR_DEVICE_REMOVED). Before this, such a page never became ready and the check failed only at
// its timeout (30 s, 120 s for a site view), with nothing saying the GPU had gone. Install `deviceLossGuard` as an init
// script; it reports through the console, which `watchDeviceLoss` collects on the Node side:
//   [gpu] lost <json {reason, message, at}>     a device the page created was lost for any reason but destroy(), or
//                                               requestDevice failed with a driver error (reason "request-failed")
// The Node side then looks the reset up in the Windows event log (support/driver-resets.mjs) and names it in the
// failure, or says that none was logged. Losses a page causes itself with device.destroy() (reason "destroyed": the
// device-loss and restore checks) are not reported. scripts/browser.js installs it in every page it opens;
// scripts/visual-regression.js in every view's context.
import { confirmed, describeResets, driverResets } from './driver-resets.mjs';

/**
 * Init script: wraps GPUAdapter.prototype.requestDevice to report every device lost other than by destroy(), and every
 * requestDevice that fails with a driver error (the device a reset would not let the page create).
 */
export function deviceLossGuard() {
  if (typeof GPUAdapter === 'undefined' || GPUAdapter.prototype.requestDevice.margoDeviceLossGuard) return;
  const request = GPUAdapter.prototype.requestDevice;
  const report = (reason, message) =>
    console.debug(
      `[gpu] lost ${JSON.stringify({ reason, message: String(message ?? ''), at: new Date().toISOString() })}`,
    );
  const guarded = async function (...args) {
    let device;
    try {
      device = await request.apply(this, args);
    } catch (error) {
      // Only driver failures: a bad descriptor (a TypeError or a limit the adapter lacks) is the page's own mistake.
      if (
        /D3D1[12]|DXGI|E_OUTOFMEMORY|VK_ERROR_DEVICE_LOST|device (was )?(lost|removed|hung)/i.test(
          String(error?.message),
        )
      )
        report('request-failed', error.message);
      throw error;
    }
    device.lost?.then((info) => {
      if (info?.reason === 'destroyed') return;
      report(info?.reason ?? 'unknown', info?.message);
    });
    return device;
  };
  guarded.margoDeviceLossGuard = true;
  GPUAdapter.prototype.requestDevice = guarded;
}

/**
 * The failure message for a lost device: what happened, when, whether the event log shows a GPU driver reset
 * (`resets`, from driverResets; undefined when not looked up) and what to do.
 */
export function deviceLossMessage({ reason, message, at }, resets) {
  const time = at ? new Date(at).toLocaleTimeString('en-GB', { hour12: false }) : 'an unknown time',
    detail = message ? `: ${message.trim().slice(0, 200)}` : '';
  const what =
    reason === 'request-failed'
      ? `the page could not get a WebGPU device at ${time} (requestDevice failed${detail})`
      : `the page's WebGPU device was lost at ${time} (reason "${reason}"${detail})`;
  if (resets && confirmed(resets))
    return (
      `${what}, so it cannot get ready: the GPU driver reset the GPU (${describeResets(resets)}). A reset removes the ` +
      'WebGPU device of every page on that GPU, so this page may only have been the one that was using it; check:merge ' +
      'runs the step once more after a confirmed reset. If resets repeat, see bug 25 (scripts/support/driver-resets.mjs)'
    );
  if (resets) {
    const why = describeResets(resets);
    return (
      `${what}, so it cannot get ready. ${why ? `${why[0].toUpperCase()}${why.slice(1)}` : 'No GPU driver reset is logged in the Windows event log around then'}` +
      ", so something else took the device: a crash of the browser's GPU process, or the page's own GPU work. Run the " +
      'check again; if it repeats, it is a bug to find (bug 25, scripts/support/driver-resets.mjs)'
    );
  }
  return (
    `${what}, so it cannot get ready; the GPU driver or the browser removed it (a GPU reset, or a crash of the ` +
    "browser's GPU process). Run the check again; if it repeats, find what resets the GPU (bug 25, scripts/support/driver-resets.mjs)"
  );
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Looks up the driver resets around a loss. A driver logs its reset after it recovers, a few seconds after the page
 * saw the device go, so it asks again for up to `settleMs` before deciding none was logged. Returns undefined where the
 * log is not read (not Windows).
 */
export async function resetsAround(
  loss,
  { lookup = driverResets, settleMs = 8000, poll = 1000, platform = process.platform } = {},
) {
  if (platform !== 'win32') return undefined;
  const at = Date.parse(loss.at) || Date.now(),
    since = new Date(at - 30_000),
    deadline = Date.now() + settleMs;
  for (;;) {
    const resets = lookup({ since, until: new Date() });
    if (confirmed(resets) || Date.now() >= deadline) return resets;
    await sleep(poll);
  }
}

/**
 * Collects a page's `[gpu] lost` reports in `losses` and makes `page.waitForFunction` reject as soon as one arrives
 * and its driver reset is looked up (an Error whose message is deviceLossMessage, printed once with `log` as well, for
 * a suite that fails through page.evaluate rather than a wait) instead of at its timeout. Call before the first
 * navigation. `options` go to resetsAround (tests pass a stand-in lookup).
 */
export function watchDeviceLoss(page, { log = (line) => console.error(line), ...options } = {}) {
  const losses = [];
  let fail;
  const lost = new Promise((_, reject) => {
    fail = reject;
  });
  lost.catch(() => {});
  page.on('console', (m) => {
    const text = m.text();
    if (!text.startsWith('[gpu] lost ')) return;
    let loss;
    try {
      loss = JSON.parse(text.slice('[gpu] lost '.length));
    } catch {
      loss = { reason: 'unknown', message: text.slice('[gpu] lost '.length) };
    }
    losses.push(loss);
    if (losses.length !== 1) return;
    resetsAround(loss, options).then(
      (resets) => {
        const error = new Error(deviceLossMessage(loss, resets));
        error.code = 'gpu-device-lost';
        error.driverResets = resets ?? [];
        log(`[gpu] ${error.message}`);
        fail(error);
      },
      (error) => fail(error),
    );
  });
  const waitForFunction = page.waitForFunction.bind(page);
  page.waitForFunction = (...args) => {
    const waiting = waitForFunction(...args);
    // The losing branch of the race still settles later (its own timeout): keep that from going unhandled.
    waiting.catch(() => {});
    return Promise.race([waiting, lost]);
  };
  return { losses };
}
