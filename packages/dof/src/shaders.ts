const params = `struct Params {lens:vec4f,frame:vec4f,ortho:vec4f}
@group(0) @binding(0) var<uniform> p:Params;`;

// Largest value over an 8x8 workgroup, without atomics (contended workgroup atomics cost ~0.3 ms at 720p on Arc).
// Call from uniform control flow.
const groupMax = `var<workgroup> lanes:array<f32,64>;
var<workgroup> rows:array<f32,8>;
fn groupMax(v:f32,local:u32)->f32 {
  lanes[local]=v;workgroupBarrier();
  if(local<8u){var m=lanes[local*8u];for(var i=1u;i<8u;i++){m=max(m,lanes[local*8u+i]);}rows[local]=m;}
  workgroupBarrier();
  var m=rows[0];for(var i=1u;i<8u;i++){m=max(m,rows[i]);}return m;
}`;

// Orthographic cameras (ortho.x): reversed-Z depth is linear in view distance, and blur grows linearly with defocus.
// Each 8x8 workgroup also writes its tile's largest near-field radius.
export const cocShader = `${params}
@group(0) @binding(1) var depth:texture_depth_2d;
@group(0) @binding(2) var coc:texture_storage_2d<rg32float,write>;
@group(0) @binding(3) var tiles:texture_storage_2d<r32float,write>;
${groupMax}
@compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) id:vec3u,@builtin(workgroup_id) tile:vec3u,@builtin(local_invocation_index) local:u32) {
  var near=0.0;
  if(all(id.xy<textureDimensions(coc))){
    let d=textureLoad(depth,vec2i(id.xy),0);
    let ortho=p.ortho.x>0.5;
    let z=select(p.frame.x*p.frame.y/(p.frame.x+d*(p.frame.y-p.frame.x)),mix(p.frame.y,p.frame.x,d),ortho);
    let radius=clamp(p.frame.z*select(1.0-p.lens.x/z,(z-p.lens.x)/p.lens.x,ortho),-p.lens.w,p.lens.w)*p.frame.w;
    textureStore(coc,vec2i(id.xy),vec4f(radius,z,0,0));near=-radius;
  }
  let m=groupMax(near,local);
  if(local==0u){textureStore(tiles,vec2i(tile.xy),vec4f(m,0,0,0));}
}`;

// Far-field gather of n spiral taps over the center's own disk into farColor/farWeight; only background samples
// count, so foreground stays in its own layer. A constant n lets the compiler fold the tap offsets.
const far = (n: number) => `for(var i=0u;i<${n}u;i++){
    let farPixel=clamp(pixel+vec2i(round(spiral(i,${n}.0)*center.x)),vec2i(0),limit);
    let farCoC=textureLoad(coc,farPixel,0).xy;
    if(farCoC.x>=0.0&&farCoC.y>=center.y-max(0.001,center.y*0.01)){farColor+=textureLoad(scene,farPixel,0).rgb;farWeight+=1.0;}
  }`;
const sampling = `@group(0) @binding(1) var scene:texture_2d<f32>;
@group(0) @binding(2) var coc:texture_2d<f32>;
fn spiral(i:u32,n:f32)->vec2f {
  let angle=f32(i)*2.39996323;
  return sqrt((f32(i)+0.5)/n)*vec2f(cos(angle),sin(angle));
}`;

// Wide far disks (radius > 3.19 px) are gathered once per 2x2 block, at its top-left pixel, into rgb + view depth
// (0: not a wide far pixel).
export const coarseShader = `${params}
${sampling}
@group(0) @binding(3) var coarse:texture_storage_2d<rgba16float,write>;
@compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) id:vec3u) {
  if(any(id.xy>=textureDimensions(coarse))){return;}
  let pixel=vec2i(id.xy)*2;let limit=vec2i(textureDimensions(coc))-1;let center=textureLoad(coc,pixel,0).xy;
  var farColor=textureLoad(scene,pixel,0).rgb;var farWeight=1.0;
  let wide=center.x>3.19&&p.frame.w!=0.0;
  if(wide){${far(64)}}
  textureStore(coarse,id.xy,vec4f(farColor/farWeight,select(0.0,center.y,wide)));
}`;

// Gather bokeh. Far field: about one spiral tap per pixel of the disk (16 taps to r 2.26, 32 to 3.19); wider disks
// interpolate the 2x2 block gathers (a wide disk changes little over one pixel), or gather 64 taps themselves when
// any interpolated block lies at another depth (silhouettes, where the gather changes fastest).
// Near field: foreground pixels within maxRadius whose own disk reaches this pixel. Tap i lies sqrt((i+0.5)/64)*
// maxRadius out and rounding moves it at most 0.71 px closer, so taps beyond the largest near radius of the
// neighbouring tiles plus one pixel cannot pass the radius test and are skipped. The foreground center itself is
// always counted, even for a disk smaller than the sampling lattice.
export const bokehShader = `${params}
${sampling}
@group(0) @binding(3) var result:texture_storage_2d<rgba16float,write>;
@group(0) @binding(4) var tiles:texture_2d<f32>;
@group(0) @binding(5) var coarse:texture_2d<f32>;
${groupMax}
fn disk(i:u32)->vec2f {return spiral(i,64.0);}
@compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) id:vec3u,@builtin(workgroup_id) tile:vec3u,@builtin(local_invocation_index) local:u32) {
  let count=vec2i(textureDimensions(tiles));let reach=i32(ceil(ceil(p.lens.w)/8.0));let span=2*reach+1;
  var mine=0.0;
  for(var t=i32(local);t<span*span;t+=64){
    let at=vec2i(tile.xy)+vec2i(t%span,t/span)-reach;
    if(all(at>=vec2i(0))&&all(at<count)){mine=max(mine,textureLoad(tiles,at,0).x);}
  }
  let nearMax=groupMax(mine,local);
  let size=textureDimensions(result);if(any(id.xy>=size)){return;}
  let pixel=vec2i(id.xy);let center=textureLoad(coc,pixel,0).xy;
  let sharp=textureLoad(scene,pixel,0);
  if(p.frame.w==0.0){textureStore(result,pixel,sharp);return;}
  var farColor=sharp.rgb;var farWeight=1.0;
  var nearColor=vec3f(0);var nearWeight=0.0;
  let limit=vec2i(size)-1;
  if(center.x>3.19){
    let q=pixel/2;let f=vec2f(pixel%2)*0.5;let last=vec2i(textureDimensions(coarse))-1;var up=vec4f(0);
    for(var k=0;k<4;k++){
      let o=vec2i(k%2,k/2);let w=mix(1.0-f.x,f.x,f32(o.x))*mix(1.0-f.y,f.y,f32(o.y));
      let s=textureLoad(coarse,min(q+o,last),0);
      if(w>0.0&&abs(s.w-center.y)<=0.05*center.y){up+=vec4f(s.rgb,1.0)*w;}
    }
    if(up.w>0.999){farColor=up.rgb;farWeight=up.w;}else{${far(64)}}
  }else if(center.x>2.26){${far(32)}}else if(center.x>0.5){${far(16)}}
  let reachTaps=select(0u,u32(clamp(64.0*pow((nearMax+1.0)/p.lens.w,2.0)+0.5,0.0,64.0)),nearMax>0.5);
  for(var i=0u;i<reachTaps;i++){
    let nearOffset=vec2i(round(disk(i)*p.lens.w));let nearPixel=pixel+nearOffset;
    if(any(nearPixel<vec2i(0))||any(nearPixel>limit)){continue;}
    let nearCoC=textureLoad(coc,nearPixel,0).xy;let radius=-nearCoC.x;
    if(radius>0.5&&length(vec2f(nearOffset))<=radius&&nearCoC.y<=center.y+max(0.001,center.y*0.01)){
      let weight=p.lens.w*p.lens.w/max(radius*radius,1.0);
      nearColor+=textureLoad(scene,nearPixel,0).rgb*weight;nearWeight+=weight;
    }
  }
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
