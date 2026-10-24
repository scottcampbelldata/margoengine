/** Octave sum settings for `fbm` and `ridged`. */
export interface FractalOptions {
  /** Octaves summed, 1..16 (default 5). */ octaves?: number;
  /** Frequency multiplier per octave (default 2). */ lacunarity?: number;
  /** Amplitude multiplier per octave (default 0.5). */ gain?: number;
  /** Frequency of the first octave (default 1). */ frequency?: number;
}
/** `[octaves, lacunarity, gain, frequency]` with the defaults; RangeError for invalid settings. */
export function fractalOptions(options: FractalOptions): [number, number, number, number];
