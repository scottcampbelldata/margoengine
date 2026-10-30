// Shadows' route on the WebGL2 compatibility layer, loaded by import() only there (docs/webgl2-compat-roadmap.md,
// "Package routes"). The PCSS search needs each map layer's nearest depth; the WebGPU kernel (shader.ts
// `nearestDepth`) reduces it with workgroup memory and atomics, which put it on the layer's CPU tier: the whole map
// read back and looped over in JavaScript, about 0.5 s a frame for a 2048 x 2048 map whenever a caster moves. Here
// the same minimum comes from three kernels the layer runs on the GPU: two that store only their own texel (fragment
// draws), each the minimum of a 16 x 16 block, and one invocation per layer that stores the layer's word (a point
// draw). min is exact and order-free and both routes start from 1.0, so the words equal the WebGPU route's.

declare const GPUTextureUsage: { STORAGE_BINDING: number; TEXTURE_BINDING: number };

/** Texels per side of the block one invocation of {@link blockShader} reduces. */
export const BLOCK = 16;
const block = (input: string, load: string) => `@group(0) @binding(0) var map:${input};
@group(0) @binding(1) var blocks:texture_storage_2d_array<r32float,write>;
@compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) id:vec3u){
  if(any(id.xy>=textureDimensions(blocks))){return;}
  let size=textureDimensions(map);var m=1.0;
  for(var y=0u;y<${BLOCK}u;y++){for(var x=0u;x<${BLOCK}u;x++){let c=id.xy*${BLOCK}u+vec2u(x,y);if(all(c<size)){m=min(m,${load});}}}
  textureStore(blocks,id.xy,id.z,vec4f(m,0,0,0));
}`;
/** Each texel: the nearest depth of a 16 x 16 block of the shadow map's layer. */
export const blockShader = block('texture_depth_2d_array', 'textureLoad(map,c,id.z,0)');
/** Each texel: the minimum of a 16 x 16 block of the previous level. */
export const levelShader = block('texture_2d_array<f32>', 'textureLoad(map,c,id.z,0).x');
/** One invocation per layer: the minimum of the last level, stored as f32 bits in the layer's word. */
export const wordShader = `@group(0) @binding(0) var map:texture_2d_array<f32>;
@group(0) @binding(1) var<storage,read_write> nearest:array<u32,4>;
@compute @workgroup_size(1) fn main(@builtin(global_invocation_id) id:vec3u){
  let size=textureDimensions(map);var m=1.0;
  for(var y=0u;y<size.y;y++){for(var x=0u;x<size.x;x++){m=min(m,textureLoad(map,vec2u(x,y),id.z,0).x);}}
  nearest[id.z]=bitcast<u32>(m);
}`;

/** The reduction's GPU state for one map size; {@link NearestRoute.encode} rebuilds it when the map changes. */
export class NearestRoute {
  private readonly pipelines: GPUComputePipeline[];
  private levels: GPUTexture[] = [];
  private groups: GPUBindGroup[] = [];
  private source?: GPUTextureView;
  private buffer?: GPUBuffer;
  constructor(private readonly device: GPUDevice) {
    this.pipelines = [blockShader, levelShader, wordShader].map((code) =>
      device.createComputePipeline({
        layout: 'auto',
        compute: { module: device.createShaderModule({ code }), entryPoint: 'main' },
      }),
    );
  }
  /**
   * Records the reduction of `map` (a `width` x `height` 2D-array view with `layers` layers) into the first `layers`
   * words of `nearest`.
   */
  encode(
    encoder: GPUCommandEncoder,
    map: GPUTextureView,
    width: number,
    height: number,
    layers: number,
    nearest: GPUBuffer,
  ): void {
    if (map !== this.source || nearest !== this.buffer) this.build(map, width, height, layers, nearest);
    const pass = encoder.beginComputePass(),
      last = this.groups.length - 1;
    for (const [i, group] of this.groups.entries()) {
      pass.setPipeline(this.pipelines[i === last ? 2 : i ? 1 : 0]);
      pass.setBindGroup(0, group);
      const level = this.levels[i];
      if (level) pass.dispatchWorkgroups(Math.ceil(level.width / 8), Math.ceil(level.height / 8), layers);
      else pass.dispatchWorkgroups(1, 1, layers);
    }
    pass.end();
  }
  private build(map: GPUTextureView, width: number, height: number, layers: number, nearest: GPUBuffer): void {
    this.destroy();
    this.source = map;
    this.buffer = nearest;
    // Blocks of 16 until a level is at most 16 x 16 (one level for maps up to 256, two up to 4,096, three up to
    // 65,536); the word kernel then reads at most 256 texels per layer.
    let input = map;
    do {
      width = Math.ceil(width / BLOCK);
      height = Math.ceil(height / BLOCK);
      const level = this.device.createTexture({
        size: [width, height, layers],
        format: 'r32float',
        usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
      });
      const pipeline = this.pipelines[this.levels.length ? 1 : 0];
      this.groups.push(
        this.device.createBindGroup({
          layout: pipeline.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: input },
            { binding: 1, resource: level.createView({ dimension: '2d-array' }) },
          ],
        }),
      );
      this.levels.push(level);
      input = level.createView({ dimension: '2d-array' });
    } while (width > BLOCK || height > BLOCK);
    this.groups.push(
      this.device.createBindGroup({
        layout: this.pipelines[2].getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: input },
          { binding: 1, resource: { buffer: nearest } },
        ],
      }),
    );
  }
  /** Frees the levels; the next {@link encode} rebuilds them. */
  destroy(): void {
    for (const level of this.levels) level.destroy();
    this.levels = [];
    this.groups = [];
    this.source = this.buffer = undefined;
  }
}
