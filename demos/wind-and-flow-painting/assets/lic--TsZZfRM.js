import{A as e,c as t,f as n,i as r,k as i,n as a,o,u as s,x as c}from"./render-DjrFtSQy-f_fSRgeI.js";var l=new WeakMap;function u(e,t,n,r){return l.get(e)?.(t,n,r),r}var d=`
struct Lic {
  model: mat4x4f, origin: vec4f, axisU: vec4f, axisV: vec4f,
  gridOrigin: vec4f, gridU: vec4f, gridV: vec4f, dualU: vec4f, dualV: vec4f,
  dims: vec4u, image: vec4u, style: vec4f, colour: vec4f
}
@group(1) @binding(0) var<uniform> lic: Lic;
`,f=`${d}
@group(1) @binding(1) var<storage, read> field: array<vec4f>;
@group(1) @binding(2) var<storage, read_write> image: array<vec4f>;
fn missing(v: f32) -> bool { return (bitcast<u32>(v) & 0x7fffffffu) > 0x7f800000u; }
fn sampleField(uv: vec2f) -> vec4f {
  if (any(uv < vec2f(0.0)) || any(uv > vec2f(1.0))) { return vec4f(0.0, 0.0, 0.0, -1.0); }
  let p = lic.gridOrigin.xyz + uv.x * lic.gridU.xyz + uv.y * lic.gridV.xyz;
  if (any(p < vec3f(0.0)) || any(p > vec3f(1.0))) { return vec4f(0.0, 0.0, 0.0, -1.0); }
  let q = p * vec3f(lic.dims.xyz - vec3u(1u));
  let lo = min(vec3u(q), lic.dims.xyz - vec3u(1u));
  let hi = min(lo + vec3u(1u), lic.dims.xyz - vec3u(1u));
  let t = q - vec3f(lo);
  var sum = vec4f(0.0);
  for (var z = 0u; z < 2u; z++) {
    for (var y = 0u; y < 2u; y++) {
      for (var x = 0u; x < 2u; x++) {
        let weight = select(1.0 - t.x, t.x, x == 1u) * select(1.0 - t.y, t.y, y == 1u) * select(1.0 - t.z, t.z, z == 1u);
        if (weight > 0.0) {
          let at = select(lo, hi, vec3u(x, y, z) == vec3u(1u));
          let value = field[(at.z * lic.dims.y + at.y) * lic.dims.x + at.x];
          if (missing(value.w)) { return vec4f(0.0, 0.0, 0.0, -1.0); }
          sum += value * weight;
        }
      }
    }
  }
  // Rescale after interpolation, before projection or a squared norm can underflow.
  let componentScale = max(max(abs(sum.x), abs(sum.y)), abs(sum.z));
  var unit = vec3f(0.0);
  if (componentScale > 0.0) { unit = sum.xyz / componentScale; }
  let direction = vec2f(dot(unit, lic.dualU.xyz), dot(unit, lic.dualV.xyz)) * vec2f(lic.image.xy);
  let directionScale = max(abs(direction.x), abs(direction.y));
  var velocity = vec2f(0.0);
  if (directionScale > 0.0) {
    let scaled = direction / directionScale;
    velocity = scaled / length(scaled) / vec2f(lic.image.xy);
  }
  let scalar = select((componentScale * lic.colour.x) * length(unit) + lic.colour.y, sum.w, lic.dims.w == 1u);
  return vec4f(velocity, scalar, 1.0);
}
fn hash(p: vec2u) -> f32 {
  var h = (p.x * 1664525u + p.y * 1013904223u) ^ lic.image.w;
  h = (h ^ (h >> 16u)) * 2246822519u;
  h = (h ^ (h >> 13u)) * 3266489917u;
  h = h ^ (h >> 16u);
  return f32(h >> 8u) / 16777216.0;
}
fn noise(uv: vec2f) -> f32 {
  let q = clamp(uv * vec2f(lic.image.xy) - vec2f(0.5), vec2f(0.0), vec2f(lic.image.xy - vec2u(1u)));
  let lo = vec2u(q); let hi = min(lo + vec2u(1u), lic.image.xy - vec2u(1u));
  let t = fract(q);
  return mix(mix(hash(lo), hash(vec2u(hi.x, lo.y)), t.x), mix(hash(vec2u(lo.x, hi.y)), hash(hi), t.x), t.y);
}
fn weight(s: f32) -> f32 {
  if (lic.style.w < 0.5) { return 1.0; }
  let x = s / f32(lic.image.z + 1u);
  // Hann envelope and three ripples per full window. Signed phase moves downstream.
  return (0.5 + 0.5 * cos(3.141592653589793 * x)) * (0.5 + 0.5 * cos(9.42477796076938 * x + lic.style.z));
}
@compute @workgroup_size(8, 8) fn generate(@builtin(global_invocation_id) id: vec3u) {
  if (any(id.xy >= lic.image.xy)) { return; }
  let at = id.y * lic.image.x + id.x;
  let uv = (vec2f(id.xy) + vec2f(0.5)) / vec2f(lic.image.xy);
  let first = sampleField(uv);
  if (first.w < 0.0) { image[at] = vec4f(0.0); return; }
  var total = noise(uv) * weight(0.0);
  var norm = weight(0.0);
  for (var side = 0u; side < 2u; side++) {
    let sign = select(-1.0, 1.0, side == 1u);
    var p = uv;
    for (var i = 1u; i <= lic.image.z; i++) {
      let a = sampleField(p);
      if (a.w < 0.0 || dot(a.xy, a.xy) == 0.0) { break; }
      let mid = sampleField(p + 0.5 * sign * lic.style.x * a.xy);
      if (mid.w < 0.0 || dot(mid.xy, mid.xy) == 0.0) { break; }
      p += sign * lic.style.x * mid.xy;
      if (sampleField(p).w < 0.0) { break; }
      let w = weight(sign * f32(i));
      total += noise(p) * w; norm += w;
    }
  }
  let average = select(noise(uv), total / max(norm, 1e-20), norm > 1e-20);
  image[at] = vec4f(clamp(0.5 + (average - 0.5) * lic.style.y, 0.0, 1.0), first.z, 1.0, 0.0);
}`,p=`${r}
${c}${d}
@group(1) @binding(1) var<storage, read> image: array<vec4f>;
@group(1) @binding(2) var colours: texture_2d<f32>;
@group(1) @binding(3) var colourSampler: sampler;
struct Out { @builtin(position) clip: vec4f, @location(0) uv: vec2f }
@vertex fn vertex(@builtin(vertex_index) index: u32) -> Out {
  let u = select(0.0, 1.0, index == 1u || index == 2u || index == 4u);
  let v = select(0.0, 1.0, index == 2u || index == 4u || index == 5u);
  var out: Out; out.uv = vec2f(u, v);
  out.clip = frame.clip * lic.model * vec4f(lic.origin.xyz + u * lic.axisU.xyz + v * lic.axisV.xyz, 1.0);
  return out;
}
@fragment fn fragment(in: Out) -> @location(0) vec4f {
  let q = clamp(in.uv * vec2f(lic.image.xy) - vec2f(0.5), vec2f(0.0), vec2f(lic.image.xy - vec2u(1u)));
  let lo = vec2u(q); let hi = min(lo + vec2u(1u), lic.image.xy - vec2u(1u));
  let t = fract(q);
  let a = image[lo.y * lic.image.x + lo.x]; let b = image[lo.y * lic.image.x + hi.x];
  let c = image[hi.y * lic.image.x + lo.x]; let d = image[hi.y * lic.image.x + hi.x];
  let value = mix(mix(a, b, t.x), mix(c, d, t.x), t.y);
  if (value.z < 0.999) { discard; }
  let colour = colourLookup(colours, value.y).rgb;
  let rgb = mix(vec3f(1.0), colour, lic.colour.w) * value.x;
  return vec4f(toOutput(rgb), lic.colour.z);
}`,m=e=>{throw i(e,`sciviz`)},h=()=>new Promise(e=>setTimeout(e,0)),g=(e,t)=>e.reduce((e,n,r)=>e+n*t[r],0),_=e=>(Number.isFinite(e)||m(`LIC phase must be finite`),(e%(2*Math.PI)+2*Math.PI)%(2*Math.PI)),v=class r{#e;#t;#n;#r;#i;#a;#o;#s;#c;#l;#u;#d;#f;#p;#m;constructor(e,t,n,r,i){this.visible=!0,this.#s=[],this.#p=!0,this.#m=!1,this.#e=e.renderer,this.#a=t,this.#r=n,this.#t=r,this.#n=[...i.resolution??[256,256]],this.#i=o(i.colormap),this.transparent=(i.opacity??1)<1}static async create(e,t,n={}){let i=n.signal;i?.throwIfAborted();let o=t?.dims,c=t?.bounds;(!o||o.length!==3||o.some((e,t)=>!Number.isSafeInteger(e)||e<(t<2?2:1)))&&m(`LIC dims need x/y >= 2 and z >= 1 integer samples`),(!c||c.length!==6||c.some(e=>!Number.isFinite(e)))&&m(`LIC bounds need six finite coordinates`);let l=[0,1,2].map(e=>c[2*e+1]-c[2*e]);l.some((e,t)=>!Number.isFinite(e)||(o[t]===1?e!==0:e<=0))&&m(`LIC bounds must ascend on sampled axes and be equal on singleton z`);let u=o[0]*o[1]*o[2],d=n.resolution??[256,256],f=n.steps??20,p=n.step??.5,v=n.seed??0,y=n.contrast??3,b=n.opacity??1;(!Number.isSafeInteger(u)||u*48>134217728)&&m(`LIC copied field must fit the 128 MiB working budget`),(d.length!==2||d.some(e=>!Number.isInteger(e)||e<8||e>2048))&&m(`LIC resolution needs two integer dimensions in 8..2048`),(!Number.isInteger(f)||f<1||f>128||!Number.isFinite(p)||p<.1||p>1||!Number.isInteger(v)||v<0||v>4294967295||!Number.isFinite(y)||y<0||y>10||!Number.isFinite(b)||b<0||b>1)&&m(`LIC steps, step, seed, contrast and opacity must lie in their documented ranges`),[n.animated,n.coloured].some(e=>e!==void 0&&typeof e!=`boolean`)&&m(`LIC animated and coloured options must be booleans`);let x=_(n.phase??0);for(let e of[t.u,t.v,...t.w===void 0?[]:[t.w],...n.scalar===void 0?[]:[n.scalar]])(!e||e.length!==u)&&m(`LIC components and scalar need one number per field node`);let S=n.slice??{origin:[c[0],c[2],c[4]],axisU:[l[0],0,0],axisV:[0,l[1],0]},C=[S.origin,S.axisU,S.axisV];C.some(e=>!e||e.length!==3||e.some(e=>!Number.isFinite(e)||Math.abs(e)>0x38d7ea4c68000))&&m(`LIC slice needs finite xyz origin and edges within +/-1e15; use local coordinates`);let[w,T,E]=C,D=g(T,T),O=g(E,E),k=g(T,E),A=D*O-k*k;A>D*O*1e-8||m(`LIC slice edges must be independent, with sin(angle)^2 > 1e-8`);let j=T.map((e,t)=>(O*e-k*E[t])/A),M=E.map((e,t)=>(D*e-k*T[t])/A),N=Math.max(...j.map(Math.abs),...M.map(Math.abs)),P=new Float32Array(64),F=new Uint32Array(P.buffer);P.set(w,16),P.set(T,20),P.set(E,24);for(let e=0;e<3;e++)P[28+e]=l[e]?(w[e]-c[e*2])/l[e]:0,P[32+e]=l[e]?T[e]/l[e]:0,P[36+e]=l[e]?E[e]/l[e]:0,!l[e]&&(w[e]!==c[2*e]||T[e]!==0||E[e]!==0)&&m(`LIC slice must lie in the singleton z plane`),P[40+e]=j[e]/N,P[44+e]=M[e]/N;P.some(e=>!Number.isFinite(e)||Math.abs(e)>0x38d7ea4c68000)&&m(`LIC slice mapping exceeds float32 arithmetic headroom; use local coordinates`);let I=[w,w.map((e,t)=>e+T[t]),w.map((e,t)=>e+E[t]),w.map((e,t)=>e+T[t]+E[t])],L=[0,1,2].flatMap(e=>[Math.min(...I.map(t=>t[e])),Math.max(...I.map(t=>t[e]))]),R=0,z=1/0,B=-1/0,V=new Float64Array(u*4);for(let e=0;e<u;e+=16384){i?.throwIfAborted();for(let r=e;r<Math.min(u,e+16384);r++){let e=[t.u[r],t.v[r],t.w===void 0?0:t.w[r]],i=n.scalar===void 0?Math.hypot(...e):n.scalar[r];[...e,i].some(e=>!Number.isFinite(e)&&!Number.isNaN(e))&&m(`LIC samples must be finite or NaN`),e.some(Number.isNaN)||Number.isNaN(i)?V[4*r+3]=NaN:((e.some(e=>Math.abs(e)>1e30)||Math.abs(i)>1e30)&&m(`LIC samples exceed +/-1e30; rescale field units`),V.set(e,4*r),V[4*r+3]=i,R=Math.max(R,...e.map(Math.abs)),z=Math.min(z,i),B=Math.max(B,i))}await h()}let H=s(n.range,`LIC range`)??(z<=B?[z,B>z?B:z+Math.max(1,Math.abs(z)*1e-6)]:[0,1]),U=H[1]-H[0];(!(U>0)||!Number.isFinite(U)||Math.abs(H[0]/U)>0x38d7ea4c68000||R/U>0x38d7ea4c68000)&&m(`LIC colour range needs representable float32 ratios; rescale scalar units`);let W=new Float32Array(u*4);for(let e=0;e<u;e+=16384){i?.throwIfAborted();for(let t=e;t<Math.min(u,e+16384);t++){let e=Math.max(Math.abs(V[4*t]),Math.abs(V[4*t+1]),Math.abs(V[4*t+2]))/(R||1);e>0&&e<8*2**-126&&m(`LIC nonzero field nodes must retain eight float32 normal units after common scaling; split fields with excessive dynamic range`);for(let e=0;e<3;e++)W[4*t+e]=V[4*t+e]/(R||1);W[4*t+3]=(V[4*t+3]-H[0])/U,!Number.isFinite(W[4*t+3])&&!Number.isNaN(W[4*t+3])&&m(`LIC scalar range overflows float32; rescale scalar units`)}await h()}F.set([...o,+!!n.scalar],48),F.set([...d,f,v],52),P.set([p,y,x,+!!n.animated],56),P.set([R/U,-H[0]/U,b,n.coloured===!1?0:1],60),i?.throwIfAborted(),a(e.renderer);let G=e.renderer.device;for(let e of[W.byteLength,d[0]*d[1]*16])(e>G.limits.maxStorageBufferBindingSize||e>G.limits.maxBufferSize)&&m(`LIC image or field exceeds device buffer limits; reduce grid or resolution`);let K=new r(e,W,P,L,n);try{return K.#g(),e.addLayer(K),e.renderer.add(K),K}catch(e){throw K.dispose(),e}}get resolution(){return[...this.#n]}get bounds(){return[...this.#t]}get phase(){return this.#r[58]}setPhase(e){this.#h(),this.#r[58]=_(e),this.#p=!0}setModel(e){this.#r.set(e)}center(){let e=this.#t;return t(this.#r,(e[0]+e[1])/2,(e[2]+e[3])/2,(e[4]+e[5])/2)}#h(){if(this.#m)throw e(`disposed`,`Create a new LIC layer after disposal`,`sciviz`)}#g(){let e=this.#o=this.#e.device,t=[256,this.#a.byteLength,this.#n[0]*this.#n[1]*16];for(let n=0;n<t.length;n++)this.#s.push(e.createBuffer({size:t[n],usage:GPUBufferUsage.COPY_DST|(n?GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC:GPUBufferUsage.UNIFORM)}));e.queue.writeBuffer(this.#s[1],0,this.#a);let r=e.createBindGroupLayout({entries:t.map((e,t)=>({binding:t,visibility:GPUShaderStage.COMPUTE,buffer:{type:t===0?`uniform`:t===1?`read-only-storage`:`storage`}}))});this.#l=e.createBindGroup({layout:r,entries:this.#s.map((e,t)=>({binding:t,resource:{buffer:e}}))}),this.#f=e.createComputePipeline({layout:e.createPipelineLayout({bindGroupLayouts:[r]}),compute:{module:e.createShaderModule({code:f.replaceAll(`@group(1)`,`@group(0)`),label:`sciviz LIC convolution`}),entryPoint:`generate`}}),this.#c=n(e,this.#i),this.#d=e.createBindGroupLayout({entries:[{binding:0,visibility:GPUShaderStage.VERTEX|GPUShaderStage.FRAGMENT,buffer:{type:`uniform`}},{binding:1,visibility:GPUShaderStage.FRAGMENT,buffer:{type:`read-only-storage`}},{binding:2,visibility:GPUShaderStage.FRAGMENT,texture:{sampleType:`unfilterable-float`}},{binding:3,visibility:GPUShaderStage.FRAGMENT,sampler:{}}]}),this.#u=e.createBindGroup({layout:this.#d,entries:[{binding:0,resource:{buffer:this.#s[0]}},{binding:1,resource:{buffer:this.#s[2]}},{binding:2,resource:this.#c.createView()},{binding:3,resource:e.createSampler({magFilter:`linear`,minFilter:`linear`})}]}),this.#p=!0}restore(){if(!this.#m){for(let e of this.#s)e.destroy();this.#s=[],this.#c?.destroy(),this.#g()}}prepare(e){if(this.#o.queue.writeBuffer(this.#s[0],0,this.#r),!this.#p)return;let t=e.encoder.beginComputePass();t.setPipeline(this.#f),t.setBindGroup(0,this.#l),t.dispatchWorkgroups(Math.ceil(this.#n[0]/8),Math.ceil(this.#n[1]/8)),t.end(),this.#p=!1}draw(e,t,n){let r=n.pipeline(`lic`,t,e=>{let t=this.#o.createShaderModule({code:p,label:`sciviz LIC slice`});return{layout:this.#o.createPipelineLayout({bindGroupLayouts:[n.frameLayout,this.#d]}),vertex:{module:t,entryPoint:`vertex`},fragment:{module:t,entryPoint:`fragment`,targets:[{format:e.format,blend:{color:{srcFactor:`src-alpha`,dstFactor:`one-minus-src-alpha`,operation:`add`},alpha:{srcFactor:`one`,dstFactor:`one-minus-src-alpha`,operation:`add`}}}]},primitive:{topology:`triangle-list`,cullMode:`none`},depthStencil:{format:e.depth,depthWriteEnabled:!this.transparent,depthCompare:`greater-equal`},multisample:e.multisample}});e.setPipeline(r),e.setBindGroup(1,this.#u),e.draw(6)}async readIntensity(t={}){if(t.signal?.throwIfAborted(),this.#h(),this.#e.device!==this.#o)throw e(`state`,`Await figure.ready() after LIC device replacement`,`sciviz`);let n=t.timeoutMs??3e4;(!Number.isFinite(n)||n<=0||n>2147483647)&&m(`LIC readback timeoutMs must be positive and <=2147483647`);let r=this.#n[0]*this.#n[1],i=this.#o,a=i.createBuffer({size:r*16,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ}),o,s;try{let c=i.createCommandEncoder();if(this.prepare({encoder:c}),c.copyBufferToBuffer(this.#s[2],0,a,0,r*16),i.queue.submit([c.finish()]),await Promise.race([a.mapAsync(GPUMapMode.READ),new Promise((r,i)=>{s=()=>i(t.signal.reason),t.signal?.addEventListener(`abort`,s,{once:!0}),o=setTimeout(()=>i(e(`timeout`,`LIC readback timed out; check GPU/device state`,`sciviz`)),n)})]),t.signal?.throwIfAborted(),this.#h(),i!==this.#e.device)throw e(`state`,`Await figure.ready() after LIC device replacement`,`sciviz`);let l=new Float32Array(a.getMappedRange()),u=new Float32Array(r);for(let e=0;e<r;e++)u[e]=l[e*4+2]>0?l[e*4]:NaN;return u}finally{o!==void 0&&clearTimeout(o),s&&t.signal?.removeEventListener(`abort`,s),a.destroy()}}dispose(){if(!this.#m){this.#m=!0,this.#e.remove(this);for(let e of this.#s)e.destroy();this.#s=[],this.#c?.destroy(),this.#c=void 0,this.#a=new Float32Array}}[Symbol.dispose](){this.dispose()}};function y(e,t,n={}){return v.create(e,t,n).then(r=>u(e,`lic`,[t,n],r))}export{v as LicLayer,y as lic};