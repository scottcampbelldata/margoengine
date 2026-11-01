import type { PointLight, SpotLight } from './index.js';

/** `shadowBudget` settings. */
export interface ShadowBudgetOptions {
  /** Where the viewer is: nearer and brighter lights choose first. */
  viewer: ArrayLike<number>;
  /** Shadow-map texels all lights may draw together: a point light pays six faces, a spot light one. */
  texels: number;
  /** Largest map per face, the `resolution` of the shadow maps. Default 512. */
  resolution?: number;
  /** Smallest map per face; a light that cannot afford it stops casting. Default 64. */
  minResolution?: number;
  /** Lights that may cast at all, the `maxLights` of the shadow maps. Default 4. */
  maxLights?: number;
}
const faces = (light: PointLight | SpotLight) => ('direction' in light && light.direction ? 1 : 6);
const close = (a: ArrayLike<number>, b: ArrayLike<number>) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/**
 * Shares a budget of shadow texels among the lights with `castShadow`, for `setLights`: lights choose in order of
 * intensity over squared distance, each taking the largest map that leaves the smallest map for those after it and is
 * no larger than the one before it; lights that cannot afford one stop casting. Returns new light objects in the same order; the lights passed in are not changed. Budgets what is drawn each
 * update. The texture array keeps its size, set by `resolution` and `maxLights`.
 * @throws RangeError for a budget or size that is not a positive number, or a minimum above the largest size.
 */
export function shadowBudget<T extends PointLight | SpotLight>(
  lights: readonly T[],
  { viewer, texels, resolution = 512, minResolution = 64, maxLights = 4 }: ShadowBudgetOptions,
): T[] {
  if (!(texels > 0) || !(minResolution >= 16) || !(resolution >= minResolution) || !(maxLights >= 1))
    throw new RangeError(
      'Invalid shadow budget; use texels > 0, resolution >= minResolution >= 16 and maxLights of 1 or more',
    );
  const out = lights.map((light) => ({ ...light })),
    casters = out
      .filter((light) => light.castShadow)
      .map((light) => ({
        light,
        weight: (light.intensity ?? 1) / Math.max(close(light.position, viewer) ** 2, 1e-6),
      }))
      .sort((a, b) => b.weight - a.weight);
  let left = texels,
    largest = resolution;
  const smallest = (light: PointLight | SpotLight) => minResolution * minResolution * faces(light);
  casters.forEach(({ light }, i) => {
    // What the lights after this one need to cast at all stays free.
    let reserve = 0;
    for (let k = i + 1; k < Math.min(casters.length, maxLights); k++) reserve += smallest(casters[k].light);
    let size = i < maxLights ? largest : 0;
    while (size && size * size * faces(light) > left - reserve) size = size >> 1 >= minResolution ? size >> 1 : 0;
    if (!size) {
      light.castShadow = false;
      return;
    }
    largest = size;
    light.shadow = { ...(light.shadow as object), resolution: size };
    left -= size * size * faces(light);
  });
  return out;
}
