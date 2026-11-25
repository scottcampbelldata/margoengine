// The wave-spectrum contract of the physics framework (docs/physics-framework.md, section 4; SEA-01 -> SEA-02): the
// directional spectrum of the sea's waves at any place, which the sea surface synthesises its waves from. The waves'
// solver owns it; the sea surface, the nearshore, ships and the sound of the sea read it. Types only: this entry has no
// code, so importing it costs nothing.

/** An integer origin cell of a large world: three whole numbers (see `FlowCell`). */
type WaveCell = readonly [number, number, number];

/** The sea's directional spectrum at a place: how its wave energy is shared out over frequency and direction. */
export interface WaveSpectrumSample {
  /** Frequencies, Hz, ascending (shared: do not change them). */
  readonly frequencies: Float64Array;
  /** Directions the waves travel toward, radians in the ground plane from +x toward +z (shared: do not change them). */
  readonly directions: Float64Array;
  /**
   * The spectral density E(f, theta), m^2/(Hz rad), frequency-major: element `i * directions.length + j` belongs to
   * frequency i and direction j. The variance of the surface is the sum of E df dtheta; the significant wave height is
   * 4 sqrt of it.
   */
  energy: Float64Array;
  /** Still-water depth, m (Infinity for deep water; 0 or less on land). */
  depth: number;
  /** Density of the water, kg/m^3 (fresh water for a lake, sea water for the sea). */
  density: number;
}

/**
 * The sea's waves: a directional spectrum that can be sampled anywhere on the water. `sample` gives the spectrum at
 * (x, z) as it stands now; the solver that owns it moves it on with the world clock.
 */
export interface WaveSpectrumField {
  /** The origin cell `sample`'s coordinates are offsets from. */
  readonly cell: WaveCell;
  /** The spectrum at (x, z) m from the field's cell. Writes into `out` when given (its arrays sized to this field) and returns it. */
  sample(x: number, z: number, out?: WaveSpectrumSample): WaveSpectrumSample;
}
