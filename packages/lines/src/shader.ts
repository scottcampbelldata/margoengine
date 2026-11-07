import { MargoError } from '@margoengine/math/errors';
import { BLOCK, FAN } from './geometry.js';
import { fogWgsl } from '../../shared/fog.js';

/** The fragment's cut by clipping planes, shared with the pick shader. */
export const clipCut = /* wgsl */ `let clipCount=style.flags.w&0xffffu;var clipBehind=0u;
  for(var p=0u;p<clipCount;p++){if(dot(style.planes[p].xyz,i.world)+style.planes[p].w<0.0){clipBehind++;}}
  if(clipCount>0u&&select(clipBehind>0u,clipBehind==clipCount,(style.flags.w&65536u)!=0u)){discard;}`;

/** Fat line shader. The expansion mirrors `expandLine` in geometry.ts; keep the two in step. */
export const lineShader: string = /* wgsl */ `
const FAN:u32=${FAN}u;
const BLOCK:u32=${BLOCK}u;
const PI:f32=3.14159265;
struct Frame{viewProj:mat4x4f,viewport:vec4f,extra:vec4f}
struct Style{model:mat4x4f,color:vec4f,a:vec4f,b:vec4f,flags:vec4u,planes:array<vec4f,6>}
@group(0) @binding(0) var<uniform> frame:Frame;
@group(1) @binding(0) var<uniform> style:Style;
@group(1) @binding(1) var<storage,read> points:array<vec4f>;
@group(1) @binding(2) var<storage,read> colors:array<vec4f>;
struct Out{
  @builtin(position) clip:vec4f,
  @location(0) color:vec4f,
  @location(1) @interpolate(linear) edge:vec4f,
  @location(2) dist:f32,
  @location(3) world:vec3f,
}
struct Joint{sOut:f32,miter:bool,innerOk:bool,inner:vec2f,outer0:vec2f,outer1:vec2f,n1:vec2f}
struct Corner{off:vec2f,d:f32,atB:bool,valid:bool}

fn project(i:u32)->vec4f{return frame.viewProj*(style.model*vec4f(points[i].xyz,1.0));}
fn nearSide(c:vec4f)->f32{return c.w-c.z;}
fn screen(c:vec4f)->vec2f{return c.xy/c.w*0.5*frame.viewport.xy;}
fn perp(d:vec2f)->vec2f{return vec2f(-d.y,d.x);}
fn halfWidth(c:vec4f)->f32{
  let width=style.a.x;
  if((style.flags.z&16u)!=0u){return 0.5*width*frame.viewport.w/c.w;}
  return 0.5*width*frame.viewport.z;
}
fn joint(d0:vec2f,d1:vec2f,hwG:f32,len0:f32,len1:f32)->Joint{
  var j:Joint;
  let n0=perp(d0);let n1=perp(d1);
  let cr=d0.x*d1.y-d0.y*d1.x;
  j.sOut=select(1.0,-1.0,cr>0.0);
  let sum=n0+n1;let sl=length(sum);
  var m=n0;var L=1e6;
  if(sl>1e-4){m=sum/sl;L=1.0/max(dot(m,n0),1e-6);}
  j.miter=(style.flags.z&3u)==0u&&L<=style.a.y;
  j.innerOk=L<1e5&&hwG*sqrt(max(L*L-1.0,0.0))<=min(len0,len1);
  j.inner=select(vec2f(0.0),m*(-j.sOut*hwG*L),j.innerOk);
  j.outer0=select(n0*(j.sOut*hwG),m*(j.sOut*hwG*L),j.miter);
  j.outer1=select(n1*(j.sOut*hwG),m*(j.sOut*hwG*L),j.miter);
  j.n1=n1;
  return j;
}
fn arc(start:vec2f,sweep:f32,step:u32,hwG:f32)->vec2f{
  let a=atan2(start.y,start.x)+sweep*f32(step)/f32(FAN);
  return vec2f(cos(a),sin(a))*hwG;
}
// Vertex k of a fan block: triangle t, corner c. Corner 0 is the center.
fn fanCorner(k:u32,start:vec2f,sweep:f32,hwG:f32,atB:bool)->Corner{
  let t=k/3u;let c=k%3u;
  var r:Corner;r.atB=atB;r.valid=t>=2u;
  if(!r.valid||c==0u){r.off=vec2f(0.0);r.d=0.0;return r;}
  r.off=arc(start,sweep,t-2u+c-1u,hwG);r.d=hwG;return r;
}

@vertex fn vertex(@builtin(vertex_index) vi:u32,@builtin(instance_index) ii:u32)->Out{
  var o:Out;
  o.clip=vec4f(2.0,2.0,0.0,1.0);o.color=vec4f(0.0);o.edge=vec4f(0.0,1.0,0.0,0.0);o.dist=0.0;
  let mode=style.flags.x;let n=style.flags.y;let bits=style.flags.z;
  let join=bits&3u;let cap=(bits>>2u)&3u;
  var ia:u32;var ib:u32;var ip:u32=0u;var inx:u32=0u;var hasPrev=false;var hasNext=false;
  if(mode==0u){ia=2u*ii;ib=ia+1u;}
  else if(mode==2u&&n>=3u){ia=ii;ib=(ii+1u)%n;ip=(ii+n-1u)%n;inx=(ii+2u)%n;hasPrev=true;hasNext=true;}
  else{ia=ii;ib=ii+1u;hasPrev=ii>0u;ip=select(0u,ii-1u,hasPrev);hasNext=ii+2u<n;inx=select(0u,ii+2u,hasNext);}
  let oa=project(ia);let ob=project(ib);
  let fa=nearSide(oa);let fb=nearSide(ob);
  if(fa<0.0&&fb<0.0){return o;}
  var ta=0.0;var tb=1.0;
  if(fa<0.0){ta=fa/(fa-fb);hasPrev=false;}
  if(fb<0.0){tb=fa/(fa-fb);hasNext=false;}
  let ca=mix(oa,ob,ta);let cb=mix(oa,ob,tb);
  let sa=screen(ca);let sb=screen(cb);
  let seg=sb-sa;let len=length(seg);
  let dir=select(vec2f(1.0,0.0),seg/len,len>1e-4);let nrm=perp(dir);
  var dPrev=dir;var lPrev=0.0;var dNext=dir;var lNext=0.0;
  if(hasPrev){var cp=project(ip);let fp=nearSide(cp);if(fp<0.0){cp=mix(cp,ca,fp/(fp-nearSide(ca)));}
    let v=sa-screen(cp);lPrev=length(v);hasPrev=lPrev>1e-4;dPrev=select(dir,v/lPrev,hasPrev);}
  if(hasNext){var cn=project(inx);let fq=nearSide(cn);if(fq<0.0){cn=mix(cn,cb,fq/(fq-nearSide(cb)));}
    let v=screen(cn)-sb;lNext=length(v);hasNext=lNext>1e-4;dNext=select(dir,v/lNext,hasNext);}
  let aa=style.b.z;
  let rawA=halfWidth(ca);let rawB=halfWidth(cb);
  let hwA=max(rawA,0.5);let hwB=max(rawB,0.5);
  let hwGA=hwA+aa;let hwGB=hwB+aa;
  var jA:Joint;var jB:Joint;
  if(hasPrev){jA=joint(dPrev,dir,hwGA,lPrev,len);}
  if(hasNext){jB=joint(dir,dNext,hwGB,len,lNext);}
  var cr:Corner;cr.valid=true;
  if(vi<6u){
    let ends=array<u32,6>(0u,0u,1u,0u,1u,1u);let sides=array<f32,6>(-1.0,1.0,1.0,-1.0,1.0,-1.0);
    cr.atB=ends[vi]==1u;let side=sides[vi];
    let hasJ=select(hasPrev,hasNext,cr.atB);
    if(hasJ){
      var j=jA;if(cr.atB){j=jB;}
      let hwG=select(hwGA,hwGB,cr.atB);
      if(side==j.sOut){cr.off=select(j.outer1,j.outer0,cr.atB);}
      else{cr.off=select(nrm*(side*hwG),j.inner,j.innerOk);}
    }else{
      let hw=select(hwA,hwB,cr.atB);let hwG=hw+aa;
      var ext=0.0;if(cap==2u){ext=hw+aa;}else if(cap==0u){ext=aa;}
      cr.off=nrm*(side*hwG)+dir*select(-ext,ext,cr.atB);
    }
    cr.d=dot(cr.off,nrm);
  }else if(vi<6u+BLOCK){
    let k=vi-6u;cr.atB=true;
    if(hasNext){
      let t=k/3u;let c=k%3u;
      if(t<2u){
        let ln=select(jB.n1,nrm,t==0u);
        let inner=select(ln*(-jB.sOut*hwGB),jB.inner,jB.innerOk);
        let outer=select(jB.outer1,jB.outer0,t==0u);
        if(c==0u){cr.off=inner;}else if(c==1u){cr.off=vec2f(0.0);}else{cr.off=outer;}
        cr.d=dot(cr.off,ln);
      }else if(jB.miter){cr.valid=false;}
      else if(join!=1u){
        cr.valid=t==2u;
        if(c==0u){cr.off=vec2f(0.0);cr.d=0.0;}else{cr.off=select(jB.outer1,jB.outer0,c==1u);cr.d=hwGB;}
      }else{
        let o0=jB.outer0;let o1=jB.outer1;
        cr=fanCorner(k,o0,atan2(o0.x*o1.y-o0.y*o1.x,dot(o0,o1)),hwGB,true);
      }
    }else if(cap==1u){cr=fanCorner(k,nrm,-PI,hwGB,true);}
    else{cr.valid=false;}
  }else{
    let k=vi-6u-BLOCK;cr.atB=false;
    if(!hasPrev&&cap==1u){cr=fanCorner(k,nrm,PI,hwGA,false);}else{cr.valid=false;}
  }
  if(!cr.valid){cr.off=vec2f(0.0);cr.d=0.0;}
  let base=select(ca,cb,cr.atB);
  let p=select(sa,sb,cr.atB)+cr.off;
  o.clip=vec4f(base.xy+cr.off/(0.5*frame.viewport.xy)*base.w,base.z,base.w);
  let capped=cap!=1u;
  let capA=select(0.0,hwA,cap==2u);let capB=select(0.0,hwB,cap==2u);
  let uStart=select(-1e4,dot(p-sa,-dir)-capA,!hasPrev&&capped);
  let uEnd=select(-1e4,dot(p-sb,dir)-capB,!hasNext&&capped);
  let hw=select(hwA,hwB,cr.atB);
  o.edge=vec4f(cr.d,hw,uStart,uEnd);
  var colA=vec4f(1.0);var colB=vec4f(1.0);
  if((bits&64u)!=0u){colA=mix(colors[ia],colors[ib],ta);colB=mix(colors[ia],colors[ib],tb);}
  let raw=select(rawA,rawB,cr.atB);
  let fade=select(1.0,min(1.0,2.0*raw),aa>0.0);
  o.color=select(colA,colB,cr.atB)*vec4f(style.color.rgb,style.color.a*fade);
  var dA=points[ia].w;var dB=points[ib].w;
  if(mode==2u&&n>=3u&&ib==0u){dB=style.b.y;}
  o.dist=mix(dA,dB,select(ta,tb,cr.atB));
  // The centre line's world point: each end of the quad takes its segment end, so fragments interpolate along it.
  let wa=style.model*vec4f(points[ia].xyz,1.0);let wb=style.model*vec4f(points[ib].xyz,1.0);
  o.world=mix(wa.xyz/wa.w,wb.xyz/wb.w,select(ta,tb,cr.atB));
  return o;
}

fn encode(c:vec3f)->vec3f{return select(c*12.92,1.055*pow(c,vec3f(1.0/2.4))-0.055,c>=vec3f(0.0031308));}

@fragment fn fragment(i:Out)->@location(0) vec4f{
  let aa=style.b.z>0.0;
  var cover=1.0;
  if(aa){
    cover=clamp(i.edge.y+0.5-abs(i.edge.x),0.0,1.0)*clamp(0.5-i.edge.z,0.0,1.0)*clamp(0.5-i.edge.w,0.0,1.0);
  }
  let fw=max(fwidth(i.dist),1e-6);
  if((style.flags.z&32u)!=0u){
    let dash=style.a.z;let period=dash+style.a.w;
    let x=i.dist+style.b.x-dash*0.5+period*0.5;
    let t=x-period*floor(x/period)-period*0.5;
    let inside=dash*0.5-abs(t);
    cover*=select(select(0.0,1.0,inside>=0.0),clamp(inside/fw+0.5,0.0,1.0),aa);
  }
  // Clipping planes (flags.w & 0xffff of them): cut away where the centre line's world point is on a plane's negative
  // side, of any plane, or with bit 16 set (clipIntersection) of every plane.
  ${clipCut}
  let alpha=i.color.a*cover;
  var rgb=max(i.color.rgb,vec3f(0.0));
  if(frame.extra.x>0.5){rgb=encode(min(rgb,vec3f(1.0)));}
  return vec4f(rgb,alpha);
}
`;

/**
 * `code` (the line shader, fogged or not) for one draw step of a depth-writing line: 1 the part at least half covered,
 * which writes depth, 2 the rest of the edge ramp, which blends over it; 0 all of the line. Features are edits of the
 * text, so a line that uses none compiles exactly `lineShader`.
 */
export const phasedShader = (code: string, phase: number): string =>
  phase
    ? code.replace('let alpha=i.color.a*cover;', `if(cover${phase === 1 ? '<' : '>='}0.5){discard;}let alpha=i.color.a*cover;`)
    : code;

/**
 * `code` for solid triangles: a vertex entry of their own over `points`, into the same fragment, so fog and clipping
 * planes apply and only the dashes do not.
 */
export const filledShader = (code: string): string =>
  code.replace('if((style.flags.z&32u)!=0u){\n    let dash=', 'if(false){\n    let dash=') +
  /* wgsl */ `
@vertex fn fillVertex(@builtin(vertex_index) vi:u32)->Out{
  var o:Out;
  let p=points[vi];let w=style.model*vec4f(p.xyz,1.0);
  o.clip=frame.viewProj*w;
  o.color=vec4f(style.color.rgb,style.color.a*p.w);
  o.edge=vec4f(0.0,1.0,-1e4,-1e4);o.dist=0.0;o.world=w.xyz/w.w;
  return o;
}
`;

/** `code` for lines with a width scale per point: the fourth value of each point scales the half width. */
export const pointWidthShader = (code: string): string =>
  code.replace(
    'let rawA=halfWidth(ca);let rawB=halfWidth(cb);',
    'let rawA=halfWidth(ca)*mix(points[ia].w,points[ib].w,ta);let rawB=halfWidth(cb)*mix(points[ia].w,points[ib].w,tb);',
  );

/** `code` for a line with a depth bias: the fourth value of `style.b` moves it that fraction of its distance nearer. */
export const biasedShader = (code: string): string =>
  code
    .replace(
      'o.clip=vec4f(base.xy+cr.off/(0.5*frame.viewport.xy)*base.w,base.z,base.w);',
      'o.clip=vec4f(base.xy+cr.off/(0.5*frame.viewport.xy)*base.w,min(base.z*(1.0+style.b.w),base.w),base.w);',
    )
    .replace('o.clip=placed;', 'o.clip=vec4f(placed.xy,min(placed.z*(1.0+style.b.w),placed.w),placed.w);');

/**
 * `code` with a vertex entry for a flat ribbon: each point spreads across its normal x the line's direction there, in
 * world units, scaled by the point's fourth value, so the strip lies in the world and does not turn to the camera. A segment
 * uses the first 6 vertices of its block. A ribbon has no dashes, so the normal rides in the dash fields of the style. `picking` carries the segment on, as the pick shader's `Out` has it.
 */
export const ribbonShader = (code: string, picking = false): string =>
  code +
  /* wgsl */ `
@vertex fn ribbonVertex(@builtin(vertex_index) vi:u32,@builtin(instance_index) ii:u32)->Out{
  var o:Out;
  o.clip=vec4f(2.0,2.0,0.0,1.0);o.color=vec4f(0.0);o.edge=vec4f(0.0,1.0,-1e4,-1e4);o.dist=0.0;
  if(vi>=6u){return o;}
  let ends=array<u32,6>(0u,0u,1u,0u,1u,1u);let sides=array<f32,6>(-1.0,1.0,1.0,-1.0,1.0,-1.0);
  let k=ii+ends[vi];let last=style.flags.y-1u;
  let before=style.model*vec4f(points[select(k,k-1u,k>0u)].xyz,1.0);
  let after=style.model*vec4f(points[min(k+1u,last)].xyz,1.0);
  let here=style.model*vec4f(points[k].xyz,1.0);
  let across=cross(vec3f(style.a.zw,style.b.x),after.xyz/after.w-before.xyz/before.w);
  let size=length(across);
  let side=select(vec3f(0.0),across/size,size>1e-9);
  let w=here.xyz/here.w+side*(sides[vi]*0.5*style.a.x*points[k].w);
  let placed=frame.viewProj*vec4f(w,1.0);
  o.clip=placed;
  var tint=vec4f(1.0);
  if((style.flags.z&64u)!=0u){tint=colors[k];}
  o.color=tint*style.color;
  o.world=w;${picking ? 'o.segment=ii;' : ''}
  return o;
}
`;

/** The fragment's dash step, which `dashCapShader` replaces. */
const dashStep = 'cover*=select(select(0.0,1.0,inside>=0.0),clamp(inside/fw+0.5,0.0,1.0),aa);';

/**
 * `code` for dashes with round or square ends. Each reaches half the line width past the dash, in pixels. A round end
 * is the distance to the dash's end point, which only cuts deeper than the side ramp already in `cover`.
 */
export const dashCapShader = (code: string, cap: 'round' | 'square'): string =>
  code.replace(
    dashStep,
    cap === 'square'
      ? 'let past=inside/fw+i.edge.y;cover*=select(select(0.0,1.0,past>=0.0),clamp(past+0.5,0.0,1.0),aa);'
      : 'let past=max(-inside/fw,0.0);let sd=sqrt(past*past+i.edge.x*i.edge.x)-i.edge.y;' +
          'cover=min(cover,select(select(0.0,1.0,sd<=0.0),clamp(0.5-sd,0.0,1.0),aa));',
  );

const fogEdits: Array<[string, string]> = [
  // Lines blend alpha over the scene, so a fogged line fades toward the fog colour, in linear before any encoding.
  [
    'var rgb=max(i.color.rgb,vec3f(0.0));',
    'var rgb=max(i.color.rgb,vec3f(0.0));rgb=mix(rgb,margoFog.color.rgb,fogAmount(i.world));',
  ],
];
/** The line shader with scene fog (fog uniform at group 2); `lineShader` itself stays unchanged. */
export function foggedLineShader(): string {
  let code = lineShader;
  for (const [from, to] of fogEdits) {
    if (!code.includes(from))
      throw new MargoError(
        'unsupported',
        'Line fog needs the line shader it was written for; update the fog edits with it',
      );
    code = code.replace(from, to);
  }
  return code + fogWgsl(2, 0);
}
