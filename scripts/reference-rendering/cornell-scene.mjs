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
