// The layout of terrain's lighting group, read from what the effects declared in the shader. Effects choose their own
// bindings and resource kinds, so a table of binding numbers can only ever fit the effects it was written against.
declare const GPUShaderStage: { FRAGMENT: number };
const declaration = /@group\(1\)\s*@binding\((\d+)\)\s*var(?:<([^>]*)>)?\s+(\w+)\s*:\s*([^;]+);/g;
const sampled = /^texture_(2d_array|2d|3d|cube_array|cube)<(f32|i32|u32)>$/;
const depth = /^texture_depth_(2d_array|2d|cube_array|cube)$/;
const dimension = (name: string) => name.replace('_', '-') as GPUTextureViewDimension;
function layoutOf(code: string, space: string, name: string, type: string): Omit<GPUBindGroupLayoutEntry, 'binding' | 'visibility'> {
  if (space === 'uniform') return { buffer: { type: 'uniform' } };
  if (space.startsWith('storage'))
    return { buffer: { type: space.includes('read_write') ? 'storage' : 'read-only-storage' } };
  if (type === 'sampler_comparison') return { sampler: { type: 'comparison' } };
  if (type === 'sampler') return { sampler: { type: 'filtering' } };
  const flat = depth.exec(type);
  if (flat) return { texture: { sampleType: 'depth', viewDimension: dimension(flat[1]) } };
  const texture = sampled.exec(type);
  if (!texture) throw new TypeError(`Terrain lighting declares ${name} as ${type}, which a lighting group cannot hold; declare a sampled texture, sampler or buffer`);
  // As WebGPU's automatic layouts do: only a texture read through a sampler has to be filterable.
  const filtered = new RegExp(String.raw`textureSample\w*\(\s*${name}\b`).test(code),
    sampleType = texture[2] === 'f32' ? (filtered ? 'float' : 'unfilterable-float') : texture[2] === 'u32' ? 'uint' : 'sint';
  return { texture: { sampleType, viewDimension: dimension(texture[1]) } };
}
/**
 * The layout entries of `entries`, each as `code` declares it at group 1. One it does not declare has no entry, so
 * WebGPU's `createBindGroup` names it as a validation error.
 */
export function lightingLayout(code: string, entries: readonly GPUBindGroupEntry[]): GPUBindGroupLayoutEntry[] {
  const found = new Map<number, Omit<GPUBindGroupLayoutEntry, 'binding' | 'visibility'>>();
  for (const [, binding, space = '', name, type] of code.matchAll(declaration))
    found.set(+binding, layoutOf(code, space.replace(/\s/g, ''), name, type.trim()));
  return entries.flatMap(({ binding }) => {
    const layout = found.get(binding);
    return layout ? [{ binding, visibility: GPUShaderStage.FRAGMENT, ...layout }] : [];
  });
}
