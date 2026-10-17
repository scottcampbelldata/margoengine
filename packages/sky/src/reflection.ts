import { compute } from '../../shared/gpu.js';
import type { SkyFeatures } from './base.js';
import { environment } from './environment.js';
declare const GPUTextureUsage: { STORAGE_BINDING: number; TEXTURE_BINDING: number };
const reflectSky = `
@group(0) @binding(3) var reflectionMap:texture_storage_2d<rgba16float,write>;
@compute @workgroup_size(8,8) fn reflectSky(@builtin(global_invocation_id) id:vec3u){
 if(any(id.xy>=vec2u(64,32))){return;}
 // Texels are about 0.1 rad wide.
 textureStore(reflectionMap,vec2i(id.xy),vec4f(skyEnvironment(environmentDirection((vec2f(id.xy)+0.5)/vec2f(64,32)),0.1),1));
}`;
/** 64x32 linear HDR environment of the sky (`reflectionTexture`), refreshed every frame once read. */
export const reflection: NonNullable<SkyFeatures['reflection']> = {
  create(d, code, entries, owned) {
    const texture = d.createTexture({
      size: [64, 32],
      format: 'rgba16float',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING,
    });
    owned.push(texture);
    const pipeline = compute(d, code + environment + reflectSky, 'reflectSky');
    const group = d.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [...entries, { binding: 3, resource: texture.createView() }],
      }),
      descriptor: GPUComputePassDescriptor = {};
    return {
      texture,
      run(c) {
        const pass = c.encoder.beginComputePass(descriptor);
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, group);
        pass.dispatchWorkgroups(8, 4);
        pass.end();
      },
    };
  },
};
