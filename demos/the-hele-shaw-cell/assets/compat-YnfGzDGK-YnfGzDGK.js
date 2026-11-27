var e=16,t=(e,t)=>`@group(0) @binding(0) var map:${e};
@group(0) @binding(1) var blocks:texture_storage_2d_array<r32float,write>;
@compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) id:vec3u){
  if(any(id.xy>=textureDimensions(blocks))){return;}
  let size=textureDimensions(map);var m=1.0;
  for(var y=0u;y<16u;y++){for(var x=0u;x<16u;x++){let c=id.xy*16u+vec2u(x,y);if(all(c<size)){m=min(m,${t});}}}
  textureStore(blocks,id.xy,id.z,vec4f(m,0,0,0));
}`,n=t(`texture_depth_2d_array`,`textureLoad(map,c,id.z,0)`),r=t(`texture_2d_array<f32>`,`textureLoad(map,c,id.z,0).x`),i=`@group(0) @binding(0) var map:texture_2d_array<f32>;
@group(0) @binding(1) var<storage,read_write> nearest:array<u32,4>;
@compute @workgroup_size(1) fn main(@builtin(global_invocation_id) id:vec3u){
  let size=textureDimensions(map);var m=1.0;
  for(var y=0u;y<size.y;y++){for(var x=0u;x<size.x;x++){m=min(m,textureLoad(map,vec2u(x,y),id.z,0).x);}}
  nearest[id.z]=bitcast<u32>(m);
}`,a=class{constructor(e){this.device=e,this.levels=[],this.groups=[],this.pipelines=[n,r,i].map(t=>e.createComputePipeline({layout:`auto`,compute:{module:e.createShaderModule({code:t}),entryPoint:`main`}}))}encode(e,t,n,r,i,a){(t!==this.source||a!==this.buffer)&&this.build(t,n,r,i,a);let o=e.beginComputePass(),s=this.groups.length-1;for(let e=0;e<=s;e++){o.setPipeline(this.pipelines[e===s?2:+!!e]),o.setBindGroup(0,this.groups[e]);let t=this.levels[e];t?o.dispatchWorkgroups(Math.ceil(t.width/8),Math.ceil(t.height/8),i):o.dispatchWorkgroups(1,1,i)}o.end()}build(e,t,n,r,i){this.destroy(),this.source=e,this.buffer=i;let a=e;do{t=Math.ceil(t/16),n=Math.ceil(n/16);let e=this.device.createTexture({size:[t,n,r],format:`r32float`,usage:GPUTextureUsage.STORAGE_BINDING|GPUTextureUsage.TEXTURE_BINDING}),i=this.pipelines[+!!this.levels.length];this.groups.push(this.device.createBindGroup({layout:i.getBindGroupLayout(0),entries:[{binding:0,resource:a},{binding:1,resource:e.createView({dimension:`2d-array`})}]})),this.levels.push(e),a=e.createView({dimension:`2d-array`})}while(t>16||n>16);this.groups.push(this.device.createBindGroup({layout:this.pipelines[2].getBindGroupLayout(0),entries:[{binding:0,resource:a},{binding:1,resource:{buffer:i}}]}))}destroy(){for(let e of this.levels)e.destroy();this.levels=[],this.groups=[],this.source=this.buffer=void 0}};export{e as BLOCK,a as NearestRoute,n as blockShader,r as levelShader,i as wordShader};