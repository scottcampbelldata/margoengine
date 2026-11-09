// volume-64 field shared by the Margo figure and the VTK.js page. x is fastest.
// A sphere of radius (n - 1) / 2, value 1 at the centre and 0 at the surface, so both
// renderers see the same samples. The scene box matches Figure's default aspect [1, 1, 0.75].

export const N = 64;
export const SIZE = 256;
export const ROUNDS = 7;

/** Dark theme background #0f141c, as linear 0..1 channels. */
export const BACKGROUND = [15 / 255, 20 / 255, 28 / 255];

/** Spacing of the 64-cube in the figure's scene: x and y span 2, z spans 1.5. */
export function sceneSpacing() {
  const span = N - 1;
  return [2 / span, 2 / span, 1.5 / span];
}

/**
 * World step for about 1.5 samples per voxel, the figure default `quality`.
 * Mean spacing over 1.5. VTK.js sample distance is one world step.
 */
export function sampleDistance() {
  const spacing = sceneSpacing();
  return (spacing[0] + spacing[1] + spacing[2]) / 3 / 1.5;
}

/** The volume and the sum of its values. */
export function fillVolume() {
  const data = new Float32Array(N * N * N);
  const c = (N - 1) / 2;
  let sum = 0;
  for (let z = 0; z < N; z++) {
    for (let y = 0; y < N; y++) {
      const slice = N * (y + N * z);
      for (let x = 0; x < N; x++) {
        const value = Math.max(0, 1 - Math.hypot(x - c, y - c, z - c) / c);
        data[slice + x] = value;
        sum += value;
      }
    }
  }
  return { data, sum };
}
