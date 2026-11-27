import { libraryParts } from '@margoengine/scenes/library';
import { generateFirSprayLevels } from '@margoengine/procedural/fir-sprays';
import { packedAsset } from '../live/asset-base.js';

// Each rectangle encloses one photographed fir spray, from its leader to its stem.
const atlas = [
  [0.18, 0.041, 0.443, 0.319],
  [0.646, 0.037, 0.963, 0.378],
  [0.295, 0.394, 0.645, 0.784],
  [0.629, 0.444, 0.971, 0.835],
];

function firForm(parts, { height, spread, lean, tint }) {
  return parts.map((part) => ({
    ...part,
    color: part.kind === 'foliage' ? part.color.map((channel, i) => channel * tint[i]) : part.color,
    geometry: part.geometry.map(({ positions, normals, indices }) => {
      const vertices = new Float32Array(positions.length);
      const directions = new Float32Array(normals.length);
      for (let i = 0; i < positions.length; i += 3) {
        const y = positions[i + 1];
        const fraction = y / 19;
        const slope = (2 * lean * fraction) / 19;
        vertices[i] = spread * positions[i] + lean * fraction ** 2;
        vertices[i + 1] = height * y;
        vertices[i + 2] = spread * positions[i + 2];
        const nx = normals[i] / spread;
        const ny = (normals[i + 1] - slope * nx) / height;
        const nz = normals[i + 2] / spread;
        const length = Math.hypot(nx, ny, nz) || 1;
        directions[i] = nx / length;
        directions[i + 1] = ny / length;
        directions[i + 2] = nz / length;
      }
      return { positions: vertices, normals: directions, indices };
    }),
  }));
}

async function image(url, signal) {
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error('Cannot load fir needle map ' + url);
  return createImageBitmap(await response.blob(), { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
}

export async function ridgeTrees(firKey, youngFirKey, timberlineFirKey) {
  const signal = AbortSignal.timeout(15000);
  const [wood, baseColor, normal, occlusionRoughnessMetal] = await Promise.all([
    libraryParts(
      [
        packedAsset('showcase-films/assets/subalpine-fir/fir_tree_01_a_near.gltf'),
        packedAsset('showcase-films/assets/subalpine-fir/fir_tree_01_a_middle.gltf'),
        packedAsset('showcase-films/assets/subalpine-fir/fir_tree_01_a_far.gltf'),
      ],
      { signal },
    ),
    image(packedAsset('showcase-films/assets/subalpine-fir/textures/fir_tree_01_twig_diff_2k.png'), signal),
    image(packedAsset('showcase-films/assets/subalpine-fir/textures/fir_tree_01_twig_nor_gl_2k.jpg'), signal),
    image(packedAsset('showcase-films/assets/subalpine-fir/textures/fir_tree_01_twig_arm_2k.png'), signal),
  ]);

  const rings = generateFirSprayLevels({ regions: atlas });
  const canopyPart = {
    geometry: rings,
    kind: 'foliage',
    color: [0.91, 0.98, 0.86],
    textures: { uvs: rings.map((ring) => ring.uvs), baseColor, normal, occlusionRoughnessMetal, alphaCutoff: 0.36 },
  };
  const fir = [...wood, canopyPart];
  return {
    [firKey]: fir,
    [youngFirKey]: firForm(fir, { height: 0.76, spread: 0.85, lean: -0.49, tint: [0.94, 1, 0.9] }),
    [timberlineFirKey]: firForm(fir, { height: 0.41, spread: 0.72, lean: 1.74, tint: [1, 0.93, 0.83] }),
  };
}
