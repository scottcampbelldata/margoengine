import { cornellScene, positionsOf } from '../../packages/lightmap/scripts/cornell-box.mjs';

/** Reuse batch 168's published Cornell quads, winding, Float32 snap and three-band reflectance. */
export function cornellPicture(point = false) {
  const { quads } = cornellScene(),
    positions = positionsOf(quads);
  const settings = {
    width: 512,
    height: 512,
    camera: { position: [2.78, 2.744, -8], target: [2.78, 2.744, 2.796], fov: 35, near: 0.1, far: 30 },
    light: point
      ? { position: [2.78, 4.8, 1], intensity: 70, color: [1, 1, 1], range: 20 }
      : { direction: [0.2, -0.6, 1], intensity: 3, color: [1, 1, 1] },
    bounds: { min: [-0.1, -0.1, -0.1], max: [5.7, 5.6, 5.7] },
  };
  return {
    settings,
    quads: quads.map((q, i) => ({
      name: q.name,
      albedo: q.albedo,
      positions: Array.from(positions.slice(i * 12, i * 12 + 12)),
    })),
  };
}

/**
 * KB3573 decomposition: diagnostic variants of the frozen shadowed picture (the frozen scene and budgets are
 * unchanged). `light` is merged into the point light and `local` into the LocalShadows options. Range 0 with
 * `shadow.far` equal to the authored range removes only the finite-range window (Karis 2013) and keeps the same
 * shadow camera; larger maps show how much of the residual is shadow-map resolution and 3x3 PCF width.
 */
export function cornellDecomposition(point = false) {
  const noWindow = { range: 0, shadow: { far: 20 } };
  return point
    ? [
        { name: 'no-range-window', light: noWindow },
        { name: 'map-2048', local: { resolution: 2048 } },
        { name: 'map-4096', local: { resolution: 4096 } },
        { name: 'no-range-window-map-4096', light: noWindow, local: { resolution: 4096 } },
      ]
    : [
        { name: 'map-1024', local: { resolution: 1024 } },
        { name: 'map-2048', local: { resolution: 2048 } },
        { name: 'map-4096', local: { resolution: 4096 } },
      ];
}
