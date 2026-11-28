import{a as e,c as t,i as n,n as r,o as i,r as a,s as o}from"./index-BY8K2MXZ.js";var s=(e,t=n,i=import.meta.url)=>(r(e,a(t,i)),e),c=class extends Error{constructor(e,t){super(t),this.name=`MargoError`,this.code=e}static[Symbol.hasInstance](e){return e instanceof Error&&e.name===`MargoError`}};function l(e,t=new Float64Array(16)){let n=e[0],r=e[1],i=e[2],a=e[3],o=e[4],s=e[5],c=e[6],l=e[7],u=e[8],d=e[9],f=e[10],p=e[11],m=e[12],h=e[13],g=e[14],_=e[15],v=n*s-r*o,y=n*c-i*o,b=n*l-a*o,x=r*c-i*s,S=r*l-a*s,C=i*l-a*c,w=u*h-d*m,T=u*g-f*m,E=u*_-p*m,D=d*g-f*h,O=d*_-p*h,k=f*_-p*g,A=v*k-y*O+b*D+x*E-S*T+C*w;if(!A||!Number.isFinite(A))return null;let j=1/A;return t[0]=(s*k-c*O+l*D)*j,t[1]=(i*O-r*k-a*D)*j,t[2]=(h*C-g*S+_*x)*j,t[3]=(f*S-d*C-p*x)*j,t[4]=(c*E-o*k-l*T)*j,t[5]=(n*k-i*E+a*T)*j,t[6]=(g*b-m*C-_*y)*j,t[7]=(u*C-f*b+p*y)*j,t[8]=(o*O-s*E+l*w)*j,t[9]=(r*E-n*O-a*w)*j,t[10]=(m*S-h*b+_*v)*j,t[11]=(d*b-u*S-p*v)*j,t[12]=(s*T-o*D-c*w)*j,t[13]=(n*D-r*T+i*w)*j,t[14]=(h*y-m*x-g*v)*j,t[15]=(u*x-d*y+f*v)*j,t}var u=(e,t=`1.0.0`,n=import.meta.url)=>s(e,t,n);new Uint32Array(new Float32Array(1).buffer);var d=[.282094792,.488602512,.488602512,.488602512,1.092548431,1.092548431,.315391565,1.092548431,.546274215],f=[1,2/3,2/3,2/3,.25,.25,.25,.25,.25];function p(e,t,n,r=new Float64Array(9)){return r[0]=d[0],r[1]=d[1]*t,r[2]=d[2]*n,r[3]=d[3]*e,r[4]=d[4]*e*t,r[5]=d[5]*t*n,r[6]=d[6]*(3*n*n-1),r[7]=d[7]*e*n,r[8]=d[8]*(e*e-t*t),r}function m(e,t){let n=Math.hypot(t[0],t[1],t[2])||1,r=p(t[0]/n,t[1]/n,t[2]/n),i=[0,0,0];for(let t=0;t<9;t++)for(let n=0;n<3;n++)i[n]+=e[t*3+n]*r[t];return i}function h(e){let t=new Float32Array(27);for(let n=0;n<9;n++)for(let r=0;r<3;r++)t[n*3+r]=e[n*3+r]*f[n];return t}var g=`2.0*nl*nv/max(nl*sqrt(a2+(1.0-a2)*nv*nv)+nv*sqrt(a2+(1.0-a2)*nl*nl),1e-30)`,_=(e,t,n=`nh`,r=`a2`)=>`(max(dot(cross(${e},${t}),cross(${e},${t})),step(${n},0.0))+${r}*${n}*${n})`,v=`
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
`;v+``,v+`
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
        let q = ${_(`vec3f(0.0, 0.0, 1.0)`,`hl`,`hl.z`)};
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
`,v+``,v+`
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
      let g = ${g};
      let visibility = g * vh / (h.z * nv);
      let fc = pow(1.0 - vh, 5.0);
      scale += (1.0 - fc) * visibility;
      bias += fc * visibility;
    }
  }
  destination[id.y * size + id.x] = pack2x16float(vec2f(scale, bias) / f32(samples));
}
`;var y=class{coreRequirement=a(`1.0.0`,import.meta.url);constructor(e){this.disposed=!1,this.models=new Map,this.shaders=new Map,this.pbrHooks=new Map,this.name=e}bindings(){return this.disposed||!this.device?[]:this.entries()}pbr(e){if(!this.bindings().length)return;let t=this.pbrHooks.get(e);return t||this.pbrHooks.set(e,t=this.hooks(e)),t}shader(e,t){if(!this.bindings().length)return e;let n=this.shaders.get(t),r=n?.get(e);if(r===void 0){if(r=this.patch(e,t),r===e)throw new c(`unsupported`,`${this.name} requires the standard core PBR shader; remove the plugin that replaced core's shader`);n||this.shaders.set(t,n=new Map),n.size>=64&&n.clear(),n.set(e,r)}return r}add(e){if(this.disposed)throw new c(`disposed`,`${this.name} is disposed; create a new one`);let t=this.models.get(e);if(!t){let n=e.addLighting(this);t=()=>{this.models.get(e)===t&&(this.models.delete(e),n())},this.models.set(e,t)}return t}applyTo(e){return this.add(e)}setup(e){if(this.disposed)throw new c(`disposed`,`${this.name} is disposed; create a new one`);if(e.backend===`webgl2`)throw new c(`unsupported`,`${this.name} requires the WebGPU backend; use an engine on the WebGPU backend; see https://margoengine.com/errors#webgpu`);this.engine=e}registerPasses(e){e.add({name:this.name,order:-1,execute:e=>{e.backend!==`webgpu`||this.disposed||this.device!==e.device||(e.shader=this.shader(e.shader,0),e.bindings.push(...this.entries()))}})}dispose(){if(!this.disposed){this.disposed=!0;for(let e of[...this.models.values()])e();this.shaders.clear(),this.engine?.sceneOf(this)?.removePlugin(this.name),this.engine=void 0}}[Symbol.dispose??Symbol()](){this.dispose()}},b=`margoSkyLight(n)`,x=/\*frame\.radiance\.w(?:\*frame\.ambient\.rgb)?|\*skyAmbient\.rgb/g,S=/(i\.color\*\(1\.0-i\.material\.y\)|base)\*0\.0(?:\*frame\.ambient\.rgb)?/;function C(e,t,n){if(t.includes(`fn margoSkyLight(`))throw new c(`attached`,`${e}: an ambient light (HemisphereLight, AmbientLight or SHLight) already lights this shader; use one per engine`);let r=t.replace(x,`*${b}`);return r===t&&(r=t.replace(S,`$1*${b}`)),r===t?t:n+r}var w=e=>`struct MargoSkyLight {c:array<vec4f,9>}
@group(${e}) @binding(144) var<uniform> margoSkyLightData:MargoSkyLight;
fn margoSkyLight(n:vec3f)->vec3f {let d=normalize(n);let c=margoSkyLightData.c;
let e=c[0].rgb+c[1].rgb*d.y+c[2].rgb*d.z+c[3].rgb*d.x+c[4].rgb*(d.x*d.y)+c[5].rgb*(d.y*d.z)+c[6].rgb*(3.0*d.z*d.z-1.0)+c[7].rgb*(d.x*d.z)+c[8].rgb*(d.x*d.x-d.y*d.y);
return max(e,vec3f(0.0));}
`;function T(e){let t=new Float32Array(27),n=Array.isArray(e)&&e.length===9&&Array.isArray(e[0]);if(!n&&e.length!==27)throw RangeError(`SH coefficients must be 9 [r, g, b] triples or 27 numbers`);for(let r=0;r<9;r++)for(let i=0;i<3;i++){let a=n?e[r][i]:e[r*3+i];if(typeof a!=`number`||!Number.isFinite(Math.fround(a)))throw RangeError(`SH coefficient ${r} channel ${i} must be a finite number`);t[r*3+i]=a}return t}var E=class e extends y{coreRequirement=a(`1.0.0`,import.meta.url);static attach(t,n){r(t,a(`1.0.0`,import.meta.url));let i=new e(n);return t.use(i),i}constructor(e={}){super(e.name??`environment:sh`),this.radiance=new Float32Array(27),this.strength=1,this.dirty=!0,this.values=new Float32Array(36),e.coefficients!==void 0&&(this.radiance=T(e.coefficients)),this.intensity=e.intensity??1}get coefficients(){return this.radiance.slice()}set coefficients(e){this.radiance=T(e),this.update()}get intensity(){return this.strength}set intensity(e){if(typeof e!=`number`||!Number.isFinite(Math.fround(e))||e<0)throw RangeError(`SH light intensity must be a finite number of 0 or more`);this.strength=e,this.update()}irradiance(e){return m(h(this.radiance),e).map(e=>Math.max(0,e*this.strength))}update(){for(let e=0;e<9;e++)for(let t=0;t<3;t++)this.values[e*4+t]=this.radiance[e*3+t]*d[e]*f[e]*this.strength;this.dirty=!0}get device(){return this.gpu}entries(){return this.dirty&&=(this.gpu.queue.writeBuffer(this.buffer,0,this.values),!1),this.entry}patch(e,t){return C(this.name,e,w(t))}hooks(e){return{declarations:w(e),sky:b}}setup(e){super.setup(e);let t=u(e).gpu;if(!t)throw new c(`unsupported`,`SHLight requires the WebGPU backend`);this.release(),this.allocate(t)}onDeviceRestored(e){let t=u(e).gpu;this.release(),t&&!this.disposed&&this.allocate(t)}allocate(e){this.buffer=e.createBuffer({label:`SH light`,size:this.values.byteLength,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST}),this.entry=[{binding:144,resource:{buffer:this.buffer}}],this.gpu=e,this.dirty=!0}release(){this.buffer?.destroy(),this.buffer=this.gpu=this.entry=void 0}dispose(){super.dispose(),this.release()}},D=(e,t=`1.0.0`,n=import.meta.url)=>s(e,t,n);function O(e,n,r,i){let a=e.replace(`@group(0) @binding(0) var<uniform> frame:Frame;`,`@group(0) @binding(0) var<uniform> margoMainFrame:Frame;\n@group(0) @binding(${n}) var<uniform> frame:Frame;`).replace(`@vertex fn vertex(i:Input)->Output {`,`@vertex fn vertex(i:Input)->Output {_=margoMainFrame.eye;`).replace(/o\.clip=(?!frame\.camera\*)([A-Za-z_]\w*)\*p;/,`o.clip=frame.camera*p;_=$1;`).replace(/let mapped=[\s\S]*?return vec4f\([^\n]+\);|return vec4f\(linear,1\);/,()=>`if(false){_=linear;}${r}`);if(!a.includes(`margoMainFrame:Frame`)||!a.includes(`_=margoMainFrame`)||!a.includes(`o.clip=frame.camera*p`)||!a.includes(r))throw t(`unsupported`,`${i} requires the standard core lighting shader; remove the plugin that replaced core's shader`,`webgpu`);return a}var k=Symbol.for(`@margoengine/environment lost rebuild`),A=Symbol.for(`@margoengine/environment restore reported`);function j(e,t){let n=t;n?.[k]||n?.[A]||(n&&typeof n==`object`&&Object.defineProperty(n,A,{value:!0}),e.onError(t))}var M=`
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
`;function N(e,t=0){return[{binding:t,resource:e.specularView},{binding:t+1,resource:e.sampler},{binding:t+2,resource:{buffer:e.brdfLut}},{binding:t+3,resource:{buffer:e.shBuffer,offset:0,size:144}},{binding:t+4,resource:{buffer:e.paramsBuffer,offset:0,size:16}}]}new Uint32Array(new Float32Array(1).buffer);function P(e){let t=e&32768?-1:1,n=e>>10&31,r=e&1023;return n===0?t*r*5.960464477539063e-8:n===31?r?NaN:t*(1/0):t*(1+r/1024)*2**(n-15)}var F=[.282094792,.488602512,.488602512,.488602512,1.092548431,1.092548431,.315391565,1.092548431,.546274215];function ee(e,t,n,r=new Float64Array(9)){return r[0]=F[0],r[1]=F[1]*t,r[2]=F[2]*n,r[3]=F[3]*e,r[4]=F[4]*e*t,r[5]=F[5]*t*n,r[6]=F[6]*(3*n*n-1),r[7]=F[7]*e*n,r[8]=F[8]*(e*e-t*t),r}function I(e,t){let n=Math.hypot(t[0],t[1],t[2])||1,r=ee(t[0]/n,t[1]/n,t[2]/n),i=[0,0,0];for(let t=0;t<9;t++)for(let n=0;n<3;n++)i[n]+=e[t*3+n]*r[t];return i}var L=(e,t,n=`nh`,r=`a2`)=>`(max(dot(cross(${e},${t}),cross(${e},${t})),step(${n},0.0))+${r}*${n}*${n})`,te=`
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
`,ne=class{coreRequirement=a(`1.0.0`,import.meta.url);constructor(e){this.disposed=!1,this.models=new Map,this.shaders=new Map,this.pbrHooks=new Map,this.name=e}bindings(){return this.disposed||!this.device?[]:this.entries()}pbr(e){if(!this.bindings().length)return;let t=this.pbrHooks.get(e);return t||this.pbrHooks.set(e,t=this.hooks(e)),t}shader(e,t){if(!this.bindings().length)return e;let n=this.shaders.get(t),r=n?.get(e);if(r===void 0){if(r=this.patch(e,t),r===e)throw new c(`unsupported`,`${this.name} requires the standard core PBR shader; remove the plugin that replaced core's shader`);n||this.shaders.set(t,n=new Map),n.size>=64&&n.clear(),n.set(e,r)}return r}add(e){if(this.disposed)throw new c(`disposed`,`${this.name} is disposed; create a new one`);let t=this.models.get(e);if(!t){let n=e.addLighting(this);t=()=>{this.models.get(e)===t&&(this.models.delete(e),n())},this.models.set(e,t)}return t}applyTo(e){return this.add(e)}setup(e){if(this.disposed)throw new c(`disposed`,`${this.name} is disposed; create a new one`);if(e.backend===`webgl2`)throw new c(`unsupported`,`${this.name} requires the WebGPU backend; use an engine on the WebGPU backend; see https://margoengine.com/errors#webgpu`);this.engine=e}registerPasses(e){e.add({name:this.name,order:-1,execute:e=>{e.backend!==`webgpu`||this.disposed||this.device!==e.device||(e.shader=this.shader(e.shader,0),e.bindings.push(...this.entries()))}})}dispose(){if(!this.disposed){this.disposed=!0;for(let e of[...this.models.values()])e();this.shaders.clear(),this.engine?.sceneOf(this)?.removePlugin(this.name),this.engine=void 0}}[Symbol.dispose??Symbol()](){this.dispose()}},re=`margoSkyLight(n)`,ie=(e,t,n)=>r=>t.call(e,{...r,code:n(r.code)});function ae(e,t){let n=new Map;return new Proxy(e,{get(e,r){let i=Reflect.get(e,r);if(typeof i!=`function`)return i;let a=n.get(r);if(a&&a.source===i)return a.bound;let o=r===`createShaderModule`?ie(e,i,t):i.bind(e);return n.set(r,{source:i,bound:o}),o}})}function oe(e,t,n){let r=Math.hypot(n[0],n[1],n[2]);e[t]=n[0]/r,e[t+1]=n[1]/r,e[t+2]=n[2]/r,e[t+3]=n[3]}var R=24;function se(e){let t=e.map(Math.abs),n=0,r=e[1],i=e[2],a=e[0];return t[1]>t[0]&&t[1]>=t[2]?[n,r,i,a]=[1,e[0],e[2],e[1]]:t[2]>t[0]&&t[2]>t[1]&&([n,r,i,a]=[2,e[0],e[1],e[2]]),(n*2+ +(a<0))*4+ +(r>=0)+(i>=0?2:0)}var ce=-.5,le=27,z=1088,ue=4096,de=256,B=[[[1,0,0],[0,1,0]],[[-1,0,0],[0,1,0]],[[0,1,0],[0,0,-1]],[[0,-1,0],[0,0,1]],[[0,0,1],[0,1,0]],[[0,0,-1],[0,1,0]]],V=(e,t,n,r=e===`read_write`)=>`
struct ProbeBox {position:vec4f,min:vec4f,max:vec4f,data:vec4u}
struct ProbeData {volumeMin:vec4f,volumeMax:vec4f,volumeCounts:vec4u,reflections:vec4u,boxes:array<ProbeBox,16>,texels:array<${r?`vec2u`:`vec4u`}>}
@group(${t}) @binding(${n}) var<storage,${e}> probeData:ProbeData;
// Texel i: float16 r, g, b in the 8-byte half i & 1 of vec4u i / 2 (octahedral radiance). Volume probes pack their SH in whole vec4u.
fn probeTexel(i:u32)->vec3f {${r?`let u=probeData.texels[i];`:`let t=probeData.texels[i>>1u];let u=select(t.xy,t.zw,(i&1u)==1u);`}return vec3f(unpack2x16float(u.x),unpack2x16float(u.y).x);}
fn probeOct(d:vec3f)->vec2f {
  let a=d/max(abs(d.x)+abs(d.y)+abs(d.z),1e-20);var q=a.xz;
  if(a.y<0.0){q=(1.0-abs(a.zx))*select(vec2f(-1.0),vec2f(1.0),a.xz>=vec2f(0.0));}
  return q*0.5+0.5;
}
`,H=`
// Visibility bin of a world direction: face 2 x major axis + (negative), then the signs of the two other axes.
fn probeBin(d:vec3f)->u32 {
  let a=abs(d);var axis=0u;var u=d.y;var v=d.z;var m=d.x;
  if(a.y>a.x&&a.y>=a.z){axis=1u;u=d.x;v=d.z;m=d.y;}else if(a.z>a.x&&a.z>a.y){axis=2u;u=d.x;v=d.y;m=d.z;}
  return (axis*2u+select(0u,1u,m<0.0))*4u+select(0u,1u,u>=0.0)+select(0u,2u,v>=0.0);
}
`,fe=V(`read_write`,0,0)+H+`
struct Depth {inverse:mat4x4f,eye:vec4f,info:vec4u,limits:vec4f}
@group(0) @binding(1) var<uniform> depthInfo:Depth;
@group(0) @binding(2) var depthMap:texture_depth_2d;
var<workgroup> sums:array<vec2f,64>;
fn depthRay(x:f32,y:f32,z:f32)->vec3f {
  let size=f32(depthInfo.info.z);let w=depthInfo.inverse*vec4f(x/size*2.0-1.0,1.0-y/size*2.0,z,1.0);
  return w.xyz/w.w-depthInfo.eye.xyz;
}
@compute @workgroup_size(64) fn visibility(@builtin(workgroup_id) q:vec3u,@builtin(local_invocation_index) t:u32) {
  let half=depthInfo.info.z/2u;let ox=(q.x&1u)*half;let oy=(q.x>>1u)*half;let cap=depthInfo.limits.x;
  var s=vec2f(0);
  for(var i=t;i<half*half;i+=64u){
    let x=ox+i%half;let y=oy+i/half;let z=textureLoad(depthMap,vec2u(x,y),0);
    var r=cap;if(z>0.0){r=min(length(depthRay(f32(x)+0.5,f32(y)+0.5,z)),cap);}
    s+=vec2f(r,r*r);
  }
  sums[t]=s;workgroupBarrier();
  for(var k=32u;k>0u;k>>=1u){if(t<k){sums[t]+=sums[t+k];}workgroupBarrier();}
  if(t==0u){
    let m=sums[0]/f32(half*half);let c=f32(half)*0.5;
    let bin=probeBin(depthRay(f32(ox)+c,f32(oy)+c,0.5));
    probeData.texels[depthInfo.info.y+depthInfo.info.x*${R}u+bin]=vec2u(bitcast<u32>(m.x),bitcast<u32>(m.y));
  }
}
`,pe=(e,t)=>{let n=t?``:`*left`,r=e?`    var w=0.0;var hit=p;
    if(b.min.w>0.5){
      let o=p-(b.min.xyz+b.max.xyz)*0.5;let rr=b.max.w;w=clamp(1.0-(length(o)-rr)/max(b.position.w,1e-3),0.0,1.0)${n};if(w<=0.0){continue;}
      let a=max(dot(r,r),1e-12);let h=dot(o,r);hit=p+r*max((-h+sqrt(max(h*h-a*(dot(o,o)-rr*rr),0.0)))/a,0.0);
    }else{
      w=probeFade(p,b.min.xyz,b.max.xyz,b.position.w)${n};if(w<=0.0){continue;}
      let t3=(select(b.min.xyz,b.max.xyz,q>vec3f(0))-p)/q;hit=p+r*max(min(t3.x,min(t3.y,t3.z)),0.0);
    }
    let d=hit-b.position.xyz;
`:`    let w=probeFade(p,b.min.xyz,b.max.xyz,b.position.w)${n};if(w<=0.0){continue;}
    let t3=(select(b.min.xyz,b.max.xyz,q>vec3f(0))-p)/q;let d=p+r*max(min(t3.x,min(t3.y,t3.z)),0.0)-b.position.xyz;
`;return`fn probeReflection(p:vec3f,r:vec3f,rough:f32)->vec4f {
  var sum=vec3f(0);var ${t?`total=0.0`:`left=1.0`};let q=r+select(vec3f(0),vec3f(1e-6),abs(r)<vec3f(1e-6));
  for(var j=0u;j<probeData.reflections.x;j++){
    let b=probeData.boxes[j];if(b.data.w==0u){continue;}
${r}    sum+=w*probeRadiance(b,select(r,d,dot(d,d)>1e-12),rough);${t?`total+=w;`:`left-=w;`}
  }
  return ${t?`select(vec4f(sum,total),vec4f(sum/total,1.0),total>1.0)`:`vec4f(sum,1.0-left)`};
}`},me=(e,t,n,r=!1,i=!1,a)=>(a??``)+V(`read`,e,26)+(n?H:``)+`
// 1 inside the box and on its faces (surfaces lying on a room box are lit by it), fading to 0 over blend outside it.
fn probeFade(p:vec3f,lo:vec3f,hi:vec3f,blend:f32)->f32 {let o=max(lo-p,p-hi);return clamp(1.0-max(o.x,max(o.y,o.z))/max(blend,1e-3),0.0,1.0);}
fn probeIrradiance(p:vec3f,n:vec3f)->vec4f {
  let k=probeData.volumeCounts.w;if(k==0u){return vec4f(0);}
  let lo=probeData.volumeMin.xyz;let hi=probeData.volumeMax.xyz;let w=probeFade(p,lo,hi,probeData.volumeMin.w);if(w<=0.0){return vec4f(0);}
  let counts=probeData.volumeCounts.xyz;let last=vec3f(counts-1u);let g=clamp((p-lo)/(hi-lo)*vec3f(counts)-0.5,vec3f(0),last);
  let i0=vec3u(g);let f=g-vec3f(i0);
  // Each probe's coefficients are float16 rgb triples packed back to back in k vec4u (2 for L1, 4 for L2): the eight
  // corners are blended as raw halves (s0..s6 hold halves 0..27), then evaluated once.
  var s0=vec4f(0);var s1=vec4f(0);var s2=vec4f(0);var s3=vec4f(0);var s4=vec4f(0);var s5=vec4f(0);var s6=vec4f(0);
${n?`  // Visibility (header word 13): each corner's weight times its Chebyshev visibility of the biased receiver point and a
  // smooth backface term, then the weights renormalised.
  let vo=probeData.reflections.y;let cell=(hi-lo)/vec3f(counts);let q=p+n*(0.25*min(cell.x,min(cell.y,cell.z)));var total=0.0;
`:``}  for(var c=0u;c<8u;c++){
    let corner=min(i0+vec3u(c&1u,(c>>1u)&1u,c>>2u),counts-1u);let t=select(1.0-f,f,vec3<bool>((c&1u)!=0u,(c&2u)!=0u,(c&4u)!=0u));
${n?`    let index=corner.x+counts.x*(corner.y+counts.y*corner.z);let o=index*k;var wt=t.x*t.y*t.z;
    let pp=lo+(vec3f(corner)+0.5)*cell;let d=q-pp;let r=length(d);
    let i=vo+index*${R}u+probeBin(d/max(r,1e-6));let h=probeData.texels[i>>1u];let u=select(h.xy,h.zw,(i&1u)==1u);
    let m=bitcast<f32>(u.x);var cheb=1.0;
    if(r>m){let v=max(bitcast<f32>(u.y)-m*m,1e-4*dot(cell,cell));let e=r-m;cheb=v/(v+e*e);cheb=cheb*cheb*cheb;}
    let back=(dot(-d/max(r,1e-6),n)+1.0)*0.5;wt*=max(cheb,1e-4)*(back*back+0.2);total+=wt;
    let a=probeData.texels[o];let b=probeData.texels[o+1u];
`:`    let o=(corner.x+counts.x*(corner.y+counts.y*corner.z))*k;let wt=t.x*t.y*t.z;let a=probeData.texels[o];let b=probeData.texels[o+1u];
`}    s0+=wt*vec4f(unpack2x16float(a.x),unpack2x16float(a.y));s1+=wt*vec4f(unpack2x16float(a.z),unpack2x16float(a.w));
    s2+=wt*vec4f(unpack2x16float(b.x),unpack2x16float(b.y));s3+=wt*vec4f(unpack2x16float(b.z),unpack2x16float(b.w));
    if(k>2u){let c4=probeData.texels[o+2u];let d=probeData.texels[o+3u];
      s4+=wt*vec4f(unpack2x16float(c4.x),unpack2x16float(c4.y));s5+=wt*vec4f(unpack2x16float(c4.z),unpack2x16float(c4.w));s6+=wt*vec4f(unpack2x16float(d.x),unpack2x16float(d.y));}
  }
${n?`  if(total>0.0){let inv=1.0/total;s0*=inv;s1*=inv;s2*=inv;s3*=inv;s4*=inv;s5*=inv;s6*=inv;}
`:``}  let b1=0.488602512*n;
  var e=s0.xyz*0.282094792+vec3f(s0.w,s1.xy)*b1.y+vec3f(s1.zw,s2.x)*b1.z+s2.yzw*b1.x;
  if(k>2u){e+=s3.xyz*(1.092548431*n.x*n.y)+vec3f(s3.w,s4.xy)*(1.092548431*n.y*n.z)+vec3f(s4.zw,s5.x)*(0.315391565*(3.0*n.z*n.z-1.0))+s5.yzw*(1.092548431*n.x*n.z)+s6.xyz*(0.546274215*(n.x*n.x-n.y*n.y));}
  return vec4f(max(e,vec3f(0)),w);
}
fn probeLevel(o:u32,s:u32,uv:vec2f)->vec3f {
  let st=clamp(uv*f32(s)-0.5,vec2f(0),vec2f(f32(s-1u)));let i=vec2u(st);let j=min(i+1u,vec2u(s-1u));let f=st-vec2f(i);
  return mix(mix(probeTexel(o+i.y*s+i.x),probeTexel(o+i.y*s+j.x),f.x),mix(probeTexel(o+j.y*s+i.x),probeTexel(o+j.y*s+j.x),f.x),f.y);
}
fn probeRadiance(b:ProbeBox,d:vec3f,rough:f32)->vec3f {
  let levels=b.data.z;let x=clamp(rough,0.0,1.0)*f32(levels-1u);let k0=min(u32(x),levels-2u);let k=f32(k0);let uv=probeOct(d);
  var o0=b.data.x;for(var j=0u;j<k0;j++){let s=b.data.y>>j;o0+=s*s;}let s0=b.data.y>>k0;
  return mix(probeLevel(o0,s0,uv),probeLevel(o0+s0*s0,b.data.y>>(k0+1u),uv),(x*x-k*k)/(2.0*k+1.0));
}
${pe(r,i)}
${t?`@group(${e}) @binding(20) var iblSpecular:texture_cube<f32>;
@group(${e}) @binding(21) var iblSampler:sampler;
@group(${e}) @binding(22) var<storage,read> iblBrdf:array<u32>;
@group(${e}) @binding(23) var<uniform> iblSh:array<vec4f,9>;
@group(${e}) @binding(24) var<uniform> iblParams:vec4f;
${M}`:``}
// Specular radiance the probes put on a surface (before the split-sum weight): reflection probes, then the environment's
// prefiltered sky (or nothing). Post's SSR calls it to remove exactly the light its reflections replace.
fn probeSpecular(p:vec3f,n:vec3f,v:vec3f,rough:f32)->vec3f {
  let r=reflect(-v,n);let s=probeReflection(p,r,rough);
  return s.rgb+(1.0-s.a)*${t?`iblPrefiltered(iblSpecular,iblSampler,iblParams,r,rough)*iblParams.w`:a?`skyRadiance(r,rough)`:`vec3f(0)`};
}
// The receiver's ambient term with the probes: diffuse from the volume, specular from the reflection probes, the rest from
// the environment (or \`ambient\`, the receiver's own ambient, without one). Split-sum weights as EnvironmentLighting.
fn probeShade(p:vec3f,n:vec3f,v:vec3f,base:vec3f,metal:f32,rough:f32,ambient:vec3f,dielectricF0:vec3f,dielectricF90:f32)->vec3f {
  let nv=clamp(dot(n,v),1e-4,1.0);let f0=mix(dielectricF0,base,metal);let f90=mix(dielectricF90,1.0,metal);
  ${t?`let ab=iblBrdfTerms(nv,rough);let sw=f0*ab.x+f90*ab.y;`:`let c=rough*vec4f(-1,-0.0275,-0.572,0.022)+vec4f(1,0.0425,1.04,-0.04);let a=min(c.x*c.x,exp2(-9.28*nv))*c.x+c.y;let sw=f0*(c.z-1.04*a)+f90*(c.w+1.04*a);`}
  let diffuse=(1.0-sw)*(1.0-metal)*base;let e=probeIrradiance(p,n);
  ${t?`let fallback=diffuse*iblIrradiance(iblSh,iblRotate(n,iblParams))*iblParams.w;`:a?`let fallback=diffuse*skyIrradiance(n);_=ambient;`:`let fallback=ambient;`}
  return mix(fallback,diffuse*e.rgb,e.a)+probeSpecular(p,n,v,rough)*sw;
}
`,he=(e,t)=>V(`read_write`,0,0)+(t?te:``)+`
struct Bake {offset:u32,size:u32,source:u32,sourceSize:u32,roughness:f32,count:u32,pad0:u32,pad1:u32}
@group(0) @binding(1) var<uniform> bake:Bake;
@group(0) @binding(2) var faces:texture_2d_array<f32>;
@group(0) @binding(3) var linear:sampler;
${e?`@group(0) @binding(4) var sky:texture_cube<f32>;
@group(0) @binding(5) var<uniform> skyParams:vec4f;
fn envRadiance(d:vec3f)->vec3f {return textureSampleLevel(sky,linear,vec3f(skyParams.x*d.x-skyParams.y*d.z,d.y,skyParams.y*d.x+skyParams.x*d.z),0.0).rgb*skyParams.w;}`:`fn envRadiance(d:vec3f)->vec3f {return vec3f(0);}`}
// Columns: right, up, forward (FACES in probes.ts).
fn face(f:u32)->mat3x3f {return array<mat3x3f,6>(
  mat3x3f(0,0,1, 0,1,0, 1,0,0),mat3x3f(0,0,-1, 0,1,0, -1,0,0),mat3x3f(-1,0,0, 0,0,-1, 0,1,0),
  mat3x3f(-1,0,0, 0,0,1, 0,-1,0),mat3x3f(-1,0,0, 0,1,0, 0,0,1),mat3x3f(1,0,0, 0,1,0, 0,0,-1))[f];}
fn store(i:u32,c:vec3f) {probeData.texels[i]=vec2u(pack2x16float(c.rg),pack2x16float(vec2f(c.b,0.0)));}
fn octDecode(uv:vec2f)->vec3f {let f=uv*2.0-1.0;var n=vec3f(f.x,1.0-abs(f.x)-abs(f.y),f.y);let t=max(-n.y,0.0);n.x+=select(t,-t,n.x>=0.0);n.z+=select(t,-t,n.z>=0.0);return n;}
fn sampleFaces(d:vec3f)->vec3f {
  let m=abs(d);var f=select(1u,0u,d.x>0.0);if(m.y>=m.x&&m.y>=m.z){f=select(3u,2u,d.y>0.0);}else if(m.z>m.x&&m.z>m.y){f=select(5u,4u,d.z>0.0);}
  let b=face(f);let ndc=vec2f(dot(d,b[0]),dot(d,b[1]))/dot(d,b[2]);
  let c=textureSampleLevel(faces,linear,vec2f(ndc.x*0.5+0.5,0.5-ndc.y*0.5),f,0.0);
  return c.rgb+(1.0-c.a)*envRadiance(normalize(d));
}
var<workgroup> partial:array<vec4f,256>;
@compute @workgroup_size(256) fn sh(@builtin(local_invocation_index) t:u32) {
  let s=textureDimensions(faces).x;let total=6u*s*s;var acc:array<vec3f,9>;var weight=0.0;
  for(var i=t;i<total;i+=256u){
    let f=i/(s*s);let xy=vec2u(i%s,(i/s)%s);let ndc=vec2f((f32(xy.x)+0.5)/f32(s)*2.0-1.0,1.0-(f32(xy.y)+0.5)/f32(s)*2.0);
    let b=face(f);let d=normalize(b[2]+ndc.x*b[0]+ndc.y*b[1]);let w=pow(1.0+dot(ndc,ndc),-1.5);
    let c=textureLoad(faces,xy,f,0);let l=(c.rgb+(1.0-c.a)*envRadiance(d))*w;weight+=w;
    acc[0]+=l*0.282094792;acc[1]+=l*(0.488602512*d.y);acc[2]+=l*(0.488602512*d.z);acc[3]+=l*(0.488602512*d.x);
    acc[4]+=l*(1.092548431*d.x*d.y);acc[5]+=l*(1.092548431*d.y*d.z);acc[6]+=l*(0.315391565*(3.0*d.z*d.z-1.0));acc[7]+=l*(1.092548431*d.x*d.z);acc[8]+=l*(0.546274215*(d.x*d.x-d.y*d.y));
  }
  for(var k=0u;k<bake.count;k++){
    partial[t]=vec4f(acc[k],weight);workgroupBarrier();
    for(var stride=128u;stride>0u;stride>>=1u){if(t<stride){partial[t]+=partial[t+stride];}workgroupBarrier();}
    if(t==0u){let band=select(select(0.25,0.6666667,k>0u&&k<4u),1.0,k==0u);coefficients[k]=partial[0].xyz*(12.566370614/partial[0].w)*band;}
    workgroupBarrier();
  }
  // Pack the count * 3 halves into bake.size vec4u at vec4 index bake.offset (zero padded).
  if(t<bake.size){var v=vec4u(0);for(var e=0u;e<4u;e++){let h=(t*4u+e)*2u;v[e]=pack2x16float(vec2f(coefficientHalf(h),coefficientHalf(h+1u)));}let q=(bake.offset+t)*2u;probeData.texels[q]=v.xy;probeData.texels[q+1u]=v.zw;}
}
var<workgroup> coefficients:array<vec3f,9>;
fn coefficientHalf(h:u32)->f32 {if(h>=bake.count*3u){return 0.0;}return coefficients[h/3u][h%3u];}
@compute @workgroup_size(8,8) fn resample(@builtin(global_invocation_id) id:vec3u) {
  let s=bake.size;if(id.x>=s||id.y>=s){return;}
  store(bake.offset+id.y*s+id.x,sampleFaces(octDecode((vec2f(id.xy)+0.5)/f32(s))));
}
${t?`
var<workgroup> texelSum:array<vec4f,64>;
@compute @workgroup_size(64) fn prefilter(@builtin(workgroup_id) g:vec3u,@builtin(local_invocation_index) k:u32) {
  let s=bake.size;
  let n=normalize(octDecode((vec2f(g.xy)+0.5)/f32(s)));
  let up=select(vec3f(1,0,0),vec3f(0,0,1),abs(n.z)<0.999);
  let t=normalize(cross(up,n));let b=cross(n,t);let alpha=bake.roughness*bake.roughness;
  var sum=vec4f(0);
  for(var i=k;i<bake.count;i+=64u){
    let hl=importanceGGX(hammersley(i,bake.count),alpha);
    let h=t*hl.x+b*hl.y+n*hl.z;let l=2.0*hl.z*h-n;let nl=dot(n,l);
    if(nl>0.0){sum+=vec4f(sampleFaces(l)*nl,nl);}
  }
  texelSum[k]=sum;workgroupBarrier();
  for(var stride=32u;stride>0u;stride>>=1u){if(k<stride){texelSum[k]+=texelSum[k+stride];}workgroupBarrier();}
  if(k==0u){let total=texelSum[0];store(bake.offset+g.y*s+g.x,total.rgb/max(total.a,1e-20));}
}
`:`
@compute @workgroup_size(8,8) fn prefilter(@builtin(global_invocation_id) id:vec3u) {
  let s=bake.size;if(id.x>=s||id.y>=s){return;}
  let n=normalize(octDecode((vec2f(id.xy)+0.5)/f32(s)));let a=bake.roughness*bake.roughness;let a2=a*a;let m=bake.sourceSize;
  var sum=vec4f(0);
  for(var j=0u;j<m*m;j++){
    let p=octDecode((vec2f(f32(j%m),f32(j/m))+0.5)/f32(m));let r=length(p);let l=p/r;let nl=dot(n,l);if(nl<=0.0){continue;}
    let h=normalize(n+l);let nh=dot(n,h);let q=${L(`n`,`h`)};let w=a2/(q*q)*nl/(r*r*r);
    sum+=vec4f(probeTexel(bake.source+j)*w,w);
  }
  store(bake.offset+id.y*s+id.x,sum.rgb/max(sum.a,1e-20));
}
`}`,ge=e=>_e(O(e,le,`return vec4f(linear,1);`,`Light probe capture`)),_e=e=>{let t=e.replace(/(?<!fn )fogAmount\(/g,`0.0*fogAmount(`);if(t.includes(`fn clusterLighting(`)){let e=t;if(t=t.replace(`if(depth<clusterFrame.depth.x||depth>clusterFrame.depth.y){return vec3f(0);}`,``).replace(`let count=clusterCounts[cell];`,`let count=clusterFrame.grid.w;if(false){_=clusterCounts[cell];_=clusterIndices[0];}`).replace(`clusterLights[clusterIndices[cell*1024u+j]]`,`clusterLights[j]`),(e.match(/clusterIndices\[cell\*1024u\+j\]|let count=clusterCounts\[cell\];|depth>clusterFrame\.depth\.y/g)??[]).length!==3||t.includes(`clusterLights[clusterIndices`))throw new c(`unsupported`,`Light probe capture does not recognise the clustered lighting shader; update @margoengine/clustered and @margoengine/environment together`)}return t},U=e=>new c(e?`disposed`:`state`,`Light probe bake interrupted; bake again on live probes`),W=e=>typeof e==`number`&&Number.isFinite(e),G=e=>Array.isArray(e)&&e.length===3&&e.every(W),K=(e,t,n,r,i)=>{let a=e??t;if(!Number.isInteger(a)||a<n||a>r||a&a-1)throw RangeError(`Light probe ${i} must be a power of two from ${n} to ${r}`);return a},ve=(e,t)=>G(e)&&G(t)&&e.every((e,n)=>e<t[n]),q=e=>Math.log2(e)-1,ye=e=>{let t=0;for(let n=0;n<q(e);n++)t+=(e>>n)**2;return t},be=class t extends ne{coreRequirement=a(`1.0.0`,import.meta.url);static attach(e,n){r(e,a(`1.0.0`,import.meta.url));let i=new t(n);return e.use(i),i}constructor(e){super(e?.name??`light-probes`),this.entry=[],this.version=-1,this.header=new ArrayBuffer(z),this.headerView=new DataView(this.header),this.headerBaked=!1,this.offsets=[],this.captured=new Set,this.replayed=new Set,this.restorePending=!1,this.snapshotExposed=!1,this.pending=!1,this.baking=!1,this.bakeSamples=0,this.bakeCache=new Map,this.volumePosition=[.1,.1,.1],this.liveOptions=null,this.job=-1,this.jobFace=0,this.jobPosition=[0,0,0],this.jobWaiters=[],this.refreshQueue=[],this.refreshCount=0,this.liveVolumeOptions=null,this.visibilityOffset=0,this.volumeCursor=0,this.volumeLive=!1,this.sweepCount=0,this.depthInverse=new Float64Array(16);let{volume:t,reflections:n=[],environment:r,sky:i}=e??{};if(!t&&!n.length)throw TypeError(`LightProbes needs a volume or reflection probes`);if(r!==void 0&&(typeof r!=`object`||!(`specularView`in r)))throw TypeError(`LightProbes environment must be an Environment`);if(i!==void 0&&(typeof i!=`object`||!i||typeof i.pbr!=`function`||typeof i.bindings!=`function`||typeof i.registerPasses!=`function`))throw TypeError(`LightProbes sky must be a Sky from @margoengine/sky (with lighting.ambient)`);if(i&&r)throw TypeError(`LightProbes takes environment or sky as the light outside the probes, not both; pass one`);if(this.near=e.near??.05,this.far=e.far??1e3,!W(this.near)||!W(this.far)||this.near<=0||this.far<=this.near)throw RangeError(`Invalid light probe near/far; use 0 < near < far`);this.resolution=K(e.resolution,128,16,256,`resolution`);let a=new DataView(this.header),o=0;if(t){let e=t.counts,n=t.sh??2,r=t.blend??0;if(!ve(t.min,t.max)||!Array.isArray(e)||e.length!==3||e.some(e=>!Number.isInteger(e)||e<1||e>64)||e[0]*e[1]*e[2]>ue||n!==1&&n!==2||!W(r)||r<0)throw RangeError(`Invalid irradiance volume; pass min < max, 1-64 probes per axis (4,096 in total), sh 1 or 2, blend >= 0`);if(K(t.resolution,16,8,64,`volume resolution`),t.visibility!==void 0&&typeof t.visibility!=`boolean`)throw TypeError(`Irradiance volume visibility must be a boolean; pass true, false or omit it`);this.volume={...t,min:[...t.min],max:[...t.max],counts:[e[0],e[1],e[2]],sh:n,blend:r},t.min.forEach((n,r)=>{a.setFloat32(r*4,n,!0),a.setFloat32(16+r*4,t.max[r],!0),a.setUint32(32+r*4,e[r],!0)}),a.setFloat32(12,r,!0),o=e[0]*e[1]*e[2]*(n===2?8:4)}if(!Array.isArray(n)||n.length>16)throw RangeError(`Expected at most 16 reflection probes`);let s=e.reflectionBlend??`order`;if(s!==`order`&&s!==`weighted`)throw TypeError(`LightProbes reflectionBlend must be 'order' or 'weighted'`);if(this.reflectionBlend=s,this.reflections=n.map((e,t)=>{let n=e?.shape??`box`;if(n!==`box`&&n!==`sphere`)throw TypeError(`Reflection probe shape must be 'box' or 'sphere'`);if(e.blend!==void 0&&(!W(e.blend)||e.blend<0))throw RangeError(`Invalid reflection probe; pass blend >= 0`);let r,i;if(n===`sphere`){let t=e.radius;if(!G(e.position)||!W(t)||t<=0||e.min!==void 0||e.max!==void 0)throw RangeError(`Invalid sphere reflection probe; pass a finite position and radius > 0, and no min or max`);let[n,a,o]=e.position;r=[n-t,a-t,o-t],i=[n+t,a+t,o+t]}else{if(!ve(e.min,e.max)||!G(e.position)||e.radius!==void 0||e.position.some((t,n)=>t<e.min[n]||t>e.max[n]))throw RangeError(`Invalid reflection probe; pass min < max and position inside the box (radius is for spheres)`);r=[...e.min],i=[...e.max]}if(e.dynamic!==void 0&&typeof e.dynamic!=`boolean`)throw TypeError(`Reflection probe dynamic must be a boolean; pass true, false or omit it`);let s=e.blend??.1*Math.min(...i.map((e,t)=>e-r[t])),c=64+t*64;return[e.position,r,i].forEach((e,t)=>e.forEach((e,n)=>a.setFloat32(c+t*16+n*4,e,!0))),a.setFloat32(c+12,s,!0),n===`sphere`&&(a.setFloat32(c+28,1,!0),a.setFloat32(c+44,e.radius,!0)),a.setUint32(c+48,o,!0),a.setUint32(c+52,this.resolution,!0),a.setUint32(c+56,q(this.resolution),!0),this.offsets.push(o),o+=ye(this.resolution),{...e,position:[...e.position],min:r,max:i,blend:s}}),this.spheres=this.reflections.some(e=>e.shape===`sphere`),a.setUint32(48,this.reflections.length,!0),this.volume?.visibility){let e=this.volume,t=e.max.map((t,n)=>(t-e.min[n])/e.counts[n]);a.setUint32(52,o,!0),a.setFloat32(28,1.5*Math.hypot(...t),!0),this.visibilityOffset=o,o+=e.counts[0]*e.counts[1]*e.counts[2]*R}this.environment=r,i&&(this.sky=i,this.addCapture(i)),this.texelCount=o,this.roundDone=new Uint8Array(this.reflections.length),this.active=new Uint8Array(this.reflections.length),this.refreshWaiters=this.reflections.map(()=>[]),e.live!==void 0&&this.setLive(e.live),e.liveVolume!==void 0&&this.setLiveVolume(e.liveVolume)}get byteLength(){return z+this.texelCount*8}get baked(){return!!this.snapshot}get live(){return this.liveOptions}get refreshes(){return this.refreshCount}setLive(e){if(e===null){this.liveOptions=null,this.jobWaiters.length||(this.job=-1);return}if(typeof e!=`object`)throw TypeError(`LightProbes live options must be an object or null`);if(!this.reflections.length)throw TypeError("LightProbes live capture needs reflection probes; add some to `reflections`");let t=e.facesPerFrame??1,n=e.priority??`nearest`,r=K(e.samples,de,64,4096,`live samples`);if(!Number.isInteger(t)||t<1||t>96)throw RangeError(`LightProbes live facesPerFrame must be an integer from 1 to 96`);if(n!==`nearest`&&n!==`dynamic`)throw TypeError(`LightProbes live priority must be 'nearest' or 'dynamic'`);this.liveOptions=Object.freeze({facesPerFrame:t,priority:n,samples:r}),this.roundDone.fill(0)}get liveVolume(){return this.liveVolumeOptions}get sweeps(){return this.sweepCount}setLiveVolume(e){if(e===null){this.liveVolumeOptions=null;return}if(typeof e!=`object`)throw TypeError(`LightProbes liveVolume options must be an object or null`);if(!this.volume)throw TypeError("LightProbes liveVolume needs an irradiance volume; pass `volume`");let t=e.probesPerFrame??4;if(!Number.isInteger(t)||t<1||t>ue)throw RangeError(`LightProbes liveVolume probesPerFrame must be an integer from 1 to 4,096`);this.liveVolumeOptions=Object.freeze({probesPerFrame:t})}async readback(){if(this.disposed||!this.gpu||!this.buffer)throw this.disposed?new c(`disposed`,`${this.name} is disposed; create new LightProbes`):new c(`state`,`${this.name} is not attached: engine.use(probes) first`);await this.copyBack(this.gpu)}async refresh(e){if(this.disposed)throw new c(`disposed`,`${this.name} is disposed; create new LightProbes`);if(!this.engine||!this.gpu)throw new c(`state`,`${this.name} is not attached; engine.use(probes) first`);if(e!==void 0&&(!Number.isInteger(e)||e<0||e>=this.reflections.length))throw RangeError(`Reflection probe index must be an integer from 0 to ${this.reflections.length-1}`);let t=e===void 0?this.reflections.map((e,t)=>t):[e];await Promise.all(t.map(e=>new Promise((t,n)=>{this.refreshWaiters[e].push({resolve:t,reject:n}),this.refreshQueue.includes(e)||this.refreshQueue.push(e)})))}setReflectionPosition(e,t){if(!Number.isInteger(e)||e<0||e>=this.reflections.length)throw RangeError(`Invalid reflection probe index; use an index below the reflection probe count`);let n=this.reflections[e];if(!G(t)||(n.shape===`sphere`?Math.hypot(...t.map((e,t)=>e-(n.min[t]+n.max[t])/2))>n.radius:t.some((e,t)=>e<n.min[t]||e>n.max[t])))throw RangeError(`Reflection probe position must be finite and inside its box or sphere`);n.position=[...t];let r=this.headerView,i=64+e*64;for(let e=0;e<3;e++)r.setFloat32(i+e*4,t[e],!0);this.gpu&&this.writeHeader(this.headerBaked)}get device(){return!this.gpu||this.disposed||this.sky&&!this.sky.bindings().length||this.environment&&(this.environment.disposed||this.environment.device!==this.gpu)?null:this.gpu}entries(){if(this.sky){let e=this.sky.bindings(),t=this.entry,n=this.skyEntries;return(!n||n.sky!==e||n.own!==t||n.length!==e.length+t.length)&&(this.skyEntries=n={sky:e,own:t,length:e.length+t.length,entries:[...e,...t]}),n.entries}return this.environment?((!this.cached||this.version!==this.environment.version)&&(this.cached=[...N(this.environment,20),...this.entry],this.version=this.environment.version),this.cached):this.entry}patch(e,t){if(e.includes(`let margoAmbient=`))throw new c(`state`,`${this.name} replaces EnvironmentLighting: pass {environment} to LightProbes instead of attaching both`);let n=e.includes(`let base=terrainColor`)?`base`:`i.color`,r=!!this.environment||!!this.sky,i=e.includes(`frame.ambient.rgb`)?`*frame.ambient.rgb`:``,a=e.replace(/let linear=([^;]+);/,(e,t)=>{let a=!r&&t.includes(`*margoSkyLight(n)`),o=r?`vec3f(0)`:`${n}*(1.0-i.material.y)*${a?re:`frame.radiance.w${i}`}`;return`let margoAmbient=probeShade(i.position,n,v,${n},i.material.y,i.material.x,${o},vec3f(0.04),1.0);let linear=${(a?t.replace(`*${re}`,`*0.0`):t).replace(`frame.radiance.w`,`0.0`)}+margoAmbient;`});return a===e?e:me(t,!!this.environment,this.visibilityOffset>0,this.spheres,this.reflectionBlend===`weighted`,this.skyDeclarations(t))+a}hooks(e){let t=this.environment||this.sky?`vec3f(0)`:`(s.base.rgb*(1.0-s.metal)+mix(s.f0,s.base.rgb,s.metal)*0.5)*mix(vec3f(0.35,0.3,0.25),vec3f(1),clamp(s.n.y*0.5+0.5,0.0,1.0))*f.radiance.w`;return{declarations:me(e,!!this.environment,this.visibilityOffset>0,this.spheres,this.reflectionBlend===`weighted`,this.skyDeclarations(e)),ambient:`probeShade(i.position,s.n,v,s.base.rgb,s.metal,s.roughness,${t},s.f0,s.sw)*s.occlusion`}}skyDeclarations(e){if(!this.sky)return;let t=this.sky.pbr(e)?.declarations;if(!t?.includes(`fn skyIrradiance(`)||!t.includes(`fn skyRadiance(`))throw new c(`unsupported`,`${this.name} sky must define skyIrradiance and skyRadiance (Sky from @margoengine/sky with lighting.ambient)`);return t}add(e){let t=super.add(e),n=e;return typeof n.draw==`function`?(this.captured.add(n),()=>{this.captured.delete(n),t()}):t}addCapture(e,t={}){if(this.disposed)throw new c(`disposed`,`${this.name} is disposed; create new LightProbes`);if(!e||typeof e.registerPasses!=`function`)throw TypeError(`LightProbes addCapture needs a plugin with registerPasses(); pass terrain, water, a sky or a VFX system`);let n=t.passes;if(n!==void 0&&(!Array.isArray(n)||!n.every(e=>typeof e==`string`)))throw TypeError("LightProbes addCapture `passes` must be an array of pass names");let r=[];e.registerPasses({revision:0,add(e){return r.push(e),()=>{}},withOwner(e,t){t()},removeOwner(){}});for(let t of n??[])if(!r.some(e=>e.name===t))throw RangeError(`LightProbes addCapture: ${e.name} has no pass '${t}'; its passes are ${r.map(e=>`'${e.name}'`).join(`, `)}`);let i=r.filter(e=>n?n.includes(e.name):e.order>0).sort((e,t)=>e.order-t.order);if(!i.length)throw RangeError(`LightProbes addCapture: ${e.name} has no pass to replay; name them in \`passes\``);let a={passes:i,restore:i.filter(e=>e.order<ce)};return this.replayed.add(a),()=>{this.replayed.delete(a)}}setup(e){super.setup(e);let t=D(e).gpu;if(!t)throw new c(`unsupported`,`LightProbes require the WebGPU backend; use an engine on the WebGPU backend; see https://margoengine.com/errors#webgpu`);this.allocate(t)}onDeviceRestored(e){let t=D(e).gpu;this.release(),this.capture=void 0,t&&!this.disposed&&(this.allocate(t),this.environment&&this.environment.device!==t&&this.environment.restore(t).catch(t=>j(e,t)))}allocate(e){if(this.byteLength>e.limits.maxStorageBufferBindingSize||this.byteLength>e.limits.maxBufferSize)throw RangeError(`Light probe buffer exceeds device limit; use fewer probes or a smaller resolution`);this.buffer=e.createBuffer({label:`light probes`,size:this.byteLength,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST|GPUBufferUsage.COPY_SRC}),this.gpu=e,this.entry=[{binding:26,resource:{buffer:this.buffer}}],this.cached=void 0;let t=this.snapshot&&this.snapshotLit;t&&(e.queue.writeBuffer(this.buffer,z,this.snapshot),t.baked||(this.active.set(t.reflections),this.volumeLive=t.volume)),this.writeHeader(!!t?.baked)}writeHeader(e){this.headerBaked=e;let t=this.headerView;this.volume&&t.setUint32(44,e||this.volumeLive?this.volume.sh===2?4:2:0,!0);for(let n=0;n<this.reflections.length;n++)t.setUint32(64+n*64+60,+(e||!!this.active[n]),!0);this.gpu.queue.writeBuffer(this.buffer,0,t.buffer)}release(){this.active.fill(0),this.job!==-1&&this.jobWaiters.length&&(this.refreshWaiters[this.job].unshift(...this.jobWaiters),this.refreshQueue.includes(this.job)||this.refreshQueue.unshift(this.job)),this.jobWaiters=[],this.job=-1,this.volumeLive=!1,this.volumeCursor=0;let e=this.captureResources;if(this.captureResources=void 0,e)for(let t of e.owned)t.destroy();this.buffer?.destroy(),this.buffer=this.gpu=void 0,this.entry=[],this.cached=void 0,this.capture=void 0,this.bakeDevice=void 0,this.captureProxy=void 0,this.bakeCache.clear()}registerPasses(e){super.registerPasses(e),e.add({name:this.name+`:capture`,order:ce,execute:e=>{if(e.backend===`webgpu`&&e.device===this.gpu)try{this.pending?(this.pending=!1,this.jobFace=0,this.captureAll(e)):(this.job!==-1||this.refreshQueue.length||this.liveOptions||this.liveVolumeOptions)&&this.captureSlice(e)}finally{if(this.restorePending){this.restorePending=!1;for(let t of this.replayed)for(let n of t.restore)n.execute(e)}}}})}async bake(e={}){let t=e.bounces??1;if(!Number.isInteger(t)||t<1||t>8)throw RangeError(`Light probe bounces must be an integer from 1 to 8`);let n=e.samples===void 0?0:K(e.samples,0,64,4096,`bake samples`);if(this.disposed||!this.engine||!this.gpu)throw new c(this.disposed?`disposed`:`state`,`${this.name} is not attached: engine.use(probes) first`);if(this.baking)throw new c(`state`,`Light probe bake pending; await the running bake() first`);if(this.environment?.device===null)throw new c(`state`,`Light probe environment is not ready; wait for its restore or pass a live Environment`);this.baking=!0,this.bakeSamples=n;try{let e=this.engine,n=this.gpu,r=D(e).sceneOf(this),i=()=>e.render(r?{views:[{scene:r,camera:e.camera,viewport:[0,0,1,1]}],culling:!1}:{culling:!1});if(i(),this.disposed||this.gpu!==n)throw U(this.disposed);for(let e=0;e<t;e++){this.pending=!0,n.pushErrorScope(`validation`);try{i()}catch(e){try{await n.popErrorScope()}catch{}throw e}let e=await n.popErrorScope();if(e)throw new c(`failed`,`Light probe bake failed: ${e.message}; check the probe size and GPU memory, then bake again`);if(this.pending)throw new c(`failed`,`Light probe capture did not run (the engine did not render)`);if(this.disposed||this.gpu!==n)throw U(this.disposed);this.writeHeader(!0)}await this.copyBack(n,!0)}finally{this.pending=!1,this.baking=!1,this.bakeSamples=0}}irradianceAt(e,t){let n=this.volume,r=this.snapshot;if(!n||!r||!G(e)||!G(t)||e.some((e,t)=>e<n.min[t]||e>n.max[t]))return null;let i=n.sh===2?9:4,a=n.counts,o=[0,0,0],s=new Float32Array(27),c=e.map((e,t)=>Math.min(a[t]-1,Math.max(0,(e-n.min[t])/(n.max[t]-n.min[t])*a[t]-.5))),l=c.map(Math.floor),u=this.visibilityOffset,d=n.max.map((e,t)=>(e-n.min[t])/a[t]),f=e.map((e,n)=>e+t[n]*.25*Math.min(...d)),p=new Float32Array(r.buffer,r.byteOffset,r.length),m=0;for(let e=0;e<8;e++){let h=[0,1,2].map(t=>Math.min(l[t]+(e>>t&1),a[t]-1)),g=[0,1,2].reduce((t,n)=>t*(e>>n&1?c[n]-l[n]:1-c[n]+l[n]),1);if(u){let e=h.map((e,t)=>f[t]-(n.min[t]+(e+.5)*d[t])),r=Math.hypot(...e),i=e.map(e=>e/Math.max(r,1e-6)),o=(u+(h[0]+a[0]*(h[1]+a[1]*h[2]))*R+se(i))*2,s=p[o],c=1;if(r>s){let e=Math.max(p[o+1]-s*s,1e-4*d.reduce((e,t)=>e+t*t,0));c=(e/(e+(r-s)**2))**3}let l=(1-(i[0]*t[0]+i[1]*t[1]+i[2]*t[2]))*.5;g*=Math.max(c,1e-4)*(l*l+.2),m+=g}let _=(h[0]+a[0]*(h[1]+a[1]*h[2]))*(i===9?16:8);s.fill(0);for(let e=0;e<i*3;e++)s[e]=xe(r[_+(e>>1)])[e&1];I(s,t).forEach((e,t)=>{o[t]+=e*g})}if(u&&m>0)for(let e=0;e<3;e++)o[e]/=m;return o.map(e=>Math.max(0,e))}get texels(){return this.snapshot&&(this.snapshotExposed=!0),this.snapshot}reflectionOffset(e){return this.offsets[e]}resources(t){if(this.captureResources?.device===t)return this.captureResources;let n=[],r=e=>(n.push(e),e);try{let i=r(t.createBuffer({size:128,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST})),a=r(t.createBuffer({size:2048,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST})),o=t.createSampler({magFilter:`linear`,minFilter:`linear`}),s=new Map,c=(e,n)=>{let i=r(t.createTexture({size:[n,n,6],format:`rgba16float`,usage:GPUTextureUsage.RENDER_ATTACHMENT|GPUTextureUsage.TEXTURE_BINDING})),a=r(t.createTexture({size:[n,n],format:`depth24plus`,usage:GPUTextureUsage.RENDER_ATTACHMENT|(this.visibilityOffset?GPUTextureUsage.TEXTURE_BINDING:0)})),o=a.createView(),c=[],l=[];for(let e=0;e<6;e++){let t=i.createView({dimension:`2d`,baseArrayLayer:e,arrayLayerCount:1});c.push(t),l.push({colorAttachments:[{view:t,clearValue:[0,0,0,0],loadOp:`clear`,storeOp:`store`}],depthStencilAttachment:{view:o,depthClearValue:0,depthLoadOp:`clear`,depthStoreOp:`store`}})}s.set(e,{color:i,depth:a,array:i.createView({dimension:`2d-array`}),colors:c,depthView:o,passes:l,groups:new Map})};this.volume&&c(`volume`,this.volume.resolution??16),this.reflections.length&&c(`reflection`,this.resolution);let l=[],u=[],d=[];for(let t=0;t<6;t++){let n=[.1,.1,.1],r=[.1,.1,.1],i=new e({fov:90,position:n,target:r,near:this.near,far:this.far});i.up=B[t][1],l.push(i),u.push(n),d.push(r)}let f=[],p=new Uint32Array(512),m={device:t,owned:n,frame:i,params:a,sampler:o,targets:s,cameras:l,positions:u,aims:d,bindings:f,frameBinding:{binding:le,resource:{buffer:i}},values:new Float32Array(32),slots:p,floats:new Float32Array(p.buffer),commands:[],descriptor:{},depthStencil:{format:`depth24plus`,depthWriteEnabled:!0,depthCompare:`greater-equal`},multisample:{count:1},draw:{pipeline:this.capture.pipeline,bindings:f,clear:!1,clearDepth:!1}};return this.captureResources=m,m}catch(e){for(let e of n)e.destroy();throw e}}prepare(e,t){let n=e.device,r=e.descriptor.vertex.buffers?.length;if(this.capture?.source!==e.shader||this.capture.buffers!==r){let t=ge(e.shader),i=n.createShaderModule({code:t});this.capture={source:e.shader,buffers:r,pipeline:n.createRenderPipeline({layout:`auto`,vertex:{module:i,entryPoint:`vertex`,buffers:e.descriptor.vertex.buffers},fragment:{module:i,entryPoint:`fragment`,targets:[{format:`rgba16float`}]},depthStencil:{format:`depth24plus`,depthWriteEnabled:!0,depthCompare:`greater-equal`},primitive:{cullMode:`none`}})}}let i=this.bakePipelines(n,t>0),a=this.resources(n),o=a.descriptor;for(let t in o)Object.prototype.hasOwnProperty.call(e.descriptor,t)||delete o[t];Object.assign(o,e.descriptor),o.multisample=a.multisample,o.depthStencil=a.depthStencil,a.bindings.length=e.bindings.length+1;for(let t=0;t<e.bindings.length;t++)a.bindings[t]=e.bindings[t];a.bindings[e.bindings.length]=a.frameBinding,a.draw.pipeline=this.capture.pipeline;let s=this.environment?.specularView,c=this.environment?.paramsBuffer;if(a.environmentView!==s||a.environmentParams!==c){for(let e of a.targets.values())e.groups.clear();a.environmentView=s,a.environmentParams=c}return this.captureProxy?.device!==n&&(this.captureProxy={device:n,proxy:ae(n,_e)}),a.view||={...e},i}copyBack(e,t=!1){let n=this.copying;if(n&&!t)return n;let r=()=>{if(this.disposed||this.gpu!==e)throw U(this.disposed);return this.copyOnce(e)},i=(n?n.catch(()=>void 0).then(r):r()).finally(()=>{this.copying===i&&(this.copying=void 0)});return this.copying=i,i}async copyOnce(e){let t=this.captureResources,n=t?.read;n||(n=e.createBuffer({size:this.texelCount*8,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ}),t&&(t.owned.push(n),t.read=n));let r=!1;try{let t=e.createCommandEncoder();t.copyBufferToBuffer(this.buffer,z,n,0,this.texelCount*8),e.queue.submit([t.finish()]);let i={baked:this.headerBaked,volume:this.volumeLive,reflections:this.active.slice()};try{await n.mapAsync(GPUMapMode.READ)}catch(t){throw this.disposed||this.gpu!==e||t?.name===`AbortError`?U(this.disposed):t}if(r=!0,this.disposed||this.gpu!==e)throw U(this.disposed);let a=new Uint32Array(n.getMappedRange());this.snapshot&&!this.snapshotExposed&&this.snapshot.length===a.length?this.snapshot.set(a):this.snapshot=a.slice(),this.snapshotLit=i,this.snapshotExposed=!1}finally{r&&n.unmap(),t||n.destroy()}}captureAll(e){let t=this.bakeSamples,n=this.prepare(e,t),r=this.captureResources;if(this.volume){let i=this.volume,a=i.resolution??16,o=this.volumePosition;for(let s=0;s<i.counts[2];s++)for(let c=0;c<i.counts[1];c++)for(let l=0;l<i.counts[0];l++){o[0]=i.min[0]+(l+.5)*(i.max[0]-i.min[0])/i.counts[0],o[1]=i.min[1]+(c+.5)*(i.max[1]-i.min[1])/i.counts[1],o[2]=i.min[2]+(s+.5)*(i.max[2]-i.min[2])/i.counts[2];for(let u=0;u<6;u++)this.captureFace(e,r,n,o,a,u,l+i.counts[0]*(c+i.counts[1]*s),-1,t)}}for(let i=0;i<this.reflections.length;i++)for(let a=0;a<6;a++)this.captureFace(e,r,n,this.reflections[i].position,this.resolution,a,-1,i,t)}captureSlice(e){let t=this.liveOptions,n=t?t.samples:de,r;try{for(let i=t?t.facesPerFrame:1;i>0&&(this.job!==-1||this.nextJob(e.camera));i--){r??=this.prepare(e,n);let t=this.jobFace++;this.captureFace(e,this.captureResources,r,this.jobPosition,this.resolution,t,-1,this.job,n),t===5&&this.finishJob()}let i=this.liveVolumeOptions,a=this.volume;if(i&&a){r??=this.prepare(e,n);let[t,o,s]=a.counts,c=t*o*s,l=a.resolution??16,u=this.volumePosition;for(let d=Math.min(i.probesPerFrame,c);d>0;d--){let i=this.volumeCursor,d=i%t,f=Math.floor(i/t)%o,p=Math.floor(i/(t*o));u[0]=a.min[0]+(d+.5)*(a.max[0]-a.min[0])/t,u[1]=a.min[1]+(f+.5)*(a.max[1]-a.min[1])/o,u[2]=a.min[2]+(p+.5)*(a.max[2]-a.min[2])/s;for(let t=0;t<6;t++)this.captureFace(e,this.captureResources,r,u,l,t,i,-1,n);++this.volumeCursor<c||(this.volumeCursor=0,this.sweepCount++,this.volumeLive||(this.volumeLive=!0,this.headerView.setUint32(44,a.sh===2?4:2,!0),this.gpu.queue.writeBuffer(this.buffer,44,this.header,44,4)))}}}catch(e){throw this.liveOptions=null,this.liveVolumeOptions=null,this.job=-1,this.rejectRefreshes(e),e}}rejectRefreshes(e){let t=this.jobWaiters;this.jobWaiters=[],this.refreshQueue.length=0;for(let n of t)n.reject(e);for(let t=0;t<this.refreshWaiters.length;t++){let n=this.refreshWaiters[t];this.refreshWaiters[t]=[];for(let t of n)t.reject(e)}}nextJob(e){let t=this.refreshQueue.length?this.refreshQueue.shift():-1,n=this.liveOptions;if(t===-1&&n){let r=e.position,i=n.priority===`dynamic`;for(let e=0;e<2&&t===-1;e++){e&&this.roundDone.fill(0);let n=1/0;for(let e=0;e<this.reflections.length;e++){let a=this.reflections[e];if(this.roundDone[e]||i&&!a.dynamic)continue;let o=0;for(let e=0;e<3;e++){let t=a.min[e]-r[e],n=r[e]-a.max[e],i=t>n?t:n;i>0&&(o+=i*i)}o<n&&(n=o,t=e)}}}if(t===-1)return!1;this.job=t,this.jobFace=0;let r=this.reflections[t].position;if(this.jobPosition[0]=r[0],this.jobPosition[1]=r[1],this.jobPosition[2]=r[2],this.refreshWaiters[t].length){let e=this.refreshWaiters[t];this.refreshWaiters[t]=this.jobWaiters,this.jobWaiters=e}return!0}finishJob(){let e=this.job,t=this.gpu;if(this.job=-1,this.roundDone[e]=1,this.refreshCount++,!this.active[e]){this.active[e]=1;let n=64+e*64+60;this.headerView.setUint32(n,1,!0),t.queue.writeBuffer(this.buffer,n,this.header,n,4)}if(this.jobWaiters.length){let n=this.jobWaiters;this.jobWaiters=[];let r=r=>{if(this.disposed){let e=new c(`disposed`,`${this.name} was disposed before the refresh finished`);for(let t of n)t.reject(e)}else this.gpu===t?r():(this.refreshWaiters[e].push(...n),this.refreshQueue.includes(e)||this.refreshQueue.push(e))};t.queue.onSubmittedWorkDone().then(()=>r(()=>{for(let e of n)e.resolve()}),e=>r(()=>{for(let t of n)t.reject(e)}))}}captureFace(e,t,n,r,i,a,o,s,c){let l=e.device,u=t.targets.get(s>=0?`reflection`:`volume`),d=D(this.engine).lighting,f=t.values,p=t.view,m=t.cameras[a],h=t.positions[a],g=t.aims[a],_=B[a][0];for(let e=0;e<3;e++)h[e]=r[e],g[e]=r[e]+_[e];m.fov=90,m.near=this.near,m.far=this.far,m.position=h,m.target=g,m.up=B[a][1],m.project=void 0,m.cancelFit(),m.update(1,!0),f.set(m.matrix),f.set(r,16),f[19]=0,oe(f,20,d.direction),f.set(d.radiance,24),f.fill(1,28,31),d.ambient&&f.set(d.ambient,28),l.queue.writeBuffer(t.frame,0,f);let v=l.createCommandEncoder(),y=u.colors[a],b=u.depthView,x={encoder:e.encoder,color:e.color,depth:e.depth,descriptor:e.descriptor,camera:e.camera,width:e.width,height:e.height,format:e.format,view:e.view},S=Object.hasOwn(e,`view`),C=[0,0,i,i],w=x.view&&{id:x.view.id,camera:m,viewport:C,index:0,count:1,layers:x.view.layers};try{if(v.beginRenderPass(u.passes[a]).end(),e.encoder=v,e.color=y,e.depth=b,e.descriptor=t.descriptor,e.camera=m,e.width=e.height=i,e.format=`rgba16float`,e.view=w,t.draw.pipeline=this.capture.pipeline,t.draw.bindings=t.bindings,t.draw.clear=!1,t.draw.clearDepth=!1,e.draw(t.draw),this.disposed||this.gpu!==l)throw U(this.disposed);for(let t in p)Object.prototype.hasOwnProperty.call(e,t)||delete p[t];Object.assign(p,e),p.device=this.captureProxy.proxy;for(let e of this.captured)if(e.draw(p,`beauty`,y,b),this.disposed||this.gpu!==l)throw U(this.disposed);if(this.replayed.size){p.device=l,p.attach=void 0,p.last=p.joins=p.only=!1;for(let e of this.replayed){e.restore.length&&(this.restorePending=!0);for(let t of e.passes)if(t.execute(p),this.disposed||this.gpu!==l)throw U(this.disposed)}}this.visibilityOffset&&s===-1&&o>=0&&this.measureDepth(t,u,v,m,r,o,a,i),a===5&&this.filterProbe(t,u,n,v,o,s,c),t.commands[0]=v.finish(),l.queue.submit(t.commands)}finally{Object.assign(e,x),S||delete e.view}}captureGroup(e,t,n,r,i,a){let o=t.groups.get(n);o||t.groups.set(n,o=[]);let s=o[i];if(!s){let c=[{binding:0,resource:{buffer:this.buffer}},{binding:1,resource:{buffer:e.params,offset:i*256,size:32}}];(r!==`prefilter`||a>0)&&(c.push({binding:2,resource:t.array}),(r!==`sh`||this.environment)&&c.push({binding:3,resource:e.sampler}),this.environment&&c.push({binding:4,resource:e.environmentView},{binding:5,resource:{buffer:e.environmentParams,offset:0,size:16}})),s=e.device.createBindGroup({layout:n.getBindGroupLayout(0),entries:c}),o[i]=s}return s}measureDepth(e,t,n,r,i,a,o,s){let c=e.device;this.depthPipeline?.device!==c&&(this.depthPipeline={device:c,pipeline:c.createComputePipeline({layout:`auto`,compute:{module:c.createShaderModule({code:fe}),entryPoint:`visibility`}})});let u=this.depthPipeline.pipeline,d=e.depthUniform;d||(d=c.createBuffer({size:1536,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST}),e.owned.push(d),e.depthUniform=d);let f=new Float32Array(28),p=new Uint32Array(f.buffer);if(!l(r.matrix,this.depthInverse))return;f.set(this.depthInverse),f.set(i,16),p[20]=a,p[21]=this.visibilityOffset,p[22]=s,f[24]=this.headerView.getFloat32(28,!0),c.queue.writeBuffer(d,o*256,f);let m=t.groups.get(u);m||t.groups.set(u,m=[]);let h=m[o]??=c.createBindGroup({layout:u.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:this.buffer}},{binding:1,resource:{buffer:d,offset:o*256,size:112}},{binding:2,resource:t.depthView}]}),g=n.beginComputePass();g.setPipeline(u),g.setBindGroup(0,h),g.dispatchWorkgroups(4),g.end()}filterProbe(e,t,n,r,i,a,o){let s=e.slots,c=e.floats,l=a===-1,u=l?1:q(this.resolution),d=this.offsets[a],f=l?i*(this.volume.sh===1?2:4):d;for(let e=0;e<u;e++){let t=e*64,n=l?this.volume.sh===1?2:4:this.resolution>>e;s[t]=f,s[t+1]=n,s[t+2]=!l&&e>0?d:0,s[t+3]=this.resolution,c[t+4]=!l&&e>0?e/(u-1):0,s[t+5]=l?this.volume.sh===1?4:9:e>0?o:0,s[t+6]=s[t+7]=0,l||(f+=n**2)}e.device.queue.writeBuffer(e.params,0,s,0,u*64);let p=r.beginComputePass();for(let r=0;r<u;r++){let i=l?`sh`:r===0?`resample`:`prefilter`,a=s[r*64+1],c=l?1:i===`prefilter`&&o>0?a:Math.ceil(a/8),u=n[i];p.setPipeline(u),p.setBindGroup(0,this.captureGroup(e,t,u,i,r,o)),p.dispatchWorkgroups(c,c)}p.end()}bakePipelines(e,t){this.bakeDevice!==e&&(this.bakeCache.clear(),this.bakeDevice=e);let n=this.bakeCache.get(t);if(n)return n;let r=e.createShaderModule({code:he(!!this.environment,t)}),i=t=>e.createComputePipeline({layout:`auto`,compute:{module:r,entryPoint:t}}),a={sh:i(`sh`),resample:i(`resample`),prefilter:i(`prefilter`)};return this.bakeCache.set(t,a),a}dispose(){super.dispose(),this.release(),this.captured.clear(),this.replayed.clear(),this.liveOptions=null,this.liveVolumeOptions=null,this.rejectRefreshes(new c(`disposed`,`${this.name} was disposed before the refresh finished`))}},xe=e=>[P(e&65535),P(e>>>16)],J=.435,Se=.034,Ce=2.25,Y=.486,we=Math.PI*2;function Te(){let e=[],t=[],n=[];return{tri(r,i,a,o){let s=e.length/3;if(e.push(...r,...i,...a),o)t.push(...o);else{let e=i[0]-r[0],n=i[1]-r[1],o=i[2]-r[2],s=a[0]-r[0],c=a[1]-r[1],l=a[2]-r[2],u=n*l-o*c,d=o*s-e*l,f=e*c-n*s,p=Math.hypot(u,d,f)||1;for(let e=0;e<3;e++)t.push(u/p,d/p,f/p)}n.push(s,s+1,s+2)},quad(e,t,n,r){this.tri(e,t,n),this.tri(e,n,r)},finish(){return new o(e,t,n)}}}function Ee(e,t,n,r,i,a,o,s){let c=i*.5,l=a*.5,u=o*.5,d=Math.min(s,c*.5,l*.5,u*.5),f=(e,n,i,a)=>[[t-n+a,e,r+i],[t+n-a,e,r+i],[t+n,e,r+i-a],[t+n,e,r-i+a],[t+n-a,e,r-i],[t-n+a,e,r-i],[t-n,e,r-i+a],[t-n,e,r+i-a]],p=[f(n-l,c-d,u-d,d*.35),f(n-l+d,c,u,d),f(n+l-d,c,u,d),f(n+l,c-d,u-d,d*.35)];for(let t=0;t<3;t++)for(let n=0;n<8;n++){let r=(n+1)%8;e.quad(p[t][n],p[t][r],p[t+1][r],p[t+1][n])}for(let t=1;t<7;t++)e.tri(p[0][0],p[0][t+1],p[0][t]),e.tri(p[3][0],p[3][t],p[3][t+1])}function X(e,t,n,r,i,a,o){let s=(e,i,a)=>[t+i*Math.cos(e*Math.PI/38),n+i*Math.sin(e*Math.PI/38),r+a];for(let t=0;t<38;t++){let n=i+a,r=t+1;e.quad(s(t,i,o/2),s(t,n,o/2),s(r,n,o/2),s(r,i,o/2)),e.quad(s(r,i,-o/2),s(r,n,-o/2),s(t,n,-o/2),s(t,i,-o/2)),e.quad(s(t,i,-o/2),s(t,i,o/2),s(r,i,o/2),s(r,i,-o/2)),e.quad(s(r,n,-o/2),s(r,n,o/2),s(t,n,o/2),s(t,n,-o/2))}}var De={floor:[`#656157`,.82,0],slate:[`#323839`,.82,0],char:[`#242e32`,.75,0],gantry:[`#303b3b`,.78,0],brass:[`#bd9d64`,.5,.72],light:[`#e9dfca`,.63,0],ivory:[`#aca28b`,.8,0],amber:[`#b0583d`,.78,0],amberDeep:[`#724538`,.86,0],amberLight:[`#e2a063`,.8,0],green:[`#4e9782`,.78,0],greenDeep:[`#316959`,.85,0],greenLight:[`#93bf91`,.8,0],blue:[`#4375a6`,.76,0],blueDeep:[`#2d4c73`,.84,0],blueLight:[`#9baed9`,.76,0],tileA:[`#746d5e`,.82,0],tileB:[`#77705f`,.86,0],tileC:[`#646053`,.85,0]};function Oe(){let e=new Map,t=t=>(e.has(t)||e.set(t,Te()),e.get(t)),n=(e,n,r,i,a,o,s,c=.018)=>Ee(t(e),n,r,i,a,o,s,c);n(`floor`,0,-.147,-.15,7.13,.25,4.65,.028);for(let e=0;e<8;e++)for(let t=0;t<4;t++){let r=(e-3.5)*.865+t%2*.22,i=-1.55+t*.89,a=[`tileA`,`tileB`,`tileC`][(e*9+t*5)%3];n(a,r,-.025,i,.854,.038,.88,.006)}n(`char`,0,1.57,-1.921,7.2,3.16,.23,.01),n(`ivory`,0,.141,-1.714,7.16,.26,.19),n(`gantry`,-3.44,1.52,-.18,.2,3.07,3.51),n(`gantry`,3.44,1.52,-.18,.2,3.07,3.51),n(`char`,0,3.17,-.61,7.17,.252,2.93,.061),n(`brass`,0,2.98,.8,6.91,.056,.16,.018),n(`light`,0,2.957,.8,6.71,.014,.136,.009),n(`brass`,0,2.926,-1.57,6.77,.024,.063,.01);for(let e of[-3.3,-1.103,1.103,3.3])n(`gantry`,e,1.42,-.49,.083,2.65,2.1,.014),n(`ivory`,e,1.417,.567,.122,2.69,.085,.026),n(`brass`,e,1.417,.617,.028,2.58,.016,.006);for(let e=0;e<3;e++){let r=(e-1)*2.205,i=[`amber`,`green`,`blue`][e],a=i+`Deep`,o=i+`Light`;n(a,r,1.57,-1.769,2.14,2.84,.084),n(i,r,1.53,-1.666,1.86,2.53,.16,.034);for(let e of[-1,1]){let t=r+e*.949;n(o,t,1.2,-1.504,.09,1.86,.124,.018),n(a,t+e*.088,1.25,-.966,.145,2,.877,.026),n(i,t+e*.046,1.25,-.945,.056,1.84,.831,.012);for(let r=0;r<3;r++)n(o,t+e*.013,1.212,-1.19+r*.178,.021,1.65,.025,.005)}X(t(o),r,1.625,-1.501,.833,.123,.135),X(t(a),r,1.625,-1.412,.958,.051,.083);for(let e=0;e<6;e++){let t=r-.656+e*.262;n(e%2==0?i:o,t,1.164,-1.57,.096,1.58,.046,.015),n(a,t-.06,1.217,-1.585,.017,1.62,.023,.005)}n(`slate`,r,.095,-1.226,1.77,.167,.858,.033),n(o,r,.187,-1.241,1.63,.029,.778,.012),n(`ivory`,r,2.643,-.732,1.42,.039,.218,.01),n(`light`,r,2.613,-.722,1.32,.027,.177,.008),n(i,r,-.004,1.44,2.13,.03,1.056,.011),n(o,r,.011,1.487,2.01,.006,.779,.002),n(a,r,.019,1.919,1.99,.007,.027,.002),n(a,r,2.962,1.314,2.131,.144,1.078,.024),n(o,r,2.885,1.314,2.001,.03,.981,.014)}n(`slate`,0,-.016,Y,6.18,.095,.944,.024),n(`char`,0,.016,Y,6.04,.036,.715,.016);for(let e of[.191,.7809999999999999])n(`brass`,0,.028,e,5.956,.012,.021,.004);for(let e=-24;e<=24;e++){let t=e*.108;n(e%5==0?`light`:`ivory`,t,.035,.83,.007,.0015,e%5==0?.051:.027,3e-4)}for(let e of[-2.83,2.83])n(`brass`,e,.054,Y,.038,.066,.593,.008);return Array.from(e,([e,t])=>{let[n,r,a]=De[e];return{geometry:t.finish(),material:new i({color:n,roughness:r,metalness:a,doubleSided:!1})}})}function ke(){let e=[],t=[],n=[];for(let r=0;r<=80;r++){let i=Math.PI*r/80,a=Math.cos(i),o=Math.sin(i);for(let i=0;i<=108;i++){let s=i%108*we/108,c=o*Math.cos(s),l=o*Math.sin(s);if(e.push(c*J,a*J,l*J),t.push(c,a,l),r<80&&i<108){let e=r*109+i,t=e+108+1;r>0&&n.push(e,e+1,t+1),r+1<80&&n.push(e,t+1,t)}}}return new o(e,t,n)}function Ae(){let e=[],t=[],n=[];for(let r of[-.64,.19,.74])for(let i=0;i<=190;i++){let a=we*i/190;for(let n of[-1,1]){let i=r+n*.014,o=.4356,s=Math.cos(i)*Math.cos(a),c=Math.sin(i),l=Math.cos(i)*Math.sin(a);e.push(o*s,o*c,o*l),t.push(s,c,l)}if(i){let t=e.length/3-2;n.push(t-2,t-1,t+1,t-2,t+1,t)}}return new o(e,t,n)}function je(e){let t=e.createMesh(),n=new i({color:`#d5d2c6`,roughness:.124,metalness:.63,doubleSided:!0}),r=new i({color:`#78594a`,roughness:.39,metalness:.56,doubleSided:!0}),a=e.createMesh(t).setGeometry(ke()).setMaterial(n),o=e.createMesh(t).setGeometry(Ae()).setMaterial(r);return{setPosition(e){t.setPosition([e,.469,Y]),t.setRotation([0,0,-e/J])},setSatin(e){n.set({roughness:e?.52:.124})},hide(e){a.visible=!e,o.visible=!e}}}var Z=[-2.2266666666666666,0,2.2266666666666666],Me=[[.42797852,.25219727,.15576172,-.11169434,-.06765747,-.03886414,-.22045898,-.07392883,-.03852081,.01132393,.01589584,.00343609,-.00244713,-.007267,-.00699234,.06494141,.0284729,.00376129,.2232666,.04241943,-.00669861,-.00144196,.01567078,.00826263,-.12670898,-.056427,-.02304077],[.23828125,.36181641,.26318359,-.0703125,-.09365845,-.06495667,-.04680634,-.15975952,-.10006714,-.02561188,-.00281954,.02280807,.00487137,-.00181484,-.00810242,.01776123,.03594971,.00812531,.02352905,.14135742,.07312012,-.02017212,.00987244,.03424072,-.0451355,-.0826416,-.04690552],[.21057129,.2878418,.40161133,-.06468201,-.07731628,-.09851074,-.05877686,-.09988403,-.19976807,-.02389526,-.0379715,-.03435516,.00147629,.00512314,.00454712,.02954102,.03102112,.05206299,.02528381,.07202148,.19519043,-.00242805,-.00685501,.01693726,-.05679321,-.06744385,-.1104126]],Q=e=>document.getElementById(e),Ne=e=>Ce*(e/500-1),$={min:[-3.34,-.02,-1.75],max:[3.34,3.04,2.18]},Pe=[-2.21,0,2.21].map((e,t)=>({position:[e,.52,.48],min:[[-3.34,-1.18,.99][t],$.min[1],$.min[2]],max:[[-.99,1.18,3.34][t],$.max[1],$.max[2]],blend:.47})),Fe=[0,-.255,.967],Ie=(e,t,n)=>Math.min(n,Math.max(t,e));function Le(e){let t=Ie(e,0,1);return Math.round(255*(t<=.0031308?12.92*t:1.055*t**(1/2.4)-.055))}function Re(e){let t=Z[1]-Z[0],n=Ie((e-Z[0])/t,0,2),r=Math.min(1,Math.floor(n)),i=n-r;return Me[r].map((e,t)=>e+(Me[r+1][t]-e)*i)}function ze(e){e.lighting.direction.set([.24,.67,.74]),e.lighting.radiance.set([.53,.55,.56,.47]),e.lighting.ambient.set([1.06,1.07,1.08])}function Be({opening:e,viewport:t,canvas:n,loading:r,page:i,signal:a,fail:o,resize:s}){let c=Q(`path`),l=Q(`controls`),u=Q(`satin`),d=Q(`position`),f=Q(`irradiance`),p=Q(`sample`),m=Q(`reflection-status`),h,g,_,v,y,b,x,S,C=!1,w=!1,T=!1,D=Ne(Number(c.value)),O=u.checked;function k(e){D=e,n.width/n.height<1.25?(h.camera.position=[D+.6,1.52,4.46],h.camera.target=[D,.8,-.1],h.camera.fov=39):(h.camera.position=[D*.11+.45,2.02,7.5],h.camera.target=[D*.08,.98,-.18],h.camera.fov=31)}function A(){let e=y?y.irradiance(Fe):g.irradianceAt([D,J+Se,Y],Fe);if(!e)throw Error(`The irradiance volume did not provide a sample at the sphere.`);p.style.backgroundColor=`rgb(`+e.map(Le).join(`,`)+`)`,f.textContent=e.map(e=>e.toFixed(3)).join(` / `),d.textContent=D.toFixed(2).replace(`-`,`−`)+` m`,c.setAttribute(`aria-valuetext`,d.textContent),t.dataset.coordinate=D.toFixed(3),t.dataset.diffuse=e.map(e=>e.toFixed(5)).join(`,`),t.dataset.finish=O?`satin`:`polished`}function j(){if(!v){h.render();return}let e=[0,0,1,1],t=h.camera;y.coefficients=Re(D),h.render({views:[{id:`gallery`,scene:h.scene,camera:t,viewport:e},{id:`probe-sphere`,scene:v,camera:t,viewport:e,clear:{color:!1,depth:!1}}]})}async function M(e){let t=Ne(Number(c.value));_.setPosition(t),O=u.checked,_.setSatin(O),k(t),j(),await h.gpu.queue.onSubmittedWorkDone(),await new Promise(e=>requestAnimationFrame(e)),a.throwIfAborted(),A(),e&&(performance.mark(`roll-frame`),performance.getEntriesByName(`first-control-frame`).length||(performance.mark(`first-control-frame`),v&&!C&&(clearTimeout(S),S=setTimeout(L,570))))}async function N(){if(!(a.aborted||i.failed)&&(T=!0,!w)){w=!0;try{for(;T&&!a.aborted;)T=!1,await M(!0)}catch(e){o(e)}finally{w=!1}}}function P(){x||=h.gpu.createTexture({size:[1,1],format:`rgba8unorm`,usage:GPUTextureUsage.RENDER_ATTACHMENT}),h.render({views:[{id:`probe-capture`,scene:h.scene,camera:h.camera,viewport:[0,0,1,1],target:{color:x}}],culling:!1})}async function F(){g=be.attach(h,{volume:{...$,counts:[3,1,1],resolution:16,sh:2,blend:.27},reflections:Pe,resolution:64,reflectionBlend:`weighted`,near:.065,far:15}),performance.mark(`probe-capture-start`),g.setLiveVolume({probesPerFrame:3});try{P()}finally{g.setLiveVolume(null)}if(await g.readback(),g.sweeps!==1)throw Error(`The irradiance probe volume did not finish its first sweep.`);performance.mark(`irradiance-ready`);for(let e=0;e<3;e++){a.throwIfAborted(),g.setLive({facesPerFrame:6,priority:`nearest`,samples:64});let t=g.refresh(e);try{P()}finally{g.setLive(null)}await t,await new Promise(e=>requestAnimationFrame(e))}await g.readback(),a.throwIfAborted(),_=je(h),v&&(v.dispose(),v=void 0,y=void 0),t.dataset.probeBytes=String(g.byteLength)}function ee(){v=h.createScene(`rolling-probe-sphere`),v.background=null,ze(v),y=new E({coefficients:Re(D)}),v.use(y),_=je(v),t.dataset.probes=`3,0`,t.dataset.irradiance=`captured`,m.hidden=!1,performance.mark(`captured-irradiance-ready`)}function I(){t.dataset.probes=`3,3`,t.dataset.irradiance=`live-capture`,performance.mark(`reflections-ready`),m.hidden=!0}function L(){a.aborted||i.failed||C||(C=!0,F().then(async()=>{await M(!1),I()}).catch(o))}async function te(){let d=Oe();performance.mark(`architecture-prepared`),h=await e,a.throwIfAborted(),h.scene.background=`#465150`,k(D),ze(h.scene);for(let{geometry:e,material:t}of d)h.createMesh().setGeometry(e).setMaterial(t);let f=t.dataset.renderer===`webgpu`;f?await F():ee(),await M(!1),f&&I(),performance.mark(`gallery-frame`),c.addEventListener(`input`,()=>void N(),{signal:a}),u.addEventListener(`change`,()=>void N(),{signal:a}),b=new ResizeObserver(()=>{if(s()&&!a.aborted)try{k(D),j()}catch(e){o(e)}}),b.observe(n),i.ready()&&(l.disabled=!1,u.disabled=!1,r.hidden=!0,f||(S=setTimeout(L,Math.max(1050,3550-performance.now()))))}return te().catch(o),()=>{clearTimeout(S),b?.disconnect(),x?.destroy()}}export{Be as mount};