import{a as e,i as t,n,o as r,s as i,t as a}from"./built-material-D1frGyvL-BK5s3J_z.js";import{t as o}from"./errors-DkwPZuAq.js";import{n as s,o as c}from"./color-CMZXT1qw-BP0tYt0G.js";function l(e,t){if(e.backend===`webgl2`||!e.gpu)throw new o(`unsupported`,`${t} needs WebGPU; see https://margoengine.com/errors#webgpu`)}function u(e){return e?.view?.viewport}function d(e,t){let n=u(t);if(!n)return;e.setViewport(n[0],n[1],n[2],n[3],0,1);let r=t.view.scissor??n;e.setScissorRect(r[0],r[1],r[2],r[3])}var f={},p=()=>new Float32Array([1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]);function m(e,t,n,r,i,a,o,s){(f.hook?.fill??h)(e,t,n,r,i,a,o,s)}function h(e,t,n,r,i,a,o,s){let c=n.matrix;e.set(t,0),e[16]=r,e[17]=i,e[18]=a,e[19]=c[3]||c[7]||c[11]?.5*o/Math.tan(n.fov*Math.PI/360):.5*o*Math.hypot(c[1],c[5],c[9]),e[20]=s}function g(e,t,n,r,i,a){let o=n[3]*r+n[7]*i+n[11]*a+n[15]||1;e[t]=(n[0]*r+n[4]*i+n[8]*a+n[12])/o,e[t+1]=(n[1]*r+n[5]*i+n[9]*a+n[13])/o,e[t+2]=(n[2]*r+n[6]*i+n[10]*a+n[14])/o}function _(e,t){let n=!1;for(let r=0;r<e.length;r++)e[r]!==t[r]&&(e[r]=t[r],n=!0);return n}function v(e,t){for(let n=0;n<e.length;n++){let r=e[n];if(typeof r!=`number`||!Number.isFinite(Math.fround(r)))throw RangeError(`${t} must be finite Float32 values`)}}function y(e,t){if(!Array.isArray(e))throw TypeError(`${t} clippingPlanes must be an array of [a, b, c, d] planes`);if(e.length>6)throw RangeError(`${t} clippingPlanes holds at most 6 planes; pass fewer`);let n=[];for(let r of e){if(!Array.isArray(r)||r.length!==4||!r.every(e=>typeof e==`number`&&Number.isFinite(Math.fround(e))))throw TypeError(`${t} clipping plane must be four finite numbers [a, b, c, d]`);let e=Math.hypot(r[0],r[1],r[2]);if(!e)throw TypeError(`${t} clipping plane needs a non-zero normal [a, b, c]`);n.push(r[0]/e,r[1]/e,r[2]/e,r[3]/e)}return n}var b=[`miter`,`round`,`bevel`],x=[`butt`,`round`,`square`],S=[`segments`,`strip`,`loop`];function ee(e,t){return t<2?0:e===`segments`?t>>1:e===`loop`&&t>=3?t:t-1}function te(e,t,n,r=new Float32Array(t*2),i=4,a=3){if(r.fill(-1,0,t*2),n===`segments`||t<2)return r;let o=(t,n)=>{for(let r=0;r<a;r++)if(e[t*i+r]!==e[n*i+r])return!1;return!0};if(!(n===`loop`&&t>=3)){for(let e=1;e<t;e++)r[e*2]=o(e,e-1)?r[(e-1)*2]:e-1;for(let e=t-2;e>=0;e--)r[e*2+1]=o(e,e+1)?r[(e+1)*2+1]:e+1;return r}let s=-1;for(let e=0;e<t&&s<0;e++)o(e,(e+t-1)%t)||(s=e);if(s<0)return r;for(let e=0;e<t;e++){let n=(s+e)%t,i=(n+t-1)%t;r[n*2]=e>0&&o(n,i)?r[i*2]:i}let c=(s+t-1)%t;for(let e=0;e<t;e++){let n=(c-e+t)%t,i=(n+1)%t;r[n*2+1]=e>0&&o(n,i)?r[i*2+1]:i}return r}function ne(e,t,n,r){let i=[0,0,0],a=[0,0,0],o=(t,n)=>{let i=e[t*4],a=e[t*4+1],o=e[t*4+2];r?g(n,0,r,i,a,o):(n[0]=i,n[1]=a,n[2]=o)},s=0;if(n===`segments`){for(let n=0;n+1<t;n+=2)o(n,i),o(n+1,a),e[n*4+3]=s,s+=Math.hypot(a[0]-i[0],a[1]-i[1],a[2]-i[2]),e[n*4+7]=s;return t%2&&(e[(t-1)*4+3]=s),s}t&&(o(0,i),e[3]=0);for(let n=1;n<t;n++)o(n,a),s+=Math.hypot(a[0]-i[0],a[1]-i[1],a[2]-i[2]),e[n*4+3]=s,i[0]=a[0],i[1]=a[1],i[2]=a[2];return n===`loop`&&t>=3&&(o(0,a),s+=Math.hypot(a[0]-i[0],a[1]-i[1],a[2]-i[2])),s}var re=()=>({colorAttachments:[{view:void 0,loadOp:`load`,storeOp:`store`}],depthStencilAttachment:{view:void 0,depthReadOnly:!0,stencilReadOnly:!0}}),ie=()=>({colorAttachments:[{view:void 0,loadOp:`load`,storeOp:`store`}],depthStencilAttachment:{view:void 0,depthLoadOp:`load`,depthStoreOp:`store`,stencilReadOnly:!0}}),ae=Object.freeze({color:{srcFactor:`src-alpha`,dstFactor:`one-minus-src-alpha`,operation:`add`},alpha:{srcFactor:`one`,dstFactor:`one-minus-src-alpha`,operation:`add`}});function oe(e){if(e!==null&&(typeof e!=`object`||typeof e.check!=`function`))throw TypeError(`Expected a Margo Engine mesh`);return e?.check(),e}var C=[`fade`,`highlight`,`filter`],se=new Float32Array(1),ce=new Uint32Array(se.buffer),w=(e,t)=>Math.round(255*Math.min(1,Math.max(0,t?e<=.0031308?e*12.92:1.055*e**(1/2.4)-.055:e))),T=(e,t)=>{if(!e||typeof e!=`object`)throw TypeError(`A mask style is an object; pass { mode, fade }`);let n={...t,...e};if(!C.includes(n.mode))throw RangeError(`Unknown mask mode; use 'fade', 'highlight' or 'filter'`);for(let e of[n.fade,n.highlightAmount])if(typeof e!=`number`||!(e>=0&&e<=1))throw RangeError(`Mask fade and amount must be in [0, 1]`);if(n.highlight?.length!==3||![...n.highlight].every(e=>e>=0&&e<1/0))throw RangeError(`Mask highlight is a linear [r, g, b] of finite values of 0 or more; pass such an array`);return Object.freeze(n)};function E(e,t){let n=t.highlight;return se[0]=t.fade,e[0]=C.indexOf(t.mode),e[1]=ce[0],e[2]=(w(n[0],1)|w(n[1],1)<<8|w(n[2],1)<<16|w(t.highlightAmount)<<24)>>>0,e[3]=1,e}function D(e,t,n=0){for(let r=0;r<t.length;r++){let i=4+(n+r>>>5),a=1<<(n+r&31),o=t[r];if(typeof o!=`boolean`&&(typeof o!=`number`||o!==o))throw TypeError(`Mask values are booleans or numbers; pass true or a value above 0 to select`);e[i]=(o>0?e[i]|a:e[i]&~a)>>>0}return e}var le=(e,t)=>(e[4+(t>>>5)]>>>(t&31)&1)==1,ue=class{mask=null;maskVersion=0;#e=Object.freeze({mode:`fade`,fade:.12,highlight:Object.freeze([1,.4508,.0194]),highlightAmount:.7});get maskStyle(){return this.#e}setMaskStyle(e){return this.#e=T(e,this.#e),this.mask&&E(this.mask,this.#e),this.maskVersion++,this}updateMask(e,t){if(!this.mask)throw new o(`state`,`There is no selection mask; call setMask first`);if(!Number.isInteger(e)||e<0||e+t.length>this.count)throw RangeError(`Mask values ${e}..${e+t.length} pass the ${this.count} elements; pass fewer`);return D(this.mask,t,e),this.maskVersion++,this}isSelected(e){return!this.mask||le(this.mask,e)}takeMaskStyle(e){return e&&(this.#e=T(e,this.#e)),this.#e}},de=class{constructor(e={}){this.color=new Float32Array([1,1,1]),this.opacity=1,this.width=1,this.worldUnits=!1,this.join=`round`,this.cap=`round`,this.miterLimit=4,this.dashed=!1,this.dashCap=`butt`,this.dashSize=1,this.gapSize=1,this.dashOffset=0,this.colorMode=`multiply`,this.onTop=!1,this.depthWrite=!1,this.behind=!1,this.depthBias=0,this.alphaToCoverage=!1,this.antialias=!0,this.fog=!0,this.clipIntersection=!1,this.clipping=[],this.set(e)}set(e){let{color:t,...n}=e;t!==void 0&&this.setColor(t);for(let[e,t]of Object.entries(n))t!==void 0&&(this[e]=t);return this.validate(),this}setColor(e){return s(e,this.color),this}get clippingPlanes(){let e=[];for(let t=0;t<this.clipping.length;t+=4)e.push(this.clipping.slice(t,t+4));return e}set clippingPlanes(e){this.clipping=y(e,`Line material`)}validate(){if(v(this.color,`Line color`),[this.opacity,this.width,this.miterLimit,this.dashSize,this.gapSize,this.dashOffset].some(e=>typeof e!=`number`||!Number.isFinite(e)))throw RangeError(`Line material values must be finite numbers`);if(this.opacity<0||this.opacity>1)throw RangeError(`Line opacity must be 0..1`);if(!(this.depthBias>=0&&this.depthBias<1))throw RangeError(`Line depthBias must be 0 up to 1`);if(this.width<=0)throw RangeError(`Line width must be positive`);if(this.miterLimit<1)throw RangeError(`Miter limit must be at least 1`);if(this.dashSize<=0||this.gapSize<0)throw RangeError(`Dash size must be positive and gap size non-negative`);if(!b.includes(this.join)||!x.includes(this.cap)||!x.includes(this.dashCap))throw TypeError(`Unknown line join or cap; use the values listed in the line options`);if(![`multiply`,`set`,`add`].includes(this.colorMode))throw TypeError(`Unknown line colorMode; use 'multiply', 'set' or 'add'`);for(let e of[this.worldUnits,this.dashed,this.onTop,this.depthWrite,this.behind,this.alphaToCoverage,this.antialias,this.fog,this.clipIntersection])if(typeof e!=`boolean`)throw TypeError(`Line flags must be boolean`)}},O=class extends ue{get memoryResources(){let e=this.owner?.memoryFor?.(this);return{cpu:[this.points,this.colors,this.mask,this.fill,this.matrix,this.distancesFor,...e?.cpu??[]],gpu:e?.gpu??[]}}constructor(e={}){super(),this.points=new Float32Array,this.colors=null,this.version=0,this.capacityVersion=0,this.totalDistance=0,this.fill=null,this.fillVersion=0,this.fillOpaque=!1,this.pointWidths=!1,this.flatNormal=null,this.pointCount=0,this.mount=null,this.distancesFor=new Float32Array(16).fill(NaN),this.distanceVersion=-1;let{positions:t,colors:n,mode:r=`strip`,material:i,mesh:a=null,matrix:o,visible:s=!0,...c}=e;if(!S.includes(r))throw TypeError(`Unknown line mode; use the values listed in the line options`);if(this.mode=r,this.visible=s,this.material=i??new de,this.material.set(c),this.matrix=p(),o&&this.setMatrix(o),t)this.setPositions(t,n??void 0);else if(n)throw TypeError(`Colors need positions`);this.attach(a)}get count(){return this.pointCount}get segmentCount(){return ee(this.mode,this.pointCount)}get attachedMesh(){return this.mount}setPositions(e,t){if(e.length%3)throw RangeError(`Positions need x, y, z per point`);v(e,`Line positions`);let n=e.length/3;if(n>4e6)throw RangeError(`Too many line points; split the line into several lines`);n*4>this.points.length&&(this.points=new Float32Array(n*4),this.capacityVersion++,this.colors&&this.growColors(n),this.mask&&this.growMask());for(let t=0;t<n;t++)this.points[t*4]=e[t*3],this.points[t*4+1]=e[t*3+1],this.points[t*4+2]=e[t*3+2],this.points[t*4+3]=0;return this.pointCount=n,this.version++,t===void 0?this.colors&&this.colors.length<n*4&&this.growColors(n):this.setColors(t),this}setColors(e){if(e===null)return this.colors&&(this.colors=null,this.capacityVersion++,this.version++),this;let t=this.pointCount,n=e.length===t*4?4:e.length===t*3?3:0;if(!n)throw RangeError(`Colors need r, g, b or r, g, b, a per point`);v(e,`Line colors`),(!this.colors||this.colors.length<t*4)&&this.growColors(t);let r=this.colors;for(let i=0;i<t;i++)r[i*4]=e[i*n],r[i*4+1]=e[i*n+1],r[i*4+2]=e[i*n+2],r[i*4+3]=n===4?e[i*n+3]:1;return this.version++,this}setMask(e,t){if(this.takeMaskStyle(t),e===null)this.mask&&this.capacityVersion++,this.mask=null;else{if(e.length!==this.pointCount)throw RangeError(`A mask needs ${this.pointCount} values, one a point; pass one value per point`);this.mask||(this.growMask(),this.capacityVersion++),D(this.mask,e)}return this.maskVersion++,this}growMask(){let e=this.points.length/4,t=E(new Uint32Array(4+Math.ceil(Math.max(e,1)/32)).fill(-1>>>0),this.maskStyle);this.mask&&t.set(this.mask.subarray(4,Math.min(this.mask.length,t.length)),4),this.mask=t}growColors(e){let t=new Float32Array(Math.max(e*4,this.points.length)).fill(1);this.colors&&t.set(this.colors.subarray(0,Math.min(this.colors.length,t.length))),this.colors=t,this.capacityVersion++}attach(e){return this.mount=oe(e),this}setMatrix(e){if(e.length!==16)throw TypeError(`Matrix needs 16 values`);return v(e,`Line matrix`),this.matrix.set(Array.from(e)),this}update(e,t){}setFill(e,t=!1){this.fill=e,this.fillOpaque=t,this.fillVersion++}resize(e){this.pointCount=e,this.version++}updateDistances(e){(_(this.distancesFor,e)||this.distanceVersion!==this.version||this.distanceMode!==this.mode)&&(this.totalDistance=ne(this.points,this.pointCount,this.mode,e),this.distanceMode=this.mode,this.distanceVersion=this.version,this.version++,this.distanceVersion=this.version)}bind(e){if(e&&this.owner&&this.owner!==e)throw new o(`attached`,`Line already belongs to another Lines plugin; remove it from that plugin first`);this.owner=e}get attached(){return this.owner!==void 0}dispose(){this.owner?.remove(this)}[Symbol.dispose??Symbol()](){this.dispose()}},fe=(e,t)=>`
struct MargoFog {color:vec4f,params:vec4f,eye:vec4f}
@group(${e}) @binding(${t}) var<uniform> margoFog:MargoFog;
fn fogAmount(p:vec3f)->f32 {
  let d=distance(p,margoFog.eye.xyz);let q=margoFog.params;
  let amount=select(clamp((d-q.x)/max(q.y-q.x,1e-6),0.0,1.0),1.0-exp(-q.z*q.z*d*d),q.z>0.0);
  return amount*exp(-q.w*max(p.y-margoFog.color.w,0.0));
}
`,k=(e,t,n,r)=>{let i=e===void 0?t:e;if(typeof i!=`number`||!Number.isFinite(i)||i<r)throw RangeError(`Fog ${n} is ${String(i)}; pass a finite number${r===0?`, 0 or more`:``}`);return i};function pe(e){if(e!==null&&(typeof e!=`object`||Array.isArray(e)))throw TypeError(`Fog must be an object with Fog fields; pass an environment Fog, such an object or null`);return e&&A(e,[0,0,0],new Float32Array(12)),e}function A(e,t,n,r=!1){let i=e.enabled??!0;if(typeof i!=`boolean`)throw TypeError(`Fog enabled is ${String(i)}; pass true or false`);let a=k(e.height,0,`height`,-1/0),o=k(e.near,1,`near`,0),l=k(e.far,1e3,`far`,0),u=k(e.density,0,`density`,0),d=k(e.heightFalloff,0,`heightFalloff`,0);if(s(e.color??`#ffffff`,n,0),r)for(let e=0;e<3;e++)n[e]=c(n[e]);n[3]=a,n[4]=o,n[5]=l,n[6]=u,n[7]=d,i||(n.fill(0,0,8),n[4]=n[5]=34028234663852886e22),n[8]=t[0],n[9]=t[1],n[10]=t[2],n[11]=0}var j=`
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
`,me=(e,t)=>t?e.replace(`let alpha=i.color.a*cover;`,`if(cover${t===1?`<`:`>=`}0.5){discard;}let alpha=i.color.a*cover;`):e,he=e=>e.replace(`if((style.flags.z&32u)!=0u){
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
`,ge=e=>e.replace(`let rawA=halfWidth(ca);let rawB=halfWidth(cb);`,`let rawA=halfWidth(ca)*mix(points[ia].w,points[ib].w,ta);let rawB=halfWidth(cb)*mix(points[ia].w,points[ib].w,tb);`),_e=e=>e.replace(`o.clip=vec4f(base.xy+cr.off/(0.5*frame.viewport.xy)*base.w,base.z,base.w);`,`o.clip=vec4f(base.xy+cr.off/(0.5*frame.viewport.xy)*base.w,min(base.z*(1.0+style.b.w),base.w),base.w);`).replace(`o.clip=placed;`,`o.clip=vec4f(placed.xy,min(placed.z*(1.0+style.b.w),placed.w),placed.w);`),ve=(e,t=!1)=>e+`
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
`,ye=`cover*=select(select(0.0,1.0,inside>=0.0),clamp(inside/fw+0.5,0.0,1.0),aa);`,M=(e,t)=>e.replace(ye,t===`square`?`let past=inside/fw+i.edge.y;cover*=select(select(0.0,1.0,past>=0.0),clamp(past+0.5,0.0,1.0),aa);`:`let past=max(-inside/fw,0.0);let sd=sqrt(past*past+i.edge.x*i.edge.x)-i.edge.y;cover=min(cover,select(select(0.0,1.0,sd<=0.0),clamp(0.5-sd,0.0,1.0),aa));`),be=[[`var rgb=max(i.color.rgb,vec3f(0.0));`,`var rgb=max(i.color.rgb,vec3f(0.0));rgb=mix(rgb,margoFog.color.rgb,fogAmount(i.world));`]];function xe(){let e=j;for(let[t,n]of be){if(!e.includes(t))throw new o(`unsupported`,`Line fog needs the line shader it was written for; update the fog edits with it`);e=e.replace(t,n)}return e+fe(2,0)}var Se=(e,n=`1.0.0`,r=import.meta.url)=>t(e,n,r);function Ce(e,t){for(let n=t;n>=0;n=e.parents?.[n]??-1)if(e.hidden[n])return!0;return!1}function we(t,n){let r=Se(t),i=e(n),a=i.id;return r.disposed||r.meshes.get(a)!==n||Ce(r.store,a)?null:i.matrix??r.store.matrices.subarray(a*16,a*16+16)}var N=224,P=1,F=2,I=4,L=8,R=16,z=32,B=64,V=128,H=256,U=512,W=1024,G=2048,Te={binding:7,visibility:1,buffer:{type:`read-only-storage`,minBindingSize:16}},Ee=e=>e.fillOpaque&&e.material.opacity===1&&!e.material.behind,De=7,Oe=class e{coreRequirement=i(`1.0.0`,import.meta.url);memoryFor(e){let t=this.resources.get(e);return t?{cpu:[t.floats,t.uints,t.written],gpu:[t.uniform,t.points,t.colors,...t.mask?[t.mask]:[],...t.fill?[t.fill.buffer]:[]]}:{cpu:[],gpu:[]}}static attach(t,n){r(t,i(`1.0.0`,import.meta.url));let a=new e(n);return t.use(a),a}constructor(e={}){if(this.stats={lines:0,segments:0,drawCalls:0},this.members=new Set,this.resources=new Map,this.watchers=new Set,this.pipelines=new Map,this.modules=new Map,this.extendedLayouts=new Map,this.elapsed=0,this.frameData=new Float32Array(24),this.frameBits=new Uint32Array(this.frameData.buffer),this.frameWritten=new Uint32Array(24),this.frameValid=!1,this.drawLists=[[],[],[],[]],this.fillLists=[[],[]],this.descriptor=re(),this.writeDescriptor=ie(),this.fogSource=null,this.fogData=new Float32Array(12),this.execute=e=>{let t=this.stats;if(t.lines=t.segments=t.drawCalls=0,e.backend!==`webgpu`||!this.device||!this.engine||e.device!==this.device)return;f.hook?.lines(this);let n=this.engine,r=this.device,i=this.drawLists;this.collect(n,0);for(let e of i)for(let[n]of e)t.lines++,t.segments+=n.segmentCount;if(!t.lines)return;let a=n.canvas,o=this.frameData,s=e.camera;m(o,s.matrix,s,e.width,e.height,a.clientWidth?e.width/a.clientWidth:1,e.height,e.format.endsWith(`-srgb`)||e.format.includes(`float`)?0:1);let c=!this.frameValid;for(let e=0;!c&&e<this.frameBits.length;e++)c=this.frameBits[e]!==this.frameWritten[e];c&&(r.queue.writeBuffer(this.frameBuffer,0,o),this.frameWritten.set(this.frameBits),this.frameValid=!0);let l=this.fogSource,u=!1;if(l)for(let e of i)for(let[t]of e)u||=t.material.fog;u&&(A(l,s.position,this.fogData),r.queue.writeBuffer(this.fogResources().buffer,0,this.fogData));let p=this.fillLists,h=i[0].length||i[2].length||p.some(e=>e.some(([e])=>Ee(e)))?this.writeDescriptor:this.descriptor;h.colorAttachments[0].view=e.color,h.depthStencilAttachment.view=e.depth;let g=e.encoder.beginRenderPass(h);d(g,e),g.setBindGroup(0,this.frameGroup),u&&g.setBindGroup(2,this.fogGpu.group);for(let t=0;t<4;t+=2){let n=t?P:0;this.drawFills(g,e,p[t/2],u,n),this.drawList(g,e,i[t],u,n|2052),this.drawList(g,e,i[t],u,n|2*G),this.drawList(g,e,i[t+1],u,n)}g.end();for(let e of i)e.length=0},this.name=e.name??`lines`,this.order=e.order??20,!this.name||typeof this.name!=`string`||!Number.isFinite(this.order))throw TypeError(`Invalid Lines options; pass the documented option types`)}get lines(){return this.members}get fog(){return this.fogSource}setFog(e){return this.fogSource=pe(e),this}add(e){if(!(e instanceof O))throw TypeError(`Expected a Line`);e.bind(this),this.members.add(e);for(let t of this.watchers)t.added(e);return e}remove(e){if(this.members.delete(e)){for(let t of this.watchers)t.removed(e);this.release(e),e.bind(void 0)}}clear(){for(let e of[...this.members])this.remove(e)}get time(){return this.elapsed}resetTime(){this.elapsed=0;for(let e of this.members)e.resetTime?.()}advanceTime(e){if(e>0){this.elapsed+=e;for(let t of this.members)t.visible&&t.advanceTime?.(e)}}onPreUpdate(e){this.advanceTime(e)}setup(e){l(e,`Lines`),this.engine=e;let t=this.device=e.gpu,n=(e,t)=>({binding:0,visibility:t,buffer:{type:`uniform`,minBindingSize:e}}),r=t.createBindGroupLayout({entries:[n(96,GPUShaderStage.VERTEX|GPUShaderStage.FRAGMENT)]}),i=t.createBindGroupLayout({entries:[n(N,GPUShaderStage.VERTEX|GPUShaderStage.FRAGMENT),{binding:1,visibility:GPUShaderStage.VERTEX,buffer:{type:`read-only-storage`,minBindingSize:16}},{binding:2,visibility:GPUShaderStage.VERTEX,buffer:{type:`read-only-storage`,minBindingSize:16}},Te]});this.noMask=t.createBuffer({size:16,usage:GPUBufferUsage.STORAGE}),this.layouts={frame:r,style:i,pipeline:t.createPipelineLayout({bindGroupLayouts:[r,i]})},this.module(0),this.frameBuffer=t.createBuffer({size:96,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST}),this.frameValid=!1,this.frameGroup=t.createBindGroup({layout:r,entries:[{binding:0,resource:{buffer:this.frameBuffer}}]})}registerPasses(e){e.add({name:`${this.name}:draw`,order:this.order,execute:this.execute})}module(e,t){let n=`${e&-86}|${t?.key??``}`,r=this.modules.get(n);if(!r){let i=e&F?xe():j;e&W&&(i=ve(i)),e&L&&(i=ge(i)),e&z&&(i=_e(i)),e&V&&(i=M(i,`round`)),e&H&&(i=M(i,`square`)),e&U&&(i=he(i)),i=me(i,Math.floor(e/G)),t&&(i=t.shader(i)),f.hook&&(i=f.hook.shader(i)),r=this.device.createShaderModule({code:i}),this.modules.set(n,r)}return r}pipeline(e,t,n,r,i){let a=`${e}|${t}|${n}|${r}|${i?.key??``}`,o=this.pipelines.get(a);if(!o){let s=(r&F)!==0,c=(r&B)!==0,l=s?this.fogResources():void 0,u=this.module(r,i);o=this.device.createRenderPipeline({layout:i?this.device.createPipelineLayout({bindGroupLayouts:[this.layouts.frame,this.styleLayout(i),...l?[l.layout]:[]]}):l?.pipeline??this.layouts.pipeline,vertex:{module:u,entryPoint:r&U?`fillVertex`:r&W?`ribbonVertex`:`vertex`},fragment:{module:u,entryPoint:`fragment`,targets:[c?{format:e,writeMask:De}:{format:e,blend:ae}]},primitive:{topology:`triangle-list`,cullMode:`none`},multisample:c?{count:n,alphaToCoverageEnabled:!0}:{count:n},depthStencil:{format:t,depthWriteEnabled:(r&I)!==0,depthCompare:r&P?`always`:r&R?`less`:`greater-equal`}}),this.pipelines.set(a,o)}return o}fogResources(){if(this.fogGpu)return this.fogGpu;let e=this.device,t=this.layouts,n=e.createBindGroupLayout({entries:[{binding:0,visibility:GPUShaderStage.FRAGMENT,buffer:{type:`uniform`,minBindingSize:48}}]}),r=e.createBuffer({size:48,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});return this.fogGpu={layout:n,buffer:r,pipeline:e.createPipelineLayout({bindGroupLayouts:[t.frame,t.style,n]}),group:e.createBindGroup({layout:n,entries:[{binding:0,resource:{buffer:r}}]})}}ensure(e){let t=this.device,n=e.colors,r=this.resources.get(e);if(r&&r.capacity===e.capacityVersion)return r;r&&this.release(e);let i=[],a;try{let o=(e,n)=>{let r=t.createBuffer({size:e,usage:n});return i.push(r),r},s=o(N,GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST),c=e.points.length/4,l=Math.ceil(c/2)*4,u=o(Math.max(16,e.points.byteLength+l*4),GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST),d=o(Math.max(16,n?.byteLength??16),GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST),f=e.mask?o(e.mask.byteLength,GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST):null;a=e.extension?.create(t);let p=t.createBindGroup({layout:this.styleLayout(e.extension),entries:[{binding:0,resource:{buffer:s}},{binding:1,resource:{buffer:u}},{binding:2,resource:{buffer:d}},{binding:7,resource:{buffer:f??this.noMask}},...a?.entries??[]]}),m=new ArrayBuffer(N);r={extra:a,uniform:s,points:u,colors:d,mask:f,maskVersion:-1,group:p,capacity:e.capacityVersion,version:-1,style:m,floats:new Float32Array(m),uints:new Uint32Array(m),written:new Float32Array(N/4).fill(NaN),near:new Float32Array(l),nearMode:``}}catch(e){a?.dispose();for(let e of i)e.destroy();throw e}return this.resources.set(e,r),r}styleLayout(e){if(!e)return this.layouts.style;let t=this.extendedLayouts.get(e.key);return t||(t=this.device.createBindGroupLayout({entries:[{binding:0,visibility:3,buffer:{type:`uniform`,minBindingSize:N}},{binding:1,visibility:1,buffer:{type:`read-only-storage`,minBindingSize:16}},{binding:2,visibility:1,buffer:{type:`read-only-storage`,minBindingSize:16}},Te,...e.entries]}),this.extendedLayouts.set(e.key,t)),t}release(e){let t=this.resources.get(e);t&&(t.extra?.dispose(),t.uniform.destroy(),t.points.destroy(),t.colors.destroy(),t.mask?.destroy(),t.fill?.buffer.destroy(),this.resources.delete(e))}uploadFill(e,t,n){let r=this.device;if(t.fill?.bytes!==n.byteLength){t.fill?.buffer.destroy();let e=r.createBuffer({size:n.byteLength,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST});t.fill={buffer:e,group:r.createBindGroup({layout:this.layouts.style,entries:[{binding:0,resource:{buffer:t.uniform}},{binding:1,resource:{buffer:e}},{binding:2,resource:{buffer:t.colors}},{binding:7,resource:{buffer:t.mask??this.noMask}}]}),bytes:n.byteLength,version:-1}}t.fill.version!==e.fillVersion&&(r.queue.writeBuffer(t.fill.buffer,0,n),t.fill.version=e.fillVersion)}collect(e,t){let n=this.device,r=this.drawLists;for(let e of r)e.length=0;for(let e of this.fillLists)e.length=0;for(let i of this.members){if(!i.visible||i.update(e,t)===!1)continue;let a=i.attachedMesh,o=a?we(e,a):i.matrix;if(!o)continue;let s=i.segmentCount,c=i.material;if(!s)continue;c.validate(),(c.dashed||i.extension)&&i.updateDistances(o);let l=this.ensure(i);if(l.extra?.update(),l.version!==i.version&&(n.queue.writeBuffer(l.points,0,i.points,0,i.count*4),l.nearMode=``,i.colors&&n.queue.writeBuffer(l.colors,0,i.colors,0,i.count*4),l.version=i.version),i.mode!==`segments`&&l.nearMode!==i.mode){let e=i.count,t=te(i.points,e,i.mode,l.near);n.queue.writeBuffer(l.points,e*16,t,0,Math.ceil(e/2)*4),l.nearMode=i.mode}l.mask&&i.mask&&l.maskVersion!==i.maskVersion&&(n.queue.writeBuffer(l.mask,0,i.mask),l.maskVersion=i.maskVersion);let u=l.floats,d=l.uints;u.set(o,0),u.set(c.color,16),u[19]=c.opacity,u[20]=c.width,u[21]=c.miterLimit,i.flatNormal?u.set(i.flatNormal,22):(u[22]=c.dashSize,u[23]=c.gapSize,u[24]=c.dashOffset),u[25]=i.totalDistance,u[26]=+!!c.antialias,u[27]=c.depthBias;let f=(c.vertexColors??!0)&&i.colors!==null;d[28]=S.indexOf(i.mode),d[29]=i.count,d[30]=b.indexOf(c.join)|x.indexOf(c.cap)<<2|(c.worldUnits?16:0)|(c.dashed&&!i.flatNormal?32:0)|(f?64:0)|(f&&c.colorMode===`set`?128:0)|(f&&c.colorMode===`add`?256:0);let p=c.clipping;d[31]=p.length/4+(c.clipIntersection?65536:0),u.set(p,32),u.fill(0,32+p.length);let m=!1;for(let e=0;e<u.length;e++)if(!Object.is(l.written[e],u[e])){m=!0;break}m&&(n.queue.writeBuffer(l.uniform,0,l.style),l.written.set(u)),r[(c.onTop?2:0)+(c.depthWrite&&!c.behind?0:1)].push([i,l]);let h=i.fill;h?.length&&(this.uploadFill(i,l,h),this.fillLists[+!!c.onTop].push([i,l]))}}drawFills(e,t,n,r,i){let a=t.descriptor.depthStencil.format,o=t.descriptor.multisample?.count??1;for(let[s,c]of n){let{fog:n,behind:l}=s.material,u=(Ee(s)?I:0)|(l?R:0)|(r&&n?F:0);e.setPipeline(this.pipeline(t.format,a,o,U|i|u)),e.setBindGroup(1,c.fill.group),e.draw(s.fill.length/4),this.stats.drawCalls++}}drawList(e,t,n,r,i){let a=t.descriptor.depthStencil.format,o=t.descriptor.multisample?.count??1,s=i>=2*G,c;for(let[l,u]of n){let{fog:n,antialias:d,dashed:f,dashCap:p,behind:m,depthBias:h,alphaToCoverage:g}=l.material,_=g&&o>1;if(s&&(!d||_))continue;let v=(l.pointWidths&&!f?L:0)|(l.flatNormal?W:0)|(m?R:0)|(h?z:0)|(_?B:0)|(f&&p===`round`?V:0)|(f&&p===`square`?H:0)|(r&&n?F:0),y=this.pipeline(t.format,a,o,(_?i%G:i)|v,l.extension);y!==c&&e.setPipeline(c=y),e.setBindGroup(1,u.group),e.draw(this.vertexCount(l),l.segmentCount),this.stats.drawCalls++}}vertexCount(e){return e.mode===`segments`&&e.material.cap!==`round`&&!e.extension?6:78}onDeviceRestored(e){this.releaseGpu(),this.setup(e)}releaseGpu(){for(let e of[...this.resources.keys()])this.release(e);this.extendedLayouts.clear(),this.frameBuffer?.destroy(),this.noMask?.destroy(),this.fogGpu?.buffer.destroy(),this.frameBuffer=this.frameGroup=this.layouts=this.device=this.fogGpu=this.noMask=void 0,this.pipelines.clear(),this.modules.clear()}dispose(){this.engine?.sceneOf?.(this)?.removePlugin(this.name),this.releaseGpu(),this.engine=void 0}[Symbol.dispose??Symbol()](){this.dispose()}},K=Symbol.for(`margoengine.mesh-sources.v1`),ke=globalThis[K]??new WeakMap;globalThis[K]||Object.defineProperty(globalThis,K,{value:ke});var q=Symbol.for(`margoengine.geometry-surfaces.v1`),Ae=globalThis[q]??new WeakMap;globalThis[q]||Object.defineProperty(globalThis,q,{value:Ae});var J=NaN,Y=1,X=0;(()=>{let e=[],t=t=>{let n=[[-1,-1],[1,-1],[1,1],[-1,1]];for(let r=0;r<4;r++)e.push([...n[r],t,...n[(r+1)%4],t,0])};t(Y),t(X);for(let[t,n]of[[-1,-1],[1,-1],[1,1],[-1,1]])e.push([t,n,Y,t,n,X,0]),e.push([J,J,J,t,n,Y,1]);e.push([0,1.15,Y,0,1.75,Y,2]),e.push([-.3,1.45,Y,0,1.75,Y,2]),e.push([.3,1.45,Y,0,1.75,Y,2]),e.push([0,0,Y,0,0,X,3]);for(let t of[Y,X])e.push([-.25,0,t,.25,0,t,4]),e.push([0,-.25,t,0,.25,t,4]);return e.push([J,J,J,0,0,Y,4]),e})();var Z=(e,t)=>e.reduce((e,n,r)=>e+n*t[r],0),Q=(e,t,n)=>e.map((e,r)=>e+n*t[r]),je=e=>e.map((e,t,n)=>e/Math.hypot(...n)),$=(e,t,n)=>{let r=Z(e,t),i=1-n*n*(1-r*r);return i<0?null:je(e.map((e,a)=>n*e-(n*r+Math.sqrt(i))*t[a]))};function Me(e,t,n,r){let i=[Q(t,n,-.009),t],a=$(n,[0,1,0],1/r),o=Q(t,a,2e-6);for(let t=0;t<8;t++){let t=1/0,n;for(let[r,i,s,c]of e){let e=[r,i,s],l=Z(e,a);if(l<=1e-5)continue;let u=(c-Z(e,o))/l;u>1e-6&&u<t&&(n=e,t=u)}if(!n)break;let s=Q(o,a,t);i.push(s);let c=$(a,n.map(e=>-e),r);if(c){i.push(Q(s,c,.009));break}a=Q(a,n,-2*Z(a,n)),o=Q(s,a,2e-6)}return i}function Ne(e,t){let r=Oe.attach(e),i=new n({color:`#95c5e1`,transparent:!0,opacity:.23,depthWrite:!1,roughness:.23,doubleSided:!0}),o=a(e,t.gemShape,i);o.root.name=`Transparent facet diagram`,o.root.setParent(t.bearing).setPosition([0,t.stoneHeight,0]),o.root.visible=!1;let s=t.stoneHeight+t.bearing.position.y,c=[[2.407,`#ff7d75`],[2.425,`#8af9bc`],[2.453,`#84bfff`]].map(([e,t])=>({ior:e,line:r.add(new O({positions:[0,0,0,0,.001,0],color:t,width:1.8,opacity:.92,onTop:!0}))}));return{update(e,n){o.root.visible=n,t.gem.root.visible=!n;let r=je([-.64*Math.sin(e),-.77,-.64*Math.cos(e)]),i=[46e-5,t.stoneTable,33e-5];for(let{ior:e,line:a}of c)a.visible=n,n&&a.setPositions(Me(t.facets,i,r,e).flatMap(([e,t,n])=>[e,t+s,n]))}}}export{Ne as showOptics};