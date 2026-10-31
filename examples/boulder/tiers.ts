// What each quality tier turns on. Pure data; tests/boulder-climb.test.js reads it.
export interface TierSettings {
  shadow: { resolution: number; filter: 'soft' | 'pcf' };
  /** Screen-space contact shadows in the hold shadows. */
  ssao: boolean;
  bloom: boolean;
  /** Face size of the reflection probe at the climber. */
  probeResolution: number;
  /** One probe face a frame while climbing, or a bake when a move ends. */
  probeLive: boolean;
  chalkCapacity: number;
}

export const TIERS: Record<'high' | 'light' | 'phone', TierSettings> = {
  high: {
    shadow: { resolution: 2048, filter: 'soft' },
    ssao: true,
    bloom: true,
    probeResolution: 128,
    probeLive: true,
    chalkCapacity: 4000,
  },
  light: {
    shadow: { resolution: 1024, filter: 'pcf' },
    ssao: false,
    bloom: true,
    probeResolution: 64,
    probeLive: false,
    chalkCapacity: 2000,
  },
  phone: {
    shadow: { resolution: 512, filter: 'pcf' },
    ssao: false,
    bloom: false,
    probeResolution: 64,
    probeLive: false,
    chalkCapacity: 1000,
  },
};
