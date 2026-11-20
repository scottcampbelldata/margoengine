// Like-for-like output transfer for the Sample Viewer comparison (docs/limits.md, "Sample Viewer like for like").
// The viewer's PNG measures as a pure power curve, pow(x, 1/2.2), with one sample per pixel. Margo writes the exact
// sRGB transfer of IEC 61966-2-1 and resolves 4x MSAA. This rewrite swaps only the final transfer in Margo's WGSL,
// so a like-for-like row measures what is left of the material maths once both pictures share one transfer.

/** Margo's WGSL sRGB encode: select(x*12.92, 1.055*pow(x, 1/2.4) - 0.055, x >= 0.0031308) on one identifier. */
export const SRGB_ENCODE = String.raw`select\((\w+)\*12\.92,1\.055\*pow\(\1,vec3f\(1\.0\/2\.4\)\)-0\.055,\1>=vec3f\(0\.0031308\)\)`;

/** The viewer's measured transfer in the same spot. */
export const GAMMA_22 = 'pow(max($1,vec3f(0)),vec3f(1.0/2.2))';

/** Rewrites every exact sRGB encode of `code` to the viewer's pow(x, 1/2.2); `count` is how many were replaced. */
export function viewerTransfer(code) {
  const re = new RegExp(SRGB_ENCODE, 'g');
  const count = code.match(re)?.length ?? 0;
  return { code: code.replace(re, GAMMA_22), count };
}

/**
 * Page init script: every WGSL module the page creates gets the viewer's transfer, and `window.__viewerTransfer`
 * counts the rewritten encodes so a run can prove the rewrite reached the material shaders.
 */
export function installViewerTransfer({ source, replacement }) {
  const create = GPUDevice.prototype.createShaderModule;
  window.__viewerTransfer = 0;
  GPUDevice.prototype.createShaderModule = function (descriptor) {
    const re = new RegExp(source, 'g');
    window.__viewerTransfer += descriptor.code.match(re)?.length ?? 0;
    return create.call(this, { ...descriptor, code: descriptor.code.replace(re, replacement) });
  };
}
