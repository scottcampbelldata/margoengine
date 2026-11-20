// The fog a clustered point or spot light really scatters toward the camera, for the volumetric beam checks: each froxel
// column's light integrated along its rays (4,000 steps), with clustered's legacy terms (packages/shared/light-terms.js),
// the isotropic phase 1 / 4 pi (anisotropy 0) and the fog the light crosses on its way from the light to each point.

/** The light one point p takes from `light` (position, range, intensity, optional unit direction and cone angles). */
export function lightAt(light, p, density) {
  const dx = light.position[0] - p[0],
    dy = light.position[1] - p[1],
    dz = light.position[2] - p[2],
    d = Math.hypot(dx, dy, dz);
  if (d >= light.range) return 0;
  const reach = d / light.range,
    fade = Math.min(Math.max(1 - reach ** 4, 0), 1);
  let cone = 1;
  if (light.direction) {
    const along = -(dx * light.direction[0] + dy * light.direction[1] + dz * light.direction[2]) / d,
      lo = Math.cos(light.outerAngle),
      hi = Math.cos(light.innerAngle),
      ramp = Math.min(Math.max((along - lo) / Math.max(hi - lo, 1e-6), 0), 1);
    cone = ramp * ramp * (3 - 2 * ramp);
  }
  return (
    (light.intensity * ((fade * fade) / Math.max(d * d, 2 ** -12)) * cone * Math.exp(-density * d)) / (4 * Math.PI)
  );
}

/**
 * Integrated light per froxel column: `scene` is { grid, range, density, camera: { position, fov, near } } (the camera
 * looks down -Z); each column averages sub x sub rays over its footprint (one ray: its centre; [across, down] for a
 * different count each way), then the 3 x 3 tent the
 * integration applies across columns (clamped at the edges). Returns a Float64Array of grid[0] x grid[1], row major.
 */
export function reference(scene, light, sub) {
  const [subX, subY] = Array.isArray(sub) ? sub : [sub, sub];
  const { grid, range, density, camera } = scene,
    [w, h] = grid,
    aspect = scene.aspect ?? 1,
    t = Math.tan((camera.fov * Math.PI) / 360),
    steps = 4000,
    dt = range / steps,
    direction = light.direction && light.direction.map((v) => v / Math.hypot(...light.direction)),
    lit = { ...light, direction },
    raw = new Float64Array(w * h);
  const column = (x, y) => {
    const dir = [x * t * aspect, y * t, -1],
      stretch = Math.hypot(...dir);
    let sum = 0;
    for (let k = 0; k < steps; k++) {
      const s = (k + 0.5) * dt,
        along = camera.near + s,
        p = [
          camera.position[0] + dir[0] * along,
          camera.position[1] + dir[1] * along,
          camera.position[2] + dir[2] * along,
        ];
      sum += density * lightAt(lit, p, density) * Math.exp(-density * stretch * s) * stretch * dt;
    }
    return sum;
  };
  for (let j = 0; j < h; j++)
    for (let i = 0; i < w; i++) {
      let sum = 0;
      for (let b = 0; b < subY; b++)
        for (let a = 0; a < subX; a++) {
          const u = (i + (a + 0.5) / subX) / w,
            v = (j + (b + 0.5) / subY) / h;
          sum += column(u * 2 - 1, 1 - v * 2);
        }
      raw[j * w + i] = sum / (subX * subY);
    }
  const at = (i, j) => raw[Math.min(Math.max(j, 0), h - 1) * w + Math.min(Math.max(i, 0), w - 1)],
    out = new Float64Array(w * h);
  for (let j = 0; j < h; j++)
    for (let i = 0; i < w; i++) {
      let sum = 0;
      for (let b = -1; b <= 1; b++)
        for (let a = -1; a <= 1; a++) sum += (2 - Math.abs(a)) * (2 - Math.abs(b)) * at(i + a, j + b);
      out[j * w + i] = sum / 16;
    }
  return out;
}
