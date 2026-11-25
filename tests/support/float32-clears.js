// Page init script for the pick regressions (KB-FX273): every render pass's colour clear values go through float32, as
// Firefox 157 (wgpu) clears an integer target, measured on the RTX A6000 by the browser matrix
// (packages/webgl2-compat/scripts/browser-matrix.mjs): a clear of 4294967295 into r32uint read back 0 and 16777217
// read back 16777216. With it, any browser shows that bug, so the regression tests fail without the fix everywhere.
// Pass it to `page.addInitScript`. Without the WebGPU encoder (the WebGL2 layer's own device) it does nothing.

/** Patches GPUCommandEncoder.beginRenderPass: each array or {r, g, b, a} clear value is rounded to float32, wrapped. */
export function float32Clears() {
  const encoder = globalThis.GPUCommandEncoder?.prototype;
  if (!encoder || encoder.__float32Clears) return;
  encoder.__float32Clears = true;
  // float32 then cast to u32: 2^32 and above wrap, as the measured 4294967295 -> 0.
  const round = (v) => {
    const f = Math.fround(v);
    return f >= 2 ** 32 ? f - 2 ** 32 : f;
  };
  const begin = encoder.beginRenderPass;
  encoder.beginRenderPass = function (descriptor) {
    const colorAttachments = [...(descriptor.colorAttachments ?? [])].map((a) => {
      const c = a?.clearValue;
      if (!c) return a;
      const clearValue = Array.isArray(c)
        ? c.map(round)
        : { r: round(c.r), g: round(c.g), b: round(c.b), a: round(c.a) };
      return { ...a, clearValue };
    });
    return begin.call(this, { ...descriptor, colorAttachments });
  };
}
