// The tile steps the CPU and GPU paths share: which field layers classification needs, and the crop and pack of a
// classified cell rectangle. One copy, used by the root (CPU) and the GPU entry.
import type { Classifier } from './classify.js';
import { LAYERS, type RasterLayer } from './layers.js';

/** True when `names` asks for a classified layer (the fields are then made one cell wider for the blur). */
export const classified = (names: readonly string[]): boolean =>
  names.includes('biome') || names.includes('biomeWeight');

/** The field layers of the wide (1-cell margin) rectangle: the asked ones and the classifier's inputs. */
export const wideNames = (names: readonly string[], c: Classifier): string[] => [
  ...new Set([...names, ...c.inputs.filter((n) => !n.startsWith('mask/'))]),
];

/** The asked layers of a `width` x `depth` rectangle: field layers cropped from `wide`, then the classification. */
export function assemble(
  names: readonly string[],
  wide: ReadonlyMap<string, RasterLayer>,
  ids: Uint8Array,
  weights: Uint8Array,
  width: number,
  depth: number,
): Map<string, RasterLayer> {
  const layers = new Map<string, RasterLayer>(),
    n = width + 2;
  for (const name of names) {
    if (name === 'biome' || name === 'biomeWeight') continue;
    // The interior of a layer computed with a 1-cell margin.
    const layer = wide.get(name)!,
      data = new (layer.data.constructor as Int32ArrayConstructor)(width * depth);
    for (let j = 0; j < depth; j++) data.set(layer.data.subarray((j + 1) * n + 1, (j + 1) * n + 1 + width), j * width);
    layers.set(name, { ...layer, width, depth, data });
  }
  for (const [name, data] of [
    ['biome', ids],
    ['biomeWeight', weights],
  ] as const)
    if (names.includes(name))
      layers.set(name, {
        name,
        format: 'rgba8',
        width,
        depth,
        data,
        scale: LAYERS[name].scale,
        unit: LAYERS[name].unit,
      });
  return layers;
}
