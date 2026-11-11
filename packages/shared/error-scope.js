// Allocation checks for optional packages (KB6434): WebGPU reports a failed createBuffer or createTexture only later,
// to the innermost error scope, or else as `uncapturederror` after frames have used the object. A package that makes
// its resources inside these scopes hears of the failure itself, and can leave them unused until the device confirms
// them, instead of handing core an error that stops every frame.

/**
 * Calls `make()` inside out-of-memory and validation error scopes of `device` and returns `[value, check]`: `check`
 * resolves the GPU error the call raised (an out-of-memory error before a validation error it caused), or null, once
 * the device has checked it. On a device without error scopes (a CPU recorder) `check` is undefined: the value is
 * good at once. A throw from `make` closes the scopes and propagates.
 */
export function scoped(device, make) {
  if (!device.pushErrorScope) return [make(), undefined];
  device.pushErrorScope('out-of-memory');
  device.pushErrorScope('validation');
  let value, check;
  try {
    value = make();
  } finally {
    const validation = device.popErrorScope(),
      memory = device.popErrorScope();
    // A popped scope rejects only when the device is lost: nothing to report then, the restore rebuilds everything.
    check = Promise.all([validation, memory]).then(([v, m]) => m ?? v, () => null);
  }
  return [value, check];
}
