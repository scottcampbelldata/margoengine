import {compute} from '../../shared/gpu.js';
import type {SkyFeatures} from './base.js';
declare const GPUTextureUsage:{STORAGE_BINDING:number;TEXTURE_BINDING:number};
const reflectSky=`
@group(0) @binding(3) var reflectionMap:texture_storage_2d<rgba16float,write>;
@compute @workgroup_size(8,8) fn reflectSky(@builtin(global_invocation_id) id:vec3u){
 if(any(id.xy>=vec2u(64,32))){return;}
 let uv=(vec2f(id.xy)+0.5)/vec2f(64,32);let phi=(uv.x-0.5)*6.2831853;let theta=uv.y*3.14159265;
 let w=vec3f(sin(theta)*cos(phi),cos(theta),sin(theta)*sin(phi));let s=frame.sun.xyz;
 let ray=normalize(vec3f(w.x,max(0.001,w.y),w.z));var color=daySky(ray);
 color=mix(vec3f(0.015,0.018,0.012),color,smoothstep(-0.2,0.02,w.y));
 color=mix(color,nightSky(w),frame.sun.w);
 color+=frame.moonColor.rgb*frame.moon.w*moonRadiance(w,frame.moon.xyz,0.1);
 color=cloudSky(color,w,0.1);
 textureStore(reflectionMap,vec2i(id.xy),vec4f(color*exp2(frame.settings.y),1));
}`;
/** 64x32 linear HDR environment of the sky (`reflectionTexture`), refreshed every frame once read. */
export const reflection:NonNullable<SkyFeatures['reflection']>={create(d,code,entries,owned){
 const texture=d.createTexture({size:[64,32],format:'rgba16float',usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.STORAGE_BINDING});owned.push(texture);const pipeline=compute(d,code+reflectSky,'reflectSky');
 const group=d.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:[...entries,{binding:3,resource:texture.createView()}]}),descriptor:GPUComputePassDescriptor={};
 return {texture,run(c){const pass=c.encoder.beginComputePass(descriptor);pass.setPipeline(pipeline);pass.setBindGroup(0,group);pass.dispatchWorkgroups(8,4);pass.end();}};
}};
