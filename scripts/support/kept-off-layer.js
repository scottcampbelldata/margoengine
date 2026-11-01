// Whether a built demo entry keeps its page off the WebGL2 layer: `needsWebGPU(area, { layer: false })`, which a minifier
// writes `{layer:!1}`. scripts/test-no-webgpu-browser.mjs reads this from each page instead of keeping a list by hand.

/** True when the entry's code passes `layer: false`, as written or minified. */
export const keptOffLayer = (code) => /\blayer\s*:\s*(?:false|!1)\b/.test(code);
