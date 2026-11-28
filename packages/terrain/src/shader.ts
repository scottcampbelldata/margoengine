import { neutralShader } from '../../shared/display.js';
import { ggxD, smithGCorrelated } from '../../shared/light-terms.js';
// Vertex morph between grid levels: Strugar 2009, "Continuous Distance-Dependent Level of Detail" (CDLOD), JGT.
// Each cell is a fan around a centre vertex (`clipmapGrid`) that sits on the midpoint of one of the cell's diagonals, so
// the cell is drawn split along that diagonal: the one whose mean height is nearer the Catmull-Rom height at the cell's
// centre (Catmull and Rom 1974, "A class of local interpolating splines"; the cubic convolution weights of Keys 1981,
// "Cubic convolution interpolation for digital image processing", IEEE TASSP 29(6), a = -0.5). Choosing each quad's
// diagonal by the data is data-dependent triangulation (Dyn, Levin and Rippa 1990, "Data dependent triangulations for
// piecewise linear interpolation", IMA J. Numer. Anal. 10(1)); a fixed diagonal draws a crest that runs along the other
// one as a row of triangular teeth (KB-TERRAIN-CRESTTEETH1, Above the Treeline look round 10). The centre is shared by
// its own cell's triangles only, so no choice opens a crack; it follows the cell's corners through the morph.
// A ring's inner edge meets the finer ring's outer edge, whose corner sits up to one finer cell (`Frame.offset`) away:
// the inner edge's vertices move by that whole offset and every other vertex stays on the ring's lattice. Spreading the
// offset over the ring (it fell linearly to 0 at the outer edge) put the ring's vertices a fraction of a cell off the
// heightmap's lattice, where the bilinear height cuts every sharp feature: a knife-edge ridge sagged by up to a third
// of its height between the lattice points, most near the ring's inner edge (KB-TERRAIN-RINGSAG1, test/teeth.browser.mjs).
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
fn terrainCatmull(t:f32)->vec4f {let t2=t*t;let t3=t2*t;return vec4f(-0.5*t3+t2-0.5*t,1.5*t3-2.5*t2+1.0,-1.5*t3+2.0*t2+0.5*t,0.5*t3-0.5*t2);}
fn terrainCubic(position:vec2f)->f32 {
  let dimensions=vec2i(textureDimensions(heightMap));let uv=clamp((position-frame.map.xy)/frame.map.zw,vec2f(0),vec2f(1));let pixel=uv*vec2f(dimensions-vec2i(1));let lo=vec2i(floor(pixel));
  let wx=terrainCatmull(fract(pixel.x));let wy=terrainCatmull(fract(pixel.y));var h=0.0;
  for(var j=0;j<4;j++){for(var k=0;k<4;k++){h+=wx[k]*wy[j]*textureLoad(heightMap,clamp(lo+vec2i(k-1,j-1),vec2i(0),dimensions-vec2i(1)),0).r;}}
  return h*frame.heights.x+frame.heights.y;
}
fn terrainMorph(g:vec2f)->vec3f {
  let edge=max(abs(g.x),abs(g.y));let morph=clamp((edge-frame.grid.w*0.5+2)/2,0.0,1.0);
  return vec3f(mix(g,round(g*0.5)*2,morph),select(0.0,1.0,edge<=frame.grid.w*0.25));
}
fn terrainMorphXZ(m:vec3f)->vec2f {return frame.grid.xy+m.xy*frame.grid.z+frame.offset.xy*m.z;}
struct Output {@builtin(position) @invariant clip:vec4f,@location(0) position:vec3f,@location(1) normal:vec3f,@location(2) color:vec3f,@location(3) material:vec4f}
@vertex fn vertex(@location(0) grid:vec2f)->Output {
  var m=terrainMorph(grid);var lift=0.0;let centre=fract(grid.x)!=0.0;
  if(centre){
    let a=terrainMorph(grid-vec2f(0.5));let b=terrainMorph(grid+vec2f(0.5,-0.5));let c=terrainMorph(grid+vec2f(-0.5,0.5));let d=terrainMorph(grid+vec2f(0.5));
    let ad=(height(terrainMorphXZ(a))+height(terrainMorphXZ(d)))*0.5;let bc=(height(terrainMorphXZ(b))+height(terrainMorphXZ(c)))*0.5;
    let r=terrainCubic(terrainMorphXZ((a+b+c+d)*0.25));let along=abs(r-ad)<abs(r-bc);
    m=select((b+c)*0.5,(a+d)*0.5,along);lift=select(bc,ad,along);
  }
  let aligned=m.xy;let inner=m.z;
  let xz=frame.grid.xy+aligned*frame.grid.z+frame.offset.xy*inner;let position=vec3f(xz.x,select(height(xz),lift,centre),xz.y);
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
 *
 * The lit draw also works relative to the eye (Cozzi and Ring 2011, "3D Engine Design for Virtual Globes", chapter 5,
 * "Rendering relative to eye"; Ohlarik 2008, "Precisions, Precisions", AGI): local positions are whatever the origin's
 * shift leaves them, so a rebase in place re-rounds every float32 number derived from them (the clip position, each
 * texture coordinate and its screen derivatives), and the texture unit's sub-texel and level rounding, finer with 16x
 * anisotropy, flipped 0.1 percent of pixels by one level (KB-TERRAIN-REBASEROUND1). The vertex writes `Output.eye`,
 * the vertex less the eye, from `Frame.view` (the ring's lattice less the eye, and the eye's local Y, computed in
 * float64 on the CPU) plus the ring-relative grid offset, and the clip position is `camera * (eye, 0)` plus
 * `Frame.column` (the camera matrix times the local eye, float64): none of these depend on where the origin sits, so a
 * rebase in place draws the same numbers. `eyeShader` reads the textures there.
 */
export const terrainClip = 'o.clip=frame.camera*vec4f(position,1);';
/** The clip line of the floating-origin vertex (`originShader`): what `surface-height` replaces with its own. */
export const originClip =
  'let terrainE=frame.view.xy+aligned*frame.grid.z+frame.offset.xy*inner;o.eye=vec3f(terrainE.x,position.y-frame.view.z,terrainE.y);o.clip=frame.camera*vec4f(o.eye,0)+frame.column;';
export const originShader = (code: string): string =>
  code.includes('anchor:vec4f,view:vec4f')
    ? code
    : code
        .replace('ambient:vec4f}', 'ambient:vec4f,anchor:vec4f,view:vec4f,column:vec4f}')
        .replace(/struct Layer \{([^}]*)\}/, 'struct Layer {$1,wrap:vec4f,tone:vec4f,eyeWrap:vec4f,eyeTone:vec4f}')
        .replace('@location(3) material:vec4f}', '@location(3) material:vec4f,@location(12) eye:vec3f}')
        .replace(terrainClip, originClip)
        .replace(
          'fn terrainRockP(p:vec3f)->vec3f {return p;}',
          'fn terrainRockP(p:vec3f)->vec3f {return p+vec3f(frame.anchor.x,frame.anchor.z,frame.anchor.y);}',
        )
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
const fragmentHead = '@fragment fn fragment(i:Output)->@location(0) vec4f {';
/** What an entry adds at its start to read the textures relative to the eye (`eyeShader`). */
export const eyeEntry = 'terrainEyeOn=true;terrainEyeAt=i.eye;terrainEyeLocal=i.position;';
/**
 * The floating-origin lit shader's last step, after every entry and effect has edited the text (so the text they look
 * for is the one they always saw): each layer sample's point and screen derivatives come from `Output.eye`, the vertex
 * less the eye, plus the layer's `eyeWrap` (the eye less the terrain's anchor less whole macro repeats, float64 on the
 * CPU) and `eyeTone`, in place of the local position plus `wrap` and `tone`. A sample point that is not the fragment's
 * own (a displaced one) keeps its offset from it. The same texel either way (the two differ by whole repeats); only
 * the rounding no longer moves with the origin. Shaders without `eyeEntry` (the virtual texture's bake) keep the local
 * reading. Applied once.
 */
export const eyeShader = (code: string): string =>
  code.includes('var<private> terrainEyeOn:bool;') || !code.includes('eye:vec3f}')
    ? code
    : /* wgsl */ `var<private> terrainEyeOn:bool;var<private> terrainEyeAt:vec3f;var<private> terrainEyeLocal:vec3f;
fn terrainTexAt(p:vec3f)->vec3f {return select(p,terrainEyeAt+(p-terrainEyeLocal),terrainEyeOn);}
fn terrainTexPoint(p:vec3f,l:u32)->vec3f {return terrainTexAt(p)+select(layerRules[l].wrap.xyz,layerRules[l].eyeWrap.xyz,terrainEyeOn);}
fn terrainToneOf(l:u32)->vec3f {return select(layerRules[l].tone.xyz,layerRules[l].eyeTone.xyz,terrainEyeOn);}
` +
      code
        .replace(fragmentHead, fragmentHead + eyeEntry)
        .replace(/\(position\+layerRules\[layer\]\.wrap\.xyz\)/g, 'terrainTexPoint(position,layer)')
        .replace(/layerRules\[layer\]\.tone\.xyz/g, 'terrainToneOf(layer)')
        .replace(/(dpd[xy](Fine)?)\(position\)/g, '$1(terrainTexAt(position))');
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
/**
 * The fragment's shading normal `n` and layer colour `base` (the SSR capture entry starts the same way). With `rock`
 * (`TerrainOptions.rock`) the normal first takes the rock structure and the colour its tone. The layer colour (its
 * triplanar projections and slope rules) still reads the surface's own normal: the structure only shades. Picking the
 * projections by the structure's normal laid a bench's near-level normal or a facet's tilt on a steep face, so the
 * texture was projected along the face and drawn as streaks a few metres long down every rock wall
 * (KB-TERRAIN-ROCKSMEAR1, Above the Treeline look round 10).
 */
export const terrainShading = (surface: boolean, rock = false): string =>
  rock
    ? surface
      ? 'let terrainN=terrainRock(i.position,normalize(i.normal));let base=terrainColor(i.position,normalize(i.normal))*terrainRockShade;let n=terrainBump(i.position,terrainN);'
      : 'let n=terrainRock(i.position,normalize(i.normal));let base=terrainColor(i.position,normalize(i.normal))*terrainRockShade;'
    : surface
      ? 'let terrainN=normalize(i.normal);let base=terrainColor(i.position,terrainN);let n=terrainBump(i.position,terrainN);'
      : 'let n=normalize(i.normal);let base=terrainColor(i.position,n);';

/** `TerrainOptions.rock` resolved: every field set; `debris` -1 for none, `map` the structure texture's binding or -1. */
export interface RockShaderOptions {
  readonly slope: readonly [number, number];
  readonly strata: number;
  readonly ledges: number;
  readonly dip: readonly [number, number];
  readonly facets: number;
  readonly relief: number;
  readonly gullies: number;
  readonly tone: number;
  readonly debris: number;
  readonly map: number;
}

const f32 = (v: number): string => {
  const s = Math.fround(v).toPrecision(9);
  return s.includes('.') || s.includes('e') ? s : s + '.0';
};

/**
 * `TerrainOptions.rock`: the structure of bare rock at 10 to 100 m, where a heightmap of 4 to 30 m cells draws a steep
 * face as one smooth plane. All of it fades in with slope between `slope[0]` and `slope[1]` degrees and fades out where
 * a pixel covers a good share of its feature, so far ground keeps its mean and nothing aliases.
 * - Ledges: beds `strata` metres thick (planes tilted by `dip`, their heights warped by value noise so they wander and
 *   break off), each a riser and a bench. The shading normal takes the bench's or the riser's slope analytically: the
 *   height gradient times A = 0.25 on the top 30 percent of a bed and B = (1 - 0.3 A) / 0.7 below it, so the mean slope
 *   is the heightmap's (layered terrain of hard and soft beds: Benes and Forsbach 2001, "Layered data representation
 *   for visual simulation of terrain erosion", SCCG; Peytavie et al. 2009, "Arches: a framework for modeling complex
 *   terrains", Computer Graphics Forum 28(2)). Benches collect loose stone (`debris`) and each bed its own tone.
 * - Facets: joint blocks `facets` metres across and 2.4 times as tall (the steep joint set of granite and gneiss makes
 *   ribs and columns), and buttresses 4.1 times that at 0.7 the strength, the nearest of the points scattered one to a
 *   cell over the 27 cells around the position
 *   (Worley 1996, "A cellular texture basis function", SIGGRAPH), each tilting the normal by up to `relief` in its own
 *   direction, with dark joints where the nearest two points are about equally near (F2 - F1). The tilt and tone blend
 *   into the second-nearest cell's across the edge (half each where F2 = F1, all the cell's own by F2 - F1 = 0.14 of a
 *   cell plus two pixels), so an edge is a rounded joint, never a hard switch; relief, tone and joint shade fall to 0.3
 *   as the pixel footprint grows from 0.006 to 0.04 of a block (about 170 to 25 pixels across it) and to none by 0.4,
 *   the prefiltering of normal detail with its footprint (Toksvig 2005; Bruneton and Neyret 2012), so blocks 200 to
 *   600 m away do not read as low-poly shards (Above the Treeline look round 5).
 * - Gullies: with `TerrainTextures.structure`, its R (drainage, 0 to 1) is carved `gullies` metres deep into the
 *   shading normal by its central differences, darkened as wet, shaded rock, and on gentler ground below the faces its
 *   floors and its G (debris fans) carry `debris`. `@margoengine/biomes/hydrology` `drainageStructure` makes one from
 *   multiple-flow routing (Freeman 1991) and rockfall travel (Statham 1976).
 * The pcg3d hash is Jarzynski and Olano 2020, "Hash Functions for GPU Rendering", JCGT 9(3). With `floatingOrigin`
 * every feature reads terrain-relative positions. Without the option the shader is unchanged.
 */
export const rockFunctions = (o: RockShaderOptions): string => {
  const a = 0.25,
    tau = 0.3,
    b = (1 - tau * a) / (1 - tau),
    map = o.map >= 0;
  return /* wgsl */ `
${map ? `@group(0) @binding(${o.map}) var terrainStructure:texture_2d<f32>;` : ''}
var<private> terrainRockShade:f32=1.0;var<private> terrainRockLoose:f32=0.0;
fn terrainRockP(p:vec3f)->vec3f {return p;}
fn terrainRockHash(c:vec3i)->vec3f {
  var v=bitcast<vec3u>(c)*1664525u+1013904223u;
  v.x+=v.y*v.z;v.y+=v.z*v.x;v.z+=v.x*v.y;v^=v>>vec3u(16u);v.x+=v.y*v.z;v.y+=v.z*v.x;v.z+=v.x*v.y;
  return vec3f(v>>vec3u(8u))/16777216.0;
}
fn terrainRockNoise(p:vec2f,seed:i32)->f32 {
  let i=floor(p);let f=p-i;let u=f*f*f*(f*(f*6.0-15.0)+10.0);let c=vec2i(i);
  return mix(mix(terrainRockHash(vec3i(c,seed)).x,terrainRockHash(vec3i(c+vec2i(1,0),seed)).x,u.x),mix(terrainRockHash(vec3i(c+vec2i(0,1),seed)).x,terrainRockHash(vec3i(c+vec2i(1,1),seed)).x,u.x),u.y);
}
fn terrainRockFacets(p:vec3f,normal:vec3f,size:f32,fp:f32,steep:f32,weight:f32,seed:vec3i)->vec3f {
  let q=p*vec3f(1.0,0.42,1.0)/size;let base=vec3i(floor(q));var d1=1e9;var d2=1e9;var id=vec3i(0);var id2=vec3i(0);
  for(var j=0;j<27;j++){
    let cell=base+vec3i(j%3-1,(j/3)%3-1,j/9-1);let d=distance(q,vec3f(cell)+terrainRockHash(cell+seed));
    if(d<d1){d2=d1;id2=id;d1=d;id=cell+seed;}else if(d<d2){d2=d;id2=cell+seed;}
  }
  let r=fp/size;let near=steep*weight*mix(1.0,0.3,smoothstep(0.006,0.04,r))*(1.0-smoothstep(0.12,0.4,r));
  let own=0.5+0.5*smoothstep(0.0,0.14+2.0*r,d2-d1);
  let tilt=mix(terrainRockHash(id2+vec3i(17,-31,7)),terrainRockHash(id+vec3i(17,-31,7)),own)*2.0-1.0;
  let joint=mix(1.0,0.82+0.18*smoothstep(0.0,max(0.05,2.0*r),d2-d1),1.0-smoothstep(0.006,0.04,r));
  let tone=mix(terrainRockHash(id2).y,terrainRockHash(id).y,own);
  terrainRockShade*=mix(1.0,joint*(1.0+${f32(o.tone)}*(tone-0.5)),near);
  return normalize(normal+${f32(o.relief)}*near*(tilt-normal*dot(tilt,normal)));
}
fn terrainRock(position:vec3f,normal:vec3f)->vec3f {
  terrainRockShade=1.0;terrainRockLoose=0.0;
  let p=terrainRockP(position);let fp=max(max(length(dpdx(position)),length(dpdy(position))),0.0001);
  let steep=smoothstep(${f32(o.slope[0])},${f32(o.slope[1])},degrees(acos(clamp(normal.y,0.0,1.0))));
  var m=normal/max(normal.y,0.05);
${
  map
    ? `  let sd=vec2f(textureDimensions(terrainStructure));let e=frame.map.zw/sd;
  let uv=clamp((position.xz-frame.map.xy)/frame.map.zw,vec2f(0.5)/sd,vec2f(1)-vec2f(0.5)/sd);
  let c=textureSampleLevel(terrainStructure,terrainSampler,uv,0);let ex=vec2f(1.0/sd.x,0);let ez=vec2f(0,1.0/sd.y);
  let gx=(textureSampleLevel(terrainStructure,terrainSampler,uv+ex,0).r-textureSampleLevel(terrainStructure,terrainSampler,uv-ex,0).r)/(2.0*e.x);
  let gz=(textureSampleLevel(terrainStructure,terrainSampler,uv+ez,0).r-textureSampleLevel(terrainStructure,terrainSampler,uv-ez,0).r)/(2.0*e.y);
  let depth=${f32(o.gullies)}*mix(0.3,1.0,steep)*(1.0-smoothstep(0.25,0.6,fp/max(e.x,e.y)));
  m.x+=depth*gx;m.z+=depth*gz;
  terrainRockShade*=1.0-0.7*${f32(o.tone)}*c.r*mix(0.4,1.0,steep);
  terrainRockLoose=max(0.85*c.g,0.5*smoothstep(0.7,1.0,c.r)*(1.0-steep));
`
    : ''
}${
  o.strata > 0
    ? `  let s=(p.y-dot(vec2f(${f32(o.dip[0])},${f32(o.dip[1])}),p.xz))/${f32(o.strata)}+1.6*(terrainRockNoise(p.xz/${f32(o.strata * 9)},7)-0.5)+0.35*(terrainRockNoise(p.xz/${f32(o.strata * 2.3)},8)-0.5);
  let ws=fwidth(s);let fade=1.0-smoothstep(0.1,0.3,ws);let bed=floor(s);let f=s-bed;let w=clamp(ws,0.03,0.12);
  let keep=smoothstep(0.32,0.62,terrainRockNoise(p.xz/${f32(o.strata * 4.5)}+vec2f(bed*17.13,bed*-9.71),9));
  let bench=smoothstep(${f32(1 - tau)}-w,${f32(1 - tau)}+w,f)*(1.0-smoothstep(1.0-w,1.0,f));
  let k=${f32(o.ledges)}*steep*fade*keep;let factor=mix(1.0,mix(${f32(b)},${f32(a)},bench),k);
  m.x*=factor;m.z*=factor;
  terrainRockLoose=max(terrainRockLoose,bench*k*0.7);
  terrainRockShade*=1.0+${f32(o.tone)}*0.6*(terrainRockHash(vec3i(i32(bed),3,5)).x-0.5)*steep*(1.0-smoothstep(0.3,1.0,ws));
`
    : ''
}  var n=normalize(m);
${
  o.facets > 0
    ? `  n=terrainRockFacets(p,n,${f32(o.facets * 4.1)},fp,steep,0.7,vec3i(41,7,-13));
  n=terrainRockFacets(p,n,${f32(o.facets)},fp,steep,1.0,vec3i(0));
`
    : ''
}  return n;
}${
    o.debris >= 0
      ? `
fn terrainRockDebris(packed:ptr<function,array<vec4f,4>>) {
  let k=clamp(terrainRockLoose,0.0,1.0);var sum=0.0;
  for(var layer=0u;layer<u32(frame.heights.z);layer++){sum+=(*packed)[layer/4u][layer%4u];(*packed)[layer/4u][layer%4u]*=1.0-k;}
  (*packed)[${o.debris >> 2}u][${o.debris & 3}u]+=k*sum;
}`
      : ''
  }`;
};
// Triplanar weights abs(n)^8 (Geiss 2007, GPU Gems 3 ch. 1; exponent 8 is Margo's); GGX + Schlick (F0 0.04) + Lambert
// sun per glTF 2.0 Appendix B (Walter et al. 2007; Schlick 1994); Khronos PBR Neutral, then sRGB (IEC 61966-2-1).
/** The rule-weighted fragment shader; `surface` adds `TerrainLayer.bump` and `macro`. A function, so a bundle that
 * never draws a terrain keeps no shader text. */
export const terrainFragment = (
  surface = false,
  rock?: RockShaderOptions,
): string => /* wgsl */ `${neutralShader}${surface ? surfaceFunctions : ''}${rock ? rockFunctions(rock) : ''}
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
  ${terrainShading(surface, !!rock)}let v=normalize(frame.eye.xyz-i.position);let l=frame.light.xyz;let h=(v+l)/max(length(v+l),0.0001);
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
 * `warp` displaces the noise's coordinates by a value-noise field of 2.6 `size` cells, up to 1.1 `warp` `size` each way
 * (domain distortion: Perlin 1985, "An image synthesizer", SIGGRAPH; Ebert, Musgrave et al. 2003, "Texturing and
 * Modeling: A Procedural Approach", ch. 16), and adds an octave of 3.3 `size` cells, so patches come in clusters and
 * strands of several sizes instead of one blob size. `terraces` adds to each layer a sine of the height, `terraces`
 * metres a cycle with its phase wandering by noise and shifted per layer: patches stretch along the contours, as turf
 * banks and gravel strips do on a grazed or frost-heaved slope. Only on slopes of about 10 to 35 degrees, in stretches
 * that come and go (a noise of 14 cycles), and it fades where a cycle covers under about 3 pixels.
 */
/** `TerrainOptions.patches` resolved: every field set (`warp` 0 and `terraces` 0 draw the plain patches). */
export interface PatchShaderOptions {
  readonly size: number;
  readonly contrast: number;
  readonly warp: number;
  readonly terraces: number;
}
const patchFunctions = ({ size, contrast, warp, terraces }: PatchShaderOptions): string => /* wgsl */ `
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
  for(var k=0u;k<3u;k++){let fade=1.0-smoothstep(0.25,0.5,footprint/cell);sum+=amp*mix(0.5,terrainPatchNoise(p,layer*3u+k),fade);norm+=amp;p=p*2.03+vec2f(19.1,7.3);cell/=2.03;amp*=0.5;}${
  warp > 0
    ? `
  let broad=1.0-smoothstep(0.25,0.5,footprint/${(size * 3.3).toPrecision(9)});sum+=0.75*mix(0.5,terrainPatchNoise(xz*${(1 / (size * 3.3)).toPrecision(9)}+vec2f(3.7,8.1),layer*3u+48u),broad);norm+=0.75;`
    : ''
}
  return sum/norm;
}
fn terrainPatchBlend(packed:ptr<function,array<vec4f,4>>,position:vec2f,height:f32,up:f32,footprint:f32) {
  var xz=position;${
  warp > 0
    ? `
  let wp=position*${(1 / (size * 2.6)).toPrecision(9)};
  xz+=${(warp * size * 2.2).toPrecision(9)}*(vec2f(terrainPatchNoise(wp,61u),terrainPatchNoise(wp+vec2f(5.2,1.3),62u))-0.5);`
    : ''
}${
  terraces > 0
    ? `
  let phase=height*${(1 / terraces).toPrecision(9)}+1.3*terrainPatchNoise(position*${(1 / (terraces * 7)).toPrecision(9)},63u);
  let tilt=degrees(acos(clamp(up,0.0,1.0)));
  let bands=${(0.22 * contrast).toPrecision(9)}*(1.0-smoothstep(0.12,0.35,fwidth(phase)))*smoothstep(8.0,14.0,tilt)*(1.0-smoothstep(30.0,38.0,tilt))*smoothstep(0.42,0.68,terrainPatchNoise(position*${(1 / (terraces * 14)).toPrecision(9)},64u));`
    : ''
}
  var top=-1.0;var plain=0.0;
  for(var layer=0u;layer<u32(frame.heights.z);layer++){
    let w=(*packed)[layer/4u][layer%4u];terrainPatchWeights[layer]=-1.0;if(w<=0.0){continue;}
    let t=w+${contrast.toPrecision(9)}*terrainPatch(xz,layer,footprint)${terraces > 0 ? '+bands*sin(6.2831853*phase+f32(layer)*2.1)' : ''};terrainPatchWeights[layer]=t;top=max(top,t);plain+=w;
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
  patches?: PatchShaderOptions,
  rock?: RockShaderOptions,
): string => {
  const rules = terrainFragment(surface, rock),
    ruleColor = rules.slice(rules.indexOf('fn terrainColor('), rules.indexOf('@fragment fn fragment(')),
    n = Math.min(4, Math.max(1, Math.floor(count))),
    ids = Array.from({ length: n }, (_, i) => i);
  const code = /* wgsl */ `
${ids.map((i) => `@group(0) @binding(${6 + i}) var terrainWeights${i}:texture_2d<f32>;`).join('\n')}
${layerSample}${patches ? patchFunctions(patches) : ''}
fn terrainColor(position:vec3f,normal:vec3f)->vec3f {
  let axes=pow(abs(normal),vec3f(8));let projection=axes/max(axes.x+axes.y+axes.z,0.00001);let dx=dpdx(position);let dy=dpdy(position);
  let d=vec2f(textureDimensions(terrainWeights0));let uv=clamp((position.xz-frame.map.xy)/frame.map.zw,vec2f(0.5)/d,vec2f(1)-vec2f(0.5)/d);
  var packed=array<vec4f,4>(${[0, 1, 2, 3].map((i) => (i < n ? `textureSampleLevel(terrainWeights${i},terrainSampler,uv,0)` : 'vec4f(0)')).join(',')});
  ${rock && rock.debris >= 0 ? 'terrainRockDebris(&packed);' : ''}${patches ? 'terrainPatchBlend(&packed,terrainPatchXZ(position),position.y,normal.y,max(length(dx),length(dy)));' : ''}var color=vec3f(0);var total=0.0;${surface ? 'var relief=0.0;var repeat=0.0;' : ''}
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
