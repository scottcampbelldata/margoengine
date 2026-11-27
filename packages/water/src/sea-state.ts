// A sea from the wind: the swell trains of a fetch-limited JONSWAP spectrum for a wind speed at 10 m, on a fixed set of
// wavelengths so that a changing wind changes only amplitudes, directions and steepness (never the trains' wavelengths).
// CPU only: it returns the `Wave` list `Water` takes, and the numbers a film wants to quote (height, period, coverage).
//
// Sources: Hasselmann et al., "Measurements of wind-wave growth and swell decay during the Joint North Sea Wave Project
// (JONSWAP)", 1973 (spectrum shape, fetch laws Hs and fp, fully developed limit fp = 0.13 g / U); Pierson and
// Moskowitz 1964 (fully developed Hs = 0.22 U^2 / g); Horvath, "Empirical directional wave spectra for computer
// graphics", DigiPro 2015 (directions spread wider away from the peak); Monahan and O'Muircheartaigh, J. Phys. Oceanogr.
// 10, 1980 (whitecap coverage W = 3.84e-6 U^3.41); Tessendorf 2001 (Gerstner fold bound used by Water).
import type { Wave } from './index.js';

const G = 9.81;
/** Most trains a Water takes. */
const MAX_TRAINS = 8;

/** What `seaState` takes besides the wind speed. */
export interface SeaStateOptions {
  /** Distance the wind has blown over open water, 1 to 1e7 metres. Default 100,000. */
  fetch?: number;
  /** Direction the waves travel in the XZ plane (any nonzero length). Default [1, 0.3]. */
  direction?: readonly [number, number];
  /** Trains, an integer 1 to 8; their wavelengths are fixed by this number alone. Default 8. */
  trains?: number;
  /** Shifts the trains' phases, any finite number. Default 0. */
  seed?: number;
}

/** The sea a wind raises: its height, period, coverage and the swell trains for `WaterOptions.waves`. */
export interface SeaState {
  /** Wind speed at 10 m, m/s. */
  windSpeed: number;
  /** Significant wave height Hs = 4 sqrt(variance of the surface), metres. */
  significantHeight: number;
  /** Period of the spectrum's peak, seconds (0 when there is no wind). */
  peakPeriod: number;
  /** Deep-water wavelength of the peak, metres (0 when there is no wind). */
  peakWavelength: number;
  /** True when the fetch is long enough that the sea has stopped growing (the fully developed limit). */
  fullyDeveloped: boolean;
  /** Fraction of the surface covered by whitecaps (Monahan and O'Muircheartaigh 1980). */
  whitecapCoverage: number;
  /** The trains for `WaterOptions.waves`, longest first; none folds the surface. */
  waves: Wave[];
}

/** Fraction of the sea surface under whitecaps at wind speed `windSpeed` m/s at 10 m: 3.84e-6 U^3.41 (0.1% at 5, 1% at 10). */
export function whitecapCoverage(windSpeed: number): number {
  check('windSpeed', windSpeed, 0, 100);
  return Math.min(1, 3.84e-6 * windSpeed ** 3.41);
}

/** The fixed wavelengths of `trains` trains, shortest first: log-spaced from 2 m to 1,500 m. */
export function seaWavelengths(trains = MAX_TRAINS): number[] {
  count(trains);
  if (trains === 1) return [Math.sqrt(2 * 1500)];
  return Array.from({ length: trains }, (_, i) => 2 * (750 ** (i / (trains - 1))));
}

function check(name: string, value: number, low: number, high: number): void {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < low || value > high)
    throw new RangeError(`Invalid sea ${name}; use a number from ${low} to ${high}`);
}
function count(trains: number): void {
  if (!Number.isInteger(trains) || trains < 1 || trains > MAX_TRAINS)
    throw new RangeError('Invalid sea trains; use an integer from 1 to 8');
}

/** JONSWAP shape (unnormalised) at frequency f, peak fp, peak enhancement 3.3. */
function shape(f: number, fp: number): number {
  const sigma = f <= fp ? 0.07 : 0.09,
    r = Math.exp(-((f - fp) ** 2) / (2 * sigma * sigma * fp * fp));
  return f ** -5 * Math.exp(-1.25 * (fp / f) ** 4) * 3.3 ** r;
}

/** The direction, XZ, a sea takes when its wind gives none (`SeaStateOptions.direction`). */
export const SEA_DIRECTION: readonly [number, number] = [1, 0.3];
/**
 * The sea a wind of `windSpeed` m/s (at 10 m) raises over `fetch` metres: Hs = 0.0016 sqrt(g F / U^2) U^2 / g, never
 * above the fully developed 0.22 U^2 / g, with the peak at fp = 3.5 (g / U) (g F / U^2)^-0.33, never below 0.13 g / U. The
 * spectrum's variance goes into the fixed wavelengths by integrating it over each one's band, so the sea's height is Hs
 * whatever the number of trains. Each train's steepness keeps `steepness x amplitude x wavenumber` under 1 / trains, the
 * fold bound of `Water`, so no wind folds the surface. Wind 0 is a flat sea.
 * @throws RangeError for a wind outside 0 to 100, a fetch outside 1 to 1e7, trains outside 1 to 8 or a zero direction.
 */
export function seaState(windSpeed: number, options: SeaStateOptions = {}): SeaState {
  const { fetch = 100000, direction = SEA_DIRECTION, trains = MAX_TRAINS, seed = 0 } = options;
  check('windSpeed', windSpeed, 0, 100);
  check('fetch', fetch, 1, 1e7);
  check('seed', seed, -1e9, 1e9);
  count(trains);
  const length = Math.hypot(direction[0], direction[1]);
  if (direction.length !== 2 || !Number.isFinite(length) || !length)
    throw new RangeError('Invalid sea direction; use a nonzero [x, z]');
  const lengths = seaWavelengths(trains),
    flat = windSpeed === 0,
    u2 = windSpeed * windSpeed,
    grown = flat ? 0 : (0.0016 * Math.sqrt((G * fetch) / u2) * u2) / G,
    limit = flat ? 0 : (0.22 * u2) / G,
    hs = Math.min(grown, limit),
    fpFetch = flat ? 1 : 3.5 * (G / windSpeed) * ((G * fetch) / u2) ** -0.33,
    fpLimit = flat ? 1 : (0.13 * G) / windSpeed,
    fp = Math.max(fpFetch, fpLimit),
    waves: Wave[] = [];
  // Variance in each train's band (log-spaced edges halfway between the wavelengths in log wavenumber).
  const step = trains === 1 ? 750 : 750 ** (1 / (trains - 1)),
    mass = lengths.map((center) => {
      if (flat) return 0;
      const lo = center / Math.sqrt(step),
        hi = center * Math.sqrt(step),
        // f = sqrt(g k) / 2 pi = sqrt(g / (2 pi lambda)); the long wavelength is the low frequency.
        f = (lambda: number) => Math.sqrt(G / (2 * Math.PI * lambda)),
        f0 = f(hi),
        f1 = f(lo),
        n = 200;
      let sum = 0;
      for (let i = 0; i < n; i++) {
        const a = f0 * (f1 / f0) ** ((i + 0.5) / n);
        sum += shape(a, fp) * a * Math.log(f1 / f0) / n;
      }
      return sum;
    }),
    total = mass.reduce((a, b) => a + b, 0),
    peakLength = flat ? 0 : G / (2 * Math.PI * fp * fp),
    variance = (hs / 4) ** 2,
    unit = [direction[0] / length, direction[1] / length],
    base = Math.atan2(unit[1], unit[0]);
  // Longest first; the train nearest the peak travels along the wind, the others turn away from it (wider the further
  // they are from the peak in octaves), alternating sides (Horvath 2015).
  const order = lengths.map((_, i) => i).reverse(),
    nearest = lengths.reduce(
      (best, l, i) => (!flat && Math.abs(Math.log(l / peakLength)) < Math.abs(Math.log(lengths[best] / peakLength)) ? i : best),
      0,
    );
  let side = 1;
  for (const i of order) {
    const lambda = lengths[i],
      k = (2 * Math.PI) / lambda,
      amplitude = total > 0 ? Math.sqrt((2 * variance * mass[i]) / total) : 0,
      octaves = flat ? 0 : Math.abs(Math.log2(lambda / peakLength)),
      spread = i === nearest ? 0 : Math.min(75, 12 * (1 + octaves)) * (Math.PI / 180) * side,
      angle = base + spread,
      room = amplitude * k * trains,
      steepness = room > 0 ? Math.min(0.6, 0.95 / room) : 0.6;
    if (i !== nearest) side = -side;
    waves.push({
      direction: [Math.cos(angle), Math.sin(angle)],
      amplitude,
      wavelength: lambda,
      steepness,
      // Golden-ratio phases keep the trains from lining up at the origin.
      phase: ((i + 1) * 2.399963229728653 + seed) % (2 * Math.PI),
    });
  }
  return {
    windSpeed,
    significantHeight: hs,
    peakPeriod: flat ? 0 : 1 / fp,
    peakWavelength: peakLength,
    fullyDeveloped: !flat && (fpFetch <= fpLimit || grown >= limit),
    whitecapCoverage: flat ? 0 : whitecapCoverage(windSpeed),
    waves,
  };
}

// The drawn water as the physics framework's sea, for floating bodies on it (SEA-02, SEA-04 with SEA-12).
export { seaSurface, type SeaSurfaceOptions, type SurfaceSource } from './sea-surface.js';
