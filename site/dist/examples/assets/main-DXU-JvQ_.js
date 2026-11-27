import{t as e}from"./orbit-D3GoP_Pd.js";import{n as t,s as n,t as r,w as i}from"./dist-DCciemw3.js";import{n as a,t as o}from"./version-DZ3BcJze.js";import{r as s}from"./color-CMZXT1qw-Zyib9BIW.js";import{t as c}from"./errors-DkwPZuAq.js";import{t as l}from"./mesh-vG0D9LIZ.js";var u={shadows:{resolution:1024,filter:`pcf`},ssao:{samples:16},ssr:{enabled:!1,steps:32},volumetric:{grid:[80,45,32]},localShadows:{resolution:256},vfx:{capacity:1e5}},d={high:{},light:u,phone:{...u,shadows:{...u.shadows,cascades:2},ssao:{enabled:!1},volumetric:{enabled:!1},scatter:{lodFade:0}}},f=`margoQualityLowered`,p=`margoQuality`,m=`held`,h=`timestamp-query`;function g(e){let t=e.requestDevice;function n(e={}){return t.call(this,this.features.has(h)?{...e,requiredFeatures:new Set([...e.requiredFeatures??[],h])}:e)}return e.requestDevice=n,()=>{e.requestDevice===n&&(e.requestDevice=t)}}var _,v,y=()=>{try{return globalThis.localStorage}catch{return}},b=()=>{try{return globalThis.sessionStorage}catch{return}};function x({search:e=globalThis.location?.search,page:t=globalThis.location?.pathname,storage:n=y(),session:r=b(),userAgent:i=globalThis.navigator?.userAgent??``}={}){let a=new URLSearchParams(e),o=a.get(`quality`)??void 0,s=t?`${p}:${t}`:p,c,l=!1;try{c=n?.getItem(s)??void 0}catch{}try{l=!!r?.getItem(f)}catch{}let u=o===`high`||o===`low`?o:void 0,h=u??c,x=l&&!u&&c===`high`,S=/Mobi|Android|iPhone/.test(i)?`phone`:h===`high`&&!x?`high`:`light`;S===`high`?delete globalThis.margoLow:globalThis.margoLow=S===`phone`?1:Math.min(2,Math.max(1,Number(a.get(`scale`))||1)),globalThis.margoPreset=d[S];let C=u??(x?`power`:void 0);return _={tier:S,stored:h,forced:C,storage:n,key:s},v?.(),v=S===`light`&&!C&&c!==m&&typeof GPUAdapter<`u`?g(GPUAdapter.prototype):void 0,S}function S(e,t=60){let n=1e3/t+1,r=new Float64Array(16).fill(1/0),i=new Float64Array(16),a=-1/0,o=-1/0,s=0,c=0;e.pace=e=>{let t=e-o;o=e,t<n*4&&(r[s++%16]=t),i.set(r),i.sort();let l=i[Math.min(s,16)-1>>1];return++c<Math.floor(n/l)&&e-a<n?!1:(a=e,c=0,!0)}}function C(e){(_??(x(),_)).tier===`light`&&S(e)}var w=new WeakMap,T=class e{coreRequirement=a(`0.1.0`,import.meta.url);constructor(){this.name=`shader:clock`,this.seconds=0,this.step=0,this.hosts=new Set}static attach(t){return o(t,a(`0.1.0`,import.meta.url)),e.hold(t,e)}static hold(t,n){let r=w.get(t);return r||t.use(r=new e),r.hosts.add(n),r}static release(e,t){let n=e&&w.get(e);n?.hosts.delete(t)&&!n.hosts.size&&n.dispose()}static find(t){let n=t&&w.get(t);return t&&!n&&queueMicrotask(()=>t.disposed||e.attach(t)),n}get time(){return this.seconds}get delta(){return this.step}resetTime(){this.seconds=this.step=0}advanceTime(e){this.step=e,this.seconds+=e}onPreUpdate(e){this.advanceTime(e)}setup(e){if(w.has(e))throw TypeError(`The engine has a ShaderClock: use ShaderClock.attach(engine)`);w.set(this.engine=e,this)}dispose(){let e=this.engine;e&&w.get(e)===this&&(w.delete(e),e.sceneOf(this)?.removePlugin(this.name))}[Symbol.dispose](){this.dispose()}},E=(e,t)=>Object.assign(Error(t),{name:`MargoError`,code:e}),ee=(e,t)=>`${e}; see https://margoengine.com/errors#${t}`,te=(e,t,n=e)=>E(e,ee(t,n));function ne(e){return e?.view?.viewport}function re(e,t){let n=ne(t);if(!n)return;e.setViewport(n[0],n[1],n[2],n[3],0,1);let r=t.view.scissor??n;e.setScissorRect(r[0],r[1],r[2],r[3])}var ie=`fn pbrNeutral(input:vec3f)->vec3f {let x=min(input.r,min(input.g,input.b));let offset=select(0.04,x-6.25*x*x,x<0.08);var v=input-offset;let peak=max(v.r,max(v.g,v.b));if(peak<0.76){return v;}let newPeak=1.0-0.24*0.24/(peak+0.24-0.76);v*=newPeak/peak;return mix(v,vec3f(newPeak),1.0-1.0/(0.15*(peak-newPeak)+1.0));}
`;`${ie}`;function ae(e,t){let n=t.position,r=t.up??[0,1,0],i=n[0]-t.target[0],a=n[1]-t.target[1],o=n[2]-t.target[2],s=Math.abs(i),c=Math.abs(a),l=Math.abs(o),u=s>c?s:c,d=u>l?u:l,f;if(s===1/0||c===1/0||l===1/0)f=1/0;else if(s!==s||c!==c||l!==l)f=s+c+l;else if(d===0)f=0;else{let e=s/d*(s/d),t=c/d*(c/d),n=e+t-e-t,r=l/d*(l/d)-n;f=Math.sqrt(e+t+r)*d}i/=f,a/=f,o/=f;let p=r[1]*o-r[2]*a,m=r[2]*i-r[0]*o,h=r[0]*a-r[1]*i,g=Math.abs(p),_=Math.abs(m),v=Math.abs(h),y=g>_?g:_,b=y>v?y:v,x;if(g===1/0||_===1/0||v===1/0)x=1/0;else if(g!==g||_!==_||v!==v)x=g+_+v;else if(b===0)x=0;else{let e=g/b*(g/b),t=_/b*(_/b),n=e+t-e-t,r=v/b*(v/b)-n;x=Math.sqrt(e+t+r)*b}if(!f||!x)throw RangeError(`Invalid camera view; pass distinct eye and target and another up vector`);p/=x,m/=x,h/=x;let S=a*h-o*m,C=o*p-i*h,w=i*m-a*p;return e[0]=p,e[1]=S,e[2]=i,e[3]=0,e[4]=m,e[5]=C,e[6]=a,e[7]=0,e[8]=h,e[9]=w,e[10]=o,e[11]=0,e[12]=-p*n[0]-m*n[1]-h*n[2],e[13]=-S*n[0]-C*n[1]-w*n[2],e[14]=-i*n[0]-a*n[1]-o*n[2],e[15]=1,e}function oe(e,t,n){return e.value=t,e.device=typeof t==`function`?void 0:n,e.made=void 0,e.told=!1,e}var se=(e,t,n,r)=>oe({name:t,setter:n},e,r);function ce(e,t,n){let{value:r}=e;if(typeof r==`function`)return e.device!==t&&(e.made=r(e.device=t)),e.made;if(r!=null){if(e.device??=t,e.device===t)return r;e.told||(e.told=!0,n?.onError(te(`state`,`${e.name} lost with the device; pass a function or call ${e.setter}`,`borrowed-lost`)))}}function le(e){if(!e||typeof e!=`object`)return!1;let t=Object.getPrototypeOf(e);return t===null||Object.getPrototypeOf(t)===null}var ue=Object.freeze({color:{srcFactor:`src-alpha`,dstFactor:`one-minus-src-alpha`,operation:`add`},alpha:{srcFactor:`one`,dstFactor:`one-minus-src-alpha`,operation:`add`}}),de=/^(f32|i32|u32|vec[234][fiu])$/,D=e=>e===`mat3x3f`?9:e===`mat4x4f`?16:+(/^vec(\d)/.exec(e)?.[1]??1),fe=e=>e===`i32`||e.endsWith(`i`)?`i`:e===`u32`||e.endsWith(`u`)?`u`:`f`,O=e=>e.startsWith(`mat`)?16:[4,8,16,16][D(e)-1],pe=e=>e===`mat3x3f`?48:D(e)*4,me=e=>{let t=D(e);return`${{f:`float`,i:`sint`,u:`uint`}[fe(e)]}32${t>1?`x`+t:``}`},he=/^(alias|array|atomic|bitcast|bool|break|case|const|const_assert|continue|continuing|default|diagnostic|discard|else|enable|f16|f32|false|fn|for|i32|if|let|loop|mat\d\w*|override|ptr|requires|return|sampler\w*|struct|switch|texture\w*|true|u32|var|vec\d\w*|while|module|target|type|self|this|camera|mesh|uniforms|Attributes|Uniforms|margo\w*|Margo\w*)$/;function k(e,t){if(!/^[A-Za-z]\w*$/.test(e)||he.test(e))throw TypeError(`${t} name ${JSON.stringify(e)} is not a usable WGSL identifier; use letters, digits and _, not a WGSL keyword or a prelude name (camera, mesh, uniforms, margo*)`);return e}var ge=(e,t,n)=>{for(let r of e.matchAll(RegExp(`@${t}\\s+fn\\s+([A-Za-z_]\\w*)`,`g`)))if(r[1]!==n)return r[1]},A=e=>de.test(e)||e===`mat3x3f`||e===`mat4x4f`,j=(e,t)=>Math.ceil(e/t)*t,_e=`${ie.replace(`pbrNeutral`,`margoNeutral`)}fn margoSRGB(x:vec3f)->vec3f {return select(x*12.92,1.055*pow(x,vec3f(1.0/2.4))-0.055,x>=vec3f(0.0031308));}
fn margoDisplay(c:vec4f)->vec4f {if(camera.encoding==0.0){return c;}let x=margoNeutral(max(c.rgb,vec3f(0)));if(camera.encoding==2.0){return vec4f(x,c.a);}return vec4f(margoSRGB(x),c.a);}
fn margoEncode(c:vec4f)->vec4f {if(camera.encoding!=1.0){return c;}return vec4f(margoSRGB(max(c.rgb,vec3f(0))),c.a);}
struct MargoCamera { view:mat4x4f, projection:mat4x4f, viewProjection:mat4x4f, position:vec3f, time:f32, resolution:vec2f, deltaTime:f32, encoding:f32, viewport:vec4f }
struct MargoMesh { world:mat4x4f, normal:mat3x3f, pickId:u32 }
@group(0) @binding(0) var<uniform> camera:MargoCamera;
@group(0) @binding(1) var<uniform> mesh:MargoMesh;
struct MargoGBuffer { @location(0) normal:vec4f, @location(1) ambient:vec4f }
fn margoGBuffer(normal:vec3f,position:vec3f,ambient:vec3f)->MargoGBuffer {return MargoGBuffer(vec4f(normalize((camera.view*vec4f(normal,0)).xyz),-(camera.view*vec4f(position,1)).z),vec4f(ambient,1));}`,ve=`struct MargoBefore { viewProjection:mat4x4f, world:mat4x4f, time:f32, valid:f32 }
@group(0) @binding(2) var<uniform> margoBefore:MargoBefore;
struct MargoVelocity { @builtin(position) @invariant clip:vec4f, @location(0) previous:vec4f }
fn margoVelocity(position:vec3f,before:vec3f)->MargoVelocity {return MargoVelocity(camera.viewProjection*mesh.world*vec4f(position,1),margoBefore.viewProjection*margoBefore.world*vec4f(before,1));}
`,ye=`
struct MargoMotion { @location(0) velocity:vec2f, @location(1) depth:f32 }
@fragment fn margoVelocityFragment(i:MargoVelocity)->MargoMotion {var o:MargoMotion;o.velocity=vec2f(0);o.depth=-1;
  if(i.previous.w>0&&margoBefore.valid>0){o.velocity=i.clip.xy/camera.resolution-(i.previous.xy/i.previous.w*vec2f(0.5,-0.5)+0.5);o.depth=i.previous.z/i.previous.w;}return o;}
`,be=`@fragment fn margoPick()->@location(0) u32 {return mesh.pickId;}
`,xe=128,Se=new WeakMap,Ce=new WeakMap,we=new WeakMap,Te=new WeakMap,Ee=new WeakMap,De=new WeakMap,Oe=new WeakMap,ke=new WeakMap,M=()=>GPUShaderStage.VERTEX|GPUShaderStage.FRAGMENT;function N(e,t=!1){let n=t?Ce:Se,r=n.get(e);return r||(r=e.createBindGroupLayout({label:t?`shader:raw:velocity`:`shader:raw:frame`,entries:(t?[0,1,2]:[0,1]).map(e=>({binding:e,visibility:M(),buffer:{type:`uniform`}}))}),n.set(e,r)),r}function P(e,t={}){let n=we.get(e);n||we.set(e,n=new Map);let r={magFilter:`linear`,minFilter:`linear`,...t},i=JSON.stringify(r),a=n.get(i);return a||n.set(i,a=e.createSampler(r)),a}function F(e,t){let n=ke.get(e);n||ke.set(e,n=new Map);let r=t.dimension??`2d`,i=t.sampleType??`float`,a=r+i,o=n.get(a);if(!o){let t=r===`cube`?6:1,s=i===`sint`||i===`uint`,c=i===`depth`,l=e.createTexture({label:`shader:raw:white`,size:[1,1,t],dimension:r===`3d`?`3d`:`2d`,format:c?`depth32float`:s?i===`sint`?`rgba8sint`:`rgba8uint`:`rgba8unorm`,usage:GPUTextureUsage.TEXTURE_BINDING|(c?GPUTextureUsage.RENDER_ATTACHMENT:GPUTextureUsage.COPY_DST)});if(c){let n=e.createCommandEncoder();for(let e=0;e<t;e++)n.beginRenderPass({colorAttachments:[],depthStencilAttachment:{view:l.createView({dimension:`2d`,baseArrayLayer:e,arrayLayerCount:1}),depthClearValue:1,depthLoadOp:`clear`,depthStoreOp:`store`}}).end();e.queue.submit([n.finish()])}else s||e.queue.writeTexture({texture:l},new Uint8Array(4*t).fill(255),{bytesPerRow:4,rowsPerImage:1},[1,1,t]);n.set(a,o=l.createView({dimension:r}))}return o}function Ae(e,t,n){if(typeof t.buffer==`function`)return t.buffer(e);let r=De.get(t.buffer);r||De.set(t.buffer,r=se(t.buffer,`RawShaderMaterial storage buffer`,`assign a new buffer`,e));let i=ce(r,e,n);if(i)return i;let a=Oe.get(e);return a||Oe.set(e,a=e.createBuffer({label:`shader:raw:storage-stand-in`,size:256,usage:GPUBufferUsage.STORAGE})),a}function je(e,t,n){let r=t.sampleType??`float`,i=r===`float`,a=n=>r===`depth`?P(e,{compare:`less-equal`,...t.sampler}):i?t.sampler||!n?P(e,t.sampler):n:P(e,{...t.sampler,magFilter:`nearest`,minFilter:`nearest`,mipmapFilter:`nearest`}),o=t.texture;if(o&&typeof o!=`function`&&typeof o.bind==`function`){let n=o.bind(e,!0);return n?[n[0],a(n[1])]:[F(e,t),a()]}if(!o)return[F(e,t),a()];let s=Ee.get(o);if(s||Ee.set(o,s=se(o,`RawShaderMaterial texture`,`assign a new texture`,e)),o=ce(s,e,n)??null,!o)return[F(e,t),a()];let c=o;if(typeof o.createView==`function`){let e=o,n=t.dimension??`2d`,r=Te.get(e);r||Te.set(e,r=new Map),c=r.get(n)??e.createView({dimension:n}),r.set(n,c)}return[c,a()]}var Me={normal:ue,additive:{color:{srcFactor:`src-alpha`,dstFactor:`one`,operation:`add`},alpha:{srcFactor:`one`,dstFactor:`one`,operation:`add`}},subtractive:{color:{srcFactor:`src-alpha`,dstFactor:`one`,operation:`reverse-subtract`},alpha:{srcFactor:`zero`,dstFactor:`one`,operation:`add`}},multiply:{color:{srcFactor:`zero`,dstFactor:`src`,operation:`add`},alpha:{srcFactor:`zero`,dstFactor:`src-alpha`,operation:`add`}},premultiplied:{color:{srcFactor:`one`,dstFactor:`one-minus-src-alpha`,operation:`add`},alpha:{srcFactor:`one`,dstFactor:`one-minus-src-alpha`,operation:`add`}}},Ne=0,I=class{constructor(e){if(this.gpu=new Map,this.revision=0,this.compiled=0,this.vertexCode=``,this.vertexName=``,this.fragmentName=``,!e||typeof e!=`object`)throw TypeError(`RawShaderMaterial needs {vertexShader, ...}`);if(this.name=e.name??`raw:`+Ne++,this.entries={vertex:e.vertexEntry,fragment:e.fragmentEntry},this.transparent=e.transparent??!1,this.blending=e.blending??`normal`,this.depthTest=e.depthTest??!0,this.depthCompare=e.depthCompare??`greater-equal`,this.depthBias=e.depthBias??0,this.depthBiasSlopeScale=e.depthBiasSlopeScale??0,this.alphaToCoverage=e.alphaToCoverage??!1,this.depthWrite=e.depthWrite??!0,this.cull=e.cull??`back`,this.colorWrite=e.colorWrite??!0,this.wireframe=e.wireframe??!1,this.gbufferName=e.gbufferEntry,this.velocityName=e.velocityEntry,this.groups=e.groups??[],this.groups.length>2||this.groups.some(e=>typeof e!=`function`))throw TypeError(`RawShaderMaterial groups must be at most two functions of the device, for @group(2) and @group(3)`);this.setCode(e.vertexShader,e.fragmentShader);let t=[],n=0,r={};this.uniforms=r;for(let[i,a]of Object.entries(e.uniforms??{})){if(k(i,`RawShaderMaterial uniform`),!a||typeof a!=`object`||!(`value`in a))throw TypeError(`RawShaderMaterial uniform ${i} must be {value, type?}`);let{count:e}=a;if(e!==void 0&&(!Number.isInteger(e)||e<1))throw RangeError(`RawShaderMaterial uniform ${i} count must be a positive integer`);if(a.struct){let o=[],s=0;for(let[e,t]of Object.entries(a.struct)){if(k(e,`RawShaderMaterial uniform ${i} field`),!A(t))throw TypeError(`RawShaderMaterial uniform ${i} field ${e} needs a type from 'f32' to 'vec4f', their i32/u32 variants, 'mat3x3f' or 'mat4x4f'`);let n=j(s,O(t));o.push({name:e,type:t,offset:n}),s=n+pe(t)}if(!o.length)throw TypeError(`RawShaderMaterial uniform ${i} struct needs at least one field`);let c=j(s,16),l=j(n,16);t.push({name:i,type:`Raw_`+i,offset:l,count:e,stride:c,fields:o}),n=l+c*(e??1),r[i]=a;continue}if(e!==void 0){let o=a.type;if(!o||!A(o))throw TypeError(`RawShaderMaterial uniform ${i} is an array, so it needs type ('f32' to 'vec4f', i32/u32 variants, 'mat3x3f' or 'mat4x4f')`);let s=j(pe(o),O(o));if(s%16)throw TypeError(`RawShaderMaterial uniform ${i}: elements of a uniform array sit 16 bytes apart, so ${o} does not fit; use vec3, vec4, a matrix or a struct, or put it in a storage buffer`);let c=j(n,16);t.push({name:i,type:o,offset:c,count:e,stride:s}),n=c+s*e,r[i]=a;continue}let o=a.value,s=typeof o==`number`?1:typeof o==`string`?3:o?.length,c=a.type??{1:`f32`,2:`vec2f`,3:`vec3f`,4:`vec4f`,9:`mat3x3f`,16:`mat4x4f`}[s];if(!c||!A(c))throw TypeError(`RawShaderMaterial uniform ${i} has no WGSL type; give type ('f32' to 'vec4f', i32/u32 variants, 'mat3x3f' or 'mat4x4f')`);let l=Math.ceil(n/O(c))*O(c);t.push({name:i,type:c,offset:l}),n=l+pe(c),r[i]=a.type?a:Object.assign(a,{type:c})}this.members=t,this.size=t.length?Math.ceil(n/16)*16:0,this.bytes=new Uint8Array(this.size),this.data=new DataView(this.bytes.buffer),this.textures={};for(let[t,n]of Object.entries(e.textures??{})){k(t,`RawShaderMaterial texture`);let e=le(n)&&`texture`in n?n:{texture:n};if(e.dimension!==void 0&&![`2d`,`2d-array`,`cube`,`3d`].includes(e.dimension))throw TypeError(`RawShaderMaterial texture ${t} dimension must be 2d, 2d-array, cube or 3d`);if(e.dimension&&e.dimension!==`2d`&&typeof e.texture?.bind==`function`)throw TypeError(`RawShaderMaterial texture ${t}: a materials Texture is 2d; pass a GPUTexture for ${e.dimension}`);if(e.sampleType!==void 0&&![`float`,`unfilterable-float`,`sint`,`uint`,`depth`].includes(e.sampleType))throw TypeError(`RawShaderMaterial texture ${t} sampleType must be float, unfilterable-float, sint, uint or depth`);if(e.sampleType===`depth`&&e.dimension===`3d`)throw TypeError(`RawShaderMaterial texture ${t}: depth textures are 2d, 2d-array or cube; use one of those dimensions`);this.textures[t]=e}this.storage={};for(let[t,n]of Object.entries(e.storage??{})){if(k(t,`RawShaderMaterial storage`),!n||typeof n!=`object`||!n.buffer||typeof n.type!=`string`||!n.type)throw TypeError(`RawShaderMaterial storage ${t} must be {buffer, type, access?} or a storage() node`);if(n.access!==void 0&&n.access!==`read`&&n.access!==`read_write`)throw TypeError(`RawShaderMaterial storage ${t} access must be read or read_write`);this.storage[t]=n}}get vertexShader(){return this.vertexCode}set vertexShader(e){this.setCode(e,this.fragmentCode)}get fragmentShader(){return this.fragmentCode}set fragmentShader(e){this.setCode(this.vertexCode,e)}setCode(e,t){if(typeof e!=`string`||!e.trim())throw TypeError(`RawShaderMaterial vertexShader must be WGSL source with a @vertex fn`);if(t!==void 0&&typeof t!=`string`)throw TypeError(`RawShaderMaterial fragmentShader must be WGSL source or undefined`);let n=this.entries.vertex??ge(e,`vertex`),r=this.entries.fragment??ge(t??e,`fragment`,this.gbufferName);if(!n)throw TypeError(`RawShaderMaterial ${this.name} has no @vertex fn; add one or pass vertexEntry`);if(!r)throw TypeError(`RawShaderMaterial ${this.name} has no @fragment fn; add one to fragmentShader (or vertexShader) or pass fragmentEntry`);if(this.gbufferName&&!RegExp(`@fragment\\s+fn\\s+${this.gbufferName}\\b`).test(t??e))throw TypeError(`RawShaderMaterial ${this.name} has no @fragment fn ${this.gbufferName}; add it beside the colour fragment or drop gbufferEntry`);if(this.velocityName&&!RegExp(`@vertex\\s+fn\\s+${this.velocityName}\\b`).test(e))throw TypeError(`RawShaderMaterial ${this.name} has no @vertex fn ${this.velocityName}; add it to vertexShader or drop velocityEntry`);this.vertexCode=e,this.fragmentCode=t,this.vertexName=n,this.fragmentName=r,this.error=void 0,this.revision++;for(let e of this.gpu.values())e.modules.clear(),e.pipelines.clear()}prelude(e){let t=[_e],n=e?.layout??[];n.length&&t.push(`struct Attributes {\n${n.map((e,t)=>`  @location(${t}) ${e.name}:${e.type},`).join(`
`)}\n}`);for(let e of this.members)e.fields&&t.push(`struct ${e.type} {\n${e.fields.map((e,t)=>`  ${t?``:`@align(16) `}${e.name}:${e.type},`).join(`
`)}\n}`);this.velocityName&&t.push(ve),this.members.length&&t.push(`struct Uniforms {\n${this.members.map(e=>`  ${e.name}:${e.count===void 0?e.type:`array<${e.type},${e.count}>`},`).join(`
`)}\n}\n@group(1) @binding(0) var<uniform> uniforms:Uniforms;`),Object.entries(this.textures).forEach(([e,n],r)=>{let i={float:`f32`,"unfilterable-float":`f32`,sint:`i32`,uint:`u32`,depth:``}[n.sampleType??`float`],a=(n.dimension??`2d`).replace(`-`,`_`);t.push(`@group(1) @binding(${1+2*r}) var ${e}:texture_${i?a+`<`+i+`>`:`depth_`+a};\n@group(1) @binding(${2+2*r}) var ${e}Sampler:sampler${i?``:`_comparison`};`)});let r=1+2*Object.keys(this.textures).length;return Object.entries(this.storage).forEach(([e,n],i)=>t.push(`@group(1) @binding(${r+i}) var<storage,${n.access??`read`}> ${e}:array<${n.type}>;`)),t.join(`
`)+`
`}code(e,t){return this.prelude(t)+(e===`fragment`?this.fragmentCode??this.vertexCode:this.vertexCode)}dispose(){for(let e of this.gpu.values())e.buffer?.destroy();this.gpu.clear()}[Symbol.dispose??Symbol()](){this.dispose()}state(){let e=this.blending;return`${this.transparent}|${typeof e==`string`?e:JSON.stringify(e)}|${this.depthTest}|${this.depthCompare}|${this.depthBias}|${this.depthBiasSlopeScale}|${this.alphaToCoverage}|${this.depthWrite}|${this.cull}|${this.colorWrite}|${this.revision}`}blend(){let e=this.blending;if(typeof e!=`string`)return e;if(!(e in Me)&&e!==`none`)throw TypeError(`RawShaderMaterial ${this.name} blending must be none, normal, additive, subtractive, multiply, premultiplied or a GPUBlendState`);return e===`normal`&&!this.transparent?void 0:Me[e]}prepare(e,t,n){n&&(this.drawnBy=n);let r=this.gpu.get(e);if(!r){let t=Object.values(this.textures),n=[];this.size&&n.push({binding:0,visibility:M(),buffer:{type:`uniform`}}),t.forEach((e,t)=>{let r=e.sampleType??`float`;n.push({binding:1+2*t,visibility:M(),texture:{sampleType:r,viewDimension:e.dimension??`2d`}},{binding:2+2*t,visibility:M(),sampler:{type:r===`float`?`filtering`:r===`depth`?`comparison`:`non-filtering`}})}),Object.values(this.storage).forEach((e,r)=>{let i=(e.access??`read`)===`read`;n.push({binding:1+2*t.length+r,visibility:i?M():GPUShaderStage.FRAGMENT,buffer:{type:i?`read-only-storage`:`storage`}})});let i=this.groups.map(t=>t(e)),a=n.length||i.length?e.createBindGroupLayout({label:`shader:raw:`+this.name,entries:n}):void 0,o=a?[a,...i.map(e=>e.layout)]:[];r={layout:a,groupLayouts:o,pipelineLayout:e.createPipelineLayout({bindGroupLayouts:[N(e),...o]}),bound:[],extras:i.map(e=>e.group),modules:new Map,pipelines:new Map},this.gpu.set(e,r)}if(r.pass===t)return r;if(r.pass=t,this.size){for(let e of this.members)this.write(e);r.buffer||(r.buffer=e.createBuffer({label:`shader:raw:uniforms`,size:this.size,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST})),(!r.written||r.written.some((e,t)=>e!==this.bytes[t]))&&(e.queue.writeBuffer(r.buffer,0,this.bytes),(r.written??=new Uint8Array(this.size)).set(this.bytes))}if(r.layout){let t=this.size?[r.buffer]:[],i=Object.values(this.textures),a=n?.engine;for(let n of i)t.push(...je(e,n,a));let o=Object.values(this.storage);for(let n of o)t.push(Ae(e,n,a));if(!r.group||t.some((e,t)=>e!==r.bound[t])){r.bound=t;let n=[],a=0;this.size&&n.push({binding:0,resource:{buffer:t[a++]}});for(let e=0;e<i.length;e++)n.push({binding:1+2*e,resource:t[a++]},{binding:2+2*e,resource:t[a++]});for(let e=0;e<o.length;e++)n.push({binding:1+2*i.length+e,resource:{buffer:t[a++]}});r.group=e.createBindGroup({layout:r.layout,entries:n})}}return r}write(e){let t=this.uniforms[e.name]?.value;if(e.count===void 0&&!e.fields)return this.put(e.type,e.offset,t,e.name);let n=D(e.type),r=t,i=e.count!==void 0&&!e.fields&&typeof r?.[0]==`number`,a=e.count??1;if((e.count===void 0?1:i?r.length/n:r?.length)!==a)throw RangeError(`RawShaderMaterial ${this.name} uniform ${e.name} needs ${a} element${a>1?`s`:``}; assign a matching value`);for(let o=0;o<a;o++){let a=e.count===void 0?t:i?Array.prototype.slice.call(r,o*n,(o+1)*n):r[o],s=e.offset+o*e.stride,c=e.count===void 0?e.name:`${e.name}[${o}]`;if(!e.fields)this.put(e.type,s,a,c);else for(let t of e.fields)this.put(t.type,s+t.offset,a?.[t.name],`${c}.${t.name}`)}}put(e,t,n,r){let i=D(e),a=typeof n==`number`&&i===1?[n]:(typeof n==`string`||typeof n==`number`)&&e===`vec3f`?Array.from(s(n)):typeof n==`object`&&n?Array.from(n):[];if(a.length!==i||a.some(e=>!Number.isFinite(e)))throw RangeError(`RawShaderMaterial ${this.name} uniform ${r} needs ${i} finite number${i>1?`s`:``} for ${e}; assign a matching value`);let o=fe(e),c=e===`mat3x3f`?3:0;a.forEach((e,n)=>{let r=t+(c?Math.floor(n/3)*16+n%3*4:n*4);o===`f`?this.data.setFloat32(r,e,!0):o===`i`?this.data.setInt32(r,e,!0):this.data.setUint32(r,e,!0)})}get writesGBuffer(){return!!this.gbufferName}target(e,t,n){let r=t?.descriptor.depthStencil?.format;if(e===`shadow`)return{entry:/\bdiscard\b/.test(this.fragmentCode??this.vertexCode)?this.fragmentName:void 0,targets:[],depthStencil:{format:`depth32float`,depthWriteEnabled:!0,depthCompare:`less-equal`}};if(e===`pick`)return{entry:`margoPick`,targets:[{format:`r32uint`}],depthStencil:{format:`depth32float`,depthWriteEnabled:!0,depthCompare:this.depthTest?this.depthCompare:`always`,...this.bias()}};if(e===`velocity`)return{entry:`margoVelocityFragment`,targets:[{format:`rg16float`},{format:`r32float`}],depthStencil:{format:r,depthWriteEnabled:!1,depthCompare:`equal`}};if(e===`gbuffer`)return{entry:this.gbufferName,targets:[{format:`rgba16float`},{format:`rgba16float`}],depthStencil:{format:r,depthWriteEnabled:!1,depthCompare:n}};let i=this.blend();return{entry:this.fragmentName,targets:[{format:t.format,...i?{blend:i}:{},writeMask:this.colorWrite?15:0}],depthStencil:r&&{format:r,depthWriteEnabled:this.depthWrite,depthCompare:this.depthTest?this.depthCompare:`always`,...this.bias()}}}bias(){return this.depthBias||this.depthBiasSlopeScale?{depthBias:this.depthBias,depthBiasSlopeScale:this.depthBiasSlopeScale}:{}}pipeline(e,t,n,r,i,a,o=`equal`){let s=r.drawTopology,l=s.endsWith(`strip`)&&r.indexFormat,u=a?.descriptor.multisample?.count??1,d=a?.descriptor.depthStencil?.format,f=`${i}|${r.layoutKey}|${s}|${l||``}|${a?.format}|${u}|${d}|${o}|${this.state()}`,p=t.pipelines.get(f);if(p)return p.pipeline;p={state:`pending`},t.pipelines.set(f,p);let m=e=>{let i=e+`|`+r.layoutKey,a=t.modules.get(i);if(!a){let o=e===`pick`?this.prelude(r)+be:e===`velocity`?this.code(`vertex`,r)+ye:this.code(e,r);a=n.createShaderModule({label:`shader:raw:${this.name}:${e}`,code:o}),t.modules.set(i,a),Pe.set(a,a.getCompilationInfo?.().catch(()=>void 0)??Promise.resolve(void 0))}return a};n.pushErrorScope?.(`validation`);let{entry:h,targets:g,depthStencil:_}=this.target(i,a,o),v=i===`velocity`,y=m(v?`velocity`:`vertex`),b=i===`pick`?m(`pick`):v||this.fragmentCode===void 0?y:m(`fragment`),x=n.popErrorScope?.(),S={label:`shader:raw:`+this.name,layout:v?t.velocityLayout??=n.createPipelineLayout({bindGroupLayouts:[N(n,!0),...t.groupLayouts]}):t.pipelineLayout,vertex:{module:y,entryPoint:v?this.velocityName:this.vertexName,buffers:r.buffers()},...h?{fragment:{module:b,entryPoint:h,targets:g}}:{},primitive:{topology:s,cullMode:i===`shadow`||v?`none`:this.cull,...l?{stripIndexFormat:l}:{}},..._&&{depthStencil:s.startsWith(`triangle`)?_:{..._,depthBias:0,depthBiasSlopeScale:0}},multisample:{count:u,...i===`color`&&u>1&&this.alphaToCoverage?{alphaToCoverageEnabled:!0}:{}}},C=p;if(typeof n.createRenderPipelineAsync!=`function`||a&&!d)return C.pipeline=n.createRenderPipeline(S),C.state=`ready`,this.compiled++,C.pipeline;let w=this.prelude(r).split(`
`).length-1,T=this.revision,E=async e=>{if(C.state=`failed`,T!==this.revision)return;let t=e?.message??String(e);for(let[e,n]of[[`vertex`,y],[`fragment`,b]]){let r=(await Pe.get(n))?.messages.find(e=>e.type===`error`);if(r){let n=r.lineNum-w;t=`${e}Shader ${n>0?`line ${n}:${r.linePos}`:`prelude line ${r.lineNum}`}: ${r.message}`;break}}let n=new c(`failed`,`RawShaderMaterial ${this.name} did not compile (${t}); fix the WGSL and assign vertexShader/fragmentShader again`);this.error=n,this.onError?this.onError(n):console.error(n)},ee=Promise.all([x,n.createRenderPipelineAsync(S)]).then(([e,t])=>{if(e)return E(e);C.pipeline=t,C.state=`ready`,this.compiled++}).catch(E);e.track(ee)}},Pe=new WeakMap,L=new WeakMap;function Fe(e,t,n,r){let i=e.createBuffer({label:n,size:r.byteLength,usage:t});return e.queue.writeBuffer(i,0,r),i}function Ie(e,t,n,r){let i=L.get(e);i||L.set(e,i=new Map);let a=2166136261;for(let e=0;e<r.length;e++)a=Math.imul(a^r[e],16777619);let o=`${t}:${r.length}:${a}`,s=i.get(o);s||i.set(o,s=[]);for(let e of s){let t=e.words,n=0;for(;n<r.length&&t[n]===r[n];)n++;if(n===r.length)return e.users++,e}let c={buffer:Fe(e,t,n,r),users:1,usage:t,label:n,key:o,words:r.slice()};return s.push(c),c}function Le(e,t){if(t.key===void 0)return;let n=L.get(e),r=n.get(t.key);r.splice(r.indexOf(t),1),r.length||n.delete(t.key),t.key=t.words=void 0}function R(e,t){!t||--t.users||(Le(e,t),t.buffer.destroy())}function Re(e,t,n){if(t.users===1)return Le(e,t),t.fresh=!1,t;t.users--;let{usage:r,label:i}=t;return{buffer:Fe(e,r,i,n),users:1,usage:r,label:i,fresh:!0}}var ze=class{constructor(e){this.step=e,this.attributes=[],this.stride=0,this.count=0,this.capacity=0,this.words=new Uint32Array,this.floats=new Float32Array,this.ints=new Int32Array,this.start=1/0,this.end=0,this.full=!0}rebuild(){let e=0;for(let t of this.attributes)t.offset=e,e+=t.size;this.stride=e*4,this.count=this.attributes.length?Math.min(...this.attributes.map(e=>e.count)):0,this.capacity=this.attributes.length?Math.max(...this.attributes.map(e=>e.count)):0;let t=new ArrayBuffer(Math.max(4,this.capacity*this.stride));this.words=new Uint32Array(t),this.floats=new Float32Array(t),this.ints=new Int32Array(t);for(let e of this.attributes)this.pack(e,0,e.count);this.full=!0}pack(e,t,n){let r=e.data instanceof Float32Array?this.floats:e.data instanceof Int32Array?this.ints:this.words,i=this.stride/4;for(let a=t;a<n;a++)for(let t=0;t<e.size;t++)r[a*i+e.offset+t]=e.data[a*e.size+t];this.start=Math.min(this.start,t),this.end=Math.max(this.end,n)}upload(e,t){if(!this.attributes.length){R(e,t);return}let n=Math.max(4,this.capacity*this.stride);return!t||this.full||t.buffer.size<n?(R(e,t),t=Ie(e,GPUBufferUsage.VERTEX|GPUBufferUsage.COPY_DST,`shader:raw:`+this.step,this.words)):this.end>this.start&&(t=Re(e,t,this.words),t.fresh||e.queue.writeBuffer(t.buffer,this.start*this.stride,this.words.buffer,this.start*this.stride,(this.end-this.start)*this.stride)),this.full=!1,this.start=1/0,this.end=0,t}},Be=[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1],z=class{constructor(e){if(this.drawRange={start:0,count:1/0},this.streams={vertex:new ze(`vertex`),instance:new ze(`instance`)},this.map=new Map,this.indices=null,this.indexDirty=!0,this.key=``,this.disposed=!1,this.changes=0,this.world=new Float32Array(16),this.object=new Float32Array(28),!(e?.material instanceof I))throw TypeError(`RawMesh needs {material: new RawShaderMaterial(...)}`);if(this.material=e.material,this.matrix=Float32Array.from(e.matrix??Be),this.matrix.length!==16)throw RangeError(`RawMesh matrix needs 16 numbers (column-major)`);this.mesh=e.mesh??null,this.visible=e.visible??!0,this.renderOrder=e.renderOrder??0,this.instanceCount=e.instanceCount,this.vertexCount=e.vertexCount,this.topology=e.topology??`triangle-list`,this.frustumCulled=e.frustumCulled??!0,this.bounds=e.bounds??null;for(let[t,n]of Object.entries(e.attributes??{}))this.define(t,n);this.restructure(),e.index&&this.setIndex(e.index)}get drawTopology(){return this.material.wireframe&&this.topology.startsWith(`triangle`)?`line-list`:this.topology}edges(e){let t=this.indices,n=this.wire;if(n&&n[0]===t&&n[1]===e&&n[2]===this.topology&&!this.indexDirty)return n[3];let r=t?t.length:e,i=e=>t?t[e]:e,a=t instanceof Uint16Array?65535:4294967295,o=this.topology===`triangle-strip`,s=new Set,c=[],l=(e,t)=>{let n=e<t?`${e},${t}`:`${t},${e}`;e!==t&&!s.has(n)&&(s.add(n),c.push(e,t))};for(let e=0;e+2<r;e+=o?1:3){let t=i(e),n=i(e+1),r=i(e+2);(!o||t!==a&&n!==a&&r!==a)&&(l(t,n),l(n,r),l(r,t))}let u=Uint32Array.from(c);return this.wire=[t,e,this.topology,u],u}get layout(){return[...this.map.values()]}get layoutKey(){return this.key}get indexFormat(){return this.indices?this.indices instanceof Uint16Array?`uint16`:`uint32`:void 0}getAttribute(e){let t=this.map.get(e);return t&&{data:t.data,type:t.type,step:t.step}}setAttribute(e,t,n){this.alive(),this.changed();let r=this.map.get(e);if(Ve(t)){if(!r||r.type!==t.type||r.step!==(t.step??`vertex`))return r&&this.streams[r.step].attributes.splice(this.streams[r.step].attributes.indexOf(r),1),this.define(e,t),this.restructure(),this;t=t.data}if(!r)throw TypeError(`RawMesh has no attribute ${e}; pass {data, type, step?} to add one`);let i=He(t,r.type,e),a=i.length/r.size,o=this.streams[r.step];if(n){let[t,s]=n;if(!Number.isInteger(t)||!Number.isInteger(s)||t<0||s<0||t+s>a||a!==r.count)throw RangeError(`RawMesh ${e} range [${t}, ${s}] must lie inside ${r.count} elements, with data of the same length`);return r.data=i,o.pack(r,t,t+s),this}return r.data=i,a===r.count?o.pack(r,0,a):(r.count=a,o.rebuild()),this}removeAttribute(e){let t=this.map.get(e);return t&&(this.map.delete(e),this.streams[t.step].attributes.splice(this.streams[t.step].attributes.indexOf(t),1),this.restructure(),this.changed()),this}setIndex(e){if(this.alive(),this.changes++,e===null)this.indices=null;else if(e instanceof Uint16Array||e instanceof Uint32Array)this.indices=e;else{let t=Array.from(e);if(t.some(e=>!Number.isInteger(e)||e<0||e>4294967295))throw RangeError(`RawMesh indices must be integers from 0 to 2^32 - 1`);this.indices=Uint32Array.from(t)}return this.indexDirty=!0,this}get shadowVersion(){return this.changes+this.material.compiled}invalidateShadow(){this.changes++}drawShadow(e){this.owner?.shadow(this,e)}dispose(){this.release(),this.owner?.remove(this),this.disposed=!0}[Symbol.dispose??Symbol()](){this.dispose()}alive(){if(this.disposed)throw new c(`disposed`,`RawMesh is disposed; create a new RawMesh`)}changed(){this.changes++,this.sphere=void 0}ownBounds(){let e=this.map.get(`position`);if(!e||e.type!==`vec3f`||e.step!==`vertex`||!e.count||this.streams.instance.attributes.length||(this.instanceCount??1)>1)return null;let t=[1/0,1/0,1/0],n=[-1/0,-1/0,-1/0],r=e.data;for(let e=0;e<r.length;e+=3)for(let i=0;i<3;i++)t[i]=Math.min(t[i],r[e+i]),n[i]=Math.max(n[i],r[e+i]);let i=t.map((e,t)=>(e+n[t])/2),a=0;for(let e=0;e<r.length;e+=3)a=Math.max(a,Math.hypot(r[e]-i[0],r[e+1]-i[1],r[e+2]-i[2]));return[i[0],i[1],i[2],a]}culled(e,t){if(!this.frustumCulled)return!1;let n=this.bounds;!n&&this.sphere===void 0&&(this.sphere=this.ownBounds());let r=n?[...n.center,n.radius]:this.sphere;if(!r)return!1;let i=e[0]*r[0]+e[4]*r[1]+e[8]*r[2]+e[12],a=e[1]*r[0]+e[5]*r[1]+e[9]*r[2]+e[13],o=e[2]*r[0]+e[6]*r[1]+e[10]*r[2]+e[14],s=r[3]*Math.max(Math.hypot(e[0],e[1],e[2]),Math.hypot(e[4],e[5],e[6]),Math.hypot(e[8],e[9],e[10]));for(let e=0;e<6;e++){let n=e>>1,r=e%2==0?1:-1,c=e===4,l=c?t[2]:t[3]+r*t[n],u=c?t[6]:t[7]+r*t[4+n],d=c?t[10]:t[11]+r*t[8+n],f=c?t[14]:t[15]+r*t[12+n];if(l*i+u*a+d*o+f<-s*Math.hypot(l,u,d))return!0}return!1}define(e,t){if(k(e,`RawMesh attribute`),!Ve(t)||!de.test(t.type))throw TypeError(`RawMesh attribute ${e} needs {data, type} with type f32, vec2f-vec4f or their i32/u32 variants`);let n=t.step??`vertex`;if(n!==`vertex`&&n!==`instance`)throw TypeError(`RawMesh attribute ${e} step must be vertex or instance`);if(!this.map.has(e)&&this.map.size>=16)throw RangeError(`RawMesh supports at most 16 attributes (the WebGPU vertex attribute limit); remove an attribute or pack them together.`);let r=He(t.data,t.type,e),i=D(t.type),a={name:e,type:t.type,step:n,size:i,data:r,count:r.length/i,offset:0};this.map.set(e,a),this.streams[n].attributes.push(a)}restructure(){for(let e of Object.values(this.streams))e.attributes=[...this.map.values()].filter(t=>t.step===e.step);this.streams.vertex.rebuild(),this.streams.instance.rebuild(),this.sphere=void 0,this.key=[...this.map.values()].map(e=>`${e.name}:${e.type}:${e.step[0]}`).join(`,`)}buffers(){let e=[...this.map.values()];return Object.values(this.streams).filter(e=>e.attributes.length).map(t=>({arrayStride:t.stride,stepMode:t.step,attributes:t.attributes.map(t=>({shaderLocation:e.indexOf(t),offset:t.offset*4,format:me(t.type)}))}))}release(){let e=this.gpu;if(e){e.object.destroy();for(let t of[e.vertex,e.instance,e.index])R(e.device,t);this.gpu=void 0,this.streams.vertex.full=this.streams.instance.full=this.indexDirty=!0}}worldMatrix(e){if(!this.mesh)return this.matrix;let t=l(e,this.mesh);if(!t)return null;let n=this.world,r=this.matrix;for(let e=0;e<4;e++)for(let i=0;i<4;i++)n[e*4+i]=t[i]*r[e*4]+t[4+i]*r[e*4+1]+t[8+i]*r[e*4+2]+t[12+i]*r[e*4+3];return n}upload(e,t,n){let r=this.gpu;r&&r.device!==e&&(this.release(),r=void 0),r||=this.gpu={device:e,object:e.createBuffer({label:`shader:raw:mesh`,size:xe,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST}),groups:new Map};let i=r.written,a=!!i;for(let e=0;a&&e<16;e++)a=Object.is(i[e],n[e]);if(!a){let t=this.object;t.set(n);let a=n[0],o=n[1],s=n[2],c=n[4],l=n[5],u=n[6],d=n[8],f=n[9],p=n[10],m=l*p-u*f,h=u*d-c*p,g=c*f-l*d,_=a*m+o*h+s*g,v=_?1/_:0;t[16]=m*v,t[17]=h*v,t[18]=g*v,t[20]=(f*s-p*o)*v,t[21]=(p*a-d*s)*v,t[22]=(d*o-f*a)*v,t[24]=(o*u-s*l)*v,t[25]=(s*c-a*u)*v,t[26]=(a*l-o*c)*v,(!i||i.some((e,n)=>!Object.is(e,t[n])))&&(e.queue.writeBuffer(r.object,0,t),(r.written??=new Float32Array(28)).set(t))}r.group=r.groups.get(t),r.group||(r.group=e.createBindGroup({layout:N(e),entries:[{binding:0,resource:{buffer:t}},{binding:1,resource:{buffer:r.object}}]}),r.groups.set(t,r.group)),r.vertex=this.streams.vertex.upload(e,r.vertex),r.instance=this.streams.instance.upload(e,r.instance);let o=this.drawTopology!==this.topology,s=this.streams.vertex.attributes.length?Math.min(this.streams.vertex.count,this.vertexCount??1/0):this.vertexCount??0,c=o?this.edges(s):this.indices;if(r.wire!==o&&(r.wire=o,this.indexDirty=!0),!c)R(e,r.index),r.index=void 0;else if(this.indexDirty||!r.index){let t=Math.ceil(c.byteLength/4)*4||4,n=new Uint8Array(t);n.set(new Uint8Array(c.buffer,c.byteOffset,c.byteLength));let i=new Uint32Array(n.buffer);r.index?.users===1&&r.index.buffer.size>=t?(r.index=Re(e,r.index,i),e.queue.writeBuffer(r.index.buffer,0,n)):(R(e,r.index),r.index=Ie(e,GPUBufferUsage.INDEX|GPUBufferUsage.COPY_DST,`shader:raw:index`,i))}this.indexDirty=!1;let l=this.streams.vertex,u=this.streams.instance,d=c?c.length:l.attributes.length?Math.min(l.count,this.vertexCount??1/0):this.vertexCount??0,f=u.attributes.length?Math.min(u.count,this.instanceCount??1/0):this.instanceCount??1,p=Math.min(Math.max(0,Math.floor(this.drawRange.start)||0),d),m=Math.min(Math.max(0,Math.floor(this.drawRange.count)),d-p);return m>0&&f>0?[p,m,Math.floor(f)]:void 0}draw(e,t,n,r,i){let a=this.gpu,o=a.vertex?.buffer,s=a.instance?.buffer,c=a.index?.buffer,l=0;if(o&&(i.slots[0]!==o&&e.setVertexBuffer(0,i.slots[0]=o),l=1),s&&i.slots[l]!==s&&e.setVertexBuffer(l,i.slots[l]=s),c){let o=a.wire?`uint32`:this.indexFormat;(i.index!==c||i.format!==o)&&e.setIndexBuffer(i.index=c,i.format=o),e.drawIndexed(n,r,t)}else e.draw(n,r,t)}},Ve=e=>!!e&&typeof e==`object`&&`data`in e&&typeof e.type==`string`;function He(e,t,n){let r=D(t),i=fe(t);if(!e||typeof e.length!=`number`||e.length%r)throw RangeError(`RawMesh attribute ${n} needs a multiple of ${r} numbers for ${t}`);let a=i===`f`?Float32Array:i===`i`?Int32Array:Uint32Array;return e instanceof a?e:a.from(e)}function Ue(e,t){let n,r,i={slots:[]};for(let a of t){let t=a.gpu.group;a.pipeline!==n&&e.setPipeline(n=a.pipeline),e.setBindGroup(0,a.mesh.gpu.group),t&&t!==r&&(e.setBindGroup(1,r=t),a.gpu.extras.forEach((t,n)=>e.setBindGroup(2+n,t))),a.mesh.draw(e,a.call[0],a.call[1],a.call[2],i)}}var We=class e{coreRequirement=a(`0.1.0`,import.meta.url);get pass(){return this.passes}get kernel(){return this.engine}static attach(t,n){o(t,a(`0.1.0`,import.meta.url));let r=new e(n);return t.use(r),r}constructor(e={}){if(this.stats={meshes:0,drawCalls:0,culled:0,pending:0},this.watchers=new Set,this.meshes=new Set,this.jobs=new Set,this.shadowCameras=[],this.shadowPass=0,this.shadowWritten=[],this.passes=0,this.cameraData=new Float32Array(60),this.view=new Float64Array(16),this.inverse=new Float64Array(16),this.velocityStates=new Map,this.beforeData=new Float32Array(36),this.name=e.name??`shader:raw`,this.opaqueOrder=e.opaqueOrder??.5,this.transparentOrder=e.transparentOrder??7,!this.name||typeof this.name!=`string`)throw TypeError(`RawShaders name must be a non-empty string`);if(!Number.isFinite(this.opaqueOrder)||!Number.isFinite(this.transparentOrder))throw RangeError(`RawShaders opaqueOrder and transparentOrder must be finite numbers`)}add(e){if(!(e instanceof z))throw TypeError(`RawShaders.add needs a RawMesh`);if(e.owner&&e.owner!==this)throw new c(`attached`,`RawMesh already belongs to another RawShaders; remove it there first`);e.alive(),e.owner=this,this.meshes.add(e);for(let t of this.watchers)t.added(e);return e}remove(e){if(!this.meshes.delete(e))return!1;for(let t of this.velocityStates.values())t.meshes.get(e)?.before.destroy(),t.meshes.delete(e);e.release(),e.owner=void 0;for(let t of this.watchers)t.removed(e);return!0}async ready(){for(;this.jobs.size;)await Promise.allSettled([...this.jobs])}track(e){let t=()=>{this.jobs.delete(e)};this.jobs.add(e),e.then(t,t)}setup(e){if(this.engine&&this.engine!==e)throw new c(`attached`,`${this.name} is attached to another engine; create a new RawShaders`);if(!e.gpu)throw new c(`unsupported`,`RawShaders requires WebGPU; see https://margoengine.com/errors#webgpu`);this.engine=e,this.device=e.gpu??void 0,T.hold(e,this)}registerPasses(e){e.add({name:this.name+`:opaque`,order:this.opaqueOrder,execute:e=>this.execute(e,!1)}),e.add({name:this.name+`:transparent`,order:this.transparentOrder,execute:e=>this.execute(e,!0)})}onDeviceRestored(e){this.release(),this.device=e.gpu??void 0}dispose(){let e=this.engine;this.release(),this.engine=this.device=void 0,T.release(e,this),e?.sceneOf(this)?.removePlugin(this.name)}[Symbol.dispose??Symbol()](){this.dispose()}release(){let e=this.device;for(let t of this.meshes)t.release(),(e&&t.material.gpu.get(e))?.buffer?.destroy(),e&&t.material.gpu.delete(e);this.camera?.destroy(),this.camera=void 0;for(let e of[...this.velocityStates.keys()])this.releaseVelocity(e);for(let e of this.shadowCameras)e.destroy();this.shadowCameras.length=this.shadowWritten.length=0,this.shadowEncoder=void 0}cameraBuffer(e){return e.createBuffer({label:`shader:raw:camera`,size:240,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST})}writeCamera(e){let t=e.device;this.camera??=this.cameraBuffer(t);let n=e.format.includes(`float`)?0:e.format.endsWith(`-srgb`)?2:1;return t.queue.writeBuffer(this.camera,0,this.cameraBlock(e.camera,e.camera.matrix,e.width,e.height,e.delta,n,ne(e))),this.camera}cameraBlock(e,t,n,r,i,a,o){let s=this.cameraData,c=ae(this.view,e),l=this.inverse;for(let e=0;e<3;e++){for(let t=0;t<3;t++)l[t*4+e]=c[e*4+t];l[12+e]=-(c[e*4]*c[12]+c[e*4+1]*c[13]+c[e*4+2]*c[14]),l[e*4+3]=0}l[15]=1,s.set(c,0);for(let e=0;e<4;e++)for(let n=0;n<4;n++)s[16+e*4+n]=t[n]*l[e*4]+t[4+n]*l[e*4+1]+t[8+n]*l[e*4+2]+t[12+n]*l[e*4+3];return s.set(t,32),s.set(e.position,48),s[51]=T.find(this.engine)?.time??0,s[52]=n,s[53]=r,s[54]=i,s[55]=a,o?s.set(o,56):s.set([0,0,n,r],56),s}nextPass(){return++this.passes}shadow(e,{context:t,pass:n,matrix:r,cascade:i}){let a=this.device,o=this.engine,s=e.material;if(!a||!o||t.device!==a||!e.visible||s.transparent)return;let c=e.worldMatrix(o);if(!c||e.culled(c,r))return;this.shadowEncoder!==t.encoder&&(this.shadowEncoder=t.encoder,this.shadowPass=this.nextPass());let l=this.shadowCameras[i]??=this.cameraBuffer(a);if(this.shadowWritten[i]!==t.encoder){this.shadowWritten[i]=t.encoder;let e=this.cameraBlock(t.camera,r,t.width,t.height,t.delta,0);e.set(Be,0),e.set(r,16),a.queue.writeBuffer(l,0,e)}let u=e.upload(a,l,c);if(!u)return;let d=s.prepare(a,this.shadowPass,this),f=s.pipeline(this,d,a,e,`shadow`);f&&Ue(n,[{mesh:e,pipeline:f,gpu:d,call:u,distance:0}])}draw(e,t,n,r,i,a){let o=e,s=this.device,c=this.engine;if(t!==`occlusion`||!a||o.backend!==`webgpu`||!s||!c||o.device!==s)return;let l=this.nextPass(),u=[],d;for(let e of this.meshes){let t=e.material;if(!e.visible||t.transparent||!t.writesGBuffer)continue;let n=e.worldMatrix(c);if(!n||e.culled(n,o.camera.matrix))continue;d??=this.writeCamera(o);let r=e.upload(s,d,n);if(!r)continue;let i=t.prepare(s,l,this),f=t.pipeline(this,i,s,e,`gbuffer`,o,a.depthCompare);f&&u.push({mesh:e,pipeline:f,gpu:i,call:r,distance:0})}Ue(a.pass,u)}drawVelocity(e,t){let n=t.context,r=this.device,i=this.engine;if(n.backend!==`webgpu`||!r||!i||n.device!==r||!this.camera)return;let a=this.velocityStates.get(t.key);a||this.velocityStates.set(t.key,a={camera:this.cameraBuffer(r),frame:0,meshes:new Map}),a.frame++;let o=t.camera,s=o.subarray(0,16),c=this.nextPass(),l=[],u;for(let e of this.meshes){let t=e.material;if(!e.visible||t.transparent||!t.velocityName)continue;let d=e.worldMatrix(i);if(!d||e.culled(d,s))continue;if(u===void 0){let e=this.cameraBlock(n.camera,s,n.width,n.height,n.delta,0,ne(n));u=e[51],r.queue.writeBuffer(a.camera,0,e)}let f=e.upload(r,this.camera,d),p=e.gpu?.object;if(!f||!p)continue;let m=a.meshes.get(e);if(!m||m.object!==p){m?.before.destroy();let t=r.createBuffer({label:`shader:raw:before`,size:144,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});m={before:t,object:p,world:new Float32Array(16),frame:-1,group:r.createBindGroup({layout:N(r,!0),entries:[a.camera,p,t].map((e,t)=>({binding:t,resource:{buffer:e}}))})},a.meshes.set(e,m)}let h=m.frame===a.frame-1&&o[34]>0&&a.time!==void 0,g=this.beforeData;g.set(o.subarray(16,32),0),g.set(h?m.world:d,16),g[32]=h?a.time:u,g[33]=+h,r.queue.writeBuffer(m.before,0,g),m.world.set(d),m.frame=a.frame;let _=t.prepare(r,c,this),v=t.pipeline(this,_,r,e,`velocity`,n);v&&l.push({mesh:e,pipeline:v,gpu:_,call:f,group:m.group})}u!==void 0&&(a.time=u);let d={slots:[]};for(let t of l)e.setPipeline(t.pipeline),e.setBindGroup(0,t.group),t.gpu.group&&(e.setBindGroup(1,t.gpu.group),t.gpu.extras.forEach((t,n)=>e.setBindGroup(2+n,t))),t.mesh.draw(e,t.call[0],t.call[1],t.call[2],d)}releaseVelocity(e){let t=this.velocityStates.get(e);if(t){t.camera.destroy();for(let e of t.meshes.values())e.before.destroy();this.velocityStates.delete(e)}}execute(e,t){if(t||(this.stats.meshes=this.stats.drawCalls=this.stats.culled=0),e.backend!==`webgpu`||!this.device||!this.engine||e.device!==this.device||!this.meshes.size)return;let n=this.device,r=this.engine,i=e.camera.position,a=[],o=this.nextPass(),s;for(let c of this.meshes){let l=c.material;if(!c.visible||l.transparent!==t)continue;let u=c.worldMatrix(r);if(!u)continue;if(c.culled(u,e.camera.matrix)){this.stats.culled++;continue}s??=this.writeCamera(e);let d=c.upload(n,s,u);if(!d)continue;let f=l.prepare(n,o,this),p=l.pipeline(this,f,n,c,`color`,e);if(this.watchers.size&&l.pipeline(this,f,n,c,`pick`),!p)continue;let m=u[12]-i[0],h=u[13]-i[1],g=u[14]-i[2];a.push({mesh:c,pipeline:p,gpu:f,call:d,distance:m*m+h*h+g*g})}if(this.stats.pending=this.jobs.size,!a.length)return;a.sort((e,n)=>e.mesh.renderOrder-n.mesh.renderOrder||(t?n.distance-e.distance:0));let c=e.descriptor.depthStencil.format.includes(`stencil`),l=e.encoder.beginRenderPass({label:this.name+(t?`:transparent`:`:opaque`),colorAttachments:[{view:e.color,loadOp:`load`,storeOp:`store`}],depthStencilAttachment:{view:e.depth,depthLoadOp:`load`,depthStoreOp:`store`,...c?{stencilReadOnly:!0}:{}}});re(l,e),Ue(l,a),this.stats.meshes+=a.length,this.stats.drawCalls+=a.length,l.end()}},Ge=[`beauty`,`redshift`,`beaming`,`temperature`,`orders`];function B(e){let t=K(e);return 1+Math.sqrt(1-t*t)}function V(e){let t=K(e),n=1+Math.cbrt(1-t*t)*(Math.cbrt(1+t)+Math.cbrt(1-t)),r=Math.sqrt(3*t*t+n*n);return 3+r-Math.sqrt((3-n)*(3+n+2*r))}function Ke(e){let t=K(e);return 2*(1+Math.cos(2/3*Math.acos(-t)))}function qe(e){let t=Math.acos(e)/3;return[2*Math.cos(t-Math.PI/3),2*Math.cos(t+Math.PI/3),-2*Math.cos(t)]}function Je(e,t){let n=Math.max(K(t),1e-6),r=Math.sqrt(V(n)),i=Math.sqrt(e);if(!(i>r))return 0;let[a,o,s]=qe(n),c=(e,t,a)=>3*(e-n)*(e-n)/(e*(e-t)*(e-a))*Math.log((i-e)/(r-e)),l=i-r-1.5*n*Math.log(i/r)-c(a,o,s)-c(o,a,s)-c(s,a,o);return 3/(8*Math.PI)*l/(i**4*(i*i*i-3*i+2*n))}function Ye(e,t){return e<Math.PI/2!=t<Math.PI/2}function Xe(e,t){let n=.028*Math.max(e-t*.9,.035)+.0042*e*e;return Math.min(Math.max(n,.012),Math.max(.65,.2*e))}function Ze(e,t){let n=K(t),r=e[0]*2,i=e[1]*2,a=e[2]*2,o=r*r+i*i+a*a-n*n,s=Math.sqrt(.5*(o+Math.sqrt(o*o+4*n*n*i*i)));return[s,Math.acos(Math.min(Math.max(i/s,-1),1)),Math.atan2(-a,r)]}function Qe(e,t,n,r){let i=K(r),a=Math.sqrt(e*e+i*i)*Math.sin(t);return[a*Math.cos(n)/2,e*Math.cos(t)/2,-a*Math.sin(n)/2]}function $e(e,t,n,r){let[i,a,o,s]=e,c=Math.max(Math.abs(Math.sin(a)),1e-6),l=U(t,n,r)&&c<.001,u=l?H*H:c*c,d=Math.cos(a),f=t*t,p=i*i-2*i+f,m=2*i-2,h=i*i+f*d*d,g=i*i+f-t*n,_=(n-t)*(n-t)+r,v=g*g-p*_,y=4*i*g-m*_,b=r-d*d*(n*n/u-f),x=l?2*n*n*d*c/u:2*n*n*d/(c*c*c),S=l?0:-2*n*d*d/u,C=-p*o*o-s*s+b,w=v/p,T=(y*p-v*m)/(p*p),E=1/(2*h);return[p*o/h,s/h,(-m*o*o+T)*E-(C+w)*i/(h*h),(x-2*f*d*c)*E+(C+w)*f*d*c/(h*h),S*E+(-2*t*g-2*p*(n-t))*E/p]}var H=.001;function U(e,t,n){return Math.abs(t)<=H/3*Math.sqrt(Math.max(n+e*e,1e-9))}function et(e,t,n){if(!U(e,t,n))return Math.PI;let r=Math.abs(t)/Math.sqrt(Math.max(n+e*e,1e-9));return(t<0?-2:2)*Math.acos(Math.min(r/H,1))}function tt(e,t,n,r,i,a){let o=Math.sqrt(Math.max(a+r*r,1e-9)),s=Math.abs(i)/o,c=Math.abs(Math.sin(n));if(c>.2)return e;let l=Math.cos(n),u=U(r,i,a),d=u?H:s,f=u&&c<.001?.5*H:.25*Math.max(c-d,.4*d);return Math.min(e,f*(t*t+r*r*l*l)/o)}function nt(e,t,n,r){let[i,a,o,s]=e,c=U(t,n,r)&&Math.sin(a)**2<1e-6?H*H:Math.max(Math.sin(a)**2,1e-8),l=Math.cos(a),u=t*t,d=i*i-2*i+u,f=i*i+u*l*l,p=i*i+u-t*n,m=p*p-d*((n-t)*(n-t)+r),h=r-l*l*(n*n/c-u);return(-d*o*o-s*s+h+m/d)/(2*f)}function rt(e,t,n){let r=K(n),[i,a,o]=Ze(e,r),s=Math.max(Math.sin(a),1e-6),c=Math.cos(a),l=Math.sqrt(i*i+r*r),u=G([i/l*s*Math.cos(o),c,-(i/l)*s*Math.sin(o)]),d=G([l*c*Math.cos(o),-i*s,-l*c*Math.sin(o)]),f=[-Math.sin(o),0,-Math.cos(o)],p=G([t[0],t[1],t[2]]),m=G([W(p,u),W(p,d),W(p,f)]).map(e=>-e),h=i*i-2*i+r*r,g=Math.sqrt(i*i+r*r*c*c),_=Math.sqrt((i*i+r*r)**2-r*r*h*s*s),v=g*Math.sqrt(h)/_,y=2*r*i/(_*_),b=_*s/g,x=1/(v+y*b*m[2]),S=x*g*m[1],C=x*b*m[2];return{y:[i,a,x*g*m[0]/Math.sqrt(h),S],phi:o,b:C,q:S*S+c*c*(C*C/(s*s)-r*r)}}function it(e,t,n,r){let i=B(t),a=(n-t)*(n-t)+r;for(let r=1;r<=32;r++){let o=i+(e-i)*r/32,s=o*o+t*t-t*n;if(s*s-(o*o-2*o+t*t)*a<0)return!1}return!0}function at(e,t){return Math.min(Math.max(4*(e*e-2*e+t*t)/(e*e),.1),1)}function ot(e,t,n={}){let r=K(n.spin??.9),i=Math.round(q(n.steps??260,32,1024)),a=n.diskOuter??6,o=B(r),s=V(r)/2,c=rt(e,t,r),{b:l,q:u}=c,d=c.y,f=c.phi,p=Qe(d[0],d[1],f,r),m=G([t[0],t[1],t[2]]),h=[...p],g=[],_=`steps`,v=0,y=!1,b=e=>$e(e,r,l,u).map(e=>-e);for(let e=0;e<i;e++){let e=d[0];if(e<=o*1.02){_=`horizon`;break}let t=b(d);if(e>160&&t[0]>0){_=`escape`;break}if(t[0]<0&&e<4&&(y||it(e,r,l,u))&&(y=!0,e<s*2)){_=`horizon`;break}let n=tt(2*Xe(e/2,o/2)*at(e,r)*Math.min(Math.max(Math.sin(d[1])*10,.05),1),e,d[1],r,l,u),i=(e,t)=>d.map((n,r)=>n+e[r]*t),c=b(i(t,n/2)),x=b(i(c,n/2)),S=b(i(x,n)),C=d.map((e,r)=>e+n/6*(t[r]+2*c[r]+2*x[r]+S[r]));f+=n/6*(t[4]+2*c[4]+2*x[4]+S[4]),(C[1]<0||C[1]>Math.PI)&&(C[1]=C[1]<0?-C[1]:2*Math.PI-C[1],C[3]=-C[3],f+=et(r,l,u));let w=Qe(C[0],C[1],f,r);if(Ye(d[1],C[1])){let e=(d[0]+(C[0]-d[0])*(d[1]-Math.PI/2)/(d[1]-C[1]))/2;e>=s&&e<=a&&g.push(e)}m=G([w[0]-p[0],w[1]-p[1],w[2]-p[2]]),d=C,p=w,v=Math.max(v,Math.abs(nt(d,r,l,u))),h.push(...p)}return{points:new Float32Array(h),fate:_,disk:g,direction:[m[0],m[1],m[2]],b:l,q:u,drift:v}}var W=(e,t)=>e[0]*t[0]+e[1]*t[1]+e[2]*t[2],G=e=>{let t=Math.hypot(e[0],e[1],e[2]);return[e[0]/t,e[1]/t,e[2]/t]};function K(e){return q(e,0,.998)}function q(e,t,n){if(!Number.isFinite(e))throw RangeError(`BlackHole: ${e} is not a finite number; pass a finite number`);return Math.min(Math.max(e,t),n)}var st=`
struct Out { @builtin(position) clip:vec4f, @location(0) ndc:vec2f }
@vertex fn vertex(@builtin(vertex_index) i:u32)->Out {
  let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u)) * 2.0 - 1.0;
  return Out(vec4f(p, 0.0, 1.0), p);
}

fn bhHash3(p:vec3f)->f32 {
  var q = fract(p * vec3f(0.1031, 0.1030, 0.0973));
  q += dot(q, q.yxz + 33.33);
  return fract((q.x + q.y) * q.z);
}
fn bhHash2(p:vec2f)->f32 { return bhHash3(vec3f(p, 7.13)); }
fn bhNoise(p:vec3f)->f32 {
  let i = floor(p);
  var f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(mix(bhHash3(i), bhHash3(i + vec3f(1,0,0)), f.x), mix(bhHash3(i + vec3f(0,1,0)), bhHash3(i + vec3f(1,1,0)), f.x), f.y),
    mix(mix(bhHash3(i + vec3f(0,0,1)), bhHash3(i + vec3f(1,0,1)), f.x), mix(bhHash3(i + vec3f(0,1,1)), bhHash3(i + vec3f(1,1,1)), f.x), f.y),
    f.z) - 0.5;
}


fn bhFbm(p:vec3f, foot:f32)->f32 {
  var v = 0.0;
  var a = 0.55;
  var q = p;
  var f = foot;
  for (var k = 0; k < 6; k++) {
    v += a * bhNoise(q) * (1.0 - smoothstep(0.25, 0.5, f));
    q = q * 2.0 + vec3f(17.1, 9.3, 23.7);
    f *= 2.0;
    a *= 0.5;
  }
  return v;
}

fn bhBlackbody(kelvin:f32)->vec3f {
  let T = clamp(kelvin, 1667.0, 25000.0);
  let i = 1000.0 / T;
  var x = -3.0258469 * i * i * i + 2.1070379 * i * i + 0.2226347 * i + 0.24039;
  if (T <= 4000.0) { x = -0.2661239 * i * i * i - 0.2343589 * i * i + 0.8776956 * i + 0.17991; }
  var y = 3.081758 * x * x * x - 5.8733867 * x * x + 3.75112997 * x - 0.37001483;
  if (T <= 4000.0) { y = -0.9549476 * x * x * x - 1.37418593 * x * x + 2.09137015 * x - 0.16748867; }
  if (T <= 2222.0) { y = -1.1063814 * x * x * x - 1.3481102 * x * x + 2.18555832 * x - 0.20219683; }
  let X = x / y;
  let Z = (1.0 - x - y) / y;
  return max(vec3f(3.2406 * X - 1.5372 - 0.4986 * Z, -0.9689 * X + 1.8758 + 0.0415 * Z, 0.0557 * X - 0.204 + 1.057 * Z), vec3f(0.0));
}


fn bhFlux(r:f32)->f32 {
  let a = max(uniforms.spin, 1e-6);
  let x = sqrt(r);
  let x0 = uniforms.x0;
  if (x <= x0) { return 0.0; }
  let x1 = uniforms.x1; let x2 = uniforms.x2; let x3 = uniforms.x3;
  let t1 = 3.0 * (x1 - a) * (x1 - a) / (x1 * (x1 - x2) * (x1 - x3)) * log((x - x1) / (x0 - x1));
  let t2 = 3.0 * (x2 - a) * (x2 - a) / (x2 * (x2 - x1) * (x2 - x3)) * log((x - x2) / (x0 - x2));
  let t3 = 3.0 * (x3 - a) * (x3 - a) / (x3 * (x3 - x1) * (x3 - x2)) * log((x - x3) / (x0 - x3));
  let b = x - x0 - 1.5 * a * log(x / x0) - t1 - t2 - t3;
  return max(0.11936621 * b / (x * x * x * x * (x * x * x - 3.0 * x + 2.0 * a)), 0.0);
}


fn bhDiskAlpha(r:f32)->f32 {
  return smoothstep(uniforms.isco * 0.985, uniforms.isco, r) * (1.0 - smoothstep(uniforms.outer * 0.9, uniforms.outer, r));
}


fn bhPhase(k:f32)->vec2f {
  let period = 24.0;
  let clock = select(camera.time, uniforms.diskTime, uniforms.diskClock > 0.5);
  let u = fract(clock / period + 0.5 * k);
  return vec2f(u * period, 1.0 - abs(2.0 * u - 1.0));
}


fn bhDiskAdvection(r:f32, age:f32)->vec2f {
  let past = r + uniforms.diskInflow * age;
  if (uniforms.spin == 0.0) {
    let now = sqrt(r);
    let previous = sqrt(past);
    return vec2f(past, (2.0 * age) / (now * previous * (now + previous)));
  }
  let mid = 0.5 * (r + past);
  let offset = (past - r) / (2.0 * sqrt(3.0));
  let a = mid - offset;
  let b = mid + offset;
  let phase = 0.5 * age * (1.0 / (a * sqrt(a) + uniforms.spin) + 1.0 / (b * sqrt(b) + uniforms.spin));
  return vec2f(past, phase);
}

fn bhDiskCoord(p:vec3f, age:f32, k:f32)->vec3f {
  let rM = sqrt(max(4.0 * dot(p.xz, p.xz) - uniforms.spin * uniforms.spin, 1e-4));
  let previous = bhDiskAdvection(rM, age * uniforms.timeScale);
  let phi = atan2(p.z, p.x) + previous.y;
  return vec3f(cos(phi) * 3.0, sin(phi) * 3.0, log(previous.x) * 6.0 + k * 31.7);
}



fn bhDisk(p:vec3f, bk:f32, turb:f32, order:f32)->vec3f {
  let rM = sqrt(max(4.0 * dot(p.xz, p.xz) - uniforms.spin * uniforms.spin, 1e-4));
  let rS = rM * 0.5;
  var f = bhFlux(rM) * uniforms.fluxNorm;

  let age = camera.time - uniforms.flareStart;
  if (age >= 0.0 && age < 14.0) {
    let fr = mix(4.2, uniforms.isco * 1.15, clamp(age / 8.0, 0.0, 1.0));
    let fphi = -age * 3.0 - 4.5 * log(max(rS, 0.35));
    let dr = (rS - fr) / 0.42;
    let dphi = sin((atan2(p.z, p.x) - fphi) * 0.5);
    f *= 1.0 + 2.5 * exp(-dr * dr - dphi * dphi * 5.0) * exp(-max(age - 6.0, 0.0) * 0.45);
  }


  let emitterGain = exp(5.0 * uniforms.turbulence * turb);
  f *= emitterGain;

  let s = sqrt(rM);
  let ut = (rM * s + uniforms.spin) / (pow(rM, 0.75) * sqrt(max(rM * s - 3.0 * s + 2.0 * uniforms.spin, 1e-5)));
  let g = 1.0 / (ut * (1.0 - bk / (rM * s + uniforms.spin)));
  let tEm = uniforms.tPeak * pow(max(f, 0.0), 0.25);
  let v = uniforms.view;
  if (v > 3.5) {
    let tint = select(select(vec3f(0.9, 0.25, 1.0), vec3f(0.2, 0.85, 1.0), order < 1.5), vec3f(1.0, 0.62, 0.25), order < 0.5);
    return tint * (0.25 + 0.75 * sqrt(f));
  }
  if (v > 2.5) { return bhBlackbody(tEm) * select(0.0, 1.0, f > 0.0); }
  if (v > 1.5) {
    let e = clamp(log2(g * g * g * g) / 3.0, -1.0, 1.0);
    return mix(vec3f(0.35, 0.35, 0.35), select(vec3f(0.15, 0.3, 1.0), vec3f(1.0, 0.95, 0.4), e > 0.0) * 1.6, abs(e)) * select(0.0, emitterGain, f > 0.0);
  }
  if (v > 0.5) {
    let e = clamp((g - 1.0) * 2.5, -1.0, 1.0);
    return mix(vec3f(0.8), select(vec3f(1.0, 0.18, 0.1), vec3f(0.2, 0.45, 1.0), e > 0.0), abs(e)) * select(0.0, 1.0, f > 0.0);
  }
  return bhBlackbody(g * tEm) * (g * g * g * g * f * uniforms.accretion * 0.8);
}


fn bhLapse(p:vec3f)->f32 {
  let a = uniforms.spin;
  let m = p * 2.0;
  let w = dot(m, m) - a * a;
  let r = sqrt(0.5 * (w + sqrt(w * w + 4.0 * a * a * m.y * m.y)));
  let c = clamp(m.y / max(r, 1e-4), -1.0, 1.0);
  let dl = max(r * r - 2.0 * r + a * a, 0.0);
  let rho2 = r * r + a * a * c * c;
  let sig2 = (r * r + a * a) * (r * r + a * a) - a * a * dl * (1.0 - c * c);
  return sqrt(rho2 * dl / sig2);
}





fn bhJet(p:vec3f, rd:vec3f)->f32 {
  let ay = abs(p.y);
  if (ay < 1.2 || ay > 40.0) { return 0.0; }
  let R = 0.28 * pow(ay, 0.58);
  let q = length(p.xz) / R;
  if (q > 3.0) { return 0.0; }
  let gamma = uniforms.jetGamma;
  let beta = sqrt(1.0 - 1.0 / (gamma * gamma));
  let cosT = dot(vec3f(0.0, sign(p.y), 0.0), -rd);
  let D = 1.0 / (gamma * (1.0 - beta * cosT));
  let knots = 0.75 + 0.5 * bhNoise(vec3f(p.x * 2.0, ay * 0.8 - camera.time * 1.5 * sign(p.y), p.z * 2.0));



  let lapse = bhLapse(p);
  return exp(-q * q * 1.5) * smoothstep(1.2, 3.0, ay) / (ay * ay * R * R) * min(pow(lapse * D, 2.7), 60.0) * knots * 0.02;
}





const BH_PLANE = vec3f(-0.4198, 0.8996, 0.12);
const BH_CENTRE = vec3f(0.1948, 0.2185, -0.9562);
struct BhFrame { e1:vec3f, e2:vec3f, inv:mat2x2f, det:f32, mu:f32, pixel:f32 }

fn bhStarFill(d:vec3f)->f32 {
  let z = abs(dot(d, BH_PLANE));
  return 0.05 + 0.11 * exp(-z * 6.0) + 0.05 * exp(-(1.0 - dot(d, BH_CENTRE)) * 6.0);
}
fn bhStarCell(d:vec3f, band:f32, dlat:f32, dlon:f32, bands:f32, seed:f32, fr:BhFrame)->vec3f {
  let lat = band + dlat;
  if (lat < 0.0 || lat >= bands) { return vec3f(0.0); }
  let latC = (lat + 0.5) / bands * 3.14159265 - 1.5707963;
  let lonBins = max(floor(cos(latC) * bands * 2.0), 6.0);
  let phi = atan2(d.z, d.x);
  let lon = floor((phi + 3.14159265) / 6.2831853 * lonBins) + dlon;
  let cell = vec2f(lon - floor(lon / lonBins) * lonBins + seed * 17.0, lat + seed * 31.0);
  let rnd = bhHash2(cell);
  if (rnd < 1.0 - bhStarFill(d)) { return vec3f(0.0); }
  let sLat = latC + (bhHash2(cell + vec2f(11.3, 5.9)) - 0.5) * 0.9 * 3.14159265 / bands;
  let sLon = (lon + 0.5 + (bhHash2(cell + vec2f(3.1, 7.7)) - 0.5) * 0.9) / lonBins * 6.2831853 - 3.14159265;
  let s = vec3f(cos(sLat) * cos(sLon), sin(sLat), cos(sLat) * sin(sLon));
  let delta = s - d;
  let px = fr.inv * vec2f(dot(delta, fr.e1), dot(delta, fr.e2));

  let u = bhHash2(cell + vec2f(5.7, 2.3));
  let flux = (0.2 + 4.8 * pow(u, 5.0)) * fr.mu;

  let tint = bhBlackbody(3000.0 + 12000.0 * pow(bhHash2(cell + vec2f(9.1, 1.7)), 2.2));
  if (dot(s, d) < 0.0) { return vec3f(0.0); }
  return tint * flux * exp(-dot(px, px) / (2.0 * 0.36)) * 0.44;
}
fn bhStars(d:vec3f, bands:f32, seed:f32, fr:BhFrame)->vec3f {
  let band = floor((asin(clamp(d.y, -1.0, 1.0)) + 1.5707963) / 3.14159265 * bands);
  var c = vec3f(0.0);
  for (var i = -1; i <= 1; i++) {
    for (var j = -1; j <= 1; j++) {
      c += bhStarCell(d, band, f32(i), f32(j), bands, seed, fr);
    }
  }



  let cellAngle = 3.14159265 / bands;
  let w = smoothstep(0.3, 0.7, sqrt(fr.det) / cellAngle);
  return mix(c, vec3f(0.85, 0.82, 0.8) * bhStarFill(d) * fr.pixel * fr.pixel / (cellAngle * cellAngle), w);
}


fn bhGalaxy(d:vec3f, foot:f32)->vec3f {
  let z = dot(d, BH_PLANE);
  let thin = exp(-abs(z) * 7.0);
  let thick = exp(-abs(z) * 2.2);
  let toward = dot(d, BH_CENTRE);
  let bulge = exp(-(1.0 - toward) * 9.0) * exp(-abs(z) * 3.0);
  let clumps = bhFbm(d * 6.0 + vec3f(1.4, -0.8, 2.1), foot * 6.0) + 0.5;
  let lanes = smoothstep(0.38, 0.7, bhFbm(d * 11.0 + vec3f(4.2, 0.3, -1.9), foot * 11.0) + 0.5) * exp(-abs(z + 0.012) * 26.0);
  let disk = (thin * (0.35 + 0.9 * clumps) + 0.25 * thick) * (0.55 + 0.45 * max(toward, 0.0));
  let light = vec3f(0.62, 0.68, 0.85) * disk + vec3f(1.0, 0.72, 0.45) * bulge * 1.4;
  return light * (1.0 - 0.85 * lanes) * 0.02;
}



struct BhKD { d:vec4f, dphi:f32 }
fn bhKerr(y:vec4f, a:f32, b:f32, q:f32, band:f32)->BhKD {
  let r = y.x; let pr = y.z; let pt = y.w;
  let s = max(sin(y.y), 1e-6); let inBand = s < band; let S2 = select(s * s, band * band, inBand); let c = cos(y.y); let a2 = a * a;
  let dl = r * r - 2.0 * r + a2; let dlp = 2.0 * r - 2.0;
  let rho2 = r * r + a2 * c * c;
  let P = r * r + a2 - a * b; let bq = (b - a) * (b - a) + q;
  let R = P * P - dl * bq; let Rp = 4.0 * r * P - dlp * bq;
  let Th = q - c * c * (b * b / S2 - a2);
  let barrier = select(2.0 * b * b * c / (s * s * s), 2.0 * b * b * c * s / S2, inBand);
  let A = -dl * pr * pr - pt * pt + Th;
  let B = R / dl; let Bp = (Rp * dl - R * dlp) / (dl * dl);
  let inv = 1.0 / (2.0 * rho2);
  let k = A + B;
  let d = vec4f(dl * pr / rho2, pt / rho2,
    (-dlp * pr * pr + Bp) * inv - k * r / (rho2 * rho2),
    (barrier - 2.0 * a2 * c * s) * inv + k * a2 * c * s / (rho2 * rho2));
  let dphi = select(-2.0, 0.0, inBand) * b * c * c / S2 * inv + (-2.0 * a * P - 2.0 * dl * (b - a)) * inv / dl;
  return BhKD(-d, -dphi);
}

fn bhCaptured(r:f32, rH:f32, a:f32, b:f32, q:f32)->bool {
  let bq = (b - a) * (b - a) + q;
  for (var i = 1; i <= 32; i++) {
    let x = rH + (r - rH) * f32(i) / 32.0;
    let P = x * x + a * a - a * b;
    if (P * P - (x * x - 2.0 * x + a * a) * bq < 0.0) { return false; }
  }
  return true;
}
fn bhCart(y:vec4f, phi:f32, a:f32, cp:f32, sp:f32)->vec3f {
  let rho = sqrt(y.x * y.x + a * a) * sin(y.y);
  let c = cp * cos(phi) - sp * sin(phi);
  let s = sp * cos(phi) + cp * sin(phi);
  return 0.5 * vec3f(rho * c, y.x * cos(y.y), -rho * s);
}



@diagnostic(off, derivative_uniformity) @fragment fn fragment(i:Out)->@location(0) vec4f {
  let v = camera.view;
  let right = vec3f(v[0][0], v[1][0], v[2][0]);
  let up = vec3f(v[0][1], v[1][1], v[2][1]);
  let back = vec3f(v[0][2], v[1][2], v[2][2]);
  let proj = camera.projection;
  var rd = normalize(right * i.ndc.x / proj[0][0] + up * i.ndc.y / proj[1][1] - back);
  let horizon = uniforms.horizon;

  var accum = vec3f(0.0);
  var trans = 1.0;

  var escaped = false;
  var falling = false;
  var crossings = 0;
  var hp = array<vec3f, 3>(vec3f(0.0), vec3f(0.0), vec3f(0.0));
  var hb = array<f32, 3>(0.0, 0.0, 0.0);
  var hw = array<f32, 3>(0.0, 0.0, 0.0);
  let steps = i32(uniforms.steps);
  let a = uniforms.spin;
  let rH = horizon * 2.0;


  let cm = camera.position * 2.0;
  let w0 = dot(cm, cm) - a * a;
  let r0 = sqrt(0.5 * (w0 + sqrt(w0 * w0 + 4.0 * a * a * cm.y * cm.y)));
  let th0 = acos(clamp(cm.y / r0, -1.0, 1.0));


  var phi = 0.0;
  let rc = length(cm.xz);
  let cp = select(1.0, cm.x / rc, rc > 1e-6);
  let sp = select(0.0, -cm.z / rc, rc > 1e-6);
  let s0 = max(sin(th0), 1e-6);
  let c0 = cos(th0);
  let ra = sqrt(r0 * r0 + a * a);
  let er = normalize(vec3f(r0 / ra * s0 * cp, c0, -r0 / ra * s0 * sp));
  let et = normalize(vec3f(ra * c0 * cp, -r0 * s0, -ra * c0 * sp));
  let ep = vec3f(-sp, 0.0, -cp);
  let n = -normalize(vec3f(dot(rd, er), dot(rd, et), dot(rd, ep)));
  let dl0 = r0 * r0 - 2.0 * r0 + a * a;
  let rho0 = sqrt(r0 * r0 + a * a * c0 * c0);
  let sig = sqrt((r0 * r0 + a * a) * (r0 * r0 + a * a) - a * a * dl0 * s0 * s0);
  let alpha = rho0 * sqrt(max(dl0, 1e-6)) / sig;
  let omega = 2.0 * a * r0 / (sig * sig);
  let varpi = sig * s0 / rho0;
  let E = 1.0 / (alpha + omega * varpi * n.z);
  let bk = E * varpi * n.z;
  var y = vec4f(r0, th0, E * rho0 * n.x / sqrt(max(dl0, 1e-6)), E * rho0 * n.y);
  let qk = y.w * y.w + c0 * c0 * (bk * bk / (s0 * s0) - a * a);
  let kq = sqrt(max(qk + a * a, 1e-9));
  let tMin = abs(bk) / kq;

  let band = select(0.0, 0.001, tMin <= 0.00033333);

  let axisTurn = select(3.14159265, sign(bk) * 2.0 * acos(min(tMin / 0.001, 1.0)), band > 0.0);
  let turnAt = select(tMin, 0.001, band > 0.0);

  for (var step = 0; step < steps; step++) {
    let r = y.x;
    if (r <= rH * 1.02) { break; }
    let k1 = bhKerr(y, a, bk, qk, band);
    if (r > 160.0 && k1.d.x > 0.0) { escaped = true; break; }

    if (k1.d.x < 0.0 && r < 4.0 && (falling || bhCaptured(r, rH, a, bk, qk))) {
      falling = true;
      if (r < uniforms.isco * 2.0) { break; }
    }
    var dt = 2.0 * min(max(0.028 * max(0.5 * r - horizon * 0.9, 0.035) + 0.00105 * r * r, 0.012), max(0.65, 0.1 * r)) *
      clamp(4.0 * (r * r - 2.0 * r + a * a) / (r * r), 0.1, 1.0) * clamp(sin(y.y) * 10.0, 0.05, 1.0);

    let sa = abs(sin(y.y));
    if (sa < 0.2) {
      let dTheta = select(0.25 * max(sa - turnAt, 0.4 * turnAt), 0.0005, sa < band);
      dt = min(dt, dTheta * (r * r + a * a * cos(y.y) * cos(y.y)) / kq);
    }
    let k2 = bhKerr(y + k1.d * (0.5 * dt), a, bk, qk, band);
    let k3 = bhKerr(y + k2.d * (0.5 * dt), a, bk, qk, band);
    let k4 = bhKerr(y + k3.d * dt, a, bk, qk, band);
    let yn = y + (k1.d + 2.0 * k2.d + 2.0 * k3.d + k4.d) * (dt / 6.0);
    let phin = phi + (k1.dphi + 2.0 * k2.dphi + 2.0 * k3.dphi + k4.dphi) * (dt / 6.0);

    var ynn = yn;
    var phn = phin;
    if (ynn.y < 0.0) { ynn = vec4f(ynn.x, -ynn.y, ynn.z, -ynn.w); phn += axisTurn; }
    if (ynn.y > 3.14159265) { ynn = vec4f(ynn.x, 6.2831853 - ynn.y, ynn.z, -ynn.w); phn += axisTurn; }
    let p0 = bhCart(y, phi, a, cp, sp);
    let p1 = bhCart(ynn, phn, a, cp, sp);
    let seg = p1 - p0;
    let segLen = length(seg);
    let dir = seg / max(segLen, 1e-6);


    let mid = 0.5 * (p0 + p1);
    if (uniforms.jet > 0.0 && abs(mid.y) > 0.5 && length(mid.xz) < 0.9 * pow(abs(mid.y), 0.58) + segLen) {
      var j = 0.0;
      for (var s = 0; s < 4; s++) { j += bhJet(p0 + seg * ((f32(s) + 0.5) * 0.25), dir); }
      accum += trans * vec3f(0.55, 0.72, 1.0) * j * 0.25 * segLen * uniforms.jet;
    }



    if ((y.y < 1.5707963) != (yn.y < 1.5707963)) {
      let t = (y.y - 1.5707963) / (y.y - yn.y);
      let hit = mix(p0, p1, t);
      let opacity = bhDiskAlpha(0.5 * mix(y.x, yn.x, t));
      if (opacity > 0.0) {
        if (crossings < 3) {
          hp[crossings] = hit;
          hb[crossings] = bk;
          hw[crossings] = trans * opacity;
        } else {
          accum += trans * opacity * bhDisk(hit, bk, 0.0, 3.0);
        }
        trans *= 1.0 - opacity;
        crossings += 1;
      }
    }
    y = ynn;
    phi = phn;
    rd = dir;
    if (trans < 0.004) { break; }
  }

  if (uniforms.view > 4.5) { return vec4f(select(0.0,1.0,escaped), f32(crossings)/3.0, y.x/400.0, 1.0); }


  let pf = uniforms.prefilter;
  var turb = array<f32, 3>(0.0, 0.0, 0.0);
  let ph0 = bhPhase(0.0);
  let ph1 = bhPhase(1.0);
  let q00 = bhDiskCoord(hp[0], ph0.x, 0.0); let q01 = bhDiskCoord(hp[0], ph1.x, 1.0);
  let q10 = bhDiskCoord(hp[1], ph0.x, 0.0); let q11 = bhDiskCoord(hp[1], ph1.x, 1.0);
  let q20 = bhDiskCoord(hp[2], ph0.x, 0.0); let q21 = bhDiskCoord(hp[2], ph1.x, 1.0);
  let f00 = max(length(dpdx(q00)), length(dpdy(q00))) * pf; let f01 = max(length(dpdx(q01)), length(dpdy(q01))) * pf;
  let f10 = max(length(dpdx(q10)), length(dpdy(q10))) * pf; let f11 = max(length(dpdx(q11)), length(dpdy(q11))) * pf;
  let f20 = max(length(dpdx(q20)), length(dpdy(q20))) * pf; let f21 = max(length(dpdx(q21)), length(dpdy(q21))) * pf;
  turb[0] = ph0.y * bhFbm(q00, f00) + ph1.y * bhFbm(q01, f01);
  turb[1] = ph0.y * bhFbm(q10, f10) + ph1.y * bhFbm(q11, f11);
  turb[2] = ph0.y * bhFbm(q20, f20) + ph1.y * bhFbm(q21, f21);
  let dx = dpdx(rd);
  let dy = dpdy(rd);






  for (var k = 0; k < 3; k++) {
    accum += hw[k] * bhDisk(hp[k], hb[k], turb[k], f32(k));
  }

  {
    let sky = select(0.0, trans, escaped);

    let d = select(vec3f(0.0, 0.0, 1.0), normalize(rd), dot(rd, rd) > 0.0);
    var e1 = cross(vec3f(0.0, 1.0, 0.0), d);
    if (dot(e1, e1) < 1e-8) { e1 = vec3f(1.0, 0.0, 0.0); }
    e1 = normalize(e1);
    let e2 = cross(d, e1);
    let pixel = 2.0 / (camera.resolution.y * proj[1][1]);

    let jx = mix(vec2f(pixel, 0.0), vec2f(dot(dx, e1), dot(dx, e2)), pf);
    let jy = mix(vec2f(0.0, pixel), vec2f(dot(dy, e1), dot(dy, e2)), pf);
    let det = max(abs(jx.x * jy.y - jy.x * jx.y), 1e-14);
    let inv = mat2x2f(vec2f(jy.y, -jx.y), vec2f(-jy.x, jx.x)) * (1.0 / det);
    let mu = min(pixel * pixel / det, 40.0);
    let fr = BhFrame(e1, e2, inv, det, mu, pixel);
    let foot = sqrt(det) * pf;
    let starLight = bhStars(d, 140.0, 1.0, fr) + bhStars(d, 300.0, 2.0, fr) * 0.6;
    accum += sky * (starLight * uniforms.stars + bhGalaxy(d, foot) * uniforms.galaxy * select(1.0, 0.25, uniforms.view > 0.5));
  }
  return margoDisplay(vec4f(accum * uniforms.exposure, 1.0));
}
`,ct=class e{static attach(t,n={}){return o(t,a(`0.1.0`,import.meta.url)),new e(We.attach(t,{name:`shader:black-hole`}),n,!0)}constructor(e,t={},n=!1){this.paths=null,this.pathMaterial=null,this.disposed=!1,this.diskSeconds=null,this.raw=e,this.owned=n,this.material=new I({vertexShader:st,uniforms:Object.fromEntries([`spin`,`accretion`,`jet`,`jetGamma`,`turbulence`,`view`,`prefilter`,`horizon`,`isco`,`outer`,`tPeak`,`fluxNorm`,`x0`,`x1`,`x2`,`x3`,`flareStart`,`timeScale`,`diskTime`,`diskClock`,`diskInflow`,`exposure`,`steps`,`stars`,`galaxy`].map(e=>[e,{value:0}])),depthTest:!1,depthWrite:!1,cull:`none`,name:`black-hole`}),this.u(`flareStart`,-1e6),this.mesh=new z({material:this.material,vertexCount:3,renderOrder:-1e3,frustumCulled:!1}),this.spin=t.spin??.9,this.accretion=t.accretion??1,this.peakTemperature=t.peakTemperature??4500,this.diskOuter=t.diskOuter??6,this.turbulence=t.turbulence??.6,this.jet=t.jet??.5,this.jetLorentz=t.jetLorentz??5,this.stars=t.stars??1,this.galaxy=t.galaxy??1,this.timeScale=t.timeScale??6,this.diskTime=t.diskTime??null,this.diskInflow=t.diskInflow??.002,this.exposure=t.exposure??1,this.view=t.view??`beauty`,this.prefilter=t.prefilter??!0,this.steps=t.steps??260,e.add(this.mesh)}u(e,t){this.material.uniforms[e].value=t}g(e){return this.material.uniforms[e].value}get spin(){return this.g(`spin`)}set spin(e){e=K(e),this.u(`spin`,e),this.u(`horizon`,B(e)/2),this.u(`isco`,V(e)/2);let[t,n,r]=qe(Math.max(e,1e-6));this.u(`x0`,Math.sqrt(V(e))),this.u(`x1`,t),this.u(`x2`,n),this.u(`x3`,r);let i=0,a=V(e);for(let t=1;t<=400;t++)i=Math.max(i,Je(a*(1+t/400*8),e));this.u(`fluxNorm`,1/i)}get horizon(){return this.g(`horizon`)}get isco(){return this.g(`isco`)}get accretion(){return this.g(`accretion`)}set accretion(e){this.u(`accretion`,q(e,0,100))}get peakTemperature(){return this.g(`tPeak`)}set peakTemperature(e){this.u(`tPeak`,q(e,1e3,1e5))}get diskOuter(){return this.g(`outer`)}set diskOuter(e){this.u(`outer`,q(e,1.5,40))}get turbulence(){return this.g(`turbulence`)}set turbulence(e){this.u(`turbulence`,q(e,0,1))}get jet(){return this.g(`jet`)}set jet(e){this.u(`jet`,q(e,0,1))}get jetLorentz(){return this.g(`jetGamma`)}set jetLorentz(e){this.u(`jetGamma`,q(e,1.0001,20))}get stars(){return this.g(`stars`)}set stars(e){this.u(`stars`,q(e,0,100))}get galaxy(){return this.g(`galaxy`)}set galaxy(e){this.u(`galaxy`,q(e,0,100))}get timeScale(){return this.g(`timeScale`)}set timeScale(e){this.u(`timeScale`,q(e,0,1e3))}get diskTime(){return this.diskSeconds}set diskTime(e){if(e!==null&&!Number.isFinite(e))throw RangeError(`Invalid disk time; pass finite seconds or null to follow the camera clock.`);this.diskSeconds=e,this.u(`diskClock`,e===null?0:1),this.u(`diskTime`,(e??0)%24)}get diskInflow(){return this.g(`diskInflow`)}set diskInflow(e){this.u(`diskInflow`,q(e,0,1))}get exposure(){return this.g(`exposure`)}set exposure(e){this.u(`exposure`,q(e,0,1e4))}get view(){return Ge[this.g(`view`)]}set view(e){let t=Ge.indexOf(e);if(t<0)throw RangeError(`BlackHole view must be one of ${Ge.join(`, `)}`);this.u(`view`,t)}get prefilter(){return this.g(`prefilter`)>0}set prefilter(e){this.u(`prefilter`,+!!e)}get steps(){return this.g(`steps`)}set steps(e){this.u(`steps`,Math.round(q(e,32,1024)))}flare(e){this.u(`flareStart`,q(e,-1e9,1e9))}showGeodesics(e){this.paths&&=(this.raw.remove(this.paths),null);let t=[],n=[];for(let r of e){let e=r.fate===`horizon`?[1,.25,.2]:r.disk.length?[1,.7,.3]:[.35,.65,1],i=r.points;for(let r=3;r<i.length;r+=3)t.push(i[r-3],i[r-2],i[r-1],i[r],i[r+1],i[r+2]),n.push(...e,...e)}t.length&&(this.pathMaterial??=new I({vertexShader:`
struct PathOut { @builtin(position) clip:vec4f, @location(0) color:vec3f }
@vertex fn vertex(a:Attributes)->PathOut { return PathOut(camera.viewProjection * mesh.world * vec4f(a.position, 1.0), a.color); }
@fragment fn fragment(i:PathOut)->@location(0) vec4f { return margoDisplay(vec4f(i.color * 0.9, 1.0)); }`,depthTest:!1,depthWrite:!1,transparent:!0,blending:`additive`,cull:`none`,name:`black-hole-geodesics`}),this.paths=this.raw.add(new z({material:this.pathMaterial,attributes:{position:{data:new Float32Array(t),type:`vec3f`},color:{data:new Float32Array(n),type:`vec3f`}},topology:`line-list`,frustumCulled:!1})))}dispose(){this.disposed||(this.disposed=!0,this.paths&&this.raw.remove(this.paths),this.raw.remove(this.mesh),this.material.dispose(),this.pathMaterial?.dispose(),this.owned&&this.raw.dispose())}[Symbol.dispose](){this.dispose()}},lt=new URLSearchParams(location.search).get(`ui`)!==`0`;lt||(document.querySelector(`#panel`).hidden=!0);var ut=[{pos:[-.55,.95,11.8],target:[0,-.05,0]},{pos:[0,.12,12.5],target:[0,0,0]},{pos:[.3,9.5,6.2],target:[0,0,0]},{pos:[-2.1,.52,6.4],target:[-.35,0,0]}],J=await i(`#viewport`,{backend:`webgpu`,controls:!1,autoStart:!1,label:`Event Horizon: a spinning black hole`,camera:{position:ut[0].pos,target:ut[0].target,fov:38,near:.05,far:1e3},onError:e=>{document.querySelector(`#error`).textContent=String(e)}});C(J.engine),n.attach(J.engine,[new t({strength:.18,threshold:1.1,exposure:0}),new r({curve:`agx`,exposure:.1,contrast:1.06,vignette:.2})]);var Y=ct.attach(J.engine,{spin:.9,accretion:1,jet:.5}),X=0,dt=-1;function ft(e){if(e===X&&Y.spin===dt)return;X=e,dt=Y.spin;let t=[];for(let n=0;n<e;n++){let r=-6+12*(n+.5)/e;t.push(ot([0,r,30],[0,0,-1],{spin:Y.spin,diskOuter:Y.diskOuter}))}Y.showGeodesics(t)}var pt=[`beauty`,`redshift`,`beaming`,`temperature`,`orders`];function mt(e){let t=e.properties?.hole;t&&(t.spin!==void 0&&(Y.spin=t.spin),t.accretion!==void 0&&(Y.accretion=t.accretion),t.jet!==void 0&&(Y.jet=t.jet),t.turbulence!==void 0&&(Y.turbulence=t.turbulence),t.exposure!==void 0&&(Y.exposure=t.exposure),t.peakTemperature!==void 0&&(Y.peakTemperature=t.peakTemperature),t.view!==void 0&&(Y.view=pt[Math.min(Math.max(Math.round(t.view),0),4)]),t.prefilter!==void 0&&(Y.prefilter=t.prefilter>=.5),t.paths!==void 0&&ft(Math.round(t.paths)),t.flareAge!==void 0&&Y.flare(performance.now()/1e3-t.flareAge),ht())}var Z=e=>document.querySelector(e);function ht(){let e=Y.spin;Z(`#telemetry`).textContent=`horizon ${B(e).toFixed(2)} M, ISCO ${V(e).toFixed(2)} M, photon orbit ${Ke(e).toFixed(2)} M`}function gt(e,t){let n=Z(`#${e}`),r=Z(`#${e}-out`);n.addEventListener(`input`,()=>{t(Number(n.value)),r.value=Number(n.value).toFixed(2),X&&ft(X),ht()})}gt(`spin`,e=>Y.spin=e),gt(`accretion`,e=>Y.accretion=e),gt(`jet`,e=>Y.jet=e),document.querySelectorAll(`[data-view]`).forEach(e=>e.addEventListener(`click`,()=>{Y.view=e.dataset.view,document.querySelectorAll(`[data-view]`).forEach(t=>t.setAttribute(`aria-pressed`,String(t===e)))}));var _t=(e,t)=>Z(`#${e}`).addEventListener(`click`,e=>{let n=e.currentTarget,r=n.getAttribute(`aria-pressed`)!==`true`;n.setAttribute(`aria-pressed`,String(r)),t(r)});_t(`paths`,e=>ft(e?24:0)),_t(`filter`,e=>Y.prefilter=e),Z(`#flare`).addEventListener(`click`,()=>Y.flare(performance.now()/1e3)),Z(`#panel`).addEventListener(`submit`,e=>e.preventDefault()),ht();var Q=lt?new e(J.engine.camera,J.canvas):null;Q&&(Q.enableDamping=!0,Q.dampingFactor=.06,Q.enablePan=!1,Q.minDistance=2.2,Q.maxDistance=120);var $=null;document.querySelectorAll(`[data-cam]`).forEach(e=>e.addEventListener(`click`,()=>$=ut[Number(e.dataset.cam)])),J.canvas.addEventListener(`pointerdown`,()=>$=null),J.canvas.addEventListener(`wheel`,()=>$=null,{passive:!0});var vt=Z(`#viewport`);J.use({name:`event-horizon`,setup(){},onPreUpdate(e){let t=Math.min(e,.1),n=J.engine.camera;if($&&Q){let e=Math.min(1,t*4),r=$,i=(t,n)=>[t[0]+(n[0]-t[0])*e,t[1]+(n[1]-t[1])*e,t[2]+(n[2]-t[2])*e];n.position=i(n.position,r.pos),n.target=i(n.target,r.target),Q.target=n.target,Math.hypot(...r.pos.map((e,t)=>e-n.position[t]))<.01&&($=null)}Q?.update(t),Y.raw.stats.drawCalls>0&&Y.raw.stats.pending===0&&vt.dataset.ready!==`true`&&(vt.dataset.ready=`true`,document.querySelector(`#status`)?.remove())},dispose:()=>Q?.dispose()}),window.eventHorizon={engine:J.engine,hole:Y,apply:mt},J.engine.start(),window.addEventListener(`pagehide`,()=>J.dispose(),{once:!0});