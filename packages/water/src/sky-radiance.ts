/** A borrowed HDR Environment in the same scene, using the -Z-centred equirectangular convention. */
export interface WaterSkyEnvironment {
  readonly equirectTexture: GPUTexture | undefined;
  readonly rotation?: number;
  readonly radianceScale?: number;
}

/** A Sky reflection callback (+X-centred), or a photographed HDR Environment. */
type WaterSkySource = (() => GPUTexture | undefined) | WaterSkyEnvironment;

export function validWaterSky(source: unknown): source is WaterSkyEnvironment {
  return !!source && typeof source === 'object' && 'equirectTexture' in source;
}

export function skyTexture(source: WaterSkySource | undefined): GPUTexture | undefined {
  return typeof source === 'function' ? source() : source?.equirectTexture;
}

/** Store longitude in turns and the radiance multiplier, with a caller-provided scale for a raw sky texture. */
export function writeSkySampling(
  source: WaterSkySource | undefined,
  out: Float32Array,
  turnOffset: number,
  scaleOffset = turnOffset + 1,
  callbackScale = 1,
): void {
  const hdr = source && typeof source !== 'function' ? source : undefined;
  const rotation = hdr?.rotation ?? 0;
  const scale = hdr?.radianceScale ?? 1;
  if (!Number.isFinite(rotation) || !Number.isFinite(scale) || scale <= 0 || scale > 3.4028234663852886e38)
    throw new RangeError('Water sky needs a finite rotation and a positive finite radiance scale');
  // Water/Sky's centre is +X. Environment's -Z centre is a quarter-turn further in U.
  out[turnOffset] = hdr ? 0.25 + ((rotation / (2 * Math.PI)) % 1) : 0;
  out[scaleOffset] = hdr ? scale : callbackScale;
}

export const skyCoordinates = `
fn seaSkyUv(ray:vec3f,turn:f32)->vec2f {
  var u=0.5;
  if(dot(ray.xz,ray.xz)>1e-12){u+=atan2(ray.z,ray.x)*0.1591549431;}
  return vec2f(u+turn,acos(clamp(ray.y,-1.0,1.0))*0.3183098862);
}`;
