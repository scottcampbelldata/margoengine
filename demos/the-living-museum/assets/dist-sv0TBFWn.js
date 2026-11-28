import{n as e,t}from"./version-YYhCZP03.js";import{_ as n,a as r,b as i,c as a,d as o,f as s,g as c,h as l,i as u,l as d,m as f,n as p,o as m,p as h,r as g,s as _,t as v,u as y,v as ee,y as te}from"./line-CXjNQjrU-DGBiKrKM.js";import{r as ne,t as b}from"./color-CMZXT1qw-Q1s-m9dW.js";import{t as x}from"./mesh-DXjKHPIj.js";import{i as re}from"./details-sNLk9txe.js";import{a as ie,s as ae}from"./scene-BvrlAlsQ.js";function oe(e,t){if(e.backend===`webgl2`||!e.gpu)throw new ie(`unsupported`,`${t} needs WebGPU; see https://margoengine.com/errors#webgpu`)}function se(e){return e?.view?.viewport}function ce(e,t){let n=se(t);if(!n)return;e.setViewport(n[0],n[1],n[2],n[3],0,1);let r=t.view.scissor??n;e.setScissorRect(r[0],r[1],r[2],r[3])}var le=(e,t)=>`
struct MargoFog {color:vec4f,params:vec4f,eye:vec4f}
@group(${e}) @binding(${t}) var<uniform> margoFog:MargoFog;
fn fogAmount(p:vec3f)->f32 {
  let d=distance(p,margoFog.eye.xyz);let q=margoFog.params;
  let amount=select(clamp((d-q.x)/max(q.y-q.x,1e-6),0.0,1.0),1.0-exp(-q.z*q.z*d*d),q.z>0.0);
  return amount*exp(-q.w*max(p.y-margoFog.color.w,0.0));
}
`,S=(e,t,n,r)=>{let i=e===void 0?t:e;if(typeof i!=`number`||!Number.isFinite(i)||i<r)throw RangeError(`Fog ${n} is ${String(i)}; pass a finite number${r===0?`, 0 or more`:``}`);return i};function ue(e){if(e!==null&&(typeof e!=`object`||Array.isArray(e)))throw TypeError(`Fog must be an object with Fog fields; pass an environment Fog, such an object or null`);return e&&de(e,[0,0,0],new Float32Array(12)),e}function de(e,t,n,r=!1){let i=e.enabled??!0;if(typeof i!=`boolean`)throw TypeError(`Fog enabled is ${String(i)}; pass true or false`);let a=S(e.height,0,`height`,-1/0),o=S(e.near,1,`near`,0),s=S(e.far,1e3,`far`,0),c=S(e.density,0,`density`,0),l=S(e.heightFalloff,0,`heightFalloff`,0);if(b(e.color??`#ffffff`,n,0),r)for(let e=0;e<3;e++)n[e]=ne(n[e]);n[3]=a,n[4]=o,n[5]=s,n[6]=c,n[7]=l,i||(n.fill(0,0,8),n[4]=n[5]=34028234663852886e22),n[8]=t[0],n[9]=t[1],n[10]=t[2],n[11]=0}var fe=`
const FAN:u32=10u;
const BLOCK:u32=36u;
const PI:f32=3.14159265;
struct Frame{viewProj:mat4x4f,viewport:vec4f,extra:vec4f}
struct Style{model:mat4x4f,color:vec4f,a:vec4f,b:vec4f,flags:vec4u,planes:array<vec4f,6>}
@group(0) @binding(0) var<uniform> frame:Frame;
@group(1) @binding(0) var<uniform> style:Style;
@group(1) @binding(1) var<storage,read> points:array<vec4f>;
@group(1) @binding(2) var<storage,read> colors:array<vec4f>;

fn tinted(p:vec4f,bits:u32,fade:f32)->vec4f{
  let m=style.color;var rgb=m.rgb*p.rgb;
  if((bits&128u)!=0u){rgb=p.rgb;}else if((bits&256u)!=0u){rgb=min(m.rgb+p.rgb,vec3f(1.0));}
  return vec4f(rgb,p.a*m.a*fade);
}
${((e,t)=>`
@group(${e}) @binding(${t}) var<storage,read> margoMask:array<u32>;
fn margoMaskPresent()->bool{return margoMask[3]==1u;}
fn margoMaskOn(i:u32)->bool{return ((margoMask[4u+(i>>5u)]>>(i&31u))&1u)!=0u;}
fn margoMaskHidden(on:bool)->bool{return !on&&margoMask[0]==2u;}
fn margoMaskColor(c:vec4f,on:bool)->vec4f{
  let l=max(c.rgb,vec3f(0.0));
  var s=select(1.055*pow(l,vec3f(1.0/2.4))-0.055,l*12.92,l<=vec3f(0.0031308));
  if(on){if(margoMask[0]!=1u){return c;}let h=unpack4x8unorm(margoMask[2]);s=mix(s,h.rgb,h.a);}
  else{s*=bitcast<f32>(margoMask[1]);}
  return vec4f(select(pow((s+0.055)/1.055,vec3f(2.4)),s/12.92,s<=vec3f(0.04045)),c.a);
}
`)(1,7)}
struct Out{
  @builtin(position) clip:vec4f,
  @location(0) color:vec4f,
  @location(1) @interpolate(linear) edge:vec4f,
  @location(2) dist:f32,
  @location(3) world:vec3f,
}
struct Joint{sOut:f32,miter:bool,innerOk:bool,inner:vec2f,outer0:vec2f,outer1:vec2f,n1:vec2f}
struct Corner{off:vec2f,d:f32,atB:bool,valid:bool}

fn near(i:u32)->vec2f{let v=points[style.flags.y+i/2u];return select(v.xy,v.zw,(i&1u)==1u);}
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
  let l=length(start);let s=select(vec2f(1.0,0.0),start/l,l>0.0);let a=sweep*f32(step)/f32(FAN);let c=cos(a);let n=sin(a);
  return vec2f(s.x*c-s.y*n,s.x*n+s.y*c)*hwG;
}

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
  else{
    ia=ii;ib=select(ii+1u,(ii+1u)%n,mode==2u&&n>=3u);
    let na=near(ia);
    if(na.y!=f32(ib)&&(na.x>=0.0||na.y>=0.0)){return o;}
    let nb=near(ib).y;
    hasPrev=na.x>=0.0;ip=u32(max(na.x,0.0));hasNext=nb>=0.0;inx=u32(max(nb,0.0));
  }
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
  o.color=tinted(select(colA,colB,cr.atB),bits,fade);

  if(margoMaskPresent()){let on=margoMaskOn(ia)&&margoMaskOn(ib);if(margoMaskHidden(on)){o.clip=vec4f(2.0,2.0,0.0,1.0);return o;}o.color=margoMaskColor(o.color,on);}
  var dA=points[ia].w;var dB=points[ib].w;
  if(mode==2u&&n>=3u&&ib==0u){dB=style.b.y;}
  o.dist=mix(dA,dB,select(ta,tb,cr.atB));

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


  let clipCount=style.flags.w&0xffffu;var clipBehind=0u;
  for(var p=0u;p<clipCount;p++){if(dot(style.planes[p].xyz,i.world)+style.planes[p].w<0.0){clipBehind++;}}
  if(clipCount>0u&&select(clipBehind>0u,clipBehind==clipCount,(style.flags.w&65536u)!=0u)){discard;}
  let alpha=i.color.a*cover;
  var rgb=max(i.color.rgb,vec3f(0.0));
  if(frame.extra.x>0.5){rgb=encode(min(rgb,vec3f(1.0)));}
  return vec4f(rgb,alpha);
}
`,pe=(e,t)=>t?e.replace(`let alpha=i.color.a*cover;`,`if(cover${t===1?`<`:`>=`}0.5){discard;}let alpha=i.color.a*cover;`):e,me=e=>e.replace(`if((style.flags.z&32u)!=0u){
    let dash=`,`if(false){
    let dash=`)+`
@vertex fn fillVertex(@builtin(vertex_index) vi:u32)->Out{
  var o:Out;
  let p=points[vi];let w=style.model*vec4f(p.xyz,1.0);
  o.clip=frame.viewProj*w;
  o.color=vec4f(style.color.rgb,style.color.a*p.w);
  o.edge=vec4f(0.0,1.0,-1e4,-1e4);o.dist=0.0;o.world=w.xyz/w.w;
  return o;
}
`,he=e=>e.replace(`let rawA=halfWidth(ca);let rawB=halfWidth(cb);`,`let rawA=halfWidth(ca)*mix(points[ia].w,points[ib].w,ta);let rawB=halfWidth(cb)*mix(points[ia].w,points[ib].w,tb);`),ge=e=>e.replace(`o.clip=vec4f(base.xy+cr.off/(0.5*frame.viewport.xy)*base.w,base.z,base.w);`,`o.clip=vec4f(base.xy+cr.off/(0.5*frame.viewport.xy)*base.w,min(base.z*(1.0+style.b.w),base.w),base.w);`).replace(`o.clip=placed;`,`o.clip=vec4f(placed.xy,min(placed.z*(1.0+style.b.w),placed.w),placed.w);`),_e=(e,t=!1)=>e+`
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
  o.color=tinted(tint,style.flags.z,1.0);
  if(margoMaskPresent()){let on=margoMaskOn(ii)&&margoMaskOn(ii+1u);if(margoMaskHidden(on)){o.clip=vec4f(2.0,2.0,0.0,1.0);return o;}o.color=margoMaskColor(o.color,on);}
  o.world=w;${t?`o.segment=ii;`:``}
  return o;
}
`,ve=`cover*=select(select(0.0,1.0,inside>=0.0),clamp(inside/fw+0.5,0.0,1.0),aa);`,ye=(e,t)=>e.replace(ve,t===`square`?`let past=inside/fw+i.edge.y;cover*=select(select(0.0,1.0,past>=0.0),clamp(past+0.5,0.0,1.0),aa);`:`let past=max(-inside/fw,0.0);let sd=sqrt(past*past+i.edge.x*i.edge.x)-i.edge.y;cover=min(cover,select(select(0.0,1.0,sd<=0.0),clamp(0.5-sd,0.0,1.0),aa));`),be=[[`var rgb=max(i.color.rgb,vec3f(0.0));`,`var rgb=max(i.color.rgb,vec3f(0.0));rgb=mix(rgb,margoFog.color.rgb,fogAmount(i.world));`]];function xe(){let e=fe;for(let[t,n]of be){if(!e.includes(t))throw new ie(`unsupported`,`Line fog needs the line shader it was written for; update the fog edits with it`);e=e.replace(t,n)}return e+le(2,0)}var C=224,w=1,T=2,Se=4,Ce=8,E=16,we=32,Te=64,D=128,O=256,k=512,A=1024,j=2048,Ee={binding:7,visibility:1,buffer:{type:`read-only-storage`,minBindingSize:16}},De=e=>e.fillOpaque&&e.material.opacity===1&&!e.material.behind,Oe=7,ke=class i{coreRequirement=e(`1.0.0`,import.meta.url);memoryFor(e){let t=this.resources.get(e);return t?{cpu:[t.floats,t.uints,t.written],gpu:[t.uniform,t.points,t.colors,...t.mask?[t.mask]:[],...t.fill?[t.fill.buffer]:[]]}:{cpu:[],gpu:[]}}static attach(n,r){t(n,e(`1.0.0`,import.meta.url));let a=new i(r);return n.use(a),a}constructor(e={}){if(this.stats={lines:0,segments:0,drawCalls:0},this.members=new Set,this.resources=new Map,this.watchers=new Set,this.pipelines=new Map,this.modules=new Map,this.extendedLayouts=new Map,this.elapsed=0,this.frameData=new Float32Array(24),this.frameBits=new Uint32Array(this.frameData.buffer),this.frameWritten=new Uint32Array(24),this.frameValid=!1,this.drawLists=[[],[],[],[]],this.fillLists=[[],[]],this.descriptor=r(),this.writeDescriptor=g(),this.fogSource=null,this.fogData=new Float32Array(12),this.execute=e=>{let t=this.stats;if(t.lines=t.segments=t.drawCalls=0,e.backend!==`webgpu`||!this.device||!this.engine||e.device!==this.device)return;n.hook?.lines(this);let r=this.engine,i=this.device,a=this.drawLists;this.collect(r,0);for(let e of a)for(let[n]of e)t.lines++,t.segments+=n.segmentCount;if(!t.lines)return;let o=r.canvas,s=this.frameData,c=e.camera;te(s,c.matrix,c,e.width,e.height,o.clientWidth?e.width/o.clientWidth:1,e.height,e.format.endsWith(`-srgb`)||e.format.includes(`float`)?0:1);let l=!this.frameValid;for(let e=0;!l&&e<this.frameBits.length;e++)l=this.frameBits[e]!==this.frameWritten[e];l&&(i.queue.writeBuffer(this.frameBuffer,0,s),this.frameWritten.set(this.frameBits),this.frameValid=!0);let u=this.fogSource,d=!1;if(u)for(let e of a)for(let[t]of e)d||=t.material.fog;d&&(de(u,c.position,this.fogData),i.queue.writeBuffer(this.fogResources().buffer,0,this.fogData));let f=this.fillLists,p=a[0].length||a[2].length||f.some(e=>e.some(([e])=>De(e)))?this.writeDescriptor:this.descriptor;p.colorAttachments[0].view=e.color,p.depthStencilAttachment.view=e.depth;let m=e.encoder.beginRenderPass(p);ce(m,e),m.setBindGroup(0,this.frameGroup),d&&m.setBindGroup(2,this.fogGpu.group);for(let t=0;t<4;t+=2){let n=t?w:0;this.drawFills(m,e,f[t/2],d,n),this.drawList(m,e,a[t],d,n|2052),this.drawList(m,e,a[t],d,n|2*j),this.drawList(m,e,a[t+1],d,n)}m.end();for(let e of a)e.length=0},this.name=e.name??`lines`,this.order=e.order??20,!this.name||typeof this.name!=`string`||!Number.isFinite(this.order))throw TypeError(`Invalid Lines options; pass the documented option types`)}get lines(){return this.members}get fog(){return this.fogSource}setFog(e){return this.fogSource=ue(e),this}add(e){if(!(e instanceof v))throw TypeError(`Expected a Line`);e.bind(this),this.members.add(e);for(let t of this.watchers)t.added(e);return e}remove(e){if(this.members.delete(e)){for(let t of this.watchers)t.removed(e);this.release(e),e.bind(void 0)}}clear(){for(let e of[...this.members])this.remove(e)}get time(){return this.elapsed}resetTime(){this.elapsed=0;for(let e of this.members)e.resetTime?.()}advanceTime(e){if(e>0){this.elapsed+=e;for(let t of this.members)t.visible&&t.advanceTime?.(e)}}onPreUpdate(e){this.advanceTime(e)}setup(e){oe(e,`Lines`),this.engine=e;let t=this.device=e.gpu,n=(e,t)=>({binding:0,visibility:t,buffer:{type:`uniform`,minBindingSize:e}}),r=t.createBindGroupLayout({entries:[n(96,GPUShaderStage.VERTEX|GPUShaderStage.FRAGMENT)]}),i=t.createBindGroupLayout({entries:[n(C,GPUShaderStage.VERTEX|GPUShaderStage.FRAGMENT),{binding:1,visibility:GPUShaderStage.VERTEX,buffer:{type:`read-only-storage`,minBindingSize:16}},{binding:2,visibility:GPUShaderStage.VERTEX,buffer:{type:`read-only-storage`,minBindingSize:16}},Ee]});this.noMask=t.createBuffer({size:16,usage:GPUBufferUsage.STORAGE}),this.layouts={frame:r,style:i,pipeline:t.createPipelineLayout({bindGroupLayouts:[r,i]})},this.module(0),this.frameBuffer=t.createBuffer({size:96,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST}),this.frameValid=!1,this.frameGroup=t.createBindGroup({layout:r,entries:[{binding:0,resource:{buffer:this.frameBuffer}}]})}registerPasses(e){e.add({name:`${this.name}:draw`,order:this.order,execute:this.execute})}module(e,t){let r=`${e&-86}|${t?.key??``}`,i=this.modules.get(r);if(!i){let a=e&T?xe():fe;e&A&&(a=_e(a)),e&Ce&&(a=he(a)),e&we&&(a=ge(a)),e&D&&(a=ye(a,`round`)),e&O&&(a=ye(a,`square`)),e&k&&(a=me(a)),a=pe(a,Math.floor(e/j)),t&&(a=t.shader(a)),n.hook&&(a=n.hook.shader(a)),i=this.device.createShaderModule({code:a}),this.modules.set(r,i)}return i}pipeline(e,t,n,r,i){let a=`${e}|${t}|${n}|${r}|${i?.key??``}`,o=this.pipelines.get(a);if(!o){let s=(r&T)!==0,c=(r&Te)!==0,l=s?this.fogResources():void 0,d=this.module(r,i);o=this.device.createRenderPipeline({layout:i?this.device.createPipelineLayout({bindGroupLayouts:[this.layouts.frame,this.styleLayout(i),...l?[l.layout]:[]]}):l?.pipeline??this.layouts.pipeline,vertex:{module:d,entryPoint:r&k?`fillVertex`:r&A?`ribbonVertex`:`vertex`},fragment:{module:d,entryPoint:`fragment`,targets:[c?{format:e,writeMask:Oe}:{format:e,blend:u}]},primitive:{topology:`triangle-list`,cullMode:`none`},multisample:c?{count:n,alphaToCoverageEnabled:!0}:{count:n},depthStencil:{format:t,depthWriteEnabled:(r&Se)!==0,depthCompare:r&w?`always`:r&E?`less`:`greater-equal`}}),this.pipelines.set(a,o)}return o}fogResources(){if(this.fogGpu)return this.fogGpu;let e=this.device,t=this.layouts,n=e.createBindGroupLayout({entries:[{binding:0,visibility:GPUShaderStage.FRAGMENT,buffer:{type:`uniform`,minBindingSize:48}}]}),r=e.createBuffer({size:48,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});return this.fogGpu={layout:n,buffer:r,pipeline:e.createPipelineLayout({bindGroupLayouts:[t.frame,t.style,n]}),group:e.createBindGroup({layout:n,entries:[{binding:0,resource:{buffer:r}}]})}}ensure(e){let t=this.device,n=e.colors,r=this.resources.get(e);if(r&&r.capacity===e.capacityVersion)return r;r&&this.release(e);let i=[],a;try{let o=(e,n)=>{let r=t.createBuffer({size:e,usage:n});return i.push(r),r},s=o(C,GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST),c=e.points.length/4,l=Math.ceil(c/2)*4,u=o(Math.max(16,e.points.byteLength+l*4),GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST),d=o(Math.max(16,n?.byteLength??16),GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST),f=e.mask?o(e.mask.byteLength,GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST):null;a=e.extension?.create(t);let p=t.createBindGroup({layout:this.styleLayout(e.extension),entries:[{binding:0,resource:{buffer:s}},{binding:1,resource:{buffer:u}},{binding:2,resource:{buffer:d}},{binding:7,resource:{buffer:f??this.noMask}},...a?.entries??[]]}),m=new ArrayBuffer(C);r={extra:a,uniform:s,points:u,colors:d,mask:f,maskVersion:-1,group:p,capacity:e.capacityVersion,version:-1,style:m,floats:new Float32Array(m),uints:new Uint32Array(m),written:new Float32Array(C/4).fill(NaN),near:new Float32Array(l),nearMode:``}}catch(e){a?.dispose();for(let e of i)e.destroy();throw e}return this.resources.set(e,r),r}styleLayout(e){if(!e)return this.layouts.style;let t=this.extendedLayouts.get(e.key);return t||(t=this.device.createBindGroupLayout({entries:[{binding:0,visibility:3,buffer:{type:`uniform`,minBindingSize:C}},{binding:1,visibility:1,buffer:{type:`read-only-storage`,minBindingSize:16}},{binding:2,visibility:1,buffer:{type:`read-only-storage`,minBindingSize:16}},Ee,...e.entries]}),this.extendedLayouts.set(e.key,t)),t}release(e){let t=this.resources.get(e);t&&(t.extra?.dispose(),t.uniform.destroy(),t.points.destroy(),t.colors.destroy(),t.mask?.destroy(),t.fill?.buffer.destroy(),this.resources.delete(e))}uploadFill(e,t,n){let r=this.device;if(t.fill?.bytes!==n.byteLength){t.fill?.buffer.destroy();let e=r.createBuffer({size:n.byteLength,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST});t.fill={buffer:e,group:r.createBindGroup({layout:this.layouts.style,entries:[{binding:0,resource:{buffer:t.uniform}},{binding:1,resource:{buffer:e}},{binding:2,resource:{buffer:t.colors}},{binding:7,resource:{buffer:t.mask??this.noMask}}]}),bytes:n.byteLength,version:-1}}t.fill.version!==e.fillVersion&&(r.queue.writeBuffer(t.fill.buffer,0,n),t.fill.version=e.fillVersion)}collect(e,t){let n=this.device,r=this.drawLists;for(let e of r)e.length=0;for(let e of this.fillLists)e.length=0;for(let i of this.members){if(!i.visible||i.update(e,t)===!1)continue;let a=i.attachedMesh,o=a?x(e,a):i.matrix;if(!o)continue;let s=i.segmentCount,c=i.material;if(!s)continue;c.validate(),(c.dashed||i.extension)&&i.updateDistances(o);let u=this.ensure(i);if(u.extra?.update(),u.version!==i.version&&(n.queue.writeBuffer(u.points,0,i.points,0,i.count*4),u.nearMode=``,i.colors&&n.queue.writeBuffer(u.colors,0,i.colors,0,i.count*4),u.version=i.version),i.mode!==`segments`&&u.nearMode!==i.mode){let e=i.count,t=f(i.points,e,i.mode,u.near);n.queue.writeBuffer(u.points,e*16,t,0,Math.ceil(e/2)*4),u.nearMode=i.mode}u.mask&&i.mask&&u.maskVersion!==i.maskVersion&&(n.queue.writeBuffer(u.mask,0,i.mask),u.maskVersion=i.maskVersion);let d=u.floats,p=u.uints;d.set(o,0),d.set(c.color,16),d[19]=c.opacity,d[20]=c.width,d[21]=c.miterLimit,i.flatNormal?d.set(i.flatNormal,22):(d[22]=c.dashSize,d[23]=c.gapSize,d[24]=c.dashOffset),d[25]=i.totalDistance,d[26]=+!!c.antialias,d[27]=c.depthBias;let m=(c.vertexColors??!0)&&i.colors!==null;p[28]=h.indexOf(i.mode),p[29]=i.count,p[30]=l.indexOf(c.join)|y.indexOf(c.cap)<<2|(c.worldUnits?16:0)|(c.dashed&&!i.flatNormal?32:0)|(m?64:0)|(m&&c.colorMode===`set`?128:0)|(m&&c.colorMode===`add`?256:0);let g=c.clipping;p[31]=g.length/4+(c.clipIntersection?65536:0),d.set(g,32),d.fill(0,32+g.length);let _=!1;for(let e=0;e<d.length;e++)if(!Object.is(u.written[e],d[e])){_=!0;break}_&&(n.queue.writeBuffer(u.uniform,0,u.style),u.written.set(d)),r[(c.onTop?2:0)+(c.depthWrite&&!c.behind?0:1)].push([i,u]);let v=i.fill;v?.length&&(this.uploadFill(i,u,v),this.fillLists[+!!c.onTop].push([i,u]))}}drawFills(e,t,n,r,i){let a=t.descriptor.depthStencil.format,o=t.descriptor.multisample?.count??1;for(let[s,c]of n){let{fog:n,behind:l}=s.material,u=(De(s)?Se:0)|(l?E:0)|(r&&n?T:0);e.setPipeline(this.pipeline(t.format,a,o,k|i|u)),e.setBindGroup(1,c.fill.group),e.draw(s.fill.length/4),this.stats.drawCalls++}}drawList(e,t,n,r,i){let a=t.descriptor.depthStencil.format,o=t.descriptor.multisample?.count??1,s=i>=2*j,c;for(let[l,u]of n){let{fog:n,antialias:d,dashed:f,dashCap:p,behind:m,depthBias:h,alphaToCoverage:g}=l.material,_=g&&o>1;if(s&&(!d||_))continue;let v=(l.pointWidths&&!f?Ce:0)|(l.flatNormal?A:0)|(m?E:0)|(h?we:0)|(_?Te:0)|(f&&p===`round`?D:0)|(f&&p===`square`?O:0)|(r&&n?T:0),y=this.pipeline(t.format,a,o,(_?i%j:i)|v,l.extension);y!==c&&e.setPipeline(c=y),e.setBindGroup(1,u.group),e.draw(this.vertexCount(l),l.segmentCount),this.stats.drawCalls++}}vertexCount(e){return e.mode===`segments`&&e.material.cap!==`round`&&!e.extension?6:78}onDeviceRestored(e){this.releaseGpu(),this.setup(e)}releaseGpu(){for(let e of[...this.resources.keys()])this.release(e);this.extendedLayouts.clear(),this.frameBuffer?.destroy(),this.noMask?.destroy(),this.fogGpu?.buffer.destroy(),this.frameBuffer=this.frameGroup=this.layouts=this.device=this.fogGpu=this.noMask=void 0,this.pipelines.clear(),this.modules.clear()}dispose(){this.engine?.sceneOf?.(this)?.removePlugin(this.name),this.releaseGpu(),this.engine=void 0}[Symbol.dispose??Symbol()](){this.dispose()}},M=Symbol.for(`margoengine.mesh-sources.v1`),Ae=globalThis[M]??new WeakMap;globalThis[M]||Object.defineProperty(globalThis,M,{value:Ae});var N=Symbol.for(`margoengine.geometry-surfaces.v1`),je=globalThis[N]??new WeakMap;globalThis[N]||Object.defineProperty(globalThis,N,{value:je});function Me(e){if(e?.geometry)return{kind:`core`,geometry:e.geometry};let t=e&&Ae.get(e);if(!t||t.model.disposed)return null;try{e.check?.()}catch{return null}return{kind:`pbr`,source:t}}var Ne=`#8f8f8f`,Pe=`#5e5e5e`,P=`#f0931e`,Fe=`#e8459a`,Ie=[[`#f03c3c`,`#ff9c9c`],[`#2fbf3f`,`#9ee8a6`],[`#3a78f2`,`#a3c1ff`]],Le=`#f0a030`,Re=`#e0503c`,ze=`#33b8e8`,Be=`#a0a0a0`,Ve=`#5cc45c`,F=.25,He=.5,I=12,Ue=.999;function We(e,t,{near:n,far:r}){let i=[],a=[],o=(r-n)/16,s=(e,t)=>{let i=Math.min(1,Math.max(0,(Math.hypot(e,t)-n)/(r-n)));return 1-i*i*(3-2*i)};for(let c=0;c<t.length;c++){let[l,u,d,f]=e.slice(c*4,c*4+4),p=d-l,m=f-u,h=p*p+m*m,g=2*(l*p+u*m),_=Math.sqrt(h),v=[0,1];for(let e of[n,r]){let t=g*g-4*h*(l*l+u*u-e*e);if(h>0&&t>0)for(let e of[(-g-Math.sqrt(t))/(2*h),(-g+Math.sqrt(t))/(2*h)])e>0&&e<1&&v.push(e)}v.sort((e,t)=>e-t);for(let e=1;e<v.length;e++){let d=v[e-1],f=v[e],h=Math.hypot(l+p*(d+f)*.5,u+m*(d+f)*.5);if(f<=d||h>=r)continue;let g=Math.max(h,Math.hypot(l+p*d,u+m*d),Math.hypot(l+p*f,u+m*f))<=n?1:Math.min(64,Math.max(1,Math.ceil(_*(f-d)/o)));for(let e=0;e<g;e++)for(let n of[d+(f-d)*e/g,d+(f-d)*(e+1)/g]){let e=l+p*n,r=u+m*n;i.push(e,0,r),a.push(t[c][0],t[c][1],t[c][2],s(e,r))}}}return[Float32Array.from(i),Float32Array.from(a)]}function Ge(e){if(e!==void 0&&!(typeof e==`object`&&e&&Number.isFinite(e.near)&&Number.isFinite(e.far)&&e.near>=0&&e.far>e.near))throw RangeError(`Invalid grid fade; pass { near, far } in world units with 0 <= near < far, both finite`)}var L=e=>({cap:`butt`,join:`miter`,...e}),R=e=>Array.from(b(e));function z(e,t){if(!e||typeof e.length!=`number`||e.length!==3)throw TypeError(`${t} needs 3 values; pass [x, y, z]`);return i(e,t),[e[0],e[1],e[2]]}function Ke(e,t){let[n,r,i]=z(e,t),a=Math.hypot(n,r,i);if(!(a>0))throw RangeError(`${t} must be nonzero; pass a direction with a length`);return[n/a,r/a,i/a]}function qe(e){let t=Math.abs(e[1])>Ue,n=t?-e[1]:e[2],r=t?e[0]:0,i=t?0:-e[0],a=Math.hypot(n,r,i);return n/=a,r/=a,i/=a,[[n,r,i],[e[1]*i-e[2]*r,e[2]*n-e[0]*i,e[0]*r-e[1]*n]]}function Je(e,t,n){let r=0,i=(i,a)=>{for(let o of[i,a])e[r++]=o&1?n[0]:t[0],e[r++]=o&2?n[1]:t[1],e[r++]=o&4?n[2]:t[2]};for(let e=0;e<8;e++)for(let t of[1,2,4])e&t||i(e,e|t)}var Ye=class extends v{constructor(e={}){let{size:t=10,divisions:n=10,color1:r=Ne,color2:i=Pe,fade:a,...o}=e;if(!(t>0)||!Number.isFinite(t)||!Number.isInteger(n)||n<1||n>1e4)throw RangeError(`Invalid grid size or divisions; pass a positive size and an integer divisions 1..10000`);Ge(a),super({...L(o),mode:`segments`});let s=R(r),c=R(i),l=t/2,u=n+1,d=new Float32Array(u*12),f=new Float32Array(u*12),p=0,m=0;for(let e=0;e<u;e++){let r=-l+e*t/n,i=n%2==0&&e*2===n?s:c;d.set([-l,0,r,l,0,r,r,0,-l,r,0,l],p),p+=12;for(let e=0;e<4;e++,m+=3)f.set(i,m)}if(!a){this.setPositions(d,f);return}let h=[],g=[];for(let e=0;e<d.length;e+=6)h.push(d[e],d[e+2],d[e+3],d[e+5]),g.push(Array.from(f.subarray(e,e+3)));this.setPositions(...We(h,g,a))}},Xe=class extends v{constructor(e={}){let{fade:t,radius:n=5,sectors:r=12,rings:i=5,divisions:a=72,color1:o=Ne,color2:s=Pe,...c}=e,l=e=>Number.isInteger(e)&&e>=0&&e<=4096;if(!(n>0)||!Number.isFinite(n)||!l(r)||!l(i)||!l(a)||a<3)throw RangeError(`Invalid polar grid options; pass a positive radius, sectors and rings 0..4096 and divisions 3..4096`);Ge(t),super({...L(c),mode:`segments`});let u=R(o),d=R(s),f=2*r+2*i*a,p=new Float32Array(f*3),m=new Float32Array(f*3),h=0,g=(e,t,n)=>{p[h]=e,p[h+2]=t,m.set(n,h),h+=3};for(let e=0;e<r;e++){let t=2*Math.PI*e/r,i=e%2?d:u;g(0,0,i),g(Math.sin(t)*n,Math.cos(t)*n,i)}for(let e=0;e<i;e++){let t=n*(i-e)/i,r=e%2?d:u;for(let e=0;e<a;e++){let n=2*Math.PI*e/a,i=2*Math.PI*(e+1)/a;g(Math.sin(n)*t,Math.cos(n)*t,r),g(Math.sin(i)*t,Math.cos(i)*t,r)}}if(!t){this.setPositions(p,m);return}let _=[],v=[];for(let e=0;e<p.length;e+=6)_.push(p[e],p[e+2],p[e+3],p[e+5]),v.push(Array.from(m.subarray(e,e+3)));this.setPositions(...We(_,v,t))}},Ze=class extends v{constructor(e={}){let{size:t=1,...n}=e;if(!(t>0)||!Number.isFinite(t))throw RangeError(`Axes size must be positive; pass a size above 0`);super({...L(n),mode:`segments`});let r=[];for(let[e,t]of Ie)r.push(...R(e),...R(t));this.setPositions([0,0,0,t,0,0,0,0,0,0,t,0,0,0,0,0,0,t],r)}setColors(e,t,n){if(t===void 0||n===void 0)return super.setColors(e);let r=[];for(let i of[e,t,n]){let e=R(i);r.push(...e,...e)}return super.setColors(r)}},Qe=class extends v{constructor(e=[-.5,-.5,-.5],t=[.5,.5,.5],n={}){let{color:r=P,...i}=n;super({...L(i),color:r,mode:`segments`}),this.corners=new Float32Array(72),this.setBox(e,t)}setBox(e,t){let n=z(e,`Box min`),r=z(t,`Box max`);if(n.some((e,t)=>e>r[t]))throw RangeError(`Box min exceeds max; pass min <= max on every axis`);return Je(this.corners,n,r),this.setPositions(this.corners)}},B=new WeakMap;function $e(e){let t=B.get(e);if(t)return t;t=new Float32Array([1/0,1/0,1/0,-1/0,-1/0,-1/0]);let n=e.vertices;for(let e=0;e+2<n.length;e+=6)for(let r=0;r<3;r++){let i=n[e+r];i<t[r]&&(t[r]=i),i>t[r+3]&&(t[r+3]=i)}return B.set(e,t),t}function et(e){let t=B.get(e);return t||B.set(e,t=Float32Array.from(e.bounds)),t}var V=e=>{for(let t=0;t<e.length;t++)if(!Number.isFinite(e[t]))return!1;return!0},tt=class extends v{constructor(e,t={}){e.check();let{color:n=P,...r}=t;super({...L(r),color:n,mode:`segments`}),this.seenMatrix=new Float32Array(16).fill(NaN),this.seenBounds=new Float32Array(6).fill(NaN),this.seenSource=null,this.lo=new Float32Array(3),this.hi=new Float32Array(3),this.corner=new Float32Array(3),this.out=new Float32Array(72),this.followed=e,this.setPositions(this.out)}setFromMesh(e){return e.check(),this.followed=e,this.seenSource=null,this}update(e){let t=x(e,this.followed);if(!t)return!1;let n=Me(ae(this.followed));if(!n)return!1;let[r,i]=n.kind===`core`?[n.geometry,$e(n.geometry)]:[n.source,et(n.source)];if(!V(t)||!V(i))return!1;let a=r!==this.seenSource,o=c(this.seenMatrix,t),s=c(this.seenBounds,i);if(!a&&!o&&!s)return!0;this.seenSource=r;let{lo:l,hi:u,corner:d}=this;l.fill(1/0),u.fill(-1/0);for(let e=0;e<8;e++){ee(d,0,t,i[e&1?3:0],i[e&2?4:1],i[e&4?5:2]);for(let e=0;e<3;e++)l[e]=Math.min(l[e],d[e]),u[e]=Math.max(u[e],d[e])}return Je(this.out,l,u),this.setPositions(this.out),!0}},nt=class extends v{constructor(e={}){let{direction:t=[0,0,1],origin:n=[0,0,0],length:r=1,color:i=P,headLength:a,headWidth:o,solidHead:s=!1,...c}=e;super({...L(c),color:i,mode:`segments`}),this.length=1,this.headLength=F,this.headWidth=F*He,this.out=new Float32Array(150),this.cone=s?new Float32Array(288):null,this.direction=Ke(t,`Direction`),this.origin=z(n,`Arrow origin`),this.setLength(r,a,o)}setDirection(e){return this.direction=Ke(e,`Direction`),this.build()}setOrigin(e){return this.origin=z(e,`Arrow origin`),this.build()}setLength(e,t=e*F,n=t*He){let r=[e,t,n];if(!r.every(Number.isFinite)||r.some(e=>e<0)||e===0||t>e)throw RangeError(`Invalid arrow length; pass a positive length and head sizes of 0 or more with headLength <= length`);return this.length=e,this.headLength=t,this.headWidth=n,this.build()}build(){let e=this.direction,t=this.origin,n=this.out,[r,i]=qe(e),a=this.length-this.headLength,o=this.headWidth/2,s=[t[0]+e[0]*a,t[1]+e[1]*a,t[2]+e[2]*a],c=[t[0]+e[0]*this.length,t[1]+e[1]*this.length,t[2]+e[2]*this.length];n.set(t,0),n.set(s,3);let l=(e,t)=>{let a=2*Math.PI*e/I,c=Math.cos(a)*o,l=Math.sin(a)*o;for(let e=0;e<3;e++)n[t+e]=s[e]+r[e]*c+i[e]*l};for(let e=0;e<I;e++){let t=6+e*12;n.set(c,t),l(e,t+3),l(e,t+6),l(e+1,t+9)}let u=this.cone;if(u){let e=(e,t,n)=>{for(let r=0;r<3;r++)u[e+r]=t[n+r];u[e+3]=1};for(let t=0;t<I;t++){let r=6+t*12,i=t*24;e(i,c,0),e(i+4,n,r+6),e(i+8,n,r+9),e(i+12,s,0),e(i+16,n,r+9),e(i+20,n,r+6)}this.setFill(u,!0)}return this.setPositions(n)}},H=NaN,U=1,W=0,G=(()=>{let e=[],t=t=>{let n=[[-1,-1],[1,-1],[1,1],[-1,1]];for(let r=0;r<4;r++)e.push([...n[r],t,...n[(r+1)%4],t,0])};t(U),t(W);for(let[t,n]of[[-1,-1],[1,-1],[1,1],[-1,1]])e.push([t,n,U,t,n,W,0]),e.push([H,H,H,t,n,U,1]);e.push([0,1.15,U,0,1.75,U,2]),e.push([-.3,1.45,U,0,1.75,U,2]),e.push([.3,1.45,U,0,1.75,U,2]),e.push([0,0,U,0,0,W,3]);for(let t of[U,W])e.push([-.25,0,t,.25,0,t,4]),e.push([0,-.25,t,0,.25,t,4]);return e.push([H,H,H,0,0,U,4]),e})(),rt=class extends v{constructor(e,t={}){let{aspect:n,...r}=t;super({...L(r),mode:`segments`}),this.camera=e,this.seen=new Float32Array(16).fill(NaN),this.inverse=new Float64Array(16),this.out=new Float32Array(G.length*6),this.aspect=n;let i=[Le,Re,ze,Be,Ve].map(R),a=[];for(let e of G)a.push(...i[e[6]],...i[e[6]]);this.setPositions(this.out,a)}update(e){let t=this.camera;t!==e.camera&&t.update(this.aspect??e.canvas.width/Math.max(1,e.canvas.height),!0);let n=t.matrix,r=!1;for(let e=0;e<16;e++)this.seen[e]!==n[e]&&(r=!0);if(!r||!re(n,this.inverse))return!0;this.seen.set(n);let i=this.inverse,a=this.out,o=t.position,s=0,c=(e,t,n)=>{if(Number.isNaN(e))a[s]=o[0],a[s+1]=o[1],a[s+2]=o[2];else{let r=i[3]*e+i[7]*t+i[11]*n+i[15]||1;a[s]=(i[0]*e+i[4]*t+i[8]*n+i[12])/r,a[s+1]=(i[1]*e+i[5]*t+i[9]*n+i[13])/r,a[s+2]=(i[2]*e+i[6]*t+i[10]*n+i[14])/r}s+=3};for(let e of G)c(e[0],e[1],e[2]),c(e[3],e[4],e[5]);return V(a)&&this.setPositions(a),!0}},it=class extends v{constructor(e={}){let{normal:t=[0,1,0],constant:n=0,size:r=1,color:i=P,fillOpacity:a=0,...o}=e;if(super({...L(o),color:i,mode:`segments`}),this.out=new Float32Array(36),!(a>=0&&a<=1))throw RangeError(`Fill opacity must be 0..1`);this.fillOpacity=a,this.square=a?new Float32Array(24):null,this.setPlane(t,n,r)}setPlane(e,t=0,n=1){let r=z(e,`Direction`),i=Math.hypot(r[0],r[1],r[2]);if(!(i>0))throw RangeError(`Direction must be nonzero; pass a plane normal with a length`);if(!Number.isFinite(t)||!(n>0)||!Number.isFinite(n))throw RangeError(`Invalid plane; pass a finite constant and a positive size`);let a=r.map(e=>e/i),o=-t/i,s=a.map(e=>e*o),[c,l]=qe(a),u=n/2,d=(e,t)=>[0,1,2].map(n=>s[n]+(c[n]*e+l[n]*t)*u),f=[d(-1,-1),d(1,-1),d(1,1),d(-1,1)],p=0;for(let[e,t]of[[0,1],[1,2],[2,3],[3,0],[0,2],[1,3]])this.out.set(f[e],p),this.out.set(f[t],p+3),p+=6;let m=this.square;return m&&([0,1,2,0,2,3].forEach((e,t)=>{m.set(f[e],t*4),m[t*4+3]=this.fillOpacity}),this.setFill(m,this.fillOpacity===1)),this.setPositions(this.out)}};function at(e){return e.kind===`core`?{arrays:[e.geometry.vertices],stride:6,normal:3}:{arrays:e.source.primitives.map(e=>e.vertices),stride:20,normal:4}}var ot=class extends v{constructor(e,t={}){e.check();let{size:n=1,color:r=Fe,...i}=t;super({...L(i),color:r,mode:`segments`}),this.mesh=e,this.seenMatrix=new Float32Array(16).fill(NaN),this.seenSource=null,this.seenSize=NaN,this.valid=!1,this.out=new Float32Array(6),this.size=n,this.setPositions(this.out)}update(e){if(!Number.isFinite(this.size))throw RangeError(`VertexNormalsHelper size must be finite; set size to a length in world units`);let t=x(e,this.mesh);if(!t)return!1;let n=Me(ae(this.mesh));if(!n||!V(t))return!1;let r=n.kind===`core`?n.geometry:n.source;if(!c(this.seenMatrix,t)&&r===this.seenSource&&this.size===this.seenSize)return this.valid;this.seenSource=r,this.seenSize=this.size;let i=[t[0],t[1],t[2]],a=[t[4],t[5],t[6]],o=[t[8],t[9],t[10]],s=(e,t)=>[e[1]*t[2]-e[2]*t[1],e[2]*t[0]-e[0]*t[2],e[0]*t[1]-e[1]*t[0]],l=s(a,o),u=s(o,i),d=s(i,a),f=i[0]*l[0]+i[1]*l[1]+i[2]*l[2];if(!f||!Number.isFinite(f))return this.valid=!1;let{arrays:p,stride:m,normal:h}=at(n),g=0;for(let e of p)g+=Math.floor(e.length/m);if(!g)return this.valid=!1;this.out.length!==g*6&&(this.out=new Float32Array(g*6));let _=this.out,v=f<0?-1:1,y=0;for(let e of p)for(let n=0;n+m<=e.length;n+=m){ee(_,y,t,e[n],e[n+1],e[n+2]);let r=e[n+h],i=e[n+h+1],a=e[n+h+2],o=(l[0]*r+u[0]*i+d[0]*a)*v,s=(l[1]*r+u[1]*i+d[1]*a)*v,c=(l[2]*r+u[2]*i+d[2]*a)*v,f=Math.hypot(o,s,c),p=f>0?this.size/f:0;o*=p,s*=p,c*=p,_[y+3]=_[y]+o,_[y+4]=_[y+1]+s,_[y+5]=_[y+2]+c,y+=6}return V(_)?(this.setPositions(_),this.valid=!0):this.valid=!1}},K=e=>Array.isArray(e)&&e.length===3&&e.every(Number.isFinite);function q(e){if(!e||typeof e!=`object`)return null;let t=e;return`sky`in t?`hemisphere`:K(t.position)&&K(t.direction)&&typeof t.width==`number`&&typeof t.height==`number`?`rect`:K(t.position)?K(t.direction)?`spot`:`point`:K(t.direction)?`directional`:null}var J=e=>{let t=Math.hypot(e[0],e[1],e[2])||1;return[e[0]/t,e[1]/t,e[2]/t]},Y=(e,t)=>[e[1]*t[2]-e[2]*t[1],e[2]*t[0]-e[0]*t[2],e[0]*t[1]-e[1]*t[0]];function st(e){let t=J(Y(Math.abs(e[1])<.99?[0,1,0]:[1,0,0],e));return[t,Y(e,t)]}function X(e){let t=e?[e[0],e[1],e[2]].map(e=>Math.max(0,e)):[1,1,1],n=Math.max(...t);return n>0?t.map(e=>e/n):[1,1,1]}var ct=class{constructor(){this.positions=[],this.colors=[],this.color=[1,1,1]}clear(){this.positions.length=this.colors.length=0}line(e,t,n=this.color){this.positions.push(e[0],e[1],e[2],t[0],t[1],t[2]),this.colors.push(n[0],n[1],n[2],n[0],n[1],n[2])}circle(e,t,n,r,i){let a=this.circleData;if(!a){let e=new Float64Array(66);for(let t=0;t<=32;t++){let n=t/32*Math.PI*2;e[t*2]=Math.cos(n),e[t*2+1]=Math.sin(n)}this.circleData=a={trig:e,p:[0,0,0],q:[0,0,0]}}let{trig:o,p:s,q:c}=a;for(let a=0;a<32;a++){for(let i=0;i<3;i++)s[i]=e[i]+(t[i]*o[a*2]+n[i]*o[a*2+1])*r,c[i]=e[i]+(t[i]*o[(a+1)*2]+n[i]*o[(a+1)*2+1])*r;this.line(s,c,i?i((s[1]+c[1])/2-e[1]):this.color)}}};function lt(e,t,n,r){let i=q(t),a=n.size??.25,o=n.position??[0,0,0];if(!i)return;if(e.color=r??X(t.color),i===`hemisphere`){let n=t,i=r??X(b(n.sky)),s=r??X(b(n.ground??n.sky)),c=e=>e>=0?i:s;e.circle(o,[1,0,0],[0,1,0],a,c),e.circle(o,[0,0,1],[0,1,0],a,c),e.circle(o,[1,0,0],[0,0,1],a,()=>s),e.line(o,[o[0],o[1]+a*1.5,o[2]],i);return}if(i===`directional`){let n=J(t.direction),[r,i]=st(n),s=(e,t)=>[0,1,2].map(n=>o[n]+(r[n]*e+i[n]*t)*(a/2)),c=[s(-1,-1),s(1,-1),s(1,1),s(-1,1)];for(let t=0;t<4;t++)e.line(c[t],c[(t+1)%4]);e.line(o,[0,1,2].map(e=>o[e]+n[e]*a*2));return}let s=t.position;if(i===`point`){e.circle(s,[1,0,0],[0,1,0],a),e.circle(s,[0,0,1],[0,1,0],a),e.circle(s,[1,0,0],[0,0,1],a);return}if(i===`rect`){let n=t,r=J(n.direction),i=n.up??(Math.abs(r[1])>.999?[0,0,1]:[0,1,0]),a=J(Y([i[0],i[1],i[2]],r)),o=Y(r,a),c=(e,t)=>[0,1,2].map(r=>s[r]+(a[r]*e*n.width+o[r]*t*n.height)/2),l=[c(-1,-1),c(1,-1),c(1,1),c(-1,1)];for(let t=0;t<4;t++)e.line(l[t],l[(t+1)%4]);e.line(s,[0,1,2].map(e=>s[e]+r[e]*Math.min(n.width,n.height)/2));return}let c=t,l=J(c.direction),[u,d]=st(l),f=Math.min(c.angle??c.outerAngle??Math.PI/4,85*Math.PI/180),p=c.angle===void 0?c.innerAngle??0:c.angle*(1-(c.penumbra??0)),m=c.range&&c.range>0&&Number.isFinite(c.range)?c.range:n.length??1,h=[0,1,2].map(e=>s[e]+l[e]*m),g=m*Math.tan(f);for(let t=0;t<8;t++){let n=t/8*Math.PI*2;e.line(s,[0,1,2].map(e=>h[e]+(u[e]*Math.cos(n)+d[e]*Math.sin(n))*g))}e.circle(h,u,d,g),p>0&&p<f&&e.circle(h,u,d,m*Math.tan(p))}function ut(e,t){e.length=0;for(let n of t){let t=q(n);if(e.push(t?t.length:0),!t)continue;let r=n;for(let t of[`position`,`direction`,`color`,`up`]){let n=r[t];n?e.push(n[0],n[1],n[2]):e.push(NaN)}for(let t of[`range`,`outerAngle`,`innerAngle`,`angle`,`penumbra`,`width`,`height`])e.push(r[t]??NaN);t===`hemisphere`&&e.push(...b(r.sky),...b(r.ground??`#000`),+(r.ground===void 0))}return e.length}var dt=class extends v{constructor(e,t={}){if(typeof e!=`function`)throw TypeError(`LightsHelper takes a function returning the lights to draw; pass () => lights`);let{color:n,size:r,length:i,position:a,...o}=t;if(r!==void 0&&!(r>0)||i!==void 0&&!(i>0))throw RangeError(`Light helper size and length must be above 0`);if(a!==void 0&&!K(a))throw TypeError(`Light helper position needs 3 finite values`);super({cap:`butt`,join:`miter`,...o,mode:`segments`}),this.lights=e,this.options=t,this.segments=new ct,this.seen=[],this.next=[],this.fixed=n===void 0?null:b(n),this.update()}update(){let e=this.lights(),t=this.next;ut(t,e);let n=t.length===this.seen.length;for(let e=0;n&&e<t.length;e++)n=Object.is(t[e],this.seen[e]);if(n)return!0;this.seen.length=0,this.seen.push(...t);let r=this.segments;r.clear();for(let t of e)lt(r,t,this.options,this.fixed);return r.positions.length||r.line([0,0,0],[0,0,0]),this.setPositions(r.positions,r.colors),!0}},Z=class extends dt{constructor(e,t,n){let r=[e];if(super(()=>r,t),this.light=e,q(e)!==n)throw TypeError(`Expected a ${n} light`)}},ft=class extends Z{constructor(e,t={}){super(e,t,`point`)}},pt=class extends Z{constructor(e,t={}){super(e,t,`spot`)}},mt=class extends Z{constructor(e,t={}){super(e,t,`directional`)}},ht=class extends Z{constructor(e,t={}){super(e,t,`hemisphere`)}},gt=class extends Z{constructor(e,t={}){super(e,t,`rect`)}},Q=e=>`joints`in e,$=`SkeletonHelper`,_t=class e extends v{constructor(e,t={}){let n=e?.parents;if(!e||typeof e!=`object`||!Array.isArray(n)||!n.length)throw TypeError(`${$} needs a skeleton with parents; pass an animation Skeleton or {joints, parents}`);let r=n.length;if(n.forEach((e,t)=>{if(!Number.isInteger(e)||e<-1||e>=r||e===t)throw RangeError(`${$} bone ${t} parent ${e} is not another bone; use -1 or an index below ${r}`)}),Q(e)){if(!Array.isArray(e.joints)||e.joints.length!==r)throw TypeError(`${$} needs one joint mesh per parent entry; pass ${r} joints`);for(let t of e.joints)if(!t||typeof t.check!=`function`)throw TypeError(`${$} joints must be Margo Engine meshes; pass model.nodes entries`)}else if(!e.matrices||typeof e.matrices.length!=`number`)throw TypeError(`${$} skeleton needs matrices, 16 numbers per bone; pass an animation Skeleton`);let{color:i=`#ff7a2e`,parentColor:a=`#16b3a3`,mesh:o=null,matrix:s,...c}=t,l=Q(e);super({cap:`butt`,join:`miter`,onTop:!0,fog:!1,...c,mode:`segments`,mesh:l?null:o,matrix:l?void 0:s}),this.pairs=[],this.revisionSeen=NaN,this.valid=!1,this.skeleton=e;for(let e=0;e<r;e++)n[e]>=0&&this.pairs.push(n[e],e);if(l)for(let t of e.joints)t.check();this.seen=new Float64Array(r*3).fill(NaN),this.out=new Float32Array(Math.max(2,this.pairs.length)*3),this.setPositions(this.out),this.setColors(i,a)}static fromGLTF(t,n=0,r){let i=t?.asset?.doc,a=i?.skins?.[n]?.joints;if(!Array.isArray(a)||!Array.isArray(t.nodes))throw TypeError(`${$}.fromGLTF: the model has no skin ${n}; pass a gltf/pbr model and one of its skins`);let o=new Map;return(i.nodes??[]).forEach((e,t)=>e?.children?.forEach(e=>o.set(e,t))),new e({joints:a.map(e=>t.nodes[e]),parents:a.map(e=>a.indexOf(o.get(e)??-1))},r)}setColors(e,t){if(t===void 0)return super.setColors(e);let n=b(e),r=b(t),i=[];for(let e=0;e<this.count;e+=2)i.push(...r,...n);return super.setColors(i)}update(e){let t=this.skeleton,n=t.parents.length,r=this.seen,i=!1,a=(e,t,n,a)=>{(r[e*3]!==t||r[e*3+1]!==n||r[e*3+2]!==a)&&(r[e*3]=t,r[e*3+1]=n,r[e*3+2]=a,i=!0)};if(Q(t))for(let r=0;r<n;r++){let n=x(e,t.joints[r]);if(!n)return!1;a(r,n[12],n[13],n[14])}else{let e=t.revision;if(e!==void 0&&e===this.revisionSeen&&this.valid)return!0;let r=t.matrices;if(r.length<n*16)throw RangeError(`${$} skeleton has ${r.length} matrix numbers for ${n} bones; pass 16 per bone`);for(let e=0;e<n;e++)a(e,r[e*16+12],r[e*16+13],r[e*16+14]);this.revisionSeen=e??NaN}if(!i)return this.valid;let o=this.pairs,s=this.out;for(let e=0;e<o.length;e++)for(let t=0;t<3;t++)s[e*3+t]=r[o[e]*3+t];return s.every(Number.isFinite)?(this.setPositions(s),this.valid=!0):this.valid=!1}};export{nt as ArrowHelper,Ze as AxesHelper,Qe as Box3Helper,tt as BoxHelper,rt as CameraHelper,mt as DirectionalLightHelper,Ye as GridHelper,ht as HemisphereLightHelper,dt as LightsHelper,v as Line,p as LineMaterial,ke as Lines,it as PlaneHelper,ft as PointLightHelper,Xe as PolarGridHelper,gt as RectAreaLightHelper,_t as SkeletonHelper,pt as SpotLightHelper,d as VERTICES_PER_SEGMENT,ot as VertexNormalsHelper,_ as computeLineDistances,f as distinctNeighbours,a as expandLine,$e as geometryBounds,q as lightKind,b as parseColor,m as segmentCount,o as segmentIndices,s as triangleArea};