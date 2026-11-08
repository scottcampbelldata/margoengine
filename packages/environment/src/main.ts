// Everything the package root exports but the image decoders (loaders.ts). index.ts joins the two, so the published
// index.js only re-exports: a bundler then leaves dist/loaders.js to the import() in EnvironmentLighting.load when an app
// does not name a decoder, which a module that both held code and re-exported the decoders did not allow.
export { halfToFloat, floatToHalf } from './half.js';
export { SH_BASIS, SH_IRRADIANCE_BANDS, shBasis, evaluateSH, projectEquirectSH, radianceToIrradianceSH } from './sh.js';
export {
  Environment,
  type EnvironmentOptions,
  type EnvironmentSource,
  type CubeFaces,
  type CubeTextureSource,
} from './environment.js';
export {
  EnvironmentBackground,
  EnvironmentBackground as Skybox,
  ImageBackground,
  type EnvironmentBackgroundOptions,
  type ImageBackgroundOptions,
  type ImageBackgroundShape,
  type ImageBackgroundSource,
} from './background.js';
export {
  ColorBackground,
  TransparentCanvas,
  srgbColor,
  type ColorBackgroundOptions,
  type ColorInput,
} from './color.js';
export { ColorOutput, type ColorOutputOptions } from './output.js';
export {
  EnvironmentLighting,
  Fog,
  IBL_BINDING,
  FOG_BINDING,
  type EnvironmentLightingOptions,
  type EnvironmentLoadOptions,
  type FogOptions,
  type LightingTarget,
} from './lighting.js';
export { IBL_WGSL, iblLayoutEntries, iblBindGroupEntries } from './ibl.js';
export {
  HemisphereLight,
  AmbientLight,
  HEMISPHERE_BINDING,
  type HemisphereLightOptions,
  type AmbientLightOptions,
} from './hemisphere.js';
