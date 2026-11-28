import{t as e}from"./scene-C8AySYNv.js";var t=(t,n)=>n.reduce((t,[n,r])=>{if(t.split(n).length!==2)throw e(`unsupported`,`DOF on WebGL2 needs the shader its compatibility route was written for`);return t.replace(n,r)},t),n=`,@builtin(workgroup_id) tile:vec3u,@builtin(local_invocation_index) local:u32`,r=({cocShader:e,groupMax:r})=>t(e,[[`@group(0) @binding(3) var tiles:texture_storage_2d<r32float,write>;
`,``],[r,``],[n,``],[`
  let m=groupMax(near,local);
  if(local==0u){textureStore(tiles,vec2i(tile.xy),vec4f(m,0,0,0));}`,``],[`let d=textureLoad(depth,vec2i(id.xy),0);`,`let at=vec2i(id.xy);var d=textureLoad(depth,at,0);
    if(p.ortho.w>0.5){let last=vec2i(textureDimensions(depth))-1;for(var k=0;k<4;k++){let o=select(vec2i(0,k*2-1),vec2i(k*2-5,0),k>1);d=max(d,textureLoad(depth,clamp(at+o,vec2i(0),last),0));}}`]]),i=`@group(0) @binding(0) var coc:texture_2d<f32>;
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
}`,a=({bokehShader:e,groupMax:r})=>t(e,[[r,``],[n,``],[`var mine=0.0;
  for(var t=i32(local);t<span*span;t+=64){`,`var mine=0.0;let tile=id.xy/8u;
  for(var t=0;t<span*span;t++){`],[`let nearMax=groupMax(mine,local);`,`let nearMax=mine;`]]),o=(e,r)=>t(e,[[`@group(0) @binding(4) var tiles:texture_storage_2d<r32float,write>;
`,``],[r,``],[n,``],[`
  let m=groupMax(near,local);
  if(local==0u){textureStore(tiles,vec2i(tile.xy),vec4f(m,0,0,0));}`,``]]);function s(e,t,n){let s=t=>e.createComputePipeline({layout:`auto`,compute:{module:e.createShaderModule({code:t}),entryPoint:`main`}});return{coc:s(r(t)),tiles:s(i),bokeh:s(a(t)),...n&&{halve:s(o(n,t.groupMax))}}}export{a as bokehAloneShader,r as cocPixelShader,s as dofCompatPipelines,i as tilesShader};