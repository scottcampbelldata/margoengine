const params = `struct Params {lens:vec4f,frame:vec4f,ortho:vec4f}
@group(0) @binding(0) var<uniform> p:Params;`;

// Orthographic cameras (ortho.x): reversed-Z depth is linear in view distance, and blur grows linearly with defocus.
export const cocShader = `${params}
@group(0) @binding(1) var depth:texture_depth_2d;
@group(0) @binding(2) var coc:texture_storage_2d<rg32float,write>;
@compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) id:vec3u) {
  if(any(id.xy>=textureDimensions(coc))){return;}
  let d=textureLoad(depth,vec2i(id.xy),0);
  let ortho=p.ortho.x>0.5;
  let z=select(p.frame.x*p.frame.y/(p.frame.x+d*(p.frame.y-p.frame.x)),mix(p.frame.y,p.frame.x,d),ortho);
  let radius=clamp(p.frame.z*select(1.0-p.lens.x/z,(z-p.lens.x)/p.lens.x,ortho),-p.lens.w,p.lens.w)*p.frame.w;
  textureStore(coc,vec2i(id.xy),vec4f(radius,z,0,0));
}`;

export const bokehShader = `${params}
@group(0) @binding(1) var scene:texture_2d<f32>;
@group(0) @binding(2) var coc:texture_2d<f32>;
@group(0) @binding(3) var result:texture_storage_2d<rgba16float,write>;
fn disk(i:u32)->vec2f {
  let angle=f32(i)*2.39996323;
  return sqrt((f32(i)+0.5)/64.0)*vec2f(cos(angle),sin(angle));
}
@compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) id:vec3u) {
  let size=textureDimensions(result);if(any(id.xy>=size)){return;}
  let pixel=vec2i(id.xy);let center=textureLoad(coc,pixel,0).xy;
  let sharp=textureLoad(scene,pixel,0);
  if(p.frame.w==0.0){textureStore(result,pixel,sharp);return;}
  var farColor=sharp.rgb;var farWeight=1.0;
  var nearColor=vec3f(0);var nearWeight=0.0;
  let limit=vec2i(size)-1;
  for(var i=0u;i<64u;i++){
    let offset=disk(i);
    let farPixel=clamp(pixel+vec2i(round(offset*max(center.x,0.0))),vec2i(0),limit);
    let farCoC=textureLoad(coc,farPixel,0).xy;
    // Only background samples contribute to a background blur; foreground stays in its own layer.
    if(center.x>0.5&&farCoC.x>=0.0&&farCoC.y>=center.y-max(0.001,center.y*0.01)){
      farColor+=textureLoad(scene,farPixel,0).rgb;farWeight+=1.0;
    }
    let nearOffset=vec2i(round(offset*p.lens.w));let nearPixel=pixel+nearOffset;
    if(any(nearPixel<vec2i(0))||any(nearPixel>limit)){continue;}
    let nearCoC=textureLoad(coc,nearPixel,0).xy;let radius=-nearCoC.x;
    if(radius>0.5&&length(vec2f(nearOffset))<=radius&&nearCoC.y<=center.y+max(0.001,center.y*0.01)){
      let weight=p.lens.w*p.lens.w/max(radius*radius,1.0);
      nearColor+=textureLoad(scene,nearPixel,0).rgb*weight;nearWeight+=weight;
    }
  }
  // Keep the foreground center represented even for a disk smaller than the sampling lattice.
  if(center.x< -0.5){nearColor+=sharp.rgb;nearWeight+=1.0;}
  let coverage=select(clamp(nearWeight/64.0,0.0,1.0),1.0,center.x< -0.5);
  let color=mix(farColor/farWeight,nearColor/max(nearWeight,0.0001),coverage);
  textureStore(result,pixel,vec4f(color,sharp.a));
}`;

export const presentShader = `
@group(0) @binding(0) var scene:texture_2d<f32>;
@vertex fn vertex(@builtin(vertex_index) i:u32)->@builtin(position) vec4f {
  let xy=array<vec2f,3>(vec2f(-1,-1),vec2f(3,-1),vec2f(-1,3));return vec4f(xy[i],0,1);
}
@fragment fn fragment(@builtin(position) pos:vec4f)->@location(0) vec4f {
  let c=textureLoad(scene,vec2i(pos.xy),0);let v=max(c.rgb,vec3f(0));let mapped=v/(1.0+v);
  return vec4f(select(mapped*12.92,1.055*pow(mapped,vec3f(1.0/2.4))-0.055,mapped>=vec3f(0.0031308)),c.a);
}`;
