import { MargoError } from '@margoengine/math/errors';
import { displayShader } from '../../shared/display.js';
const params = `struct Params {lens:vec4f,frame:vec4f,ortho:vec4f}
@group(0) @binding(0) var<uniform> p:Params;`;

// Largest value over an 8x8 workgroup, without atomics (contended workgroup atomics cost ~0.3 ms at 720p on Arc).
// Call from uniform control flow.
export const groupMax = `var<workgroup> lanes:array<f32,64>;
var<workgroup> rows:array<f32,8>;
fn groupMax(v:f32,local:u32)->f32 {
  lanes[local]=v;workgroupBarrier();
  if(local<8u){var m=lanes[local*8u];for(var i=1u;i<8u;i++){m=max(m,lanes[local*8u+i]);}rows[local]=m;}
  workgroupBarrier();
  var m=rows[0];for(var i=1u;i<8u;i++){m=max(m,rows[i]);}return m;
}`;

// Orthographic cameras (ortho.x): reversed-Z depth is linear in view distance, and blur grows linearly with defocus.
// Each 8x8 workgroup also writes its tile's largest near-field radius.
// Circle of confusion from the thin-lens equation (Potmesil & Chakravarty, "A Lens and Aperture Camera Model", 1981).
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

// Spiral taps on the golden angle (Vogel 1979).
// Far-field gather of n spiral taps over the center's own disk, scatter as gather in two layers (Jimenez 2014; layers
// as in Kraus & Strengert 2007). Samples at the center's depth or behind it average into farColor/farWeight. A far
// sample in front of the center counts only where its own disk reaches the center (reach), weighted by the center's
// disk area over its own (one tap stands for that share of the center's disk), and lies over the behind layer by the
// coverage those weights add up to. So a blurred far edge spreads both ways over what lies behind it, half inside and
// half outside, while a sharp subject (a disk under a pixel) never reaches its background. The near field keeps its own
// layer. A constant n lets the compiler fold the tap offsets.
const far = (n: number) => `var frontColor=vec3f(0);var frontWeight=0.0;var farTotal=farWeight;
  for(var i=0u;i<${n}u;i++){
    let farPixel=clamp(pixel+vec2i(round(spiral(i,${n}.0)*center.x)),vec2i(0),limit);
    let farCoC=textureLoad(coc,farPixel,0).xy;let farW=1.0;farTotal+=farW;
    if(farCoC.x>=0.0&&farCoC.y>=center.y-max(0.001,center.y*0.01)){farColor+=textureLoad(scene,farPixel,0).rgb;farWeight+=1.0;}
    else if(farCoC.x>0.5){
      let w=farW*covers(vec2f(farPixel-pixel),farCoC.x,pixel)*center.x*center.x/(farCoC.x*farCoC.x);
      frontColor+=textureLoad(scene,farPixel,0).rgb*w;frontWeight+=w;
    }
  }
  if(frontWeight>0.0){farColor=mix(farColor/farWeight,frontColor/frontWeight,min(frontWeight/farTotal,1.0));farWeight=1.0;}`;
const sampling = `@group(0) @binding(1) var scene:texture_2d<f32>;
@group(0) @binding(2) var coc:texture_2d<f32>;
fn spiral(i:u32,n:f32)->vec2f {
  let angle=f32(i)*2.39996323;
  return sqrt((f32(i)+0.5)/n)*vec2f(cos(angle),sin(angle));
}
fn covers(o:vec2f,radius:f32,pixel:vec2i)->f32 {return select(0.0,1.0,length(o)<=radius);}`;

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

// Near-field tap source: a mip chain at the gather's size of the near pixels premultiplied by 1 / radius^2 (their weight
// in the gather): colour and weight (nearTaps), weighted radius and view depth (nearShapes), and the plain scene
// (nearScene) for the background a near pixel sees past its own edge. Level 0 holds each pixel (nearShader), each level
// above the 2x2 mean of the one below (nearDownShader), so level k averages 2^k-pixel blocks. The gather reads it
// trilinearly at the level that matches its tap spacing, so a tap stands for its share of the disk, not for one pixel:
// read pixel by pixel, a sharp edge on a wide near surface came out in steps from row to row (known-bugs, "DOF near
// field: stepped blocks").
export const NEAR_LEVELS = 4;
export const nearShader = `${params}
@group(0) @binding(1) var scene:texture_2d<f32>;
@group(0) @binding(2) var coc:texture_2d<f32>;
@group(0) @binding(3) var nearTaps:texture_storage_2d<rgba16float,write>;
@group(0) @binding(4) var nearShapes:texture_storage_2d<rgba16float,write>;
@group(0) @binding(5) var nearScene:texture_storage_2d<rgba16float,write>;
@compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) id:vec3u) {
  if(any(id.xy>=textureDimensions(nearTaps))||p.frame.w==0.0){return;}
  let at=vec2i(id.xy);let s=textureLoad(coc,at,0).xy;let color=textureLoad(scene,at,0).rgb;
  let g=select(0.0,1.0/max(s.x*s.x,1.0),s.x< -0.5);
  textureStore(nearTaps,at,vec4f(color*g,g));
  textureStore(nearShapes,at,vec4f(-s.x*g,s.y*g,0,0));
  textureStore(nearScene,at,vec4f(color,1));
}`;
export const nearDownShader = `@group(0) @binding(0) var tapsBelow:texture_2d<f32>;
@group(0) @binding(1) var shapesBelow:texture_2d<f32>;
@group(0) @binding(2) var sceneBelow:texture_2d<f32>;
@group(0) @binding(3) var nearTaps:texture_storage_2d<rgba16float,write>;
@group(0) @binding(4) var nearShapes:texture_storage_2d<rgba16float,write>;
@group(0) @binding(5) var nearScene:texture_storage_2d<rgba16float,write>;
@compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) id:vec3u) {
  if(any(id.xy>=textureDimensions(nearTaps))){return;}
  let last=vec2i(textureDimensions(tapsBelow))-1;var taps=vec4f(0);var shapes=vec4f(0);var plain=vec4f(0);
  for(var k=0;k<4;k++){
    let at=min(vec2i(id.xy)*2+vec2i(k%2,k/2),last);
    taps+=textureLoad(tapsBelow,at,0);shapes+=textureLoad(shapesBelow,at,0);plain+=textureLoad(sceneBelow,at,0);
  }
  textureStore(nearTaps,vec2i(id.xy),taps*0.25);
  textureStore(nearShapes,vec2i(id.xy),shapes*0.25);
  textureStore(nearScene,vec2i(id.xy),plain*0.25);
}`;

// Gather bokeh. Far field: about one spiral tap per pixel of the disk (16 taps to r 2.26, 32 to 3.19); wider disks
// interpolate the 2x2 block gathers (a wide disk changes little over one pixel), or gather 64 taps themselves when
// any interpolated block lies at another depth (silhouettes, where the gather changes fastest).
// Near field: foreground whose own disk reaches this pixel, read from the near mip chain (nearShader): at each tap the
// premultiplied weight 1 / radius^2, colour, radius and depth of the near pixels around it. The 64 taps spread over the
// largest near radius that can reach this 8x8 tile, plus one pixel (R, at most maxRadius; a neighbouring tile counts
// where its own largest radius and the chain's footprint reach this one), so a small disk gets all 64 taps and keeps
// its shape, where taps over the whole maxRadius disk left a few blurred spots. Each tap reads the chain at the level
// whose footprint matches the taps' spacing, sqrt(area / 64) for the lens's tap area (tapArea, 1 for a round disk):
// trilinear sampling at level L blurs like a box 2^L * sqrt(3) wide. A tap counts where that radius reaches it (over
// one pixel, so a disk's outline moves smoothly as the radius changes) and that near field lies in front of this pixel.
// The foreground center counts as one tap's share of its own disk (a disk under an eighth of R is covered by its own
// pixel alone, smaller than the sampling lattice), not as full coverage: at a blurred near edge the taps from inside
// cover about half the disk, and the background seen past the edge (partial occlusion, Kraus & Strengert 2007) is the
// visible background within the center's own disk, gathered by the same taps: each tap's chain scene less the near
// field in front of this pixel there, by the share of the tap that field leaves open.
// The two whole levels around that level are read and blended here, not by the sampler's trilinear filter: a sampler
// blends two levels by the level's fraction at its own precision and in its own arithmetic, both left to the
// implementation (Vulkan's mipmapPrecisionBits, at least 4 bits), while the WebGL2 layer blends two whole levels by the
// full float fraction in the shader. Through the sampler the one-sample 'focus' case drew one 8-bit level apart on the
// two: 7 pixels on the Radeon 680M, and on the RTX A6000 even with the level on the 1/256 grid (mean 0.00053). A whole
// level is read alike by every sampler, so the near field draws the same on native WebGPU and on the layer.
const nearRead = (name: string, texture: string) =>
  `var ${name}=textureSampleLevel(${texture},filtered,at,low);if(blend>0.0){${name}=mix(${name},textureSampleLevel(${texture},filtered,at,low+1.0),blend);}`;
export const bokehShader = `${params}
${sampling}
@group(0) @binding(3) var result:texture_storage_2d<rgba16float,write>;
@group(0) @binding(4) var tiles:texture_2d<f32>;
@group(0) @binding(5) var coarse:texture_2d<f32>;
@group(0) @binding(6) var filtered:sampler;
@group(0) @binding(7) var nearTaps:texture_2d<f32>;
@group(0) @binding(8) var nearShapes:texture_2d<f32>;
@group(0) @binding(9) var nearScene:texture_2d<f32>;
${groupMax}
fn disk(i:u32)->vec2f {return spiral(i,64.0);}
const tapArea=1.0;
fn nearLod(radius:f32)->f32 {return max(log2(radius*0.2215567*sqrt(tapArea)/1.7320508),0.0);}
@compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) id:vec3u,@builtin(workgroup_id) tile:vec3u,@builtin(local_invocation_index) local:u32) {
  let count=vec2i(textureDimensions(tiles));let footprint=1.5*exp2(min(ceil(nearLod(p.lens.w)),${NEAR_LEVELS - 1}.0));let reach=i32(ceil((p.lens.w+1.0+footprint)/8.0));let span=2*reach+1;
  var mine=0.0;
  for(var t=i32(local);t<span*span;t+=64){
    let o=vec2i(t%span,t/span)-reach;let at=vec2i(tile.xy)+o;
    if(all(at>=vec2i(0))&&all(at<count)){
      let m=textureLoad(tiles,at,0).x;let gap=vec2f(max(abs(o)*8-7,vec2i(0)));
      if(length(gap)<=m+1.0+footprint){mine=max(mine,m);}
    }
  }
  let nearMax=groupMax(mine,local);
  let size=textureDimensions(result);if(any(id.xy>=size)){return;}
  let pixel=vec2i(id.xy);let center=textureLoad(coc,pixel,0).xy;
  let sharp=textureLoad(scene,pixel,0);
  if(p.frame.w==0.0){textureStore(result,pixel,sharp);return;}
  var farColor=sharp.rgb;var farWeight=1.0;
  var nearColor=vec3f(0);var nearWeight=0.0;var backColor=vec3f(0);var backWeight=0.0;
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
  let reachTaps=select(0u,64u,nearMax>0.5);let R=min(p.lens.w,nearMax+1.0);let lod=min(nearLod(R),${NEAR_LEVELS - 1}.0);
  let low=floor(lod);let blend=lod-low;
  let nearSize=vec2f(textureDimensions(nearTaps));
  for(var i=0u;i<reachTaps;i++){
    let nearTap=disk(i)*R;let nearPixel=pixel+vec2i(round(nearTap));
    if(any(nearPixel<vec2i(0))||any(nearPixel>limit)){continue;}
    let at=(vec2f(pixel)+0.5+nearTap)/nearSize;${nearRead('source', 'nearTaps')}
    var share=0.0;var tint=vec3f(0);
    if(source.w>0.0){
      ${nearRead('nearForm', 'nearShapes')}let form=nearForm.xy/source.w;let radius=form.x;tint=source.rgb/source.w;
      if(form.y<=center.y+max(0.001,center.y*0.01)){
        share=min(source.w*max(radius*radius,1.0),1.0);
        let inside=clamp(radius-length(nearTap)+0.5,0.0,1.0);
        let weight=R*R*source.w*inside;
        nearColor+=tint*weight;nearWeight+=weight;
      }
    }
    if(center.x< -0.5&&share<1.0&&covers(nearTap,-center.x,pixel)>0.0){
      ${nearRead('behind', 'nearScene')}backColor+=max(behind.rgb-tint*share,vec3f(0));backWeight+=1.0-share;
    }
  }
  if(center.x< -0.5){
    let weight=R*R/(center.x*center.x);nearColor+=sharp.rgb*weight;nearWeight+=weight;
    if(backWeight>0.0){farColor=backColor;farWeight=backWeight;}
  }
  let coverage=clamp(nearWeight/64.0,0.0,1.0);
  let color=mix(farColor/farWeight,nearColor/max(nearWeight,0.0001),coverage);
  textureStore(result,pixel,vec4f(color,sharp.a));
}`;

export const presentShader = `
@group(0) @binding(0) var scene:texture_2d<f32>;
@vertex fn vertex(@builtin(vertex_index) i:u32)->@builtin(position) vec4f {
  let xy=array<vec2f,3>(vec2f(-1,-1),vec2f(3,-1),vec2f(-1,3));return vec4f(xy[i],0,1);
}
${displayShader}
@fragment fn fragment(@builtin(position) pos:vec4f)->@location(0) vec4f {
  let c=textureLoad(scene,vec2i(pos.xy),0);return vec4f(toDisplay(c.rgb),c.a);
}`;

// Half resolution (temporal): the CoC runs at full resolution; this pass halves the scene (2x2 mean) and the CoC (the
// nearest of the four, its radius halved) and writes the half image's 8x8 tile maxima, so the gather kernels run as
// they are on a quarter of the pixels.
export const halveShader = `@group(0) @binding(0) var scene:texture_2d<f32>;
@group(0) @binding(1) var coc:texture_2d<f32>;
@group(0) @binding(2) var halfScene:texture_storage_2d<rgba16float,write>;
@group(0) @binding(3) var halfCoc:texture_storage_2d<rg32float,write>;
@group(0) @binding(4) var tiles:texture_storage_2d<r32float,write>;
${groupMax}
@compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) id:vec3u,@builtin(workgroup_id) tile:vec3u,@builtin(local_invocation_index) local:u32) {
  var near=0.0;
  if(all(id.xy<textureDimensions(halfCoc))){
    let last=vec2i(textureDimensions(coc))-1;var color=vec4f(0);var c=vec2f(0,3.4e38);
    for(var k=0;k<4;k++){
      let at=min(vec2i(id.xy)*2+vec2i(k%2,k/2),last);color+=textureLoad(scene,at,0);
      let s=textureLoad(coc,at,0).xy;if(s.y<c.y){c=s;}
    }
    textureStore(halfScene,vec2i(id.xy),color*0.25);textureStore(halfCoc,vec2i(id.xy),vec4f(c.x*0.5,c.y,0,0));near=-c.x*0.5;
  }
  let m=groupMax(near,local);
  if(local==0u){textureStore(tiles,vec2i(tile.xy),vec4f(m,0,0,0));}
}`;

// Full resolution again: the half gather, bilinear, over the sharp scene by the pixel's own blur (in focus stays
// sharp) or by the near-field coverage the half gather stored in alpha (foreground blur spreads over the focus).
export const joinShader = `@group(0) @binding(0) var scene:texture_2d<f32>;
@group(0) @binding(1) var coc:texture_2d<f32>;
@group(0) @binding(2) var blurred:texture_2d<f32>;
@group(0) @binding(3) var result:texture_storage_2d<rgba16float,write>;
@compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) id:vec3u) {
  if(any(id.xy>=textureDimensions(result))){return;}
  let pixel=vec2i(id.xy);let sharp=textureLoad(scene,pixel,0);
  let g=(vec2f(pixel)+0.5)*0.5-0.5;let q=vec2i(floor(g));let f=g-floor(g);let last=vec2i(textureDimensions(blurred))-1;
  let b=mix(mix(textureLoad(blurred,clamp(q,vec2i(0),last),0),textureLoad(blurred,clamp(q+vec2i(1,0),vec2i(0),last),0),f.x),
    mix(textureLoad(blurred,clamp(q+vec2i(0,1),vec2i(0),last),0),textureLoad(blurred,clamp(q+vec2i(1,1),vec2i(0),last),0),f.x),f.y);
  let w=max(smoothstep(0.5,1.5,abs(textureLoad(coc,pixel,0).x)),b.a);
  textureStore(result,pixel,vec4f(mix(sharp.rgb,b.rgb,w),sharp.a));
}`;

/** The gather kernels for the half image: each frame turns the taps by `p.ortho.w`, and alpha holds near coverage. */
export function halfShaders<T extends { coarseShader: string; bokehShader: string }>(source: T): T {
  const turn = (code: string) => {
    const parts = code.split('f32(i)*2.39996323');
    if (parts.length < 2)
      throw new MargoError('unsupported', 'DOF temporal needs the gather kernels of its own version');
    return parts.join('(f32(i)*2.39996323+p.ortho.w)');
  };
  const store = 'textureStore(result,pixel,vec4f(color,sharp.a));';
  const off = 'if(p.frame.w==0.0){textureStore(result,pixel,sharp);return;}';
  if (source.bokehShader.split(store).length !== 2 || source.bokehShader.split(off).length !== 2)
    throw new MargoError('unsupported', 'DOF temporal needs the gather kernels of its own version');
  return {
    ...source,
    coarseShader: turn(source.coarseShader),
    // Off, the half image covers nothing, so the join shows the scene.
    bokehShader: turn(source.bokehShader)
      .replace(store, 'textureStore(result,pixel,vec4f(color,coverage));')
      .replace(off, 'if(p.frame.w==0.0){textureStore(result,pixel,vec4f(sharp.rgb,0));return;}'),
  };
}
