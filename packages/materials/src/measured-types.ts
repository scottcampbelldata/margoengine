// Row types of the measured materials library (measured.ts).

/**
 * Where a value comes from. `measured`: converted here from a primary measurement (a paper's table or a spectral
 * library sample). `derived`: computed from measured data through a stated assumption, a fit or a compiled database.
 * `art`: chosen by eye, and said so.
 */
export type Provenance = 'measured' | 'derived' | 'art';

/** A metal: linear sRGB F0 from its complex index, and n and k at 650, 550 and 450 nm. */
export interface MeasuredMetal {
  readonly provenance: Provenance;
  readonly color: readonly [number, number, number];
  readonly roughness: number;
  readonly n: readonly [number, number, number];
  readonly k: readonly [number, number, number];
  /** Index into `SOURCES`. */
  readonly source: number;
  readonly note?: string;
}

/** A clear dielectric: n at 587.56 nm and its Abbe number where the source gives dispersion. */
export interface MeasuredDielectric {
  readonly provenance: Provenance;
  readonly ior: number;
  readonly abbe?: number;
  readonly roughness: number;
  readonly source: number;
  readonly note?: string;
}

/** An opaque everyday surface: linear sRGB albedo, an art roughness and its usual range, and its IOR. */
export interface MeasuredSurface {
  readonly provenance: Provenance;
  readonly color: readonly [number, number, number];
  readonly roughness: number;
  readonly roughnessRange: readonly [number, number];
  readonly ior: number;
  readonly source: number;
  /** The library samples (or database rows) averaged. */
  readonly samples: readonly string[];
  readonly note?: string;
}
