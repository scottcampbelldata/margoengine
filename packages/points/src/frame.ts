import type { PassContext } from '@margoengine/core/extension';
import { viewMatrix } from '../../shared/view.js';
import { viewSize } from '../../shared/view-rect.js';

/**
 * Fills the frame uniform of the point shaders (`f`, 36 floats) for the view being drawn; `view` is a scratch matrix.
 * Returns whether the camera is orthographic: a clip matrix whose w does not depend on position, such as
 * @margoengine/cameras makes. Pixels per world unit then come from the y row's length, and depth is linear: depth.y is
 * NDC per world unit and the EDL and sphere value is 1 + distance from the near plane.
 */
export function fillFrame(
  f: Float32Array,
  view: Float32Array,
  context: Extract<PassContext, { backend: 'webgpu' }>,
): boolean {
  const camera = context.camera,
    c = camera.matrix,
    orthographic = !(c[3] || c[7] || c[11]);
  f.set(c, 0);
  // Point sizes are pixels of the view being drawn: its camera projects onto its rectangle.
  const [width, height] = viewSize(context);
  f[16] = width;
  f[17] = height;
  f[18] = orthographic ? 0.5 * height * Math.hypot(c[1], c[5], c[9]) : (0.5 * height) / Math.tan((camera.fov * Math.PI) / 360);
  f[19] = context.format.endsWith('-srgb') || context.format.includes('float') ? 0 : 1;
  if (orthographic) {
    f[20] = 0;
    f[21] = Math.hypot(c[2], c[6], c[10]);
    f[22] = 1;
    f[23] = 1;
  } else {
    f[20] = camera.near / (camera.far - camera.near);
    f[21] = (camera.far * camera.near) / (camera.far - camera.near);
    f[22] = camera.near;
    f[23] = 0;
  }
  // Camera basis (right, up, back), matching Camera.update including camera.up.
  const v = viewMatrix(view, camera);
  f[24] = v[0];
  f[25] = v[4];
  f[26] = v[8];
  f[27] = 0;
  f[28] = v[1];
  f[29] = v[5];
  f[30] = v[9];
  f[31] = 0;
  f[32] = v[2];
  f[33] = v[6];
  f[34] = v[10];
  f[35] = 0;
  return orthographic;
}
