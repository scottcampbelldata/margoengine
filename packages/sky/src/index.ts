import type { EngineKernel } from '@margoengine/core';
import { Sky as SkyBase, type SkyOptions } from './base.js';
import { preetham } from './preetham.js';
import { bruneton } from './bruneton.js';
import { clouds } from './clouds.js';
import { night } from './night.js';
import { fog } from './fog.js';
export { cloudHaze } from './fog.js';
import { reflection } from './reflection.js';
import { lighting } from './lighting.js';
import { look } from './look.js';
export {
  sunDirection,
  sunDirectionFromAngles,
  type SkyLightingTarget,
  sunlight,
  moonlight,
  moonlightColor,
  cloudTransmittance,
  MOON_EXTINCTION,
  type Moonlight,
  moonAirmass,
  moonLook,
  SUN_ILLUMINANCE,
  twilightColor,
  twilightIlluminance,
  twilightLightColor,
  moonPhase,
  moonWaning,
  MOON_PHASES,
  type MoonBrightnessName,
  type MoonColorName,
  type MoonLook,
  type MoonPhase,
  type MoonPhaseName,
  skyEnvironmentFloor,
  overcastShare,
  type SkyOptions,
  type SkyLightingOptions,
  type SkyCloudOptions,
  type SkyFogOptions,
  type SkyNightOptions,
  type SkyAtmosphereOptions,
  type SkyLookOptions,
  type SkyGradientStop,
  type SkyFeatures,
} from './base.js';
const features = { preetham, bruneton, clouds, night, fog, reflection, lighting, look };
/**
 * Every sky feature: Preetham and Bruneton day models, clouds, stylized night, fog, reflection, lighting and the
 * look and air controls (`look`, `atmosphere`).
 * A scene that needs fewer loads less with `Sky` from `@margoengine/sky/base` and only the feature entries it uses.
 */
export class Sky extends SkyBase {
  constructor(options: SkyOptions = {}) {
    super(options, features);
  }
  static override attach(engine: EngineKernel, options: SkyOptions = {}): Sky {
    return super.attach(engine, options) as Sky;
  }
}
