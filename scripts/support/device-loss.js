// Clear failures when the GPU driver takes a page's WebGPU device away. A driver reset (Windows TDR or a channel reset:
// the System log shows it, for NVIDIA as nvlddmkm event 153) removes the device of whichever page had work running;
// before this, that page never became ready and the check failed only at its timeout (30 s, 120 s for a site view),
// with nothing saying the GPU had gone. Install `deviceLossGuard` as an init script; it reports through the console,
// which `watchDeviceLoss` collects on the Node side:
//   [gpu] lost <json {reason, message, at}>     a device the page created was lost for any reason but destroy()
// Losses a page causes itself with device.destroy() (reason "destroyed": the device-loss and restore checks) are not
// reported. scripts/browser.js installs it in every page it opens; scripts/visual-regression.js in every view's context.

/** Init script: wraps GPUAdapter.prototype.requestDevice to report every device lost other than by destroy(). */
export function deviceLossGuard() {
  if (typeof GPUAdapter === 'undefined' || GPUAdapter.prototype.requestDevice.margoDeviceLossGuard) return;
  const request = GPUAdapter.prototype.requestDevice;
  const guarded = async function (...args) {
    const device = await request.apply(this, args);
    device.lost?.then((info) => {
      if (info?.reason === 'destroyed') return;
      console.debug(
        `[gpu] lost ${JSON.stringify({ reason: info?.reason ?? 'unknown', message: String(info?.message ?? ''), at: new Date().toISOString() })}`,
      );
    });
    return device;
  };
  guarded.margoDeviceLossGuard = true;
  GPUAdapter.prototype.requestDevice = guarded;
}

/** The failure message for a lost device: what happened, when, and what to do. */
export function deviceLossMessage({ reason, message, at }) {
  const time = at ? new Date(at).toLocaleTimeString('en-GB', { hour12: false }) : 'an unknown time';
  return (
    `the page's WebGPU device was lost at ${time} (reason "${reason}"${message ? `: ${message.trim().slice(0, 200)}` : ''}), ` +
    'so it cannot get ready; the GPU driver removed it (a GPU reset: on Windows the System log names it, for NVIDIA ' +
    'nvlddmkm event 153). Run the check again; if it repeats, find what resets the GPU (private/handoffs/bug-queue.md, bug 25)'
  );
}

/**
 * Collects a page's `[gpu] lost` reports in `losses` and makes `page.waitForFunction` reject as soon as one arrives
 * (an Error whose message is deviceLossMessage) instead of at its timeout. Call before the first navigation.
 */
export function watchDeviceLoss(page) {
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
    if (losses.length === 1) {
      const error = new Error(deviceLossMessage(loss));
      error.code = 'gpu-device-lost';
      fail(error);
    }
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
