import { compute } from '../../shared/gpu.js';
import type { SkyFeatures } from './base.js';
import { environment, environmentLayer } from './environment.js';
declare const GPUTextureUsage: { STORAGE_BINDING: number; TEXTURE_BINDING: number };
const reflectSky = `
@group(0) @binding(3) var reflectionMap:texture_storage_2d<rgba16float,write>;
@compute @workgroup_size(8,8) fn reflectSky(@builtin(global_invocation_id) id:vec3u){
 if(any(id.xy>=vec2u(64,32))){return;}
 // Texels are about 0.1 rad wide.
 textureStore(reflectionMap,vec2i(id.xy),vec4f(skyEnvironment(environmentDirection((vec2f(id.xy)+0.5)/vec2f(64,32)),0.1),1));
}`;
// The same map with the sky's environment layer (Sky.environmentLayer, the clouds' deck) laid over it.
const reflectLayered = `${environmentLayer}
@group(0) @binding(3) var reflectionMap:texture_storage_2d<rgba16float,write>;
@compute @workgroup_size(8,8) fn reflectSky(@builtin(global_invocation_id) id:vec3u){
 if(any(id.xy>=vec2u(64,32))){return;}
 textureStore(reflectionMap,vec2i(id.xy),vec4f(layered(skyEnvironment(environmentDirection((vec2f(id.xy)+0.5)/vec2f(64,32)),0.1),id.xy),1));
}`;
/**
 * 64x32 linear HDR environment of the sky (`reflectionTexture`), refreshed every frame once read. Built when first read,
 * so a sky with the feature that never hands out its reflection allocates and compiles nothing for it. `run` with a
 * layer draws the map again with the layer over the sky.
 */
export const reflection: NonNullable<SkyFeatures['reflection']> = {
  create(d, code, entries, owned) {
    const descriptor: GPUComputePassDescriptor = {};
    let built: { texture: GPUTexture; pipeline: GPUComputePipeline; group: GPUBindGroup } | undefined,
      layered: { pipeline: GPUComputePipeline; layer?: GPUTexture; group?: GPUBindGroup } | undefined;
    const build = () => {
      if (built) return built;
      const texture = d.createTexture({
        size: [64, 32],
        format: 'rgba16float',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING,
      });
      owned.push(texture);
      return (built = { texture, ...compile(texture) });
    };
    const compile = (texture: GPUTexture) => {
      const pipeline = compute(d, code + environment + reflectSky, 'reflectSky');
      return {
        pipeline,
        group: d.createBindGroup({
          layout: pipeline.getBindGroupLayout(0),
          entries: [...entries, { binding: 3, resource: texture.createView() }],
        }),
      };
    };
    return {
      get texture() {
        return build().texture;
      },
      recode(next, bindings) {
        code = next;
        entries = bindings;
        if (built) built = { texture: built.texture, ...compile(built.texture) };
        layered = undefined;
      },
      run(c, layer) {
        let { pipeline, group, texture } = build();
        if (layer) {
          layered ??= { pipeline: compute(d, code + environment + reflectLayered, 'reflectSky') };
          if (layered.layer !== layer)
            layered.group = d.createBindGroup({
              layout: layered.pipeline.getBindGroupLayout(0),
              entries: [
                ...entries,
                { binding: 3, resource: texture.createView() },
                { binding: 4, resource: layer.createView() },
              ],
            });
          layered.layer = layer;
          pipeline = layered.pipeline;
          group = layered.group!;
        }
        const pass = c.encoder.beginComputePass(descriptor);
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, group);
        pass.dispatchWorkgroups(8, 4);
        pass.end();
      },
    };
  },
};
