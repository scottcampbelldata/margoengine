import{n as e,r as t,t as n}from"./errors-BaiKeIMi-y5KNvLD6.js";import{a as r,g as i,v as a,y as o}from"./fixed-Cr5cTILR-Cew53yNw.js";import{_ as s,b as c,c as l,o as u,s as d,v as f,y as p}from"./index-Bmk27x3-.js";import{n as m,r as h,t as g}from"./gpu-placement-flow-internal-DKyMqhCW-DO0B3s-F.js";var _=`
fn lerpQ16(a: i32, b: i32, f: u32) -> i32 {
  let ua = bitcast<u32>(a) ^ 0x80000000u;
  let ub = bitcast<u32>(b) ^ 0x80000000u;
  if (ub >= ua) {
    let m = ub - ua;
    let step = (m >> 16u) * f + (((m & 0xffffu) * f) >> 16u);
    return bitcast<i32>((ua + step) ^ 0x80000000u);
  }
  let m = ua - ub;
  let step = (m >> 16u) * f + (((m & 0xffffu) * f + 0xffffu) >> 16u);
  return bitcast<i32>((ua - step) ^ 0x80000000u);
}

fn bilinearQ16(c00: i32, c10: i32, c01: i32, c11: i32, fx: u32, fz: u32) -> i32 {
  return lerpQ16(lerpQ16(c00, c10, fx), lerpQ16(c01, c11, fx), fz);
}
`,v=_+`
struct Shape { n: u32, depth: u32, span: u32, rows: u32, ox: u32, oz: u32, pad0: u32, pad1: u32 }
@group(0) @binding(0) var<storage, read> lattice: array<i32>;
@group(0) @binding(1) var<uniform> shape: Shape;
@group(0) @binding(2) var<storage, read_write> output: array<i32>;
@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= shape.n || id.y >= shape.depth) { return; }
  let x = shape.ox + id.x;
  let z = shape.oz + id.y;
  let at = (z >> 3u) * shape.span + (x >> 3u);
  let fx = (x & 7u) << 13u;
  let fz = (z & 7u) << 13u;
  let count = shape.n * shape.depth;
  let k = id.y * shape.n + id.x;
  let base = shape.span * shape.rows;
  let n1 = bilinearQ16(lattice[at], lattice[at+1u], lattice[at+shape.span], lattice[at+shape.span+1u], fx, fz) - 32768;
  let n2 = bilinearQ16(lattice[base+at], lattice[base+at+1u], lattice[base+at+shape.span], lattice[base+at+shape.span+1u], fx, fz) - 32768;
  output[k] = n1;
  output[count+k] = n2;

  output[2u*count+k] = (n1 * 160) >> 15u;
  output[3u*count+k] = i32(k+1u);
}
`;function y(e,r,i,a,o){if(![a,o].every(e=>Number.isSafeInteger(e)&&e>=1)||a*o>1073741823)throw n(`Warp dimensions must be positive safe integers within u32 plane addressing; split the rectangle`,`biomes`);if(![r,i,r+a,i+o].every(e=>Number.isSafeInteger(e)&&e>=-2147483648&&e<=2147483647))throw n(`Warp origins and endpoints must fit signed i32 cell coordinates; use a smaller rectangle or origin`,`biomes`);if(!e||e.a0!==r>>3||e.b0!==i>>3||e.span!==(r+a>>3)-e.a0+2||e.rows!==(i+o>>3)-e.b0+2||2*e.span*e.rows>4294967295)throw n(`Warp lattice geometry does not cover this rectangle; rebuild it with warpLattice`,`biomes`);for(let n of[e.warpA,e.warpB])if(!(n instanceof Int32Array)||n.length!==e.span*e.rows)throw t(`Warp lattices must be Int32Arrays of span * rows samples; rebuild them with warpLattice`,`biomes`)}async function b(t,r,i,a,o,s,{signal:c}={}){c?.throwIfAborted(),y(r,i,a,o,s);let{span:l,rows:u,a0:d,b0:f,warpA:p,warpB:m}=r,h=o*s,g=4*h*4,_=l*u,b=i-d*8,x=a-f*8,S=[2*_*4,32,g];if(S.some(e=>e>t.limits.maxBufferSize)||[S[0],g].some(e=>e>t.limits.maxStorageBufferBindingSize)||Math.ceil(o/8)>t.limits.maxComputeWorkgroupsPerDimension||Math.ceil(s/8)>t.limits.maxComputeWorkgroupsPerDimension)throw n(`Ecotone warp rectangle exceeds device limits; split it into smaller rectangles`,`biomes`);let C=new Int32Array(2*_);C.set(p),C.set(m,_);for(let e of C)if(Math.abs(e)>13389004)throw n(`Warp corner exceeds the safe i32 temperature bound; use corners within +/-13389004`,`biomes`);let w=[],T=()=>{},E=new Promise((e,t)=>{T=t}),D=[E],O=()=>T(c?.reason),k=t=>T(e(`failed`,`Ecotone warp GPU error: ${t.error.message}; use a valid WebGPU device`,`biomes`));c?.addEventListener(`abort`,O,{once:!0});let A=e=>Promise.race([e,E]);try{t.addEventListener(`uncapturederror`,k),t.pushErrorScope(`validation`);let n,r,i,a;try{n=t.createShaderModule({code:v}),i=n.getCompilationInfo(),D.push(i),r=t.createComputePipelineAsync({layout:`auto`,compute:{module:n,entryPoint:`main`}}),D.push(r)}finally{a=t.popErrorScope(),D.push(a)}let[d,f,p]=await A(Promise.all([i,r,a]));if(d.messages.length||p)throw e(`failed`,`Ecotone warp shader compilation or validation failed: ${p?.message??d.messages.map(e=>e.message).join(`; `)}; check the WGSL device support`,`biomes`);c?.throwIfAborted();let m=(e,n)=>{let r=t.createBuffer({size:e,usage:n});return w.push(r),r};t.pushErrorScope(`validation`);let _,y;try{let e=m(C.byteLength,GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST),n=m(32,GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST),r=m(g,GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC);_=m(g,GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ),t.queue.writeBuffer(e,0,C),t.queue.writeBuffer(n,0,new Uint32Array([o,s,l,u,b,x,0,0]));let i=t.createBindGroup({layout:f.getBindGroupLayout(0),entries:[e,n,r].map((e,t)=>({binding:t,resource:{buffer:e}}))}),a=t.createCommandEncoder(),c=a.beginComputePass();c.setPipeline(f),c.setBindGroup(0,i),c.dispatchWorkgroups(Math.ceil(o/8),Math.ceil(s/8)),c.end(),a.copyBufferToBuffer(r,0,_,0,g),t.queue.submit([a.finish()]),y=_.mapAsync(GPUMapMode.READ),D.push(y)}finally{a=t.popErrorScope(),D.push(a)}let[,S]=await A(Promise.all([y,a]));if(S)throw e(`failed`,`Ecotone warp dispatch validation failed: ${S.message}; check device limits`,`biomes`);c?.throwIfAborted();let T=new Int32Array(_.getMappedRange()).slice();_.unmap();for(let t=0;t<h;t++)if(T[3*h+t]!==t+1)throw e(`failed`,`Ecotone warp dispatch left cells unwritten; check the shader dispatch dimensions`,`biomes`);return{n1:T.subarray(0,h),n2:T.subarray(h,2*h),dT:T.subarray(2*h,3*h)}}catch(t){throw c?.throwIfAborted(),t?.name===`MargoError`?t:e(`failed`,`Ecotone warp failed: ${String(t)}; recreate the WebGPU device and check its limits`,`biomes`)}finally{Promise.allSettled(D),c?.removeEventListener(`abort`,O),t.removeEventListener(`uncapturederror`,k);for(let e of w)e.destroy()}}var x=`
struct Shape { n: u32, depth: u32, cells: u32, total: u32, slots: u32, count: u32, starts: u32, dims: u32 }
@group(0) @binding(0) var<storage, read> sources: array<i32>;
@group(0) @binding(1) var<storage, read> warp: array<i32>;
@group(0) @binding(2) var<storage, read> table: array<i32>;
@group(0) @binding(3) var<uniform> shape: Shape;
@group(0) @binding(4) var<storage, read_write> output: array<i32>;

fn floor10(t: i32) -> i32 {
  let a = u32(abs(t));
  let q = a / 10u;
  if (t < 0) { return -i32(q + select(0u, 1u, a % 10u != 0u)); }
  return i32(q);
}





fn rainDelta(v: i32, noise: i32) -> i32 {
  let a = u32(abs(v));
  let b = u32(abs(noise));
  let low = (a & 65535u) * (b & 65535u);
  let cross = (a >> 16u) * (b & 65535u) + (a & 65535u) * (b >> 16u);
  let lo = low + (cross << 16u);
  let hi = (a >> 16u) * (b >> 16u) + (cross >> 16u) + select(0u, 1u, lo < low);
  let u = (hi << 18u) | (lo >> 14u);
  let q = u / 25u;
  let remainder = u % 25u != 0u || (lo & 16383u) != 0u;
  if ((v < 0) != (noise < 0)) { return -i32(q + select(0u, 1u, remainder)); }
  return i32(q);
}

@compute @workgroup_size(8, 8)
fn inputs(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= shape.n || id.y >= shape.depth || id.z >= shape.slots) { return; }
  let k = id.y * shape.n + id.x;
  let at = id.z * shape.cells + k;
  let v = sources[at];
  let noise = warp[k];
  let t = warp[shape.cells+k];
  var value = 0;
  if (table[2u*id.z+1u] != 0) {
    switch table[2u*id.z] {
      case 0: { value = max(0, v); }
      case 1: { value = v + t; }
      case 2: { value = max(0, v + 2*t); }
      case 3: { value = clamp(v + floor10(t), 0, 365); }
      case 4: { value = max(0, v + rainDelta(v, noise)); }
      case 5: { value = clamp(v + ((noise * 10) >> 15u), 0, 255); }
      default: { value = v; }
    }
  }
  output[at] = value;
  output[shape.total+at] = i32(at+1u);
}


fn ratioQ16(reach: u32, width: u32) -> u32 {
  var rem = reach;
  var r = 0u;
  for (var bit = 0u; bit < 16u; bit++) {
    rem <<= 1u;
    r <<= 1u;
    if (rem >= width) { rem -= width; r |= 1u; }
  }
  return r;
}

@compute @workgroup_size(8, 8)
fn members(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= shape.n || id.y >= shape.depth || id.z >= shape.count) { return; }
  let k = id.y * shape.n + id.x;
  var mk = 65536u;
  let end = u32(table[shape.starts+id.z+1u]);
  for (var q = u32(table[shape.starts+id.z]); q < end; q++) {
    if (mk == 0u) { continue; }
    let at = shape.dims+4u*q;
    let x = output[u32(table[at])*shape.cells+k];
    let lo = table[at+1u];
    let hi = table[at+2u];
    let width = u32(table[at+3u]);
    let half = width >> 1u;
    var reach = 0u;
    if (x < lo || x > hi) {

      let dist = select(bitcast<u32>(x)-bitcast<u32>(hi), bitcast<u32>(lo)-bitcast<u32>(x), x < lo);
      if (dist >= width-half) { mk = 0u; continue; }
      reach = dist+half;
    } else {
      let inside = min(bitcast<u32>(x)-bitcast<u32>(lo), bitcast<u32>(hi)-bitcast<u32>(x));
      if (inside >= half) { continue; }
      reach = half-inside;
    }
    let r = ratioQ16(reach, width);
    let s = 65536u-r;

    if (r == 0u) { continue; }
    let s2 = (s*s) >> 16u;
    let s4 = (s2*s2) >> 16u;
    let t = 4u*r+65536u;
    let w = s4*(t >> 16u) + ((s4*(t & 65535u)) >> 16u);
    if (mk == 65536u) { mk = w; }
    else { mk = (mk*w) >> 16u; }
  }
  let at = (shape.slots+id.z)*shape.cells+k;
  output[at] = i32(mk);
  output[shape.total+at] = i32(at+1u);
}
`;function S(e,r,i){if(!r||!i)throw t(`Supply a classifier and classification grid`,`biomes`);let{n:a,gx:o,gz:s,seed:c,cell:u}=i,d=i.depth??a;if(![a,d].every(e=>Number.isSafeInteger(e)&&e>=3)||a*d>1073741823)throw n(`Classification needs at least a 3 by 3 integer grid; split oversized rectangles`,`biomes`);if(![o,s,o+a,s+d].every(e=>Number.isSafeInteger(e)&&e>=-2147483648&&e<=2147483647))throw n(`Classification origins and endpoints must fit i32; use a smaller rectangle or origin`,`biomes`);if(!Number.isSafeInteger(c)||c<-2147483648||c>4294967295||!Number.isSafeInteger(u)||u<=0)throw n(`Supply an integer seed and a positive safe integer cell size in mm`,`biomes`);if(i.ecotone!==void 0&&(!Number.isSafeInteger(i.ecotone)||i.ecotone<0))throw n(`Supply a nonnegative integer ecotone half width in cells`,`biomes`);if(i.feathers!==void 0&&!i.feathers.every(e=>Number.isSafeInteger(e)&&e>=0))throw n(`Supply nonnegative integer paint feather half widths in cells`,`biomes`);let f=a*d,p=r.inputs.length,m=r.ids.length,h=r.envelopes,g=!!r.score,_=2*p,v=_+m+1,y=(p+(g?0:m))*f;if(!p||m<1||m>255||!(r.modes instanceof Int32Array)||r.modes.length!==p)throw t(`Supply a built classifier with input modes and 1 to 255 biomes`,`biomes`);if(!h||!(h.start instanceof Int32Array)||h.start.length!==m+1||!(h.slot instanceof Int32Array)||!(h.width instanceof Int32Array)||!(h.lo instanceof Float64Array)||!(h.hi instanceof Float64Array)||[h.width.length,h.lo.length,h.hi.length].some(e=>e!==h.slot.length))throw t(`Supply matching flattened envelope arrays from classifier()`,`biomes`);if(h.start[0]!==0||h.start[m]!==h.slot.length||h.start.some((e,t)=>e<0||t>0&&e<h.start[t-1]))throw n(`Envelope starts must cover the dimensions in biome order; rebuild the classifier`,`biomes`);for(let e=0;e<h.slot.length;e++)if(h.slot[e]<0||h.slot[e]>=p||![h.lo[e],h.hi[e],h.width[e]].every(e=>Number.isInteger(e)&&e>=-2147483648&&e<=2147483647)||h.lo[e]>h.hi[e]||h.width[e]<1)throw n(`Envelope bounds must fit i32 and widths must be 1 to 2147483647; rebuild the classifier`,`biomes`);let b=(o+a>>3)-(o>>3)+2,x=(s+d>>3)-(s>>3)+2,S=[4*p*f,8*f,4*(v+4*h.slot.length),32,8*y],C=[8*b*x,16*f];if(!Number.isSafeInteger(y)||y>2147483647||[...S,...C].some(t=>t>e.limits.maxBufferSize)||[...S.filter((e,t)=>t!==3),...C].some(t=>t>e.limits.maxStorageBufferBindingSize)||[Math.ceil(a/8),Math.ceil(d/8),p,g?1:m].some(t=>t>e.limits.maxComputeWorkgroupsPerDimension))throw n(`Classification planes exceed device limits; split the rectangle`,`biomes`);let w=new Int32Array(p*f),T=new Int32Array(v+4*h.slot.length);T.set(h.start,_);for(let e=0;e<h.slot.length;e++)T.set([h.slot[e],h.lo[e],h.hi[e],h.width[e]],v+4*e);for(let e=0;e<p;e++){let a=r.modes[e],o=a?i.layer(r.inputs[e]):i.user(r.inputs[e]);if(a<0||a>6)throw n(`Supply classification modes from 0 through 6`,`biomes`);if(T[2*e]=a,o!==void 0){if(!o||o.length!==f)throw t(`Supply each source with n * depth cells, or undefined`,`biomes`);T[2*e+1]=1;for(let t=0;t<f;t++){let r=o[t];if(!Number.isInteger(r)||Math.abs(r)>1073741824)throw n(`Classification sources must be integers within +/-1073741824; quantize or rescale the source`,`biomes`);w[e*f+t]=r}}}return{n:a,depth:d,gx:o,gz:s,seed:c,cell:u,cells:f,slots:p,count:m,zones:g,starts:_,dims:v,total:y,sizes:S,packed:w,table:T,feathered:!!l(i)&&!!r.paint.length}}async function C(t,n,r,{signal:i}={}){i?.throwIfAborted();let a=S(t,n,r),o=await b(t,d(a.seed,a.cell,a.gx,a.gz,a.n,a.depth),a.gx,a.gz,a.n,a.depth,{signal:i});i?.throwIfAborted();let s=[],c,l=()=>{},u=new Promise((e,t)=>{l=t}),f=[u],p=()=>l(i?.reason),m=t=>l(e(`failed`,`Classification GPU error: ${t.error.message}; use a valid WebGPU device`,`biomes`)),h=e=>Promise.race([e,u]);i?.addEventListener(`abort`,p,{once:!0});try{t.addEventListener(`uncapturederror`,m),t.pushErrorScope(`validation`);let n,r,l;try{let e=t.createShaderModule({code:x});n=e.getCompilationInfo(),f.push(n),r=[];for(let n of a.zones?[`inputs`]:[`inputs`,`members`]){let i=t.createComputePipelineAsync({layout:`auto`,compute:{module:e,entryPoint:n}});r.push(i),f.push(i)}}finally{l=t.popErrorScope(),f.push(l)}let[u,d,p]=await h(Promise.all([n,Promise.all(r),l]));if(u.messages.length||p)throw e(`failed`,`Classification compilation failed: ${p?.message??u.messages.map(e=>e.message).join(`; `)}; check WGSL device support`,`biomes`);i?.throwIfAborted();let g=(e,n)=>{let r=t.createBuffer({size:e,usage:n});return s.push(r),r};t.pushErrorScope(`validation`);let _,v;try{let e=g(a.sizes[0],GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST),n=g(a.sizes[1],GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST),r=g(a.sizes[2],GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST),i=g(32,GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST),s=g(a.sizes[4],GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC);_=g(a.sizes[4],GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ);let c=new Int32Array(2*a.cells);c.set(o.n2),c.set(o.dT,a.cells),t.queue.writeBuffer(e,0,a.packed),t.queue.writeBuffer(n,0,c),t.queue.writeBuffer(r,0,a.table),t.queue.writeBuffer(i,0,new Uint32Array([a.n,a.depth,a.cells,a.total,a.slots,a.count,a.starts,a.dims]));let l=t.createCommandEncoder();for(let o=0;o<d.length;o++){let c=d[o],u=[e,n,r,i,s].map((e,t)=>({binding:t,resource:{buffer:e}})),f=t.createBindGroup({layout:c.getBindGroupLayout(0),entries:o?u.slice(2):u}),p=l.beginComputePass();p.setPipeline(c),p.setBindGroup(0,f),p.dispatchWorkgroups(Math.ceil(a.n/8),Math.ceil(a.depth/8),o?a.count:a.slots),p.end()}l.copyBufferToBuffer(s,0,_,0,a.sizes[4]),t.queue.submit([l.finish()]),v=_.mapAsync(GPUMapMode.READ),f.push(v)}finally{l=t.popErrorScope(),f.push(l)}let[,y]=await h(Promise.all([v,l]));if(y)throw e(`failed`,`Classification dispatch failed: ${y.message}; check device limits`,`biomes`);i?.throwIfAborted();let b=new Int32Array(_.getMappedRange()).slice();_.unmap();for(let t=0;t<a.total;t++)if(b[a.total+t]!==t+1)throw e(`failed`,`Classification left cells unwritten; check shader dispatch dimensions`,`biomes`);c={warped:b.subarray(0,a.slots*a.cells),member:a.zones?new Int32Array(a.count*a.cells):b.subarray(a.slots*a.cells,a.total),n2:o.n2,n1s:a.feathered?o.n1:void 0}}catch(t){throw i?.throwIfAborted(),t?.name===`MargoError`?t:e(`failed`,`Classification failed: ${String(t)}; recreate the WebGPU device and check its limits`,`biomes`)}finally{Promise.allSettled(f),i?.removeEventListener(`abort`,p),t.removeEventListener(`uncapturederror`,m);for(let e of s)e.destroy()}return n.score?.(c.warped,a.cells,c.member),c}async function w(e,n,r,i,a,{signal:o}={}){o?.throwIfAborted();let s=(r.n-2)*((r.depth??r.n)-2)*4;if(!(i instanceof Uint8Array)||!(a instanceof Uint8Array)||i.length<s||a.length<s)throw t(`Supply Uint8Array ids and weights with four slots per inner cell`,`biomes`);let c=await C(e,n,r,{signal:o});o?.throwIfAborted(),u(n,r,c,i,a)}var T=[`rain`,`continentality`,`exposure`,`water`,`fill`],E=_+`
struct Shape { width: u32, depth: u32, nx: u32, nz: u32 }
@group(0) @binding(0) var<storage, read> grids: array<i32>;
@group(0) @binding(1) var<storage, read> axes: array<vec2<u32>>;
@group(0) @binding(2) var<uniform> shape: Shape;
@group(0) @binding(3) var<storage, read_write> output: array<i32>;
@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= shape.width || id.y >= shape.depth) { return; }
  let col = axes[id.x];
  let row = axes[shape.width + id.y];
  let at = row.x * shape.nx + col.x;
  let count = shape.width * shape.depth;
  let k = id.y * shape.width + id.x;
  for (var g = 0u; g < 5u; g++) {
    let base = g * shape.nx * shape.nz + at;
    output[g * count + k] = bilinearQ16(grids[base], grids[base + 1u],
      grids[base + shape.nx], grids[base + shape.nx + 1u], col.y, row.y);
  }
  output[5u * count + k] = i32(k + 1u);
}
`;function D(e,t,a,s,c,l){for(let t of[e.nx,e.nz])if(!Number.isInteger(t)||t<2||t>32768)throw n(`Region axes require 2..32768 corner samples; split larger regions`,`biomes`);for(let r of[t,e.step,c,l])if(!Number.isSafeInteger(r)||r<=0)throw n(`Region spacing and rectangle sizes must be positive safe integers`,`biomes`);if(!Number.isSafeInteger(t*65536)||!Number.isSafeInteger(c*l)||c*l>268435455)throw n(`Region rectangle or cell size is too large; use a smaller rectangle or cell`,`biomes`);if(![a,s,a+c-1,s+l-1].every(Number.isSafeInteger))throw n(`Region origins and endpoints must be safe integer cell coordinates`,`biomes`);let u=i(t*o,e.step),d=(e,t,n)=>{let i=new Int32Array(t),a=new Int32Array(t);for(let s=0;s<t;s++){let t=r((e+s)*u,0,(n-1)*o),c=Math.min(n-2,t>>16);i[s]=c,a[s]=t-c*o}return{index:i,frac:a}},f=d(a,c,e.nx),p=d(s,l,e.nz);return{colIndex:f.index,colFrac:f.frac,rowIndex:p.index,rowFrac:p.frac}}function O(e){if(5*e.nx*e.nz>4294967295)throw n(`Packed region grids exceed u32 addressing; split the region`,`biomes`);for(let n of T)if(!(e[n]instanceof Int32Array)||e[n].length!==e.nx*e.nz)throw t(`Region ${n} must be an Int32Array of nx * nz corner samples`,`biomes`)}function k(e,t){return Object.fromEntries(T.map((n,r)=>[n,e.subarray(r*t,(r+1)*t)]))}async function A(t,r,i,a,o,s,c,{signal:l}={}){l?.throwIfAborted();let u=D(r,i,a,o,s,c);O(r);let d=s*c,f=6*d*4,p=r.nx*r.nz,m=[5*p*4,(s+c)*8,16,f];if(m.some(e=>e>t.limits.maxBufferSize)||[m[0],m[1],f].some(e=>e>t.limits.maxStorageBufferBindingSize)||Math.ceil(s/8)>t.limits.maxComputeWorkgroupsPerDimension||Math.ceil(c/8)>t.limits.maxComputeWorkgroupsPerDimension)throw n(`Region rectangle exceeds device limits; split it into smaller rectangles`,`biomes`);let h=[],g=()=>{},_=new Promise((e,t)=>{g=t}),v=()=>g(l?.reason),y=t=>g(e(`failed`,`Region upsampling GPU error: ${t.error.message}; use a valid WebGPU device`,`biomes`));l?.addEventListener(`abort`,v,{once:!0}),t.addEventListener(`uncapturederror`,y);let b=e=>Promise.race([e,_]);try{t.pushErrorScope(`validation`);let n,i,a,o;try{n=t.createShaderModule({code:E}),a=n.getCompilationInfo(),i=t.createComputePipelineAsync({layout:`auto`,compute:{module:n,entryPoint:`main`}})}finally{o=t.popErrorScope()}let[l,m,g]=await b(Promise.all([a,i,o]));if(l.messages.length||g)throw e(`failed`,`Region shader compilation or validation failed: ${g?.message??l.messages.map(e=>e.message).join(`; `)}; check the WGSL device support`,`biomes`);let _=new Int32Array(5*p);T.forEach((e,t)=>_.set(r[e],t*p));let v=new Int32Array(2*(s+c));for(let e=0;e<s;e++)v.set([u.colIndex[e],u.colFrac[e]],2*e);for(let e=0;e<c;e++)v.set([u.rowIndex[e],u.rowFrac[e]],2*(s+e));let y=(e,n)=>{let r=t.createBuffer({size:e,usage:n});return h.push(r),r};t.pushErrorScope(`validation`);let x,S;try{let e=y(_.byteLength,GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST),n=y(v.byteLength,GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST),i=y(16,GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST),a=y(f,GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC);x=y(f,GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ),t.queue.writeBuffer(e,0,_),t.queue.writeBuffer(n,0,v),t.queue.writeBuffer(i,0,new Uint32Array([s,c,r.nx,r.nz]));let o=t.createBindGroup({layout:m.getBindGroupLayout(0),entries:[e,n,i,a].map((e,t)=>({binding:t,resource:{buffer:e}}))}),l=t.createCommandEncoder(),u=l.beginComputePass();u.setPipeline(m),u.setBindGroup(0,o),u.dispatchWorkgroups(Math.ceil(s/8),Math.ceil(c/8)),u.end(),l.copyBufferToBuffer(a,0,x,0,f),t.queue.submit([l.finish()]),S=x.mapAsync(GPUMapMode.READ)}finally{o=t.popErrorScope()}let[,C]=await b(Promise.all([S,o]));if(C)throw e(`failed`,`Region dispatch validation failed: ${C.message}; check device limits`,`biomes`);let w=new Int32Array(x.getMappedRange()).slice();x.unmap();for(let t=0;t<d;t++)if(w[5*d+t]!==t+1)throw e(`failed`,`Region dispatch left cells unwritten; check the shader dispatch dimensions`,`biomes`);return k(w.subarray(0,5*d),d)}catch(t){throw l?.throwIfAborted(),t?.name===`MargoError`?t:e(`failed`,`Region upsampling failed: ${String(t)}; recreate the WebGPU device and check its limits`,`biomes`)}finally{l?.removeEventListener(`abort`,v),t.removeEventListener(`uncapturederror`,y);for(let e of h)e.destroy()}}async function j(e,t,n,r,i,a,o,{temporary:c=!1,signal:l}={}){l?.throwIfAborted();let u=await A(e,t.region,t.cell,n,r,i,a,{signal:l});return l?.throwIfAborted(),s(t,n,r,i,a,o,c,u)}var M=`
fn wide(a: u32, b: u32) -> vec2<u32> {
  let p = (a & 65535u) * (b & 65535u);
  let q = (a >> 16u) * (b & 65535u) + (p >> 16u);
  let r = (a & 65535u) * (b >> 16u) + (q & 65535u);
  return vec2<u32>((r << 16u) | (p & 65535u), (a >> 16u) * (b >> 16u) + (q >> 16u) + (r >> 16u));
}
fn addwide(a: vec2<u32>, b: vec2<u32>) -> vec2<u32> {
  let lo = a.x + b.x;
  return vec2<u32>(lo, a.y + b.y + select(0u, 1u, lo < a.x));
}
fn lesswide(a: vec2<u32>, b: vec2<u32>) -> bool { return a.y < b.y || (a.y == b.y && a.x < b.x); }
fn subwide(a: vec2<u32>, b: vec2<u32>) -> vec2<u32> { return vec2<u32>(a.x-b.x, a.y-b.y-select(0u,1u,a.x<b.x)); }
fn shlwide(a: vec2<u32>) -> vec2<u32> { return vec2<u32>(a.x << 1u, (a.y << 1u) | (a.x >> 31u)); }

fn dividewide(a: vec2<u32>, b: vec2<u32>) -> u32 {
  var rem = vec2<u32>(0u); var q = 0u;
  for (var k = 0u; k < 64u; k++) {
    let bit = 63u-k;
    rem = shlwide(rem);
    rem.x |= select((a.x >> (bit & 31u)) & 1u, (a.y >> (bit & 31u)) & 1u, bit >= 32u);
    q <<= 1u;
    if (!lesswide(rem,b)) { rem = subwide(rem,b); q |= 1u; }
  }
  return q;
}
fn floorSigned(a: i32, d: u32) -> i32 {
  let mag = select(bitcast<u32>(a), 0u-bitcast<u32>(a), a < 0);
  let q = mag / d;
  return select(i32(q), -i32(q + select(0u,1u,mag % d != 0u)), a < 0);
}
fn qmul(a: i32, b: i32) -> i32 {
  let p = wide(select(bitcast<u32>(a),0u-bitcast<u32>(a),a<0), select(bitcast<u32>(b),0u-bitcast<u32>(b),b<0));
  let q = (p.y << 16u) | (p.x >> 16u);
  return bitcast<i32>(select(q, 0u-q-select(0u,1u,(p.x & 65535u)!=0u), (a<0)!=(b<0)));
}
fn pcg(v: u32) -> u32 {
  let state = v * 747796405u + 2891336453u;
  let word = ((state >> (((state >> 28u) + 4u) & 31u)) ^ state) * 277803737u;
  return (word >> 22u) ^ word;
}
fn hash5(seed: u32, code: u32, x: i32, z: i32, k: u32) -> u32 {
  return pcg(seed + pcg(code + pcg(bitcast<u32>(x) + pcg(bitcast<u32>(z) + pcg(k)))));
}
fn poisson(mu: u32, e0: u32, h: u32) -> u32 {
  let u = h >> 16u; var p = e0; var cdf = p; var k = 0u;
  while (u >= cdf && k < 40u) {
    k++; p = dividewide(wide(p,mu), vec2<u32>(k*65536u,0u));
    if (p == 0u) { break; } cdf += p;
  }
  return k;
}
fn fade(t: u32) -> i32 {
  let a = wide(t,t);
  let cube = wide(a.x,t);
  let c = (cube.x >> 16u) | (cube.y << 16u);

  let poly = subwide(addwide(wide(a.x,6u), vec2<u32>(0u,10u)), wide(t,983040u));
  let p = (poly.x >> 16u) | (poly.y << 16u);
  return i32(wide(c,p).y);
}
fn noise(seed: u32, x: i32, z: i32) -> i32 {
  let ix = x >> 16u; let iz = z >> 16u;
  let fx = fade(bitcast<u32>(x)&65535u); let fz = fade(bitcast<u32>(z)&65535u);
  let z0 = pcg(bitcast<u32>(iz)); let z1 = pcg(bitcast<u32>(iz+1));
  let a = i32(pcg(seed + pcg(bitcast<u32>(ix)+z0)) >> 16u);
  let b = i32(pcg(seed + pcg(bitcast<u32>(ix+1)+z0)) >> 16u);
  let c = i32(pcg(seed + pcg(bitcast<u32>(ix)+z1)) >> 16u);
  let d = i32(pcg(seed + pcg(bitcast<u32>(ix+1)+z1)) >> 16u);
  let top = a+qmul(b-a,fx); let bottom = c+qmul(d-c,fx);
  return top+qmul(bottom-top,fz);
}
fn stand(seed: u32, scale: u32, top: i32, px: i32, pz: i32) -> i32 {
  if (scale == 0u) { return 65536; }

  var x = bitcast<i32>(dividewide(wide(u32(px),65536u),vec2<u32>(scale,0u)));
  var z = bitcast<i32>(dividewide(wide(u32(pz),65536u),vec2<u32>(scale,0u)));
  let key = pcg(seed+pcg(scale)); var sum = 0; var amp = 65536;
  for (var i = 0u; i < 3u; i++) {
    sum += qmul(noise(key+i*1013u,x,z),amp);
    let nx = 2*x-(z >> 1u)+63369013; let nz = (x >> 1u)+2*z+461845907;
    x=nx; z=nz; amp >>= 1u;
  }
  let value = i32(dividewide(wide(u32(sum),65535u),vec2<u32>(114688u,0u)));
  let delta = top-value;
  let magnitude = wide(u32(abs(delta)),65536u);
  let quotient = dividewide(magnitude,vec2<u32>(6000u,0u));
  let remainder = subwide(magnitude,wide(quotient,6000u));
  let signed = select(i32(quotient),-i32(quotient+select(0u,1u,any(remainder!=vec2<u32>(0u)))),delta<0);
  let r = clamp(signed,0,65536);
  if (r <= 0) { return 65536; } if (r >= 65536) { return 0; }
  let s = 65536-r; let s2 = qmul(s,s);
  return qmul(qmul(s2,s2),4*r+65536);
}
`;function N(e,t){let r=e.limits.maxComputeWorkgroupsPerDimension;if(!Number.isSafeInteger(t)||t<1||t>2147483647||!(r>=1))throw n(`GPU work needs 1..2147483647 invocations and valid device limits`,`biomes`);let a=Math.min(Math.ceil(t/64),r),o=-i(-t,64*a);if(o>r)throw n(`GPU work exceeds dispatch limits; use a smaller input`,`biomes`);if(!(e.limits.maxComputeInvocationsPerWorkgroup>=64)||!(e.limits.maxComputeWorkgroupSizeX>=64))throw n(`GPU work needs 64 compute invocations per workgroup`,`biomes`);return[a,o]}function P(e,t){let r=Math.max(4,t*4);if(!Number.isSafeInteger(t)||t<0||r>e.limits.maxBufferSize||r>e.limits.maxStorageBufferBindingSize||!(e.limits.maxBufferSize>=4)||!(e.limits.maxStorageBufferBindingSize>=4))throw n(`GPU storage exceeds device limits; use a smaller input`,`biomes`)}var F=new WeakMap;function I(t){let n=F.get(t);if(!n){let r=n=new Set;F.set(t,r),t.lost.then(t=>{let n=e(`failed`,`GPU device lost: ${t.message}; recreate the WebGPU device`,`biomes`);for(let e of[...r])e(n)},e=>{for(let t of[...r])t(e)})}return n}var L=class{constructor(t,n){this.device=t,this.signal=n,this.buffers=[],this.pending=[],this.abort=()=>this.reject(this.signal.reason),this.uncaptured=t=>this.reject(e(`failed`,`GPU placement/flow error: ${t.error.message}; recreate the WebGPU device`,`biomes`));let r;this.failure=new Promise((e,t)=>{r=t}),this.reject=r,this.failure.catch(()=>{}),t.addEventListener(`uncapturederror`,this.uncaptured),n?.addEventListener(`abort`,this.abort,{once:!0}),I(t).add(r),n?.throwIfAborted()}wait(e){return this.pending.push(e),Promise.race([e,this.failure])}async scoped(t){this.signal?.throwIfAborted(),this.device.pushErrorScope(`validation`);let n,r;try{n=t()}finally{r=this.device.popErrorScope(),this.pending.push(r)}let[i,a]=await this.wait(Promise.all([Promise.resolve(n),r]));if(a)throw e(`failed`,`GPU validation failed: ${a.message}; check device limits`,`biomes`);return this.signal?.throwIfAborted(),i}async pipelines(t,n){return this.scoped(async()=>{let r=this.device.createShaderModule({code:t}),i=r.getCompilationInfo();this.pending.push(i);let a=[];for(let e of n){let t=this.device.createComputePipelineAsync({layout:`auto`,compute:{module:r,entryPoint:e}});a.push(t),this.pending.push(t)}let[o,s]=await Promise.all([i,Promise.all(a)]);if(o.messages.length)throw e(`failed`,`GPU compilation failed: ${o.messages.map(e=>e.message).join(`; `)}; check WGSL support`,`biomes`);return s})}buffer(e,t,n=!1){P(this.device,e);let r=this.device.createBuffer({size:Math.max(4,e*4),usage:n?GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST|GPUBufferUsage.COPY_SRC});return this.buffers.push(r),t?.length&&this.device.queue.writeBuffer(r,0,t),r}dispatch(e,t,n,r){let i=this.device.createBindGroup({layout:t.getBindGroupLayout(0),entries:n.map((e,t)=>({binding:t,resource:{buffer:e}}))}),a=e.beginComputePass();a.setPipeline(t),a.setBindGroup(0,i),a.dispatchWorkgroups(...N(this.device,r)),a.end()}async read(e,t,n){let r=await this.scoped(()=>{let r=this.buffer(t,void 0,!0),i=this.device.createCommandEncoder();return n?.(i),i.copyBufferToBuffer(e,0,r,0,t*4),this.device.queue.submit([i.finish()]),r});await this.wait(r.mapAsync(GPUMapMode.READ)),this.signal?.throwIfAborted();let i=new Int32Array(r.getMappedRange()).slice();return r.unmap(),r.destroy(),this.buffers.splice(this.buffers.indexOf(r),1),i}close(){Promise.allSettled(this.pending),this.signal?.removeEventListener(`abort`,this.abort),this.device.removeEventListener(`uncapturederror`,this.uncaptured),F.get(this.device)?.delete(this.reject);for(let e of this.buffers)e.destroy()}};function R(t,n,r,i=1){for(let a=0;a<r;a++)if(t[n+a]!==i)throw e(`failed`,`GPU left invocations unwritten; check shader dispatch dimensions`,`biomes`)}function z(t,n){throw n?.throwIfAborted(),t?.name===`MargoError`?t:e(`failed`,`GPU placement/flow failed: ${String(t)}; recreate the WebGPU device and check its limits`,`biomes`)}var B=`
${M}
@group(0) @binding(0) var<storage,read> input: array<i32>;
@group(0) @binding(1) var<storage,read> previous: array<i32>;
@group(0) @binding(2) var<storage,read_write> output: array<i32>;
@group(0) @binding(3) var<storage,read_write> counters: array<atomic<u32>>;
const DX = array<i32,8>(1,1,0,-1,-1,-1,0,1);
const DZ = array<i32,8>(0,1,1,1,0,-1,-1,-1);

fn score(drop: u32, straight: bool) -> vec3<u32> {
  let sq = wide(drop,drop);
  var lo = sq.x; var hi = sq.y; var top = 0u;
  if (straight) { top=hi >> 31u; hi=(hi<<1u)|(lo>>31u); lo <<= 1u; }
  let bits = select(64u-countLeadingZeros(hi),65u,top!=0u);
  if (bits > 53u) {
    let shift=bits-53u; let unit=1u<<shift; let mask=unit-1u;
    let rem=lo&mask; let base=lo&~mask;
    let up=rem>unit/2u || (rem==unit/2u && (base&unit)!=0u);
    lo=base+select(0u,unit,up);
    if (lo<base) { hi++; if (hi==0u) { top++; } }
  }
  return vec3<u32>(lo,hi,top);
}
fn greater(a: vec3<u32>, b: vec3<u32>) -> bool {
  return a.z>b.z || (a.z==b.z && (a.y>b.y || (a.y==b.y && a.x>b.x)));
}
@compute @workgroup_size(64)
fn d8(@builtin(global_invocation_id) id: vec3<u32>, @builtin(num_workgroups) groups: vec3<u32>) {
  let c=id.x+id.y*groups.x*64u; let n=u32(input[0]); if (c>=n) { return; }
  let nx=u32(input[1]); let nz=u32(input[2]); let x=i32(c%nx); let z=i32(c/nx);
  var pick = -1; var best=vec3<u32>(0u);
  if (previous[c]==0) {
    for (var d=0u; d<8u; d++) {
      let u=x+DX[d]; let v=z+DZ[d];
      if (u<0 || v<0 || u>=i32(nx) || v>=i32(nz)) { continue; }
      let other=input[3u+u32(v)*nx+u32(u)]; let own=input[3u+c];
      if (own<=other) { continue; }
      let drop=bitcast<u32>(own)-bitcast<u32>(other);
      let w=score(drop,(d&1u)==0u);
      if (greater(w,best)) { best=w; pick=i32(d); }
    }
  }
  output[c]=pick;
  output[n+c]=select(0,1,pick<0 && previous[c]==0 && x>0 && z>0 && x<i32(nx)-1 && z<i32(nz)-1);
  atomicAdd(&counters[c],1u);
}
@compute @workgroup_size(64)
fn accumulate(@builtin(global_invocation_id) id: vec3<u32>, @builtin(num_workgroups) groups: vec3<u32>) {
  let c=id.x+id.y*groups.x*64u; let n=u32(input[0]); if (c>=n) { return; }
  let nx=u32(input[1]); let nz=u32(input[2]); let x=i32(c%nx); let z=i32(c/nx);
  var sum=1;
  for (var d=0u; d<8u; d++) {
    let u=x+DX[d]; let v=z+DZ[d];
    if (u<0 || v<0 || u>=i32(nx) || v>=i32(nz)) { continue; }
    let k=u32(v)*nx+u32(u);
    if (input[3u+k]==i32((d+4u)&7u)) { sum += previous[k]; }
  }
  output[c]=sum;
  if (sum!=previous[c]) { atomicAdd(&counters[n],1u); }
  atomicAdd(&counters[c],1u);
}
`;async function V(r,i,a={},{signal:o}={}){if(o?.throwIfAborted(),!i||!(i.height instanceof Int32Array))throw t(`GPU hydrology needs Int32Array heights`,`biomes`);let{nx:s,nz:c,step:l}=i,u=s*c;if(!Number.isSafeInteger(s)||!Number.isSafeInteger(c)||s<2||c<2||!Number.isSafeInteger(u)||u>2147483647||i.height.length!==u||!Number.isFinite(l)||l<1)throw n(`GPU hydrology needs integer nx,nz >= 2, matching heights, n <= 2147483647 and step >= 1`,`biomes`);if(!a||typeof a!=`object`)throw t(`GPU hydrology options must be an object`,`biomes`);let d={...a};if(d.sea!==void 0&&!Number.isFinite(d.sea)||d.channelCells!==void 0&&(!Number.isFinite(d.channelCells)||d.channelCells<1)||d.lakeDepth!==void 0&&(!Number.isFinite(d.lakeDepth)||d.lakeDepth<=0)||d.multiple!==void 0&&typeof d.multiple!=`boolean`)throw n(`GPU hydrology needs finite sea, positive lakeDepth, channelCells >= 1 and boolean multiple`,`biomes`);N(r,u),P(r,3+2*u),P(r,2*u),P(r,u+1);let f=m.prepare({height:i.height.slice(),nx:s,nz:c,step:l},d),p=new Int32Array(3+2*u);p.set([u,s,c]),p.set(f.filled,3),p.set(f.ocean,3+u);let h=new L(r,o);try{let[t,n]=await h.pipelines(B,[`d8`,`accumulate`]),[i,a,l,d]=await h.scoped(()=>[h.buffer(p.length,p),h.buffer(u,Int32Array.from(f.ocean)),h.buffer(2*u),h.buffer(u+1)]),g=await h.read(l,2*u,e=>h.dispatch(e,t,[i,a,l,d],u));R(await h.read(d,u+1),0,u),f.direction.set(g.subarray(0,u)),f.flat.set(g.subarray(u)),m.drain(f);let _=new Int32Array(3+u);_.set([u,s,c]),_.set(f.direction,3),await h.scoped(()=>{r.queue.writeBuffer(i,0,_),r.queue.writeBuffer(a,0,new Int32Array(u).fill(1))});let v=a,y=l,b=0;for(;b<u;){o?.throwIfAborted();let e=Math.min(64,u-b),t=await h.read(d,u+1,t=>{for(let r=0;r<e;r++)t.clearBuffer(d,u*4,4),h.dispatch(t,n,[i,v,y,d],u),[v,y]=[y,v]});if(b+=e,R(t,0,u,b+1),t[u]===0){let e=await h.read(v,u);return m.finish(f,e)}}throw e(`failed`,`GPU flow did not converge within the cell count; check drainage for cycles`,`biomes`)}catch(e){z(e,o)}finally{h.close()}}var H=`
${M}
@group(0) @binding(0) var<storage,read> input: array<i32>;
@group(0) @binding(1) var<storage,read_write> output: array<i32>;
fn signedwide(value: i32) -> vec2<u32> {
  return vec2<u32>(bitcast<u32>(value),select(0u,4294967295u,value<0));
}
fn cluster(at: u32, x: i32, z: i32) -> i32 {
  let reach=input[at+9u]; if (reach==0) { return 65536; }
  let cell=u32(input[at+10u]); let reach2=wide(u32(reach),u32(reach));
  let x0=floorSigned(x-reach,cell); let x1=floorSigned(x+reach,cell);
  let z0=floorSigned(z-reach,cell); let z1=floorSigned(z+reach,cell);
  let seed=bitcast<u32>(input[at]); let code=bitcast<u32>(input[at+14u]);
  let table=u32(input[at+15u]); var sum=vec2<u32>(0u);
  for (var pz=z0; pz<=z1; pz++) { for (var px=x0; px<=x1; px++) {
    let count=poisson(u32(input[at+11u]),u32(input[at+12u]),hash5(seed,code,px,pz,0u));
    for (var i=1u; i<=count; i++) {
      let h=hash5(seed,code,px,pz,i);
      let xp=wide(h>>16u,cell); let zp=wide(h&65535u,cell);
      let ox=px*i32(cell)+i32((xp.x>>16u)|(xp.y<<16u));
      let oz=pz*i32(cell)+i32((zp.x>>16u)|(zp.y<<16u));
      let dx=u32(abs(x-ox)); let dz=u32(abs(z-oz));
      let d2=addwide(wide(dx,dx),wide(dz,dz));
      if (!lesswide(d2,reach2)) { continue; }

      let numerator=vec2<u32>(d2.x<<14u,(d2.y<<14u)|(d2.x>>18u));
      let t=dividewide(numerator,reach2); let j=t>>6u; let f=i32(t&63u);
      let a=input[table+j]; let b=input[table+j+1u];



      let interpolation=((b-a)*f)>>6u;
      sum=addwide(sum,addwide(signedwide(a),signedwide(interpolation)));
    }
  } }


  let negative=(sum.y&2147483648u)!=0u;
  let capped=select(sum.x,262144u,!negative && (sum.y!=0u || sum.x>262144u));
  let beta=input[at+13u]; return 65536-beta+qmul(beta,bitcast<i32>(capped));
}
@compute @workgroup_size(64)
fn counts(@builtin(global_invocation_id) id: vec3<u32>, @builtin(num_workgroups) groups: vec3<u32>) {
  let k=id.x+id.y*groups.x*64u; let n=u32(input[0]); if (k>=n) { return; }
  let at=1u+18u*k;
  output[k]=i32(poisson(u32(input[at+5u]),u32(input[at+6u]),
    hash5(bitcast<u32>(input[at]),bitcast<u32>(input[at+1u]),input[at+2u],input[at+3u],0u)));
  output[n+k]=1;
}
@compute @workgroup_size(64)
fn emit(@builtin(global_invocation_id) id: vec3<u32>, @builtin(num_workgroups) groups: vec3<u32>) {
  let k=id.x+id.y*groups.x*64u; let n=u32(input[0]); if (k>=n) { return; }
  let at=1u+18u*k; let out=9u*k;
  let h0=hash5(bitcast<u32>(input[at]),bitcast<u32>(input[at+1u]),input[at+2u],input[at+3u],u32(input[at+16u]));
  let h1=pcg(h0); let h2=pcg(h1); let h3=pcg(h2); let h4=pcg(h3);
  let gen=u32(input[at+4u]); let xp=wide(h0>>8u,gen); let zp=wide(h1>>8u,gen);
  let x=input[at+2u]*i32(gen)+i32((xp.x>>24u)|(xp.y<<8u));
  let z=input[at+3u]*i32(gen)+i32((zp.x>>24u)|(zp.y<<8u));
  output[out]=bitcast<i32>(h0); output[out+1u]=bitcast<i32>(h1); output[out+2u]=bitcast<i32>(h2);
  output[out+3u]=bitcast<i32>(h3); output[out+4u]=bitcast<i32>(h4); output[out+5u]=x; output[out+6u]=z;
  output[out+7u]=stand(bitcast<u32>(input[at]),u32(input[at+7u]),input[at+8u],x,z);
  output[out+8u]=cluster(at,x,z); output[9u*n+k]=1;
}
`,U=`
@group(0) @binding(0) var<storage,read> graph: array<u32>;
@group(0) @binding(1) var<storage,read> previous: array<u32>;
@group(0) @binding(2) var<storage,read_write> output: array<u32>;
@group(0) @binding(3) var<storage,read_write> executed: array<atomic<u32>>;
@compute @workgroup_size(64)
fn accept(@builtin(global_invocation_id) id: vec3<u32>, @builtin(num_workgroups) groups: vec3<u32>) {
  let i=id.x+id.y*groups.x*64u; let n=graph[0]; if (i>=n) { return; }
  let old=previous[i]; var free=old==0u;
  for (var q=graph[1u+i]; q<graph[2u+i] && free; q++) { if (previous[graph[q]]==0u) { free=false; } }

  let round=atomicLoad(&executed[i])/2u+1u;
  output[i]=select(old,round*4u+1u,free); atomicAdd(&executed[i],1u);
}
@compute @workgroup_size(64)
fn kill(@builtin(global_invocation_id) id: vec3<u32>, @builtin(num_workgroups) groups: vec3<u32>) {
  let i=id.x+id.y*groups.x*64u; let n=graph[0]; if (i>=n) { return; }
  let round=atomicLoad(&executed[i])/2u+1u; var value=previous[i];
  if (value==0u) {
    for (var q=graph[1u+i]; q<graph[2u+i]; q++) {
      if (previous[graph[q]]==round*4u+1u) { value=round*4u+2u; break; }
    }
  }
  output[i]=value; atomicAdd(&executed[i],1u);
}
`,W=(e,t,n)=>`${e.index}/${t}/${n}`;function G(e,t,n){let r=n?e.reduce((e,t)=>e+t.count,0):e.length,i=new Map,a=1+18*r;for(let{sp:t}of e)t.cluster&&!i.has(t)&&(i.set(t,a),a+=257);let o=new Int32Array(a);o[0]=r;let s=1;for(let r of e)for(let e=+!!n;e<=(n?r.count:0);e++){let{sp:n,gx:a,gz:c}=r,l=n.stands,u=n.cluster;o.set([t,n.code,a,c,n.gen,n.mu,n.e0,l?.scale??0,l?.top??0,u?.reach??0,u?.cell??0,u?.mu??0,u?.e0??0,u?.beta??0,u?.code??0,i.get(n)??0,e,0],s),s+=18}for(let[e,t]of i)o.set(e.cluster.table,t);return o}function K(e,t,n){let{plan:r,tileTicks:o}=e,s=[],c=[t*o,n*o,(t+1)*o,(n+1)*o];for(let t=r.strata.length-1;t>=0;t--){let n=r.strata[t],[o,l,u,d]=c,f=t===1||t===2?Math.max(r.strata[1].rmax,r.strata[2].rmax)+n.g:0;o-=f,l-=f,u+=f,d+=f;for(let e=t+1;e<r.strata.length;e++)if(r.strata[e].species.length){let t=Math.max(n.rmax,a(r.across,n.rmax+r.strata[e].rmax)+1)+n.g,i=s[e];o=Math.min(o,i[0]-t),l=Math.min(l,i[1]-t),u=Math.max(u,i[2]+t),d=Math.max(d,i[3]+t)}let p=(r.rounds+1)*(n.dmax+n.g);s[t]=[Math.max(0,i(o-p,n.g)*n.g),Math.max(0,i(l-p,n.g)*n.g),Math.min(-i(-e.worldX,n.g)*n.g,-i(-(u+p),n.g)*n.g),Math.min(-i(-e.worldZ,n.g)*n.g,-i(-(d+p),n.g)*n.g)]}return s}function q(e,t,n,r,o){let s=new Map;for(let t=0;t<e.n;t++){let n=`${i(e.x[t],r)},${i(e.z[t],r)}`,a=s.get(n);a||s.set(n,a=[]),a.push(t)}let c=[e.n],l=[];for(let u=0;u<e.n;u++){c.push(2+e.n+l.length);for(let c=i(e.z[u]-o,r);c<=i(e.z[u]+o,r);c++)for(let d=i(e.x[u]-o,r);d<=i(e.x[u]+o,r);d++)for(let r of s.get(`${d},${c}`)??[]){if(r===u||e.prio[r]<e.prio[u]||e.prio[r]===e.prio[u]&&(e.x[r]<e.x[u]||e.x[r]===e.x[u]&&(e.z[r]<e.z[u]||e.z[r]===e.z[u]&&e.sp[r]<=e.sp[u])))continue;let i=a(t[e.sp[u]*n+e.sp[r]],e.r[u]+e.r[r]),o=e.x[r]-e.x[u],s=e.z[r]-e.z[u];o*o+s*s<i*i&&l.push(r)}}return c.push(2+e.n+l.length),new Uint32Array([...c,...l])}async function J(r,a,o,s,{signal:c}={}){c?.throwIfAborted();let l=h.get(a);if(!l)throw t(`GPU placement needs a live BiomePlacement from this module`,`biomes`);let u=l(o,s),{plan:d}=u,f=K(u,o,s),p=[];for(let e of d.specs){let t=e.cluster;if(![e.gen,e.mu,e.e0,e.stands?.scale??0,t?.cell??0,t?.mu??0].every(e=>Number.isSafeInteger(e)&&e>=0&&e<=2147483647))throw n(`GPU placement needs nonnegative i32 plan values; reduce cluster/stand scale or density`,`biomes`)}let m=d.specs.filter(e=>e.cluster).length*257,g=0;for(let e=0;e<d.strata.length;e++){let[t,n,a,o]=f[e];for(let s of d.strata[e].species){let e=i(a-t,s.gen)*i(o-n,s.gen);g+=e,P(r,1+g*18+m),P(r,g*2),N(r,Math.max(1,g));for(let e=i(n,s.gen);e<i(o,s.gen);e++)for(let n=i(t,s.gen);n<i(a,s.gen);n++)p.push({sp:s,gx:n,gz:e,start:0,count:0})}}N(r,Math.max(1,p.length)),P(r,1+p.length*18+m),P(r,p.length*2);let _=G(p,u.seed,!1),v=new L(r,c);try{let[t,a]=await v.pipelines(H,[`counts`,`emit`]),[o,s]=await v.pipelines(U,[`accept`,`kill`]),l=async(e,t,n)=>{let r=t[0];if(!r)return new Int32Array;let[i,a]=await v.scoped(()=>[v.buffer(t.length,t),v.buffer(r*(n+1))]),o=await v.read(a,r*(n+1),t=>v.dispatch(t,e,[i,a],r));return R(o,n*r,r),o},h=await l(t,_,1),g=0,y=new Map;if(p.forEach((t,n)=>{let r=h[n];if(!Number.isInteger(r)||r<0||r>40)throw e(`failed`,`GPU Poisson count is invalid; check shader execution`,`biomes`);t.count=r,t.start=g,g+=r,y.set(W(t.sp,t.gx,t.gz),t)}),!Number.isSafeInteger(g)||g>2147483647)throw n(`GPU candidate prefix exceeds i32; use a smaller placement window`,`biomes`);N(r,Math.max(1,g)),P(r,1+g*18+m),P(r,g*10);let b=await l(a,G(p,u.seed,!0),9),x=await v.wait(u.open(f,{count(t,n,r){let i=y.get(W(t,n,r));if(!i)throw e(`failed`,`GPU placement dependency window is incomplete; check the cone derivation`,`biomes`);return i.count},candidate(t,n,r,i){let a=y.get(W(t,n,r));if(!a||i<1||i>a.count)throw e(`failed`,`GPU placement candidate is missing; check emission`,`biomes`);let o=9*(a.start+i-1);return{h0:b[o]>>>0,h1:b[o+1]>>>0,h2:b[o+2]>>>0,h3:b[o+3]>>>0,h4:b[o+4]>>>0,x:b[o+5],z:b[o+6],stand:b[o+7],cluster:b[o+8]}}},c));for(let e=0;e<d.strata.length;e++){c?.throwIfAborted();let t=d.strata[e];if(!t.species.length)continue;let n=f[e];for(let r=i(n[1],t.g);r<i(n[3],t.g);r++)for(let a=i(n[0],t.g);a<i(n[2],t.g);a++)x.run.cell(e,a,r);let a=x.run.pools[e],l=a.n;if(!l)continue;let u=q(a,d.factor,d.specs.length,t.g,t.dmax);P(r,u.length),P(r,l),N(r,l);let[p,m,h,g]=await v.scoped(()=>[v.buffer(u.length,u),v.buffer(l),v.buffer(l),v.buffer(l)]),_=await v.read(m,l,e=>{for(let t=0;t<d.rounds;t++)v.dispatch(e,o,[p,m,h,g],l),v.dispatch(e,s,[p,h,m,g],l)});R(await v.read(g,l),0,l,2*d.rounds);for(let e=0;e<l;e++)a.fate[e]=_[e]&3,a.round[e]=_[e]>>>2,a.known[e]=d.rounds}return c?.throwIfAborted(),x.render()}catch(e){z(e,c)}finally{v.close()}}var Y=new WeakMap,X=()=>e(`failed`,`BiomeWorld GPU device lost; recreate the WebGPU device`,`biomes`),Z=class e{#e=new AbortController;#t;#n;#r;constructor(e,t,n,r){this.device=e,this.#t=t,this.#n=n,this.#r=r}static of(r,a,o,s){let{backend:c=`auto`,device:l,workers:u}=r,d=c===`gpu`,f=a.map(e=>i(e,o)+1),p=e=>{if(d)throw e};if(c!==`cpu`)return!l||typeof l!=`object`||typeof l.createBuffer!=`function`||typeof l.createShaderModule!=`function`||!l.queue||typeof l.lost?.then!=`function`?p(t(`BiomeWorld backend 'gpu' requires the device option (a GPUDevice)`,`biomes`)):u&&u>0?p(n(`BiomeWorld backend 'gpu' runs on this thread; pass workers: 0`,`biomes`)):f.some(e=>e>32768)?p(n(`BiomeWorld backend 'gpu' allows at most 32768 region corners per axis; use a larger regionResolution or smaller size`,`biomes`)):new e(l,s,f,!d)}route(e){this.#r||g.set(e,{device:this.device,signal:this.#e.signal})}watch(){let e=Y.get(this.device);if(!e){let t={controllers:new Set,lost:!1};Y.set(this.device,e=t),this.device.lost.then(()=>{t.lost=!0;for(let e of t.controllers)e.abort(X());t.controllers.clear()})}e.lost?this.#e.abort(X()):e.controllers.add(this.#e)}live(){this.#r||this.#e.signal.throwIfAborted()}fits(e,t=`envelopes`,r){try{e&&this.#i(e,t);for(let e=0;r&&e<r.length;e++)if(Math.abs(r[e])>1073741824)throw n(`BiomeWorld backend 'gpu' heights must be within +/-1073741824 mm; rescale the height source or use backend 'cpu'`,`biomes`);return!0}catch(e){if(this.#r)return!1;throw e}}#i(e,t){let r=this.#t,a=this.device.limits,o=Math.min(a.maxStorageBufferBindingSize,a.maxBufferSize);if(5*this.#n[0]*this.#n[1]*4>o)throw n(`BiomeWorld backend 'gpu' packed region exceeds device buffer limits; use a smaller size or larger regionResolution`,`biomes`);let s=r+2,c=e.inputs.length,l=c+(e.score?0:e.ids.length),u=Math.min(i(o,s*Math.max(24,8*l)),i(2147483647,l*s),a.maxComputeWorkgroupsPerDimension*8),d=Math.min(r,u-2),f=4*(2*c+e.ids.length+1+4*e.envelopes.slot.length);if(d<1||f>o||a.maxBufferSize<32||[Math.ceil(s/8),c,e.score?1:e.ids.length].some(e=>e>a.maxComputeWorkgroupsPerDimension)||t!==`envelopes`&&!t.perCell&&d<r)throw n(`BiomeWorld backend 'gpu' tile row and margins exceed device limits, where a non-perCell zone scorer needs a full tile; use fewer biomes or classifier inputs, smaller tileSize, larger resolution, or backend 'cpu'`,`biomes`);return d}async layers(e,t,n,r){let a=this.#r&&r,o=()=>(t?.throwIfAborted(),n?.(),r());if(a&&this.#e.signal.aborted)return o();let s=t?AbortSignal.any([t,this.#e.signal]):this.#e.signal,{frame:l,classifier:u,gx:d,width:m,depth:h,names:g}=e,_=this.device,v=()=>{s.throwIfAborted(),n?.()},y=async(t,n)=>{v();let r=(e,t,n,r,i)=>j(_,l,e,t,n,r,i,{temporary:!1,signal:s});if(!c(g))return r(d,t,m,n,g);let i=await r(d-1,t-1,m+2,n+2,p(g,u)),a=new Uint8Array(m*n*4),o=new Uint8Array(m*n*4);return v(),await w(_,u,e.input(i,t,n),a,o,{signal:s}),v(),f(g,i,a,o,m,n)};try{let t=this.#i(u,e.kind);if(h<=t){let t=await y(e.gz,h);return v(),t}let n=new Map;for(let r=0;r<h;r+=t){let a=await y(e.gz+r,Math.min(t,h-r));v();for(let[e,t]of a){let a=n.get(e);if(!a){let r=t.data.constructor;a={...t,depth:h,data:new r(i(t.data.length,t.depth)*h)},n.set(e,a)}a.data.set(t.data,i(r*t.data.length,t.depth))}}return v(),n}catch(e){let t=s.aborted?s.reason:e;if(a&&t?.name===`MargoError`&&t.code===`failed`)return o();throw t}}dispose(e){Y.get(this.device)?.controllers.delete(this.#e),e!==void 0&&this.#e.abort(e)}[Symbol.dispose](){this.dispose()}};export{Z as GpuTiles,V as hydrologyGPU,J as placeTileGPU};