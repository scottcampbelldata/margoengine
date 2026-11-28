import { neutralShader } from '../../shared/display.js';
import { ggxD, smithGCorrelated } from '../../shared/light-terms.js';
// Vertex morph between grid levels: Strugar 2009, "Continuous Distance-Dependent Level of Detail" (CDLOD), JGT.
export const terrainVertex = /* wgsl */ `
struct Frame {camera:mat4x4f,eye:vec4f,light:vec4f,radiance:vec4f,grid:vec4f,offset:vec4f,map:vec4f,heights:vec4f,ambient:vec4f}
struct Layer {heightSlope:vec4f,params:vec4f}
@group(0) @binding(0) var<uniform> frame:Frame;
@group(0) @binding(1) var heightMap:texture_2d<f32>;
@group(0) @binding(2) var normalMap:texture_2d<f32>;
@group(0) @binding(3) var terrainLayers:texture_2d_array<f32>;
@group(0) @binding(4) var terrainSampler:sampler;
@group(0) @binding(5) var<storage,read> layerRules:array<Layer>;
fn height(position:vec2f)->f32 {
  let dimensions=vec2i(textureDimensions(heightMap));let uv=clamp((position-frame.map.xy)/frame.map.zw,vec2f(0),vec2f(1));let pixel=uv*vec2f(dimensions-vec2i(1));let lo=vec2i(floor(pixel));let hi=min(lo+vec2i(1),dimensions-vec2i(1));let t=fract(pixel);
  let a=mix(textureLoad(heightMap,lo,0).r,textureLoad(heightMap,vec2i(hi.x,lo.y),0).r,t.x);let b=mix(textureLoad(heightMap,vec2i(lo.x,hi.y),0).r,textureLoad(heightMap,hi,0).r,t.x);
  return mix(a,b,t.y)*frame.heights.x+frame.heights.y;
}
struct Output {@builtin(position) @invariant clip:vec4f,@location(0) position:vec3f,@location(1) normal:vec3f,@location(2) color:vec3f,@location(3) material:vec4f}
@vertex fn vertex(@location(0) grid:vec2f)->Output {
  let edge=max(abs(grid.x),abs(grid.y));let morph=clamp((edge-frame.grid.w*0.5+2)/2,0.0,1.0);
  let aligned=mix(grid,round(grid*0.5)*2,morph);let inner=clamp((frame.grid.w*0.5-edge)/(frame.grid.w*0.25),0.0,1.0);
  let xz=frame.grid.xy+aligned*frame.grid.z+frame.offset.xy*inner;let position=vec3f(xz.x,height(xz),xz.y);
  let step=frame.map.zw/max(vec2f(textureDimensions(heightMap))-1,vec2f(1));
  var normal=normalize(vec3f((height(xz-vec2f(step.x,0))-height(xz+vec2f(step.x,0)))/(2*step.x),1,(height(xz-vec2f(0,step.y))-height(xz+vec2f(0,step.y)))/(2*step.y)));
  if(frame.offset.w>0.5){let dimensions=vec2i(textureDimensions(normalMap));let uv=clamp((xz-frame.map.xy)/frame.map.zw,vec2f(0),vec2f(1));let sampled=textureLoad(normalMap,min(vec2i(uv*vec2f(dimensions)),dimensions-vec2i(1)),0).xyz*2-1;if(dot(sampled,sampled)>0.00001){normal=normalize(sampled);}}
  var o:Output;o.position=position;o.clip=frame.camera*vec4f(position,1);o.normal=normal;o.color=vec3f(1);o.material=vec4f(0.9,0,1,1);return o;
}
`;
/**
 * The heightmap covers `frame.map` (origin, size); the outer clipmap rings reach past it, where heights and weights are
 * only the clamped edge texels (a flat shelf with stretched walls). Fragments there are dropped, so the sky shows past
 * the terrain's edge (main drew that shelf to the horizon).
 */
/**
 * `TerrainTextures.holes`, added after `terrainOutside` in every pass with a mask: the fragment's cell of the mask
 * (its texels split the bounds evenly), dropped where R is below 0.5.
 */
export const terrainHole = /* wgsl */ `{let hd=vec2i(textureDimensions(terrainHoles));if(textureLoad(terrainHoles,clamp(vec2i(floor((i.position.xz-frame.map.xy)/frame.map.zw*vec2f(hd))),vec2i(0),hd-vec2i(1)),0).r<0.5){discard;}}`;
export const terrainOutside = /* wgsl */ `if(any(i.position.xz<frame.map.xy)||any(i.position.xz>frame.map.xy+frame.map.zw)){discard;}`;
/**
 * `TerrainLayer.bump` and `macro`, compiled in only when some layer sets one (otherwise every shader is the text it was).
 * Rules grow to 12 floats: `surface` is (bump height in metres per unit of luma, macro amount, macro texture scale, 0).
 * `terrainSurface` takes a layer's triplanar colour and returns it scaled by the macro tone (`terrainMacro`, one
 * triplanar axis at a time; the mean from the top mip keeps the average colour) with the bump height in w.
 * `terrainMacro` is the layer at 1/24 of its scale, whose one repeat tiled into a grid a kilometre away (luma correlated
 * 0.999 at the 96 m lag, test/bump.browser.mjs). A smooth coarse mip of the layer at a repeat 3.31 times longer varies the
 * tone slowly and picks an offset for the repeat, two blended by its fraction: Quilez, "Texture Repetition", technique 3.
 * Warping the coordinates instead drew wood grain, a finer second sample left the grid.
 * `terrainBump` is Mikkelsen 2010, "Bump Mapping Unparametrized Surfaces on the GPU" (JGT 15(1)), listing 1: the
 * surface gradient of that height from its screen-space derivatives and the position's, no extra texture samples. Each
 * screen axis is first divided by its position derivative's length (the formula is homogeneous in each axis), so det
 * is the sine-like measure of how far the two axes are from parallel in 3D: 1 on any surface seen squarely or at a
 * grazing angle along a screen axis, near 0 only on slivers seen edge-on. There both axes sample nearly one direction
 * on the surface, so the solve divides the height derivatives by det, and those carry errors (the 2x2 quad's helper
 * lanes lie past the crest edge, where the vertex normal, the triplanar blend and the layer weights are extrapolated).
 * The slope the gradient may give is therefore capped at min(1, 4 det), what the pixel can resolve. Uncapped, alpine
 * crests under the noon sun got slopes of 1.5 to over 8 and drew dotted lines of near-black pixels
 * (test/crest.browser.mjs: 21 specks against 0 without bump; capped, 0).
 * A slope estimated across one pixel holds only what that pixel resolves: mips average the height, not its slope, and
 * the relief is up to half a repeat high, so the estimate stayed large at every distance and drew pixel grain on far and
 * grazing ground. Past a footprint of 1/64 of a repeat it falls with the longer side of the pixel on the ground.
 * Magnified, the height holds nothing finer than 1/128 of a repeat (`terrainReliefLuma`): the layer's mip with 128
 * texels a repeat through a cubic B-spline over 4 x 4 exact texel loads (the basis of Sigg and Hadwiger 2005, "Fast
 * Third-Order Texture Filtering", GPU Gems 2 chapter 20, without their bilinear shortcut). A height read texel by texel
 * through the sampler is texel noise times half a repeat (root mean square slopes of 1.2 on the biomes' tundra and 5.3
 * on rock at 256 texels over 4 m), one slope a texel, and the hardware's rounded filter weights, which the screen
 * derivative drew as black and white speckle, facets and dotted lines along texel edges (KB-TUNDRA-GROUNDNOISE1). The
 * B-spline's slope is continuous and its weights exact. Between footprints of 1/128 and 1/64 of a repeat it hands over
 * to the colour sample's own mip; past 1/64 the height is the colour sample's, as before.
 */
export const surfaceStruct = (code: string): string =>
  code.replace(
    'struct Layer {heightSlope:vec4f,params:vec4f}',
    'struct Layer {heightSlope:vec4f,params:vec4f,surface:vec4f}',
  );
/**
 * `TerrainOptions.floatingOrigin`: positions reach the shaders local (world less the origin's shift), small enough for
 * float32. Every layer sample that repeats with position (triplanar, macro, its 0.302 tone) adds the layer's `wrap`, the
 * shift from the terrain's anchor less a whole number k of 24 / scale repeats per axis, and the tone adds
 * `fract(k * 0.302)`: so each texture coordinate equals the terrain-relative one up to whole repeats, the same at any
 * distance and across a rebase, and a terrain moved with its camera draws the same picture. `Frame.anchor` is
 * (shift.x - origin.x, shift.z - origin.z, shift.y, 0): local + anchor.xy is the terrain-relative XZ that cache surfaces,
 * overlays and imagery read. Applied once; the text without the option is unchanged.
 */
export const originShader = (code: string): string =>
  code.includes('anchor:vec4f}')
    ? code
    : code
        .replace('ambient:vec4f}', 'ambient:vec4f,anchor:vec4f}')
        .replace(/struct Layer \{([^}]*)\}/, 'struct Layer {$1,wrap:vec4f,tone:vec4f}')
        .replace(
          'fn terrainPatchXZ(p:vec3f)->vec2f {return p.xz;}',
          'fn terrainPatchXZ(p:vec3f)->vec2f {return p.xz+frame.anchor.xy;}',
        )
        .split('let p=position*scale;')
        .join('let p=(position+layerRules[layer].wrap.xyz)*scale;')
        .replace(
          'let p=position*m;let q=position*m*0.302;',
          'let p=(position+layerRules[layer].wrap.xyz)*layerRules[layer].params.x/24.0;let q=p*0.302+layerRules[layer].tone.xyz;',
        );
const surfaceFunctions = /* wgsl */ `
var<private> terrainRelief:f32;var<private> terrainRepeat:f32;
fn terrainMacro(p:vec2f,q:vec2f,dx:vec2f,dy:vec2f,m:f32,layer:u32,top:f32,norm:f32)->f32 {
  let luma=vec3f(0.2126,0.7152,0.0722);let w=dot(textureSampleLevel(terrainLayers,terrainSampler,q,i32(layer),max(top-3.0,0.0)).rgb,luma)*norm;
  let k=w*16.0;let i=floor(k);let t=smoothstep(0.2,0.8,k-i);
  let a=textureSampleGrad(terrainLayers,terrainSampler,p+sin(vec2f(3,7)*i),i32(layer),dx*m,dy*m).rgb;
  let b=textureSampleGrad(terrainLayers,terrainSampler,p+sin(vec2f(3,7)*(i+1.0)),i32(layer),dx*m,dy*m).rgb;
  return dot(mix(a,b,t),luma)*norm*w;
}
fn terrainReliefTap(p:vec2f,layer:u32,level:u32,size:i32)->f32 {
  let st=p*f32(size)-0.5;let i=floor(st);let f=st-i;let r=vec2f(1.0)-f;
  let a=r*r*r/6.0;let b=(3.0*f*f*f-6.0*f*f+4.0)/6.0;let d=f*f*f/6.0;let c=vec2f(1.0)-a-b-d;
  let wx=vec4f(a.x,b.x,c.x,d.x);let wy=vec4f(a.y,b.y,c.y,d.y);let first=vec2i(i)-1;var h=0.0;
  for(var y=0;y<4;y++){for(var x=0;x<4;x++){
    let t=((first+vec2i(x,y))%size+size)%size;
    h+=wx[x]*wy[y]*dot(textureLoad(terrainLayers,t,i32(layer),level).rgb,vec3f(0.2126,0.7152,0.0722));
  }}
  return h;
}
fn terrainReliefLuma(position:vec3f,projection:vec3f,layer:u32)->f32 {
  let scale=layerRules[layer].params.x;let p=position*scale;let texels=textureDimensions(terrainLayers).x;
  let level=u32(clamp(floor(log2(f32(texels)/128.0)),0.0,f32(textureNumLevels(terrainLayers)-1u)));let size=i32(texels>>level);
  var h=0.0;var total=0.0;
  if(projection.x>0.01){h+=projection.x*terrainReliefTap(p.zy,layer,level,size);total+=projection.x;}
  if(projection.y>0.01){h+=projection.y*terrainReliefTap(p.xz,layer,level,size);total+=projection.y;}
  if(projection.z>0.01){h+=projection.z*terrainReliefTap(p.xy,layer,level,size);total+=projection.z;}
  return h/max(total,0.00001);
}
fn terrainReliefTint(h:f32,layer:u32)->f32 {return h;}
fn terrainSurface(sample:vec3f,position:vec3f,projection:vec3f,dx:vec3f,dy:vec3f,layer:u32)->vec4f {
  let s=layerRules[layer].surface;let luma=vec3f(0.2126,0.7152,0.0722);var color=sample;
  if(s.y>0.0){
    let top=f32(textureNumLevels(terrainLayers)-1u);let norm=1.0/max(dot(textureSampleLevel(terrainLayers,terrainSampler,vec2f(0.5),i32(layer),top).rgb,luma),0.0001);
    let m=s.z;let p=position*m;let q=position*m*0.302;var tone=0.0;
    if(projection.x>0.01){tone+=projection.x*terrainMacro(p.zy,q.yz,dx.zy,dy.zy,m,layer,top,norm);}
    if(projection.y>0.01){tone+=projection.y*terrainMacro(p.xz,q.zx,dx.xz,dy.xz,m,layer,top,norm);}
    if(projection.z>0.01){tone+=projection.z*terrainMacro(p.xy,q.yx,dx.xy,dy.xy,m,layer,top,norm);}
    color*=max(1.0-s.y+s.y*tone,0.0);
  }
  var h=dot(sample,luma);
  if(s.x>0.0){
    let near=1.0-smoothstep(1.0/128.0,1.0/64.0,layerRules[layer].params.x*max(length(dx),length(dy)));
    if(near>0.0){h=mix(h,terrainReliefTint(terrainReliefLuma(position,projection,layer),layer),near);}
  }
  return vec4f(color,h*s.x);
}
fn terrainBump(position:vec3f,normal:vec3f)->vec3f {
  let px=dpdxFine(position);let py=dpdyFine(position);let ax=1.0/max(length(px),1e-20);let ay=1.0/max(length(py),1e-20);
  let dx=px*ax;let dy=py*ay;let r1=cross(dy,normal);let r2=cross(normal,dx);let det=dot(dx,r1);
  let g=sign(det)*(dpdxFine(terrainRelief)*ax*r1+dpdyFine(terrainRelief)*ay*r2)*min(1.0,1.0/max(64.0*terrainRepeat*max(length(px),length(py)),1e-20));
  let bumped=abs(det)*normal-g*min(1.0,min(1.0,4.0*abs(det))*abs(det)/max(length(g),1e-20));
  return select(normal,normalize(bumped),dot(bumped,bumped)>0.0);
}`;
/** The fragment's shading normal `n` and layer colour `base` (the SSR capture entry starts the same way). */
export const terrainShading = (surface: boolean): string =>
  surface
    ? 'let terrainN=normalize(i.normal);let base=terrainColor(i.position,terrainN);let n=terrainBump(i.position,terrainN);'
    : 'let n=normalize(i.normal);let base=terrainColor(i.position,n);';
// Triplanar weights abs(n)^8 (Geiss 2007, GPU Gems 3 ch. 1; exponent 8 is Margo's); GGX + Schlick (F0 0.04) + Lambert
// sun per glTF 2.0 Appendix B (Walter et al. 2007; Schlick 1994); Khronos PBR Neutral, then sRGB (IEC 61966-2-1).
/** The rule-weighted fragment shader; `surface` adds `TerrainLayer.bump` and `macro`. A function, so a bundle that
 * never draws a terrain keeps no shader text. */
export const terrainFragment = (
  surface = false,
): string => /* wgsl */ `${neutralShader}${surface ? surfaceFunctions : ''}
fn terrainColor(position:vec3f,normal:vec3f)->vec3f {
  let slope=1-clamp(normal.y,0.0,1.0);let axes=pow(abs(normal),vec3f(8));let projection=axes/max(axes.x+axes.y+axes.z,0.00001);let dx=dpdx(position);let dy=dpdy(position);var color=vec3f(0);var total=0.0;var fallback=vec3f(0);${surface ? 'var relief=0.0;var fallbackRelief=0.0;var repeat=0.0;' : ''}
  for(var layer=0u;layer<u32(frame.heights.z);layer++){
    let rule=layerRules[layer];let hs=rule.heightSlope;let scale=rule.params.x;let p=position*scale;
    let x=textureSampleGrad(terrainLayers,terrainSampler,p.zy,i32(layer),dx.zy*scale,dy.zy*scale).rgb;
    let y=textureSampleGrad(terrainLayers,terrainSampler,p.xz,i32(layer),dx.xz*scale,dy.xz*scale).rgb;
    let z=textureSampleGrad(terrainLayers,terrainSampler,p.xy,i32(layer),dx.xy*scale,dy.xy*scale).rgb;
    ${surface ? 'let surface=terrainSurface(x*projection.x+y*projection.y+z*projection.z,position,projection,dx,dy,layer);let sample=surface.rgb;if(layer==0){fallback=sample;fallbackRelief=surface.w;terrainRepeat=scale;}' : 'let sample=x*projection.x+y*projection.y+z*projection.z;if(layer==0){fallback=sample;}'}
    let h=rule.params.y;let s=rule.params.z;
    let weight=smoothstep(hs.x-h,hs.x+h,position.y)*(1-smoothstep(hs.y-h,hs.y+h,position.y))*smoothstep(hs.z-s,hs.z+s,slope)*(1-smoothstep(hs.w-s,hs.w+s,slope));
    color+=sample*weight;total+=weight;${surface ? 'relief+=surface.w*weight;repeat+=scale*weight;' : ''}
  }
  ${surface ? 'terrainRelief=select(fallbackRelief,relief/max(total,0.00001),total>0.00001);if(total>0.00001){terrainRepeat=repeat/total;}' : ''}return select(fallback,color/max(total,0.00001),total>0.00001);
}
@fragment fn fragment(i:Output)->@location(0) vec4f {
  ${terrainOutside}
  ${terrainShading(surface)}let v=normalize(frame.eye.xyz-i.position);let l=frame.light.xyz;let h=(v+l)/max(length(v+l),0.0001);
  let nl=clamp(dot(n,l),0.0,1.0);let nv=clamp(dot(n,v),0.0001,1.0);let nh=clamp(dot(n,h),0.0,1.0);let vh=clamp(dot(v,h),0.0,1.0);let a=i.material.x*i.material.x;let a2=a*a;
  let d=${ggxD};let g=${smithGCorrelated};let fresnel=vec3f(0.04)+vec3f(0.96)*pow(1-vh,5.0);
  let direct=((1-fresnel)*base/3.14159265+d*g*fresnel/max(4*nl*nv,0.0001))*nl;
  let linear=direct*frame.radiance.xyz*frame.light.w+base*frame.radiance.w*frame.ambient.rgb;
  if(frame.heights.w>0.5){return vec4f(linear,1);}
  let mapped=pbrNeutral(max(linear,vec3f(0)));return vec4f(select(mapped*12.92,1.055*pow(mapped,vec3f(1.0/2.4))-0.055,mapped>=vec3f(0.0031308)),1);
}`;

/** One layer's triplanar colour: its three projections blended by the normal (`terrainColor` and the weighted one). */
const layerSample = /* wgsl */ `
fn terrainLayerSample(position:vec3f,projection:vec3f,dx:vec3f,dy:vec3f,layer:u32)->vec3f {
  let scale=layerRules[layer].params.x;let p=position*scale;
  let x=textureSampleGrad(terrainLayers,terrainSampler,p.zy,i32(layer),dx.zy*scale,dy.zy*scale).rgb;
  let y=textureSampleGrad(terrainLayers,terrainSampler,p.xz,i32(layer),dx.xz*scale,dy.xz*scale).rgb;
  let z=textureSampleGrad(terrainLayers,terrainSampler,p.xy,i32(layer),dx.xy*scale,dy.xy*scale).rgb;
  return x*projection.x+y*projection.y+z*projection.z;
}`;

/**
 * `TerrainOptions.patches`: the painted weights resolved into patches with crisp edges, as alpine ground is turf, scree
 * and rock side by side rather than their average. Each layer whose weight is above 0 gets a height, `contrast` times a
 * value-noise fBm of its own (cells of `size` metres, three octaves, quintic fade, Perlin 2002 "Improving Noise",
 * SIGGRAPH; cell values from the pcg3d hash of Jarzynski and Olano 2020, "Hash Functions for GPU Rendering", JCGT 9(3)),
 * added to its weight; only the layers within 0.05 x contrast of the highest sum keep weight, by how far they reach
 * past that line (height-based splatting: Mishkinis 2013, "Advanced Terrain Texture Splatting", Gamasutra; noise-masked
 * splats as in Andersson 2007, "Terrain Rendering in Frostbite Using Procedural Shader Splatting", SIGGRAPH course).
 * Weights of 1 and 0 stay as painted. Octaves finer than half a pixel's footprint fade to their mean, and the patched
 * weights hand back to the painted ones as the footprint grows from 0.3 to 0.8 of a cell, so far ground neither
 * aliases nor turns into the strongest layer alone. With `floatingOrigin` the noise reads terrain-relative positions.
 */
const patchFunctions = (size: number, contrast: number): string => /* wgsl */ `
var<private> terrainPatchWeights:array<f32,16>;
fn terrainPatchXZ(p:vec3f)->vec2f {return p.xz;}
fn terrainPatchHash(c:vec2f,layer:u32)->f32 {
  var v=vec3u(bitcast<u32>(i32(c.x)),bitcast<u32>(i32(c.y)),layer)*1664525u+1013904223u;
  v.x+=v.y*v.z;v.y+=v.z*v.x;v.z+=v.x*v.y;v^=v>>vec3u(16u);v.x+=v.y*v.z;v.y+=v.z*v.x;v.z+=v.x*v.y;
  return f32(v.x>>8u)/16777216.0;
}
fn terrainPatchNoise(p:vec2f,layer:u32)->f32 {
  let i=floor(p);let f=p-i;let u=f*f*f*(f*(f*6.0-15.0)+10.0);
  return mix(mix(terrainPatchHash(i,layer),terrainPatchHash(i+vec2f(1,0),layer),u.x),mix(terrainPatchHash(i+vec2f(0,1),layer),terrainPatchHash(i+vec2f(1,1),layer),u.x),u.y);
}
fn terrainPatch(xz:vec2f,layer:u32,footprint:f32)->f32 {
  var p=xz*${(1 / size).toPrecision(9)};var cell=${size.toPrecision(9)};var amp=0.5;var sum=0.0;var norm=0.0;
  for(var k=0u;k<3u;k++){let fade=1.0-smoothstep(0.25,0.5,footprint/cell);sum+=amp*mix(0.5,terrainPatchNoise(p,layer*3u+k),fade);norm+=amp;p=p*2.03+vec2f(19.1,7.3);cell/=2.03;amp*=0.5;}
  return sum/norm;
}
fn terrainPatchBlend(packed:ptr<function,array<vec4f,4>>,xz:vec2f,footprint:f32) {
  var top=-1.0;var plain=0.0;
  for(var layer=0u;layer<u32(frame.heights.z);layer++){
    let w=(*packed)[layer/4u][layer%4u];terrainPatchWeights[layer]=-1.0;if(w<=0.0){continue;}
    let t=w+${contrast.toPrecision(9)}*terrainPatch(xz,layer,footprint);terrainPatchWeights[layer]=t;top=max(top,t);plain+=w;
  }
  let line=top-${(0.05 * contrast).toPrecision(9)};var sum=0.0;
  for(var layer=0u;layer<u32(frame.heights.z);layer++){let b=max(terrainPatchWeights[layer]-line,0.0);terrainPatchWeights[layer]=b;sum+=b;}
  let near=1.0-smoothstep(0.3,0.8,footprint*${(1 / size).toPrecision(9)});
  for(var layer=0u;layer<u32(frame.heights.z);layer++){
    terrainPatchWeights[layer]=mix((*packed)[layer/4u][layer%4u]/max(plain,0.00001),terrainPatchWeights[layer]/max(sum,0.00001),near);
  }
}`;

/**
 * The fragment shader with `TerrainTextures.weights` (`count` textures, 2 to 4): layer i's weight is channel i % 4 of
 * weight texture i / 4, sampled bilinearly once per fragment over the heightmap's bounds, in place of the height and
 * slope rules (which still set each layer's texture scale). A layer whose weight is 0 skips its three triplanar
 * samples, so 16 layers cost what the ones that show do; the colour is the same as sampling every layer. With `tint`
 * (`TerrainTextures.tint`, bound after the weights), each layer whose rule has params.w 1 is mixed toward the tint
 * texel's RGB by its A before relief and macro tone. A function, so importing anything else from this package keeps no
 * shader text.
 */
export const weightedFragment = (
  count: number,
  surface = false,
  tint = false,
  patches?: { readonly size: number; readonly contrast: number },
): string => {
  const rules = terrainFragment(surface),
    ruleColor = rules.slice(rules.indexOf('fn terrainColor('), rules.indexOf('@fragment fn fragment(')),
    n = Math.min(4, Math.max(1, Math.floor(count))),
    ids = Array.from({ length: n }, (_, i) => i);
  const code = /* wgsl */ `
${ids.map((i) => `@group(0) @binding(${6 + i}) var terrainWeights${i}:texture_2d<f32>;`).join('\n')}
${layerSample}${patches ? patchFunctions(patches.size, patches.contrast) : ''}
fn terrainColor(position:vec3f,normal:vec3f)->vec3f {
  let axes=pow(abs(normal),vec3f(8));let projection=axes/max(axes.x+axes.y+axes.z,0.00001);let dx=dpdx(position);let dy=dpdy(position);
  let d=vec2f(textureDimensions(terrainWeights0));let uv=clamp((position.xz-frame.map.xy)/frame.map.zw,vec2f(0.5)/d,vec2f(1)-vec2f(0.5)/d);
  var packed=array<vec4f,4>(${[0, 1, 2, 3].map((i) => (i < n ? `textureSampleLevel(terrainWeights${i},terrainSampler,uv,0)` : 'vec4f(0)')).join(',')});
  ${patches ? 'terrainPatchBlend(&packed,terrainPatchXZ(position),max(length(dx),length(dy)));' : ''}var color=vec3f(0);var total=0.0;${surface ? 'var relief=0.0;var repeat=0.0;' : ''}
  for(var layer=0u;layer<u32(frame.heights.z);layer++){
    ${patches ? 'let weight=terrainPatchWeights[layer];' : 'let weight=packed[layer/4u][layer%4u];'}if(weight<=0.0){continue;}
    ${surface ? 'let surface=terrainSurface(terrainLayerSample(position,projection,dx,dy,layer),position,projection,dx,dy,layer);color+=surface.rgb*weight;relief+=surface.w*weight;repeat+=layerRules[layer].params.x*weight;total+=weight;' : 'color+=terrainLayerSample(position,projection,dx,dy,layer)*weight;total+=weight;'}
  }
  ${surface ? 'if(total>0.00001){terrainRelief=relief/total;terrainRepeat=repeat/total;return color/total;}' : 'if(total>0.00001){return color/total;}'}
  ${surface ? 'let surface=terrainSurface(terrainLayerSample(position,projection,dx,dy,0u),position,projection,dx,dy,0u);terrainRelief=surface.w;terrainRepeat=layerRules[0].params.x;return surface.rgb;' : 'return terrainLayerSample(position,projection,dx,dy,0u);'}
}
${rules.replace(ruleColor, '')}`;
  if (!tint) return code;
  // The tint is sampled once per fragment over the heightmap's bounds, clamped to its texel centres like the weights.
  return /* wgsl */ `@group(0) @binding(${6 + n}) var terrainTint:texture_2d<f32>;
var<private> terrainTintTexel:vec4f;
fn terrainTinted(c:vec3f,layer:u32)->vec3f {return mix(c,terrainTintTexel.rgb,terrainTintTexel.a*layerRules[layer].params.w);}
${code
  .replace(
    'var packed=',
    'let td=vec2f(textureDimensions(terrainTint));terrainTintTexel=textureSampleLevel(terrainTint,terrainSampler,clamp((position.xz-frame.map.xy)/frame.map.zw,vec2f(0.5)/td,vec2f(1)-vec2f(0.5)/td),0);var packed=',
  )
  .replace(/terrainLayerSample\(position,projection,dx,dy,(layer|0u)\)/g, 'terrainTinted($&,$1)')
  .replace(
    'fn terrainReliefTint(h:f32,layer:u32)->f32 {return h;}',
    'fn terrainReliefTint(h:f32,layer:u32)->f32 {return mix(h,dot(terrainTintTexel.rgb,vec3f(0.2126,0.7152,0.0722)),terrainTintTexel.a*layerRules[layer].params.w);}',
  )}`;
};
