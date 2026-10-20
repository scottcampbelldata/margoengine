// CPU reference of clusterProjector (src/projector.ts) for tests and the real-GPU check, built on localShadowMatrix (the
// spot's local shadow map camera) rather than mirroring the WGSL: the projected colour at world `point` of a spot light
// (`position`, unit `direction`, `outerAngle`) with `entry` ({image, colorSpace, angle, aspect}).
import { localShadowMatrix } from '../src/local-shadow-math.ts';
const decode = (byte, srgb) => {
  const c = byte / 255;
  return !srgb ? c : c > 0.04045 ? ((c + 0.055) / 1.055) ** 2.4 : c / 12.92;
};
/** UV of `point` in the spot's projection (localShadowMatrix, aspect applied), or null behind the light. */
export function projectorUV(light, point, { angle, aspect = 1 } = {}) {
  const m = new Float32Array(16),
    d = light.direction,
    up = Math.abs(d[1]) / Math.hypot(...d) > 0.99 ? [0, 0, 1] : [0, 1, 0];
  localShadowMatrix(m, 0, light.position, d, up, 0.01, 100, 2 * (angle ?? light.outerAngle));
  const p = [...point, 1],
    clip = [0, 1, 3].map((r) => m[r] * p[0] + m[4 + r] * p[1] + m[8 + r] * p[2] + m[12 + r]);
  if (clip[2] <= 0) return null;
  return [(clip[0] / clip[2] / aspect) * 0.5 + 0.5, (clip[1] / clip[2]) * -0.5 + 0.5];
}
/** Linear RGB the projector multiplies its light by at `point`: bilinear, edges clamped, alpha premultiplied; 0 outside. */
export function projectorColor(light, point, entry) {
  const uv = projectorUV(light, point, entry);
  if (!uv || uv.some((v) => v < 0 || v > 1)) return [0, 0, 0];
  const { image, colorSpace = 'srgb' } = entry,
    srgb = colorSpace === 'srgb',
    texel = (x, y) => {
      const cx = Math.min(image.width - 1, Math.max(0, x)),
        cy = Math.min(image.height - 1, Math.max(0, y)),
        at = (cy * image.width + cx) * 4,
        a = image.data[at + 3] / 255;
      return [0, 1, 2].map((k) => decode(image.data[at + k], srgb) * a);
    };
  const tx = uv[0] * image.width - 0.5,
    ty = uv[1] * image.height - 0.5,
    x = Math.floor(tx),
    y = Math.floor(ty),
    fx = tx - x,
    fy = ty - y,
    mix = (p, q, f) => p.map((v, k) => v + (q[k] - v) * f);
  return mix(mix(texel(x, y), texel(x + 1, y), fx), mix(texel(x, y + 1), texel(x + 1, y + 1), fx), fy);
}
/** A w x h image whose texel (x, y) is `color(x, y)` (rgba bytes). */
export function image(w, h, color) {
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data.set(color(x, y), (y * w + x) * 4);
  return { width: w, height: h, data };
}
