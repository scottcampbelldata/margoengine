const __vite__mapDeps=(i,m=__vite__mapDeps,d=(m.f||(m.f=["./load-C59tSXhq.js","./index-DHc82pzd.js","./index-Fu--_tEU.css","./errors-DkwPZuAq.js"])))=>i.map(i=>d[i]);
import{a as e,i as t,o as n,r,t as i}from"./index-DHc82pzd.js";import{t as a}from"./errors-DkwPZuAq.js";var o=(n,i=e,a=import.meta.url)=>(r(n,t(i,a)),n),s=e=>e,c=(e,t=`1.0.0`,n=import.meta.url)=>o(e,t,n),l=Object.defineProperty,u=(e,t)=>{let n={};for(var r in e)l(n,r,{get:e[r],enumerable:!0});return t||l(n,Symbol.toStringTag,{value:`Module`}),n},d=new Float32Array(1),f=new Uint32Array(d.buffer);function p(e){d[0]=e;let t=Math.abs(e)-Math.abs(d[0]);(t>0||t<0)&&!(f[0]&1)&&(f[0]+=t>0?1:-1);let n=f[0],r=n>>>16&32768,i=n>>>23&255,a=n&8388607;if(i===255)return r|31744|(a?512:0);let o=i-127+15;if(o>=31)return r|31744;if(o<=0){if(o<-10)return r;let e=(a|8388608)>>>1-o+13,t=(a|8388608)&(1<<1-o+13)-1,n=1<<1-o+12;return r|e+(t>n||t===n&&e&1?1:0)}let s=a>>>13,c=a&8191,l=r|o<<10|s;return(c>4096||c===4096&&s&1)&&l++,l}function m(e){return p(e)}var h=65504,g=6e4;function _(e){let t=v(e);return t>6e4?Math.fround(t/g):1}function v(e){let t=0;for(let n=0;n<e.length;n++){let r=e[n];r>t&&r<1/0&&(n&3)!=3&&(t=r)}return t}function y(e,t=!0,n=1){let r=t?globalThis.Float16Array:void 0,i=r?new r(e.length):new Uint16Array(e.length),a=1/n;for(let t=0;t<e.length;t++){let n=Math.min(b(e,t,a),h);i[t]=r?n:m(n)}return r?new Uint16Array(i.buffer):i}var b=(e,t,n)=>{let r=e[t];return r>0&&r<1/0?n===1||(t&3)==3?r:Math.fround(r*n):0};function x(e,t=1){let n=new Float32Array(e.length),r=1/t;for(let t=0;t<e.length;t++)n[t]=b(e,t,r);return n}var S=[.282094792,.488602512,.488602512,.488602512,1.092548431,1.092548431,.315391565,1.092548431,.546274215];function C(e,t,n,r=new Float64Array(9)){return r[0]=S[0],r[1]=S[1]*t,r[2]=S[2]*n,r[3]=S[3]*e,r[4]=S[4]*e*t,r[5]=S[5]*t*n,r[6]=S[6]*(3*n*n-1),r[7]=S[7]*e*n,r[8]=S[8]*(e*e-t*t),r}function w(e,t){let n=Math.hypot(t[0],t[1],t[2])||1,r=C(t[0]/n,t[1]/n,t[2]/n),i=[0,0,0];for(let t=0;t<9;t++)for(let n=0;n<3;n++)i[n]+=e[t*3+n]*r[t];return i}var T=`fn pbrNeutral(input:vec3f)->vec3f {let x=min(input.r,min(input.g,input.b));let offset=select(0.04,x-6.25*x*x,x<0.08);var v=input-offset;let peak=max(v.r,max(v.g,v.b));if(peak<0.76){return v;}let newPeak=1.0-0.24*0.24/(peak+0.24-0.76);v*=newPeak/peak;return mix(v,vec3f(newPeak),1.0-1.0/(0.15*(peak-newPeak)+1.0));}
fn toDisplay(c:vec3f)->vec3f {let x=pbrNeutral(max(c,vec3f(0)));return select(x*12.92,1.055*pow(x,vec3f(1.0/2.4))-0.055,x>=vec3f(0.0031308));}
`,E=`2.0*nl*nv/max(nl*sqrt(a2+(1.0-a2)*nv*nv)+nv*sqrt(a2+(1.0-a2)*nl*nl),1e-30)`,D=(e,t,n=`nh`,r=`a2`)=>`(max(dot(cross(${e},${t}),cross(${e},${t})),step(${n},0.0))+${r}*${n}*${n})`,O=`
const PI = 3.141592653589793;
fn faceDirection(face: u32, uv: vec2f) -> vec3f {
  var d = vec3f(-uv.x, -uv.y, -1.0);
  if (face == 0u) { d = vec3f(1.0, -uv.y, -uv.x); }
  else if (face == 1u) { d = vec3f(-1.0, -uv.y, uv.x); }
  else if (face == 2u) { d = vec3f(uv.x, 1.0, uv.y); }
  else if (face == 3u) { d = vec3f(uv.x, -1.0, -uv.y); }
  else if (face == 4u) { d = vec3f(uv.x, -uv.y, 1.0); }
  return d;
}
fn equirectUv(d: vec3f) -> vec2f {
  let x = select(d.x, 0.0, d.x == 0.0);
  let z = select(-d.z, 0.0, d.z == 0.0);
  return vec2f(0.5 + atan2(x, z) / (2.0 * PI), acos(clamp(d.y, -1.0, 1.0)) / PI);
}
fn hammersley(i: u32, n: u32) -> vec2f {
  return vec2f(f32(i) / f32(n), f32(reverseBits(i)) * 2.3283064365386963e-10);
}
fn importanceGGX(xi: vec2f, alpha: f32) -> vec3f {
  let phi = 2.0 * PI * xi.x;
  let d = (1.0 - xi.y) + alpha * alpha * xi.y;
  let cosTheta = sqrt((1.0 - xi.y) / d);
  let sinTheta = alpha * sqrt(xi.y / d);
  return vec3f(sinTheta * cos(phi), sinTheta * sin(phi), cosTheta);
}
`,k=u({backgroundShader:()=>I,brdfLut:()=>P,common:()=>O,downsample:()=>j,equirectToCube:()=>A,imageBackground:()=>L,prefilter:()=>M,sphericalHarmonics:()=>N}),A=O+`
@group(0) @binding(0) var source: texture_2d<f32>;
@group(0) @binding(1) var linearSampler: sampler;
@group(0) @binding(2) var destination: texture_storage_2d_array<rgba16float, write>;
@group(0) @binding(3) var<uniform> params: vec4u;
@compute @workgroup_size(8, 8, 1) fn main(@builtin(global_invocation_id) id: vec3u) {
  let size = params.x;
  if (id.x >= size || id.y >= size) { return; }
  let n = params.y;
  var sum = vec3f(0.0);
  for (var j = 0u; j < n; j++) {
    for (var i = 0u; i < n; i++) {
      let uv = (vec2f(id.xy) + (vec2f(f32(i), f32(j)) + 0.5) / f32(n)) / f32(size) * 2.0 - 1.0;
      sum += textureSampleLevel(source, linearSampler, equirectUv(normalize(faceDirection(id.z, uv))), 0.0).rgb;
    }
  }
  textureStore(destination, id.xy, id.z, vec4f(sum / f32(n * n), 1.0));
}
`,j=`
@group(0) @binding(0) var source: texture_2d_array<f32>;
@group(0) @binding(1) var destination: texture_storage_2d_array<rgba16float, write>;
@compute @workgroup_size(8, 8, 1) fn main(@builtin(global_invocation_id) id: vec3u) {
  let size = textureDimensions(destination).x;
  if (id.x >= size || id.y >= size) { return; }
  let p = id.xy * 2u;
  let c = textureLoad(source, p, id.z, 0) + textureLoad(source, p + vec2u(1u, 0u), id.z, 0)
        + textureLoad(source, p + vec2u(0u, 1u), id.z, 0) + textureLoad(source, p + vec2u(1u, 1u), id.z, 0);
  textureStore(destination, id.xy, id.z, vec4f(c.rgb * 0.25, 1.0));
}
`,M=O+`
struct Params { roughness: f32, sourceSize: f32, samples: u32, lod0: f32, face: u32, size: f32 }
@group(0) @binding(0) var source: texture_cube<f32>;
@group(0) @binding(1) var linearSampler: sampler;
@group(0) @binding(2) var<uniform> params: Params;
@vertex fn vertexMain(@builtin(vertex_index) index: u32) -> @builtin(position) vec4f {
  return vec4f(vec2f(f32((index << 1u) & 2u), f32(index & 2u)) * 2.0 - 1.0, 0.0, 1.0);
}
@fragment fn fragmentMain(@builtin(position) position: vec4f) -> @location(0) vec4f {
  let uv = position.xy / params.size * 2.0 - 1.0;
  let n = normalize(faceDirection(params.face, uv));
  var color = vec3f(0.0);
  if (params.roughness <= 0.0) {
    color = textureSampleLevel(source, linearSampler, n, params.lod0).rgb;
  } else {
    let up = select(vec3f(1.0, 0.0, 0.0), vec3f(0.0, 0.0, 1.0), abs(n.z) < 0.999);
    let t = normalize(cross(up, n));
    let b = cross(n, t);
    let alpha = params.roughness * params.roughness;
    let a2 = alpha * alpha;
    let texelSolidAngle = 4.0 * PI / (6.0 * params.sourceSize * params.sourceSize);
    var weight = 0.0;
    for (var i = 0u; i < params.samples; i++) {
      let hl = importanceGGX(hammersley(i, params.samples), alpha);
      let h = t * hl.x + b * hl.y + n * hl.z;
      let l = 2.0 * hl.z * h - n;
      let nl = dot(n, l);
      if (nl > 0.0) {
        let q = ${D(`vec3f(0.0, 0.0, 1.0)`,`hl`,`hl.z`)};
        let pdf = a2 / (PI * q * q) * 0.25;
        let sampleSolidAngle = 1.0 / (f32(params.samples) * pdf + 1e-6);
        let lod = max(0.5 * log2(sampleSolidAngle / texelSolidAngle) + 1.0, params.lod0);
        color += textureSampleLevel(source, linearSampler, l, lod).rgb * nl;
        weight += nl;
      }
    }
    color /= max(weight, 1e-6);
  }
  return vec4f(color, 1.0);
}
`,N=O+`
@group(0) @binding(0) var source: texture_2d_array<f32>;
@group(0) @binding(1) var<storage, read_write> result: array<vec4f, 32>;
var<workgroup> partial: array<vec4f, 576>;
fn areaElement(x: f32, y: f32) -> f32 { return atan(x * y / sqrt(x * x + y * y + 1.0)); }
@compute @workgroup_size(64) fn main(@builtin(local_invocation_index) li: u32) {
  let size = textureDimensions(source).x;
  let faceTexels = size * size;
  let inv = 1.0 / f32(size);
  var acc: array<vec3f, 9>;
  for (var i = li; i < faceTexels * 6u; i += 64u) {
    let face = i / faceTexels;
    let rem = i % faceTexels;
    let x = rem % size;
    let y = rem / size;
    let u0 = f32(x) * 2.0 * inv - 1.0;
    let v0 = f32(y) * 2.0 * inv - 1.0;
    let u1 = u0 + 2.0 * inv;
    let v1 = v0 + 2.0 * inv;
    let solidAngle = areaElement(u0, v0) - areaElement(u0, v1) - areaElement(u1, v0) + areaElement(u1, v1);
    let d = normalize(faceDirection(face, vec2f(u0 + inv, v0 + inv)));
    let c = textureLoad(source, vec2u(x, y), face, 0).rgb * solidAngle;
    acc[0] += c * 0.282094792;
    acc[1] += c * (0.488602512 * d.y);
    acc[2] += c * (0.488602512 * d.z);
    acc[3] += c * (0.488602512 * d.x);
    acc[4] += c * (1.092548431 * d.x * d.y);
    acc[5] += c * (1.092548431 * d.y * d.z);
    acc[6] += c * (0.315391565 * (3.0 * d.z * d.z - 1.0));
    acc[7] += c * (1.092548431 * d.x * d.z);
    acc[8] += c * (0.546274215 * (d.x * d.x - d.y * d.y));
  }
  for (var k = 0u; k < 9u; k++) { partial[li * 9u + k] = vec4f(acc[k], 0.0); }
  workgroupBarrier();
  for (var stride = 32u; stride > 0u; stride >>= 1u) {
    if (li < stride) {
      for (var k = 0u; k < 9u; k++) { partial[li * 9u + k] += partial[(li + stride) * 9u + k]; }
    }
    workgroupBarrier();
  }
  if (li == 0u) {
    for (var k = 0u; k < 9u; k++) {
      let band = select(select(0.25, 2.0 / 3.0, k < 4u), 1.0, k == 0u);
      result[k] = vec4f(partial[k].xyz * band, 0.0);
      result[16u + k] = vec4f(partial[k].xyz, 0.0);
    }
  }
}
`,P=O+`
@group(0) @binding(0) var<storage, read_write> destination: array<u32>;
@group(0) @binding(1) var<uniform> params: vec4u;
@compute @workgroup_size(8, 8, 1) fn main(@builtin(global_invocation_id) id: vec3u) {
  let size = params.y;
  if (id.x >= size || id.y >= size) { return; }
  let nv = (f32(id.x) + 0.5) / f32(size);
  let roughness = (f32(id.y) + 0.5) / f32(size);
  let alpha = roughness * roughness;
  let a2 = alpha * alpha;
  let v = vec3f(sqrt(1.0 - nv * nv), 0.0, nv);
  var scale = 0.0;
  var bias = 0.0;
  let samples = params.x;
  for (var i = 0u; i < samples; i++) {
    let h = importanceGGX(hammersley(i, samples), alpha);
    let vh = clamp(dot(v, h), 0.0, 1.0);
    let l = 2.0 * vh * h - v;
    if (l.z > 0.0 && vh > 0.0) {
      let nl = l.z;
      let g = ${E};
      let visibility = g * vh / (h.z * nv);
      let fc = pow(1.0 - vh, 5.0);
      scale += (1.0 - fc) * visibility;
      bias += fc * visibility;
    }
  }
  destination[id.y * size + id.x] = pack2x16float(vec2f(scale, bias) / f32(samples));
}
`,F=`override outputHdr: bool = false;
struct Varyings { @builtin(position) position: vec4f, @location(0) ndc: vec2f }
@vertex fn vertexMain(@builtin(vertex_index) index: u32) -> Varyings {
  let p = vec2f(f32((index << 1u) & 2u), f32(index & 2u)) * 2.0 - 1.0;
  var out: Varyings;
  out.position = vec4f(p, 0.0, 1.0);
  out.ndc = p;
  return out;
}
`,I=(e=``)=>O+`
struct Uniforms { inverseViewProjection: mat4x4f, eye: vec4f, params: vec4f, mode: vec4u, ground: vec4f, dome: vec4f }
@group(0) @binding(0) var<uniform> u: Uniforms;
@group(0) @binding(1) var linearSampler: sampler;
@group(0) @binding(2) var equirect: texture_2d<f32>;
@group(0) @binding(3) var cube: texture_cube<f32>;
@group(0) @binding(4) var specular: texture_cube<f32>;
${F}${T}${e}
@fragment fn fragmentMain(v: Varyings) -> @location(0) vec4f {
  let world = u.inverseViewProjection * vec4f(v.ndc, 0.5, 1.0);
  let ray = ${e?`project(`:`(`}normalize(world.xyz / world.w - u.eye.xyz));
  let c = u.params.y;
  let s = u.params.z;
  let d = vec3f(c * ray.x - s * ray.z, ray.y, s * ray.x + c * ray.z);
  var color: vec3f;
  if (u.mode.x == 0u) {
    color = textureSampleLevel(equirect, linearSampler, equirectUv(d), 0.0).rgb;
  } else if (u.mode.x == 1u) {
    color = textureSampleLevel(cube, linearSampler, d, 0.0).rgb;
  } else {
    color = textureSampleLevel(specular, linearSampler, d, u.params.w).rgb;
  }
  color *= u.params.x;
  if (outputHdr) { return vec4f(color, 1.0); }
  return vec4f(toDisplay(color), 1.0);
}
`,L=e=>O+`
struct Uniforms { inverseViewProjection: mat4x4f, eye: vec4f, params: vec4f }
@group(0) @binding(0) var<uniform> u: Uniforms;
@group(0) @binding(1) var imageSampler: sampler;
@group(0) @binding(2) var image: ${e===`box`?`texture_cube`:`texture_2d`}<f32>;
${F}fn cylinderUv(d: vec3f) -> vec2f {
  return vec2f(equirectUv(d).x, clamp(0.5 - d.y / (u.params.z * max(length(d.xz), 1e-6)), 0.0, 1.0));
}
@fragment fn fragmentMain(v: Varyings) -> @location(0) vec4f {
  let world = u.inverseViewProjection * vec4f(v.ndc, 0.5, 1.0);
  let ray = normalize(world.xyz / world.w - u.eye.xyz);
  let d = vec3f(u.params.x * ray.x - u.params.y * ray.z, ray.y, u.params.y * ray.x + u.params.x * ray.z);
  let color = textureSampleLevel(image, imageSampler, ${{box:`d`,sphere:`equirectUv(d)`,cylinder:`cylinderUv(d)`}[e]}, 0.0).rgb;
  if (outputHdr) { return vec4f(color, 1.0); }
  return vec4f(select(color * 12.92, 1.055 * pow(color, vec3f(1.0 / 2.4)) - 0.055, color >= vec3f(0.0031308)), 1.0);
}
`,R=Symbol.for(`@margoengine/environment lost rebuild`),z=Symbol.for(`@margoengine/environment restore reported`);function B(){return Object.assign(new a(`failed`,`Environment rebuild stopped: its GPU device was lost; the restore onto the next device rebuilds it; see https://margoengine.com/errors#gpu-lost`),{[R]:!0})}function V(e,t){let n=t;n?.[R]||n?.[z]||(n&&typeof n==`object`&&Object.defineProperty(n,z,{value:!0}),e.onError(t))}function H(e,t,n){return e.value=t,e.device=typeof t==`function`?void 0:n,e.made=void 0,e.told=!1,e}var ee=(e,t,n,r)=>H({name:t,setter:n},e,r);function te(e,t,r){let{value:i}=e;if(typeof i==`function`)return e.device!==t&&(e.made=i(e.device=t)),e.made;if(i!=null){if(e.device??=t,e.device===t)return i;e.told||(e.told=!0,r?.onError(n(`state`,`${e.name} lost with the device; pass a function or call ${e.setter}`,`borrowed-lost`)))}}var U=new WeakMap;function ne(e,t){if(--t.users)return;let n=U.get(e);n?.get(t.key)===t&&n.delete(t.key),t.buffer.destroy()}var re=new WeakMap;function ie(e,t,n){let r=re.get(e);r||re.set(e,r=new Map);let i=r.get(t);return i||r.set(t,i=n()),i}var ae=(e,t)=>ie(e,t,()=>e.createComputePipeline({layout:`auto`,compute:{module:e.createShaderModule({code:k[t]}),entryPoint:`main`}})),oe=e=>ie(e,`prefilter`,()=>{let t=e.createShaderModule({code:M});return e.createRenderPipeline({layout:`auto`,vertex:{module:t,entryPoint:`vertexMain`},fragment:{module:t,entryPoint:`fragmentMain`,targets:[{format:`rgba16float`}]},primitive:{topology:`triangle-list`}})}),W=e=>Number.isInteger(e)&&e>0&&!(e&e-1),se=e=>2**Math.floor(Math.log2(Math.max(1,e))),G=e=>`faces`in e,K=e=>`texture`in e,ce=e=>typeof e.createTexture==`function`,le=new WeakSet,ue=new WeakSet;function de(e){ue.has(e)||(ue.add(e),e.lost?.then(()=>le.add(e)))}function q(e){if(ce(e))return e;let t=c(e).gpu;if(!t)throw new a(`unsupported`,`Environment requires the WebGPU backend; use an engine on the WebGPU backend`);return t}function J(e){if(!e||typeof e!=`object`)throw TypeError(`Expected an equirect FloatImage or CubeFaces`);if(K(e)){let t=e.texture;if(typeof t?.createView!=`function`||t.format!==`rgba16float`||t.width!==t.height||!W(t.width)||t.depthOrArrayLayers!==6||!(t.usage&GPUTextureUsage.COPY_SRC))throw TypeError(`A GPU cube source needs a square power-of-two rgba16float texture with 6 layers and COPY_SRC usage; pass a CubeCamera`)}else if(G(e)){if(!W(e.size)||e.faces.length!==6||e.faces.some(t=>!(t instanceof Float32Array)||t.length!==e.size*e.size*4))throw TypeError(`CubeFaces needs a power-of-two size and six Float32Array RGBA faces of size*size*4`)}else if(!(e.data instanceof Float32Array)||!Number.isSafeInteger(e.width)||!Number.isSafeInteger(e.height)||!(e.width>0&&e.height>0)||e.data.length!==e.width*e.height*4)throw TypeError(`Equirect FloatImage needs width, height and RGBA Float32Array data of width*height*4`)}function fe(e,t,n){let r=se(e.limits.maxTextureDimension2D),i=K(t)?t.texture.width:G(t)?t.size:void 0;if(i!==void 0&&n.size!==void 0&&n.size!==i)throw RangeError(`CubeFaces size must equal the environment size`);let a=i??n.size??Math.min(1024,r,Math.max(16,se(t.width/4)));if(!W(a)||a>r)throw RangeError(`Environment size must be a power of two up to ${r}`);let o=n.specularSize??Math.min(256,a);if(!W(o)||o>a)throw RangeError(`specularSize must be a power of two no larger than size`);let s=Math.log2(o)+1,c=n.specularMips??Math.min(s,Math.max(2,Math.log2(o)-2));if(!Number.isInteger(c)||c<1||c>s)throw RangeError(`specularMips must be an integer from 1 to ${s}`);let l=(e,t,n,r,i)=>{let a=e??t;if(!Number.isInteger(a)||a<n||a>r)throw RangeError(`${i} must be an integer from ${n} to ${r}`);return a};return{size:a,specularSize:o,specularMips:c,samples:l(n.samples,256,1,65536,`samples`),brdfSize:l(n.brdfSize,128,1,4096,`brdfSize`),brdfSamples:l(n.brdfSamples,512,1,65536,`brdfSamples`),shSize:l(n.shSize,64,1,4096,`shSize`),float32:n.float32??!0,keepEquirect:n.keepEquirect??!0}}function pe(e,t){let{width:n,height:r,data:i}=e;for(;n>t||r>t;){let e=Math.max(1,n>>1),t=Math.max(1,r>>1),a=new Float32Array(e*t*4);for(let o=0;o<t;o++)for(let t=0;t<e;t++)for(let s=0;s<4;s++){let c=0;for(let e=0;e<2;e++)for(let a=0;a<2;a++)c+=i[(Math.min(r-1,o*2+e)*n+Math.min(n-1,t*2+a))*4+s];a[(o*e+t)*4+s]=c/4}n=e,r=t,i=a}return{width:n,height:r,data:i}}async function me(e,t){e.pushErrorScope(`out-of-memory`),e.pushErrorScope(`validation`);let n;try{t()}catch(e){n=e}let r=e.popErrorScope(),i=e.popErrorScope(),o=await r.catch(()=>null)??await i.catch(()=>null);if(n)throw n;if(o)throw new a(`failed`,`Environment processing failed: ${o.message}; check the source texture size and format, or use a smaller size`)}var he=()=>new a(`disposed`,`Environment is disposed; create a new Environment`);async function ge(e,t,n,r,i,o,s){let c=[],l,u=!1,d=()=>{if(!u){u=!0;for(let e of c)e.destroy();l&&!o&&ne(e,l)}},f=()=>{if(s?.aborted)throw he()};s?.addEventListener(`abort`,d,{once:!0});let p=e=>(c.push(e),e),{size:m,specularSize:g,specularMips:b}=n,S=Math.log2(m)+1,C=GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.STORAGE_BINDING|GPUTextureUsage.COPY_SRC|GPUTextureUsage.COPY_DST,w=GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.RENDER_ATTACHMENT|GPUTextureUsage.COPY_SRC,T=t=>{let n=p(e.createBuffer({size:Math.max(16,t.byteLength),usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST}));return e.queue.writeBuffer(n,0,t),n},E=(e,t)=>e.createView({dimension:`2d-array`,baseMipLevel:t,mipLevelCount:1}),D=e=>Math.ceil(e/8),O=(t,n,r,i,a,o)=>{let s=ae(e,n),c=t.beginComputePass({label:`environment ${n}`});c.setPipeline(s),c.setBindGroup(0,e.createBindGroup({layout:s.getBindGroupLayout(0),entries:r})),c.dispatchWorkgroups(i,a,o),c.end()},k,A,j,M,N,P,F,I,L,R,z=1,B=h,V=[];try{f(),await me(e,()=>{o?{sampler:P,cube:k,specular:A,brdf:j,lut:l,sh:M,params:N}=o:(P=e.createSampler({label:`environment`,magFilter:`linear`,minFilter:`linear`,mipmapFilter:`linear`}),k=p(e.createTexture({label:`environment source cube`,size:[m,m,6],mipLevelCount:S,format:`rgba16float`,usage:C})),A=p(e.createTexture({label:`environment specular`,size:[g,g,6],mipLevelCount:b,format:`rgba16float`,usage:w})),M=p(e.createBuffer({label:`environment SH`,size:512,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_SRC})),N=p(e.createBuffer({label:`environment params`,size:16,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST}))),F=p(e.createBuffer({size:512,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ}));let a=K(t)||G(t)?void 0:pe(t,e.limits.maxTextureDimension2D);z=a?_(a.data):G(t)?Math.max(...t.faces.map(_)):1;let s=a?v(a.data):G(t)?Math.max(...t.faces.map(v)):0;B=a||G(t)?Math.min(h,s/z):h,e.queue.writeBuffer(N,0,new Float32Array([Math.cos(r),Math.sin(r),b-1,i*z]));let c=e.createCommandEncoder({label:`environment source cube`});if(K(t))c.copyTextureToTexture({texture:t.texture,mipLevel:0},{texture:k,mipLevel:0},[m,m,6]);else if(G(t))for(let n=0;n<6;n++)e.queue.writeTexture({texture:k,origin:{x:0,y:0,z:n}},y(t.faces[n],!0,z),{bytesPerRow:t.size*8,rowsPerImage:t.size},[t.size,t.size,1]);else if(a){let t=n.float32&&e.features.has(`float32-filterable`);I=p(e.createTexture({label:`environment equirect`,size:[a.width,a.height],format:t?`rgba32float`:`rgba16float`,usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST}));let r=t?x(a.data,z):y(a.data,!0,z);e.queue.writeTexture({texture:I},r,{bytesPerRow:a.width*(t?16:8),rowsPerImage:a.height},[a.width,a.height]),L=I.createView();let i=Math.min(4,Math.max(1,Math.ceil(a.width/(4*m)))),o=T(new Uint32Array([m,i,0,0]));V.push(o),O(c,`equirectToCube`,[{binding:0,resource:L},{binding:1,resource:e.createSampler({magFilter:`linear`,minFilter:`linear`,addressModeU:`repeat`})},{binding:2,resource:E(k,0)},{binding:3,resource:{buffer:o}}],D(m),D(m),6)}for(let e=1;e<S;e++)O(c,`downsample`,[{binding:0,resource:E(k,e-1)},{binding:1,resource:E(k,e)}],D(m>>e),D(m>>e),6);e.queue.submit([c.finish()])}),f(),await me(e,()=>{let t=e.createCommandEncoder({label:`environment lighting`});R=k.createView({dimension:`cube`});let r=oe(e),i=p(e.createBuffer({size:256*b*6,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST}));V.push(i);let a=new ArrayBuffer(256*b*6),s=new DataView(a);for(let e=0;e<b;e++)for(let t=0;t<6;t++){let r=b>1?e/(b-1):0,i=g>>e,a=(e*6+t)*256;s.setFloat32(a,r,!0),s.setFloat32(a+4,m,!0),s.setUint32(a+8,n.samples,!0),s.setFloat32(a+12,Math.log2(m/i),!0),s.setUint32(a+16,t,!0),s.setFloat32(a+20,i,!0)}e.queue.writeBuffer(i,0,a);for(let n=0;n<b;n++)for(let a=0;a<6;a++){let o=t.beginRenderPass({label:`environment prefilter`,colorAttachments:[{view:A.createView({dimension:`2d`,baseMipLevel:n,mipLevelCount:1,baseArrayLayer:a,arrayLayerCount:1}),loadOp:`clear`,storeOp:`store`,clearValue:[0,0,0,1]}]});o.setPipeline(r),o.setBindGroup(0,e.createBindGroup({layout:r.getBindGroupLayout(0),entries:[{binding:0,resource:R},{binding:1,resource:P},{binding:2,resource:{buffer:i,offset:(n*6+a)*256,size:32}}]})),o.draw(3),o.end()}let c=Math.max(0,Math.log2(m)-Math.floor(Math.log2(Math.min(n.shSize,m))));if(O(t,`sphericalHarmonics`,[{binding:0,resource:E(k,c)},{binding:1,resource:{buffer:M}}],1,1,1),!o){let r=U.get(e);r||U.set(e,r=new Map);let i=`${n.brdfSize}:${n.brdfSamples}`;if(l=r.get(i),l)l.users++;else{let a=e.createBuffer({label:`environment BRDF LUT`,size:n.brdfSize*n.brdfSize*4,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC});r.set(i,l={buffer:a,users:1,key:i});let o=T(new Uint32Array([n.brdfSamples,n.brdfSize,0,0]));V.push(o),O(t,`brdfLut`,[{binding:0,resource:{buffer:a}},{binding:1,resource:{buffer:o}}],D(n.brdfSize),D(n.brdfSize),1)}j=l.buffer}t.copyBufferToBuffer(M,0,F,0,512),e.queue.submit([t.finish()])}),f(),await F.mapAsync(GPUMapMode.READ),f();let s=new Float32Array(F.getMappedRange().slice(0));F.unmap(),F.destroy();for(let e of V)e.destroy();!n.keepEquirect&&I&&(I.destroy(),I=void 0,L=void 0);let c=new Float32Array(27),u=new Float32Array(27);for(let e=0;e<9;e++)for(let t=0;t<3;t++)u[e*3+t]=s[e*4+t],c[e*3+t]=s[64+e*4+t];if(!c.every(Number.isFinite))throw new a(`failed`,`Environment processing produced non-finite SH; check the source image for NaN or infinite texels`);return o?(o.radiance.set(c),o.irradiance.set(u),o.radianceScale=z,o.storedPeak=B,o):{device:e,cube:k,cubeView:R,specular:A,specularView:A.createView({dimension:`cube`}),brdf:j,lut:l,equirect:I,equirectView:L,sampler:P,sh:M,params:N,radiance:c,irradiance:u,radianceScale:z,storedPeak:B}}catch(t){if(l&&!o&&!u){let t=U.get(e);t?.get(l.key)===l&&t.delete(l.key)}throw d(),s?.aborted?he():t}finally{s?.removeEventListener(`abort`,d)}}function Y(e){e&&(e.cube.destroy(),e.specular.destroy(),ne(e.device,e.lut),e.equirect?.destroy(),e.sh.destroy(),e.params.destroy())}var _e=0,ve=class e{coreRequirement=t(`1.0.0`,import.meta.url);constructor(e,t,n,r){this.lifetime=new AbortController,this.listeners=new Set,this.paramsData=new Float32Array(4),this.version=0,this.disposed=!1,this.resources=e,this.settings=t,this.source=n,n&&K(n)&&(this.cubeSlot=ee(n.texture,`Environment source texture`,`environment.setSource()`,e.device)),this.name=r.name??`environment`,this.rotationValue=r.rotation??0,this.intensityValue=r.intensity??1}static async attach(n,i,a){r(n,t(`1.0.0`,import.meta.url));let o=c(n),s,l={coreRequirement:t(`1.0.0`,import.meta.url),name:`environment:attach:`+_e++,setup(){s=o.sceneOf(l)}};o.use(l),s.removePlugin(l.name);let u=await e.create(n,i,a);try{return o.use(u,s),u}catch(e){throw u.dispose(),e}}static async create(t,n,r={}){J(n);for(let[e,t]of[[`rotation`,r.rotation],[`intensity`,r.intensity]])if(t!==void 0&&(!Number.isFinite(t)||e===`intensity`&&t<0))throw RangeError(`Invalid ${e}; pass a finite number (intensity must be 0 or more)`);let i=q(t),a=fe(i,n,r),o=await ge(i,n,a,r.rotation??0,r.intensity??1);return new e(o,a,r.keepSource===!1?void 0:n,r)}get live(){if(this.disposed)throw new a(`disposed`,`Environment is disposed; create a new Environment`);if(!this.resources)throw new a(`state`,`Environment is being restored; wait for the device restore to finish`);return this.resources}get device(){return this.disposed?null:this.resources?.device??null}get size(){return this.settings.size}get specularSize(){return this.settings.specularSize}get specularMips(){return this.settings.specularMips}get cubeTexture(){return this.live.cube}get cubeView(){return this.live.cubeView}get specularTexture(){return this.live.specular}get specularView(){return this.live.specularView}get brdfLut(){return this.live.brdf}get equirectTexture(){return this.live.equirect}get equirectView(){return this.live.equirectView}get sampler(){return this.live.sampler}get shBuffer(){return this.live.sh}get paramsBuffer(){return this.live.params}get sh(){let e=this.live;return{radiance:e.radiance,irradiance:e.irradiance}}get rotation(){return this.rotationValue}set rotation(e){if(!Number.isFinite(e))throw RangeError(`Invalid rotation; pass a finite number of radians`);this.rotationValue=e,this.writeParams()}get intensity(){return this.intensityValue}get radianceScale(){return this.live.radianceScale}set radianceScale(e){if(!(Number.isFinite(e)&&e>0))throw RangeError(`Invalid radianceScale; pass a finite number above 0`);this.live.radianceScale=Math.fround(e),this.writeParams()}get storedPeak(){return this.live.storedPeak}set storedPeak(e){if(!(e>=0&&e<=65504))throw RangeError(`Invalid storedPeak; pass a number from 0 to 65504`);this.live.storedPeak=e}set intensity(e){if(!Number.isFinite(e)||e<0)throw RangeError(`Invalid intensity; pass a finite number of 0 or more`);this.intensityValue=e,this.writeParams()}writeParams(){let e=this.resources;if(!e||this.disposed)return;let t=this.paramsData;t[0]=Math.cos(this.rotationValue),t[1]=Math.sin(this.rotationValue),t[2]=this.settings.specularMips-1,t[3]=this.intensityValue*e.radianceScale,e.device.queue.writeBuffer(e.params,0,t)}roughnessToLod(e){return Math.min(1,Math.max(0,e))*(this.settings.specularMips-1)}lodToRoughness(e){return this.settings.specularMips>1?Math.min(1,Math.max(0,e/(this.settings.specularMips-1))):0}irradianceAt(e){let t=Math.cos(this.rotationValue),n=Math.sin(this.rotationValue),[r,i,a]=e,o=this.intensityValue*this.live.radianceScale;return w(this.live.irradiance,[t*r-n*a,i,n*r+t*a]).map(e=>e*o)}onChange(e){return this.listeners.add(e),()=>{this.listeners.delete(e)}}restore(e){if(this.disposed)return Promise.reject(new a(`disposed`,`Environment is disposed; create a new Environment`));let t=q(e);if(this.resources?.device===t)return Promise.resolve();if(this.restoring?.device===t)return this.restoring.promise;if(!this.source)return Promise.reject(new a(`state`,`Environment cannot be restored without keepSource; create it with keepSource true`));if(this.cubeSlot&&K(this.source)){let e=this.sourceTexture(this.source);if(e!==void 0&&e!==this.cubeSlot.value&&H(this.cubeSlot,e,t),te(this.cubeSlot,t,this.engine)===void 0)return Y(this.resources),this.resources=void 0,this.restoring=void 0,Promise.resolve()}Y(this.resources),this.resources=void 0;let n=ge(t,this.source,this.settings,this.rotationValue,this.intensityValue,void 0,this.lifetime.signal).then(e=>{if(this.disposed||this.restoring?.promise!==n)Y(e);else{this.resources=e,this.restoring=void 0,this.version++,this.writeParams();for(let e of this.listeners)e(this)}},async e=>{if(!this.lifetime.signal.aborted)throw this.restoring?.promise===n&&(this.restoring=void 0),await t.queue.onSubmittedWorkDone?.(),le.has(t)?B():e});return de(t),this.restoring={device:t,promise:n},n}sourceTexture(e){try{return e.texture}catch{return}}setSource(e,t){try{if(this.disposed)throw new a(`disposed`,`Environment is disposed; create a new Environment`);if(!this.cubeSlot)throw new a(`state`,`Environment setSource needs an environment made from a GPU cube`);if(J(e),e.texture.width!==this.settings.size)throw RangeError(`Environment setSource texture changed size; create a new Environment for the new size`);let n=t?q(t):this.engine?.gpu;if(!n)throw new a(`state`,`Environment setSource needs the device to use; pass it as the target`);return this.source=e,H(this.cubeSlot,e.texture,n),this.resources?.device===n?this.refresh():this.restore(n)}catch(e){return Promise.reject(e)}}refresh(){if(this.refreshing)return this.refreshing;try{let e=this.live,t=this.source;if(!t||!K(t))throw new a(`state`,`Environment refresh needs a GPU cube source; create the environment from a CubeCamera with keepSource true`);if(J(t),t.texture.width!==this.settings.size)throw RangeError(`Environment refresh source changed size; create a new Environment for the new size`);let n=ge(e.device,t,this.settings,this.rotationValue,this.intensityValue,e,this.lifetime.signal).then(()=>void 0).finally(()=>{this.refreshing===n&&(this.refreshing=void 0)});return this.refreshing=n,n}catch(e){return Promise.reject(e)}}get refreshPending(){return this.refreshing!==void 0}setup(e){if(this.disposed)throw new a(`disposed`,`Environment is disposed; create a new Environment`);let t=c(e).gpu;if(!t)throw new a(`unsupported`,`Environment requires the WebGPU backend; use an engine on the WebGPU backend`);this.engine=c(e),t!==this.resources?.device&&this.restore(t).catch(t=>V(e,t))}onDeviceRestored(e){let t=c(e).gpu;t&&!this.disposed&&this.restore(t).catch(t=>V(e,t))}dispose(){this.disposed||(this.disposed=!0,this.lifetime.abort(),this.engine?.sceneOf(this)?.removePlugin(this.name),this.engine=void 0,Y(this.resources),this.resources=void 0,this.source=void 0,this.restoring=void 0,this.listeners.clear())}[Symbol.dispose??Symbol()](){this.dispose()}},ye=0,be=(e,t)=>{let n=t+ye++;for(;e.plugins?.has(n);)n+=`:`;return n};function xe(e){let n;if(typeof e?.sceneOf==`function`){for(let t of e.plugins?.values()??[])if(n=e.sceneOf(t))break;if(!n){let r={coreRequirement:t(`1.0.0`,import.meta.url),name:be(e,`scene-scope:`),setup(){n=e.sceneOf(r)}};e.use(r),e.removePlugin(r.name)}}return Se(e,n)}function Se(e,n){return{scene:n,run(r){if(!n)return r();let i,a={coreRequirement:t(`1.0.0`,import.meta.url),name:be(e,`scene-scope:`),setup(){i=r()}};return n.use(a),n.removePlugin(a.name),i}}}var Ce=`
fn iblRotate(d: vec3f, params: vec4f) -> vec3f {
  return vec3f(params.x * d.x - params.y * d.z, d.y, params.y * d.x + params.x * d.z);
}
fn iblIrradiance(sh: array<vec4f, 9>, n: vec3f) -> vec3f {
  return max(sh[0].rgb * 0.282094792
    + sh[1].rgb * (0.488602512 * n.y) + sh[2].rgb * (0.488602512 * n.z) + sh[3].rgb * (0.488602512 * n.x)
    + sh[4].rgb * (1.092548431 * n.x * n.y) + sh[5].rgb * (1.092548431 * n.y * n.z)
    + sh[6].rgb * (0.315391565 * (3.0 * n.z * n.z - 1.0)) + sh[7].rgb * (1.092548431 * n.x * n.z)
    + sh[8].rgb * (0.546274215 * (n.x * n.x - n.y * n.y)), vec3f(0.0));
}
fn iblPrefiltered(specular: texture_cube<f32>, s: sampler, params: vec4f, r: vec3f, roughness: f32) -> vec3f {
  let x = clamp(roughness, 0.0, 1.0) * params.z;
  let k = min(floor(x), max(params.z - 1.0, 0.0));
  return textureSampleLevel(specular, s, iblRotate(r, params), k + (x * x - k * k) / (2.0 * k + 1.0)).rgb;
}
fn iblBrdfTerms(nv: f32, roughness: f32) -> vec2f {
  let n = i32(round(sqrt(f32(arrayLength(&iblBrdf)))));
  let p = clamp(vec2f(nv, roughness), vec2f(0.0), vec2f(1.0)) * f32(n) - 0.5;
  let a = vec2i(floor(p)); let t = p - floor(p);
  let lo = clamp(a, vec2i(0), vec2i(n - 1)); let hi = clamp(a + 1, vec2i(0), vec2i(n - 1));
  let lut = vec4i(lo.y * n + lo.x, lo.y * n + hi.x, hi.y * n + lo.x, hi.y * n + hi.x);
  return mix(mix(unpack2x16float(iblBrdf[lut.x]), unpack2x16float(iblBrdf[lut.y]), t.x),
             mix(unpack2x16float(iblBrdf[lut.z]), unpack2x16float(iblBrdf[lut.w]), t.x), t.y);
}
fn iblShade(specular: texture_cube<f32>, s: sampler, sh: array<vec4f, 9>, params: vec4f,
            n: vec3f, v: vec3f, baseColor: vec3f, metalness: f32, roughness: f32,
            dielectricF0: vec3f, dielectricF90: f32) -> vec3f {
  let nv = clamp(dot(n, v), 1e-4, 1.0);
  let f0 = mix(dielectricF0, baseColor, metalness);
  let f90 = mix(dielectricF90, 1.0, metalness);
  let ab = iblBrdfTerms(nv, roughness);
  let single = f0 * ab.x + f90 * ab.y;
  let lost = 1.0 - (ab.x + ab.y);
  let favg = f0 + (f90 - f0) / 21.0;
  let multiple = single * favg / (1.0 - lost * favg) * lost;
  let radiance = iblPrefiltered(specular, s, params, reflect(-v, n), roughness);
  let irradiance = iblIrradiance(sh, iblRotate(n, params));
  let diffuse = (1.0 - single - multiple) * (1.0 - metalness) * baseColor;
  return (radiance * single + (multiple + diffuse) * irradiance) * params.w;
}
`;function we(e,t=0){return[{binding:t,resource:e.specularView},{binding:t+1,resource:e.sampler},{binding:t+2,resource:{buffer:e.brdfLut}},{binding:t+3,resource:{buffer:e.shBuffer,offset:0,size:144}},{binding:t+4,resource:{buffer:e.paramsBuffer,offset:0,size:16}}]}var Te=class{coreRequirement=t(`1.0.0`,import.meta.url);constructor(e){this.disposed=!1,this.models=new Map,this.shaders=new Map,this.pbrHooks=new Map,this.name=e}bindings(){return this.disposed||!this.device?[]:this.entries()}pbr(e){if(!this.bindings().length)return;let t=this.pbrHooks.get(e);return t||this.pbrHooks.set(e,t=this.hooks(e)),t}shader(e,t){if(!this.bindings().length)return e;let n=this.shaders.get(t),r=n?.get(e);if(r===void 0){if(r=this.patch(e,t),r===e)throw new a(`unsupported`,`${this.name} requires the standard core PBR shader; remove the plugin that replaced core's shader`);n||this.shaders.set(t,n=new Map),n.size>=64&&n.clear(),n.set(e,r)}return r}add(e){if(this.disposed)throw new a(`disposed`,`${this.name} is disposed; create a new one`);let t=this.models.get(e);if(!t){let n=e.addLighting(this);t=()=>{this.models.get(e)===t&&(this.models.delete(e),n())},this.models.set(e,t)}return t}applyTo(e){return this.add(e)}setup(e){if(this.disposed)throw new a(`disposed`,`${this.name} is disposed; create a new one`);if(e.backend===`webgl2`)throw new a(`unsupported`,`${this.name} requires the WebGPU backend; use an engine on the WebGPU backend; see https://margoengine.com/errors#webgpu`);this.engine=e}registerPasses(e){e.add({name:this.name,order:-1,execute:e=>{e.backend!==`webgpu`||this.disposed||this.device!==e.device||(e.shader=this.shader(e.shader,0),e.bindings.push(...this.entries()))}})}dispose(){if(!this.disposed){this.disposed=!0;for(let e of[...this.models.values()])e();this.shaders.clear(),this.engine?.sceneOf(this)?.removePlugin(this.name),this.engine=void 0}}[Symbol.dispose??Symbol()](){this.dispose()}},Ee=(e,t,n,r,i,a,o)=>`iblShade(iblSpecular,iblSampler,iblSh,iblParams,${e},${t},${n},${r},${i},${a},${o})`,De=class e extends Te{coreRequirement=t(`1.0.0`,import.meta.url);static attach(n,i,a){r(n,t(`1.0.0`,import.meta.url));let o=new e(i,a);return n.use(o),o}static async load(t,n,r={}){let{signal:a,decode:o,weight:s,...c}=r,l=()=>{if(a?.throwIfAborted(),t.disposed)throw new DOMException(`Engine disposed`,`AbortError`)};l();let u=xe(t),d=typeof n==`string`||n instanceof URL?await(await i(async()=>{let{loadEnvironmentImage:e}=await import(`./load-C59tSXhq.js`);return{loadEnvironmentImage:e}},__vite__mapDeps([0,1,2,3]),import.meta.url)).loadEnvironmentImage(n,{signal:a,decode:o,weight:s}):n;l();let f=await ve.create(t,d,c);try{l()}catch(e){throw f.dispose(),e}return u.run(()=>{let n=!1;try{t.use(f),n=!0;let r=e.attach(t,f);return r.loadedInto=t,r}catch(e){throw n?t.removePlugin(f.name):f.dispose(),e}})}constructor(e,t={}){super(t.name??`environment:lighting`),this.environment=e,this.version=-1}dispose(){let e=this.loadedInto;this.loadedInto=void 0,super.dispose(),e&&!this.environment.disposed&&c(e).sceneOf(this.environment)?.removePlugin(this.environment.name)}get device(){return this.environment.disposed?null:this.environment.device}entries(){return(!this.cached||this.version!==this.environment.version)&&(this.cached=we(this.environment,20),this.version=this.environment.version),this.cached}declarations(e){let t=t=>`@group(${e}) @binding(${20+t})`;return`${t(0)} var iblSpecular:texture_cube<f32>;\n${t(1)} var iblSampler:sampler;\n${t(2)} var<storage,read> iblBrdf:array<u32>;\n${t(3)} var<uniform> iblSh:array<vec4f,9>;\n${t(4)} var<uniform> iblParams:vec4f;\n${Ce}\n`}patch(e,t){let n=e.replace(/let linear=([^;]+);/,(e,t)=>`let margoAmbient=${Ee(`n`,`v`,`i.color`,`i.material.y`,`i.material.x`,`vec3f(0.04)`,`1.0`)};let linear=${t.replace(`frame.radiance.w`,`0.0`)}+margoAmbient;`);return n===e?e:this.declarations(t)+n}hooks(e){return{declarations:this.declarations(e),ambient:Ee(`s.n`,`v`,`s.base.rgb`,`s.metal`,`s.roughness`,`s.f0`,`s.sw`)+`*s.occlusion`,coat:`iblPrefiltered(iblSpecular,iblSampler,iblParams,reflect(-v,s.cn),s.cr)*iblParams.w*s.occlusion`,sheen:`margoSheenAlbedo(clamp(dot(s.n,v),0.0001,1.0),s.sh.w)*iblIrradiance(iblSh,iblRotate(s.n,iblParams))*iblParams.w*s.occlusion`}}setup(e){super.setup(e),this.restore(e)}onDeviceRestored(e){this.restore(e)}restore(e){let t=c(e).gpu,n=this.environment;t&&n.device!==t&&!n.disposed&&n.restore(t).catch(t=>V(e,t))}},Oe=(e,t=`1.0.0`,n=import.meta.url)=>o(e,t,n),ke=[171,75,84,88,32,50,48,187,13,10,26,10],Ae=new TextEncoder().encode(`margoEnvironmentIBL\0`),je=(e,t=4)=>Math.ceil(e/t)*t,X=()=>{throw new a(`failed`,`Invalid prefiltered IBL KTX2; export it again with savePrefilteredEnvironment`)},Z=e=>Number.isInteger(e)&&e>=1&&e<=16384&&!(e&e-1),Me=e=>Number.isInteger(e)&&e>=1&&e<=4096,Ne=e=>e instanceof ArrayBuffer?new Uint8Array(e):new Uint8Array(e.buffer,e.byteOffset,e.byteLength),Pe=e=>new DataView(e.buffer,e.byteOffset,e.byteLength);function Fe(e){if(!Z(e.size)||!Z(e.specularSize)||e.specularSize>e.size)throw RangeError(`Invalid baked cube edge; use powers of two up to 16384 with specularSize <= size`);(!(e.brdf instanceof Uint32Array)||!Me(Math.sqrt(e.brdf.length)))&&X();let t=e.radianceScale??1;Number.isFinite(t)&&t>0||X();let n=240+e.brdf.byteLength+16*(4*e.size**2-1)+(t===1?0:4);if(4+je(Ae.length+n)>4294967295)throw RangeError(`KTX2 metadata exceeds the 32-bit byte length limit; use a smaller source cube`);for(let[t,n,r]of[[e.size,e.cube,!0],[e.specularSize,e.specular,!1]]){(!n.length||n.length>Math.log2(t)+1||r&&n.length!==Math.log2(t)+1)&&X();for(let e=0;e<n.length;e++)(!(n[e]instanceof Uint16Array)||n[e].length!==(t>>e)**2*24)&&X()}for(let t of[e.radiance,e.irradiance])(!(t instanceof Float32Array)||t.length!==27||!t.every(Number.isFinite))&&X();return(!Number.isFinite(e.rotation)||!Number.isFinite(e.intensity)||e.intensity<0)&&X(),n}function Ie(){let e=new Uint8Array(92),t=Pe(e);t.setUint32(0,92,!0),t.setUint16(8,2,!0),t.setUint16(10,88,!0),e.set([1,1,1,0],12),e[20]=8;for(let n=0;n<4;n++){let r=28+n*16;t.setUint16(r,n*16,!0),e[r+2]=15,e[r+3]=192|(n===3?15:n),t.setFloat32(r+8,-1,!0),t.setFloat32(r+12,1,!0)}return e}function Le(e){let t=Ne(e),n=Pe(t);(t.length<80||ke.some((e,n)=>t[n]!==e))&&X();let r=e=>n.getUint32(e,!0),i=r(20),a=r(40),o=r(48),s=r(52),c=r(56),l=r(60);(r(12)!==97||r(16)!==2||!Z(i)||r(24)!==i||r(28)||r(32)||r(36)!==6||!a||a>Math.log2(i)+1||r(44)||n.getBigUint64(64,!0)||n.getBigUint64(72,!0))&&X(),(o<80+24*a||o%4||s!==92||c!==o+s||c+l>t.length||l%4)&&X(),Ie().some((e,n)=>t[o+n]!==e)&&X();let u,d=new Set;for(let e=c;e<c+l;){e+4>c+l&&X();let n=r(e);e+=4,(n<2||e+je(n)>c+l)&&X();let i=t.indexOf(0,e);(i<=e||i>=e+n)&&X();let a=new TextDecoder().decode(t.subarray(e,i));d.has(a)&&X(),d.add(a);let o=t.subarray(i+1,e+n);a===`margoEnvironmentIBL`&&(u=o),a===`KTXorientation`&&new TextDecoder().decode(o).replace(/\0$/,``)!==`rd`&&X(),e+=je(n)}(!u||u.length<240)&&X();let f=Pe(u),p=e=>f.getUint32(e,!0),m=p(4),h=p(8),g=p(12),_=p(0);(_!==1&&_!==2||!Z(m)||m<i||h!==Math.log2(m)+1||!Me(g))&&X();let v=(e,t)=>(e+t>u.length&&X(),u.slice(e,e+t).buffer),y=new Float32Array(v(24,108)),b=new Float32Array(v(132,108)),x=240,S=new Uint32Array(v(x,g**2*4));x+=S.byteLength;let C=[];for(let e=0;e<h;e++){let t=(m>>e)**2*48;C.push(new Uint16Array(v(x,t))),x+=t}x+(_===2?4:0)!==u.length&&X();let w=_===2?f.getFloat32(x,!0):1;_===2&&w===1&&X();let T=[],E=[[0,c+l]];for(let e=0;e<a;e++){let r=Number(n.getBigUint64(80+24*e,!0)),a=Number(n.getBigUint64(88+24*e,!0));(!Number.isSafeInteger(r)||r%8||a!==(i>>e)**2*48||n.getBigUint64(96+24*e,!0)!==BigInt(a)||r+a>t.length||E.some(([e,t])=>r<t&&r+a>e))&&X(),E.push([r,r+a]),T.push(new Uint16Array(t.slice(r,r+a).buffer))}let D={size:m,cube:C,specularSize:i,specular:T,brdf:S,radiance:y,irradiance:b,rotation:f.getFloat32(16,!0),intensity:f.getFloat32(20,!0),..._===2?{radianceScale:w}:{}};return Fe(D),D}function Re(e){let t=`createTexture`in e?e:Oe(e).gpu;if(!t)throw new a(`unsupported`,`Baked IBL needs WebGPU; use WebGPU or its full WebGL2 compatibility layer`);return t}function ze(e,t){let n=[],r=e=>(n.push(e),e);try{let n=(t,n)=>{if(t>e.limits.maxTextureDimension2D)throw RangeError(`Baked cube exceeds the device limit; bake a smaller cube`);let i=r(e.createTexture({size:[t,t,6],mipLevelCount:n.length,format:`rgba16float`,usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST|GPUTextureUsage.COPY_SRC|GPUTextureUsage.RENDER_ATTACHMENT}));return n.forEach((n,r)=>{let a=t>>r;e.queue.writeTexture({texture:i,mipLevel:r},n,{bytesPerRow:a*8,rowsPerImage:a},[a,a,6])}),i},i=(t,n)=>{let i=r(e.createBuffer({size:t.byteLength,usage:n|GPUBufferUsage.COPY_DST|GPUBufferUsage.COPY_SRC}));return e.queue.writeBuffer(i,0,t),i},a=n(t.size,t.cube),o=n(t.specularSize,t.specular),s=new Float32Array(128);for(let e=0;e<9;e++)s.set(t.irradiance.subarray(e*3,e*3+3),e*4),s.set(t.radiance.subarray(e*3,e*3+3),64+e*4);let c=i(t.brdf,GPUBufferUsage.STORAGE);return{device:e,cube:a,specular:o,cubeView:a.createView({dimension:`cube`}),specularView:o.createView({dimension:`cube`}),brdf:c,lut:{buffer:c,users:1,key:`baked`},sh:i(s,GPUBufferUsage.UNIFORM|GPUBufferUsage.STORAGE),params:i(new Float32Array([Math.cos(t.rotation),Math.sin(t.rotation),t.specular.length-1,t.intensity*(t.radianceScale??1)]),GPUBufferUsage.UNIFORM),sampler:e.createSampler({magFilter:`linear`,minFilter:`linear`,mipmapFilter:`linear`}),radiance:t.radiance.slice(),irradiance:t.irradiance.slice(),radianceScale:t.radianceScale??1,storedPeak:65504}}catch(e){for(let e of n)e.destroy();throw e}}var Be=class extends ve{constructor(e,t,n){let r={size:e.size,specularSize:e.specularSize,specularMips:e.specular.length,brdfSize:Math.sqrt(e.brdf.length),samples:0,brdfSamples:0,shSize:0,float32:!1,keepEquirect:!1};super(ze(t,e),r,void 0,{rotation:e.rotation,intensity:e.intensity,name:n}),this.baked=e}restore(e){try{if(this.disposed)throw new a(`disposed`,`Environment is disposed; load the baked file again`);let t=Re(e);if(this.device===t)return Promise.resolve();let n=ze(t,{...this.baked,rotation:this.rotation,intensity:this.intensity}),r=this.resources;if(this.resources=n,r)for(let e of[r.cube,r.specular,r.brdf,r.sh,r.params])e.destroy();this.version++;for(let e of this.listeners)e(this);return Promise.resolve()}catch(e){return Promise.reject(e)}}dispose(){super.dispose(),this.baked=void 0}};async function Ve(e,t,n={}){n.signal?.throwIfAborted();let r=typeof t==`string`||t instanceof URL?await(async()=>{let e=await fetch(t,{signal:n.signal});if(!e.ok)throw new a(`failed`,`Baked IBL fetch returned ${e.status}; check the file URL`);return e.arrayBuffer()})():t;n.signal?.throwIfAborted();let i=Le(r);return i.rotation=n.rotation??i.rotation,i.intensity=n.intensity??i.intensity,Fe(i),new Be(i,Re(e),n.name)}async function He(e){let t=await createImageBitmap(e,{colorSpaceConversion:`none`,premultiplyAlpha:`none`});try{let e=new OffscreenCanvas(t.width,t.height).getContext(`2d`,{willReadFrequently:!0});e.drawImage(t,0,0);let{data:n}=e.getImageData(0,0,t.width,t.height);return{width:t.width,height:t.height,data:n}}finally{t.close()}}var Ue=Float32Array.from({length:256},(e,t)=>(2**(13*t/255)-1)/24);function We(e){if(e===0)return 0;let t=Math.floor(Math.log2(e));return(t+15)*1024+Math.round((e/2**t-1)*1024)}var Ge=Uint16Array.from(Ue,We);function Ke(e,t){let{width:n,height:r,data:i}=t,a=new Uint16Array(i.length);for(let e=0;e<i.length;e+=4)a[e]=Ge[i[e]],a[e+1]=Ge[i[e+1]],a[e+2]=Ge[i[e+2]],a[e+3]=15360;let o,s,c;function l(){s?.destroy(),o=s=c=void 0}function u(){return o!==e.device&&(l(),o=e.device,s=o.createTexture({label:`Coastal HDR photograph`,size:[n,r],format:`rgba16float`,usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST}),o.queue.writeTexture({texture:s},a,{bytesPerRow:n*8,rowsPerImage:r},[n,r]),c=s.createView()),c}return{source:new Proxy(e,{get(e,t){if(t===`equirectView`)return u();if(t===`equirectTexture`)return u(),s;let n=Reflect.get(e,t,e);return typeof n==`function`?n.bind(e):n}}),dispose:l}}var Q=e=>document.getElementById(e),qe=Q(`orbit`),$=document.body.dataset,Je=[...document.querySelectorAll(`[data-mode]`)],Ye=-37,Xe={ground:`Grounded projection keeps the asphalt anchored beside the tires as the camera moves.`,sphere:`The same photograph is drawn on an infinite sphere. The pavement moves with the view.`};async function Ze(e,t,n,r,i,a){let o=`ground`,s=Ye,c=0,l=0,u,d,f,p,m=!1;function h(){let e=Math.min(1.75,Math.max(1,devicePixelRatio||1));return[Math.round(t.clientWidth*e),Math.round(t.clientHeight*e)]}function g(){let[n,i]=h();t.width!==n&&(t.width=n),t.height!==i&&(t.height=i);let a=t.clientWidth<650,c=s*Math.PI/180,l=a?7.98:7.15;e.camera.position=[l*Math.sin(c),a?2.06:1.92,l*Math.cos(c)],e.camera.target=[0,.64,0],e.camera.fov=a?41:36,r(o);for(let e of Je)e.setAttribute(`aria-pressed`,String(e.dataset.mode===o));let u=Math.round(s);qe.value=String(u),Q(`orbit-number`).value=(u<0?`−`+-u:String(u))+`°`,Q(`method`).textContent=Xe[o],$.mode=o,$.orbit=String(u)}function _(){u||d||n.aborted||(u=requestAnimationFrame(async()=>{u=void 0,d=!0;let t=c;m=!1;try{if(g(),await i(),n.aborted)return;l=t,$.revision=String(l),t&&!performance.getEntriesByName(`ground-control-applied`).length&&performance.mark(`ground-control-applied`)}catch(t){e.onError(t)}finally{d=!1}(m||c!==l)&&_()}))}function v(){c++,m=!0,_()}function y(e){s=Math.max(-120,Math.min(68,e)),v()}return g(),performance.mark(`ground-submit`),await i(),{connect(){$.renderer=e.backend===`webgl2`||e.gpu?.adapterInfo?.vendor===`margo-webgl2`?`webgl2`:`webgpu`,$.revision=`0`,$.ready=`true`,Q(`controls`).disabled=!1;for(let e of Je)e.addEventListener(`click`,()=>{let t=e.dataset.mode;t!==o&&(o=t,v())},{signal:n});qe.addEventListener(`input`,()=>y(+qe.value),{signal:n}),Q(`reset`).addEventListener(`click`,()=>y(Ye),{signal:n}),t.addEventListener(`pointerdown`,e=>{p||(p={id:e.pointerId,x:e.clientX,orbit:s},t.setPointerCapture(e.pointerId))},{signal:n}),t.addEventListener(`pointermove`,e=>{p?.id===e.pointerId&&y(p.orbit+(e.clientX-p.x)*.28)},{signal:n});for(let e of[`pointerup`,`pointercancel`,`lostpointercapture`])t.addEventListener(e,e=>{p?.id===e.pointerId&&(p=void 0)},{signal:n});t.addEventListener(`keydown`,e=>{(e.key===`ArrowLeft`||e.key===`ArrowRight`)&&(e.preventDefault(),y(s+(e.key===`ArrowLeft`?-5:5)))},{signal:n}),f=new ResizeObserver(()=>{let[e,n]=h();(t.width!==e||t.height!==n)&&(m=!0,_())}),f.observe(t)},dispose(){cancelAnimationFrame(u),f?.disconnect(),a()}}}export{Ve as a,s as c,Le as i,Ke as n,De as o,He as r,o as s,Ze as t};