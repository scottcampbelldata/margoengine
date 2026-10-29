// DOF's route on the WebGL2 compatibility layer, loaded by import() only there. WebGL2 has
// no workgroup memory, so the layer would run the CoC and bokeh kernels (their 8x8 tile maxima share a workgroup
// array) one invocation at a time on the CPU: about 0.9 s a frame at 720p. These variants compute the same maxima
// without workgroup memory, so every kernel stores only its own texel and runs as a fragment draw on the GPU, with the
// same values: max is exact and order-free, so the tiles and every output pixel equal the WebGPU route's.
import { margoError } from '../../shared/errors.js';

const edit = (source: string, edits: readonly [string, string][]): string =>
  edits.reduce((code, [from, to]) => {
    if (code.split(from).length !== 2)
      throw margoError('unsupported', 'DOF on WebGL2 needs the shader its compatibility route was written for');
    return code.replace(from, to);
  }, source);
const shared = ',@builtin(workgroup_id) tile:vec3u,@builtin(local_invocation_index) local:u32';

/** DOF's WebGPU kernels (./shaders.js), handed in so this chunk shares no module with the package's entry. */
export interface DOFShaders {
  readonly cocShader: string;
  readonly bokehShader: string;
  readonly groupMax: string;
}

/** The CoC alone: every pixel stores its own circle of confusion; the tile maxima come from {@link tilesShader}. */
export const cocPixelShader = ({ cocShader, groupMax }: DOFShaders): string =>
  edit(cocShader, [
    ['@group(0) @binding(3) var tiles:texture_storage_2d<r32float,write>;\n', ''],
    [groupMax, ''],
    [shared, ''],
    ['\n  let m=groupMax(near,local);\n  if(local==0u){textureStore(tiles,vec2i(tile.xy),vec4f(m,0,0,0));}', ''],
  ]);

/**
 * One invocation per 8x8 tile: the largest near-field radius (-CoC) of its pixels, 0 for pixels past the edge, as the
 * WebGPU route's workgroup reduction gives it.
 */
export const tilesShader = `@group(0) @binding(0) var coc:texture_2d<f32>;
@group(0) @binding(1) var tiles:texture_storage_2d<r32float,write>;
@compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) id:vec3u) {
  if(any(id.xy>=textureDimensions(tiles))){return;}
  let size=textureDimensions(coc);var m=0.0;
  for(var i=0u;i<64u;i++){
    let at=id.xy*8u+vec2u(i%8u,i/8u);var near=0.0;
    if(all(at<size)){near=-textureLoad(coc,vec2i(at),0).x;}
    m=select(max(m,near),near,i==0u);
  }
  textureStore(tiles,vec2i(id.xy),vec4f(m,0,0,0));
}`;

/** The bokeh gather with each invocation reading its own neighbouring tiles' near maximum. */
export const bokehAloneShader = ({ bokehShader, groupMax }: DOFShaders): string =>
  edit(bokehShader, [
    [groupMax, ''],
    [shared, ''],
    [
      'var mine=0.0;\n  for(var t=i32(local);t<span*span;t+=64){',
      'var mine=0.0;let tile=id.xy/8u;\n  for(var t=0;t<span*span;t++){',
    ],
    ['let nearMax=groupMax(mine,local);', 'let nearMax=mine;'],
  ]);

/** The three pipelines of the route, compiled on `device`. */
export function dofCompatPipelines(
  device: GPUDevice,
  shaders: DOFShaders,
): {
  coc: GPUComputePipeline;
  tiles: GPUComputePipeline;
  bokeh: GPUComputePipeline;
} {
  const pipeline = (code: string) =>
    device.createComputePipeline({
      layout: 'auto',
      compute: { module: device.createShaderModule({ code }), entryPoint: 'main' },
    });
  return {
    coc: pipeline(cocPixelShader(shaders)),
    tiles: pipeline(tilesShader),
    bokeh: pipeline(bokehAloneShader(shaders)),
  };
}
