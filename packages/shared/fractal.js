// Octave settings of the fractal sums shared by @margoengine/procedural's CPU noise and @margoengine/shader's GPU twin.

/** `[octaves, lacunarity, gain, frequency]` with the defaults (5, 2, 0.5, 1); RangeError for invalid settings. */
export function fractalOptions({ octaves = 5, lacunarity = 2, gain = 0.5, frequency = 1 }) {
  if (
    !Number.isInteger(octaves) ||
    octaves < 1 ||
    octaves > 16 ||
    ![lacunarity, gain, frequency].every(Number.isFinite)
  )
    throw new RangeError('Invalid fractal options');
  return [octaves, lacunarity, gain, frequency];
}
