import { MargoError } from '@margoengine/math/errors';

/** A damped sinusoidal pressure mode, with signed excitation and radiation gain combined. */
export interface ModalMode {
  /** Damped frequency in Hz, up to 45% of the sample rate. */
  readonly frequency: number;
  /** Exponential amplitude decay coefficient in 1/s. */
  readonly decay: number;
  /** Signed normalized PCM amplitude per N s, before damping and sine phase. */
  readonly gain: number;
  /** Scrape multiplier on gain. Default 1. */
  readonly scrape?: number;
  /** Roll multiplier on gain. Default 1. */
  readonly roll?: number;
  /** Fracture multiplier on gain. Default 1. */
  readonly fracture?: number;
}

/** Measured or authored monotone-contact parameters for one resonating object. */
export interface ModalMaterial {
  readonly modes: readonly ModalMode[];
  /** Effective scrape force per square root of sliding power, in N/√W. Default 0.4. */
  readonly scrapeRoughness?: number;
  /** Effective rolling force per square root of rolling proxy power, in N/√W. Default 0.2. */
  readonly rollRoughness?: number;
  /** Representative scrape feature spacing in m. Default 0.006. */
  readonly scrapeSpacing?: number;
  /** Representative rolling feature spacing in m. Default 0.024. */
  readonly rollSpacing?: number;
}

/** Authored example radiators. Replace with measured modal data to match a real object. */
export type ModalPreset = 'wood' | 'metal' | 'glass' | 'bell';

const TABLE = {
  wood: [
    [181, 105, 0.16],
    [318, 166, 0.085],
    [610, 195, 0.052],
    [990, 252, 0.022],
    [1621, 310, 0.012],
  ],
  metal: [
    [302, 12, 0.13],
    [674, 19, 0.082],
    [1190, 31, 0.063],
    [1635, 33, 0.049],
    [2320, 55, 0.025],
  ],
  glass: [
    [492, 31, 0.095],
    [1138, 38, 0.09],
    [1791, 70, 0.074],
    [2505, 91, 0.046],
    [3290, 110, 0.03],
  ],
  bell: [
    [218, 4, 0.09],
    [440, 5.5, 0.16],
    [522, 8, 0.061],
    [663, 10, 0.053],
    [881, 17, 0.047],
  ],
} as const;

/** Return a fresh copy of an authored modal material, suitable for customization. */
export function modalPreset(preset: ModalPreset): ModalMaterial {
  if (!Object.hasOwn(TABLE, preset))
    throw new MargoError('state', 'Use the wood, metal, glass or bell modal sound preset.');
  return {
    modes: TABLE[preset].map(([frequency, decay, gain], i) => ({
      frequency,
      decay,
      gain,
      scrape: 0.65 + i * 0.25,
      roll: 1.3 - i * 0.25,
      fracture: preset === 'glass' || preset === 'wood' ? 0.35 + i * 0.6 : 1,
    })),
  };
}
