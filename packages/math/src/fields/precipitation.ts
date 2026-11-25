// The precipitation contract of the physics framework (docs/physics-framework.md, section 4, "rain"; PA-23): how much
// water falls anywhere, at any time on the world clock, in what form and how fast, from a pure synchronous query. The
// atmosphere owns it; the sea's rain rings, runoff, wet ground, sound and the drawn streaks read it. Types only: this entry
// has no code, so importing it costs nothing.
//
// Every species carries an exponential size distribution, N(D) = intercept exp(-slope D) particles per cubic metre of air
// per metre of size, which a reader samples for drop and flake sizes, so the count, size and energy of what lands all
// follow from one rain rate.

/** An integer origin cell of a large world: three whole numbers (see `FlowCell`). */
type PrecipitationCell = readonly [number, number, number];

/** One kind of falling water at a point: its rate, its sizes and how fast it falls. */
export interface HydrometeorSample {
  /** Precipitation rate as liquid water, mm/h (a snowfall of 1 mm/h melts to 1 mm of water an hour). */
  rate: number;
  /** Intercept N0 of the size distribution N(D) = N0 exp(-slope D), particles per m^3 of air per m of size (m^-4); 0 when none falls. */
  intercept: number;
  /** Slope of the size distribution, 1/m (its median-volume size is 3.67 / slope). */
  slope: number;
  /** Mass-weighted fall speed relative to the air, m/s. */
  fallSpeed: number;
  /** Particles crossing a square metre of level ground each second, 1/(m^2 s). */
  impactRate: number;
  /** Kinetic energy they bring down, relative to the air, W/m^2. */
  energyFlux: number;
  /** Their mass per cubic metre of air, kg/m^3. */
  waterContent: number;
}

/** What precipitation gives at a point and a time, in SI units (rates in mm/h, as weather reports and rain gauges give them). */
export interface PrecipitationSample {
  /** All species together as liquid water, mm/h. */
  rate: number;
  /** Raindrops; sizes are equivalent-sphere diameters. */
  rain: HydrometeorSample;
  /** Snow aggregates; sizes are maximum dimensions. */
  snow: HydrometeorSample;
  /** Graupel: rimed pellets up to 5 mm; sizes are diameters. */
  graupel: HydrometeorSample;
  /** Hail: ice stones of 5 mm and more; sizes are diameters. */
  hail: HydrometeorSample;
  /** Mass-weighted velocity of the falling water over the ground, m/s (the wind carries it sideways as it falls). */
  velocity: [number, number, number];
}

/**
 * Precipitation that can be sampled anywhere. `sample` is pure: the same point and time give the same answer, in any order
 * and on any thread, so a solver samples it at its own rate and a replay sees the same rain.
 */
export interface Precipitation {
  /** The origin cell `sample`'s coordinates are offsets from; a reader in another cell converts through the cell difference. */
  readonly cell: PrecipitationCell;
  /**
   * The precipitation at (x, y, z) metres from the field's cell, at time `t` seconds on the world clock. Writes into `out`
   * when given (no allocation) and returns it.
   */
  sample(x: number, y: number, z: number, t: number, out?: PrecipitationSample): PrecipitationSample;
}
