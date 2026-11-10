/** Formats WebGPU can write from a compute shader on every device. */
export type StorageFormat =
  | 'rgba8unorm'
  | 'rgba8snorm'
  | 'rgba8uint'
  | 'rgba8sint'
  | 'rgba16float'
  | 'rgba16uint'
  | 'rgba16sint'
  | 'r32float'
  | 'r32uint'
  | 'r32sint'
  | 'rg32float'
  | 'rg32uint'
  | 'rg32sint'
  | 'rgba32float'
  | 'rgba32uint'
  | 'rgba32sint';
/** What `load` returns and `store` takes: four components, whatever the format holds (a missing one reads 0, alpha 1). */
export type Texel<F extends StorageFormat> = F extends `${string}uint`
  ? 'vec4u'
  : F extends `${string}sint`
    ? 'vec4i'
    : 'vec4f';
export const bytes: Record<StorageFormat, number> = {
  rgba8unorm: 4,
  rgba8snorm: 4,
  rgba8uint: 4,
  rgba8sint: 4,
  rgba16float: 8,
  rgba16uint: 8,
  rgba16sint: 8,
  r32float: 4,
  r32uint: 4,
  r32sint: 4,
  rg32float: 8,
  rg32uint: 8,
  rg32sint: 8,
  rgba32float: 16,
  rgba32uint: 16,
  rgba32sint: 16,
};
export const texel = (f: StorageFormat) => (/uint$/.test(f) ? 'vec4u' : /sint$/.test(f) ? 'vec4i' : 'vec4f');
export const sampled = (f: StorageFormat) => ({ vec4f: 'f32', vec4i: 'i32', vec4u: 'u32' })[texel(f)];
