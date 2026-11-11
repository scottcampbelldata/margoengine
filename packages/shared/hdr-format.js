// Whether a colour target holds linear HDR light: every float format does (rgba16float, rgba32float, rg11b10ufloat,
// r16float and the rest), unorm and sRGB formats hold display-encoded values. Shaders that draw into a pass's target
// skip their own display encoding and clamp when this holds. Before 2026-11-11 about 30 places tested for exactly
// rgba16float, so over PostStack's rg11b10ufloat capture (the WebGL2 layer's HDR capture) sky, terrain, water and the
// rest encoded twice and drew up to 19/255 brighter (bug sweep L3; tests/hdr-format.test.js keeps the exact test out).
export const linearHdr = (format) => typeof format === 'string' && format.endsWith('float');
