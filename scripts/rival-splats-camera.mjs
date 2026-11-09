// Camera and picture numbers for the batch 168 splat measurement.
// COLMAP's camera frame (https://colmap.github.io/format.html): x right, y down, z forward.
// The INRIA cameras.json stores position, rotation (three rows), fx and fy. It does not say whether
// rotation is world-to-camera or camera-to-world, so both are scored against the photograph.

/** Vertical field of view in degrees from a pinhole focal length in pixels. */
export function verticalFov(height, fy) {
  return (2 * Math.atan(height / (2 * fy)) * 180) / Math.PI;
}

/**
 * Look-at pose for a Y-up camera that looks toward `target` (Margo and the rival's perspective camera).
 * @param {{ position: number[], rotation: number[][], width: number, height: number, fy: number }} cam
 * @param {'w2c' | 'c2w'} mode `w2c`: rows of a world-to-camera matrix. `c2w`: rows of a camera-to-world matrix.
 */
export function paperPose(cam, mode) {
  const rows = cam.rotation;
  const centre = cam.position;
  const axis = (i) => (mode === 'w2c' ? rows[i] : [rows[0][i], rows[1][i], rows[2][i]]);
  const forward = axis(2);
  const down = axis(1);
  return {
    position: [centre[0], centre[1], centre[2]],
    target: [centre[0] + forward[0], centre[1] + forward[1], centre[2] + forward[2]],
    up: down.map((value) => -value || 0),
    fov: verticalFov(cam.height, cam.fy),
  };
}

/** PSNR in dB of two RGBA buffers, RGB only. Identical buffers are Infinity. */
export function psnrRgb(a, b) {
  if (a.length !== b.length || a.length % 4 !== 0) throw new Error('psnr length');
  let mse = 0;
  const pixels = a.length / 4;
  for (let i = 0; i < a.length; i += 4) {
    const dr = a[i] - b[i];
    const dg = a[i + 1] - b[i + 1];
    const db = a[i + 2] - b[i + 2];
    mse += dr * dr + dg * dg + db * db;
  }
  mse /= pixels * 3;
  if (mse === 0) return Infinity;
  return 10 * Math.log10(65025 / mse);
}

/** Mean absolute RGB difference, 0 to 255. */
export function maeRgb(a, b) {
  if (a.length !== b.length || a.length % 4 !== 0) throw new Error('mae length');
  let sum = 0;
  let count = 0;
  for (let i = 0; i < a.length; i += 4) {
    sum += Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
    count += 3;
  }
  return sum / count;
}
