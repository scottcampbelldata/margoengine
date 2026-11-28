const __vite__mapDeps=(i,m=__vite__mapDeps,d=(m.f||(m.f=["./cpu-load-DZsQ-qON-zbLqq3bO.js","./array-DbI848Wf-CdHXJFgJ.js"])))=>i.map(i=>d[i]);
import{t as e}from"./index-Cy-L8UZy.js";import{_ as t,a as n,c as r,f as i,g as a,i as o,l as s,m as c,n as l,o as u,p as d,r as f,s as p,t as m,u as h,v as g}from"./array-DbI848Wf-CdHXJFgJ.js";function _(e){return e?.adapterInfo?.vendor===`margo-webgl2`?`webgl2`:`native`}function v(e,t){return _(e)===`webgl2`?t():void 0}function y(e){return e?e.then(()=>void 0,()=>void 0):Promise.resolve()}var b=new Float32Array(1),x=new Uint32Array(b.buffer);function S(e){b[0]=e;let t=Math.abs(e)-Math.abs(b[0]);(t>0||t<0)&&!(x[0]&1)&&(x[0]+=t>0?1:-1);let n=x[0],r=n>>>16&32768,i=n>>>23&255,a=n&8388607;if(i===255)return r|31744|(a?512:0);let o=i-127+15;if(o>=31)return r|31744;if(o<=0){if(o<-10)return r;let e=(a|8388608)>>>1-o+13,t=(a|8388608)&(1<<1-o+13)-1,n=1<<1-o+12;return r|e+(t>n||t===n&&e&1?1:0)}let s=a>>>13,c=a&8191,l=r|o<<10|s;return(c>4096||c===4096&&s&1)&&l++,l}var C=new Set([`f32`,`i32`,`u32`,`f16`,`bool`]),w={f:`f32`,i:`i32`,u:`u32`,h:`f16`};function T(e){let t=``,n=0;for(let r=0;r<e.length;r++){let i=e[r],a=e[r+1];if(n===0&&i===`/`&&a===`/`){for(;r<e.length&&e[r]!==`
`;)r++;t+=`
`}else i===`/`&&a===`*`?(n++,r++):n>0&&i===`*`&&a===`/`?(n--,r++):n===0?t+=i:i===`
`&&(t+=`
`)}return t}function E(e){let t=[],n=0,r=0;for(let i=0;i<e.length;i++){let a=e[i];a===`<`||a===`(`?n++:a===`>`||a===`)`?n--:a===`,`&&n===0&&(t.push(e.slice(r,i).trim()),r=i+1)}let i=e.slice(r).trim();return i&&t.push(i),t}var D=(e,t)=>Math.ceil(t/e)*e;function O(e){let t=new Map,n=new Map,r=new Map;for(let n of e.matchAll(/\balias\s+(\w+)\s*=\s*([^;]+);/g))t.set(n[1],n[2].trim());for(let t of e.matchAll(/\b(?:const|override)\s+(\w+)\s*(?::\s*\w+\s*)?=\s*([^;]+);/g))r.set(t[1],t[2].trim());for(let t of e.matchAll(/\bstruct\s+(\w+)\s*\{([^}]*)\}/g)){let e=[];for(let n of E(t[2])){let t=/^((?:@\w+(?:\([^)]*\))?\s*)*)(\w+)\s*:\s*(.+)$/s.exec(n);if(!t)continue;let r=t[1],i=/@align\(\s*(\d+)\s*\)/.exec(r),a=/@size\(\s*(\d+)\s*\)/.exec(r);e.push({name:t[2],type:t[3].trim(),align:i?Number(i[1]):void 0,size:a?Number(a[1]):void 0})}n.set(t[1],e)}return{aliases:t,structs:n,constants:r}}function k(e,t,n=new Set){let r=e.trim(),i=/^(0[xX][0-9a-fA-F]+|\d+)[iu]?$/.exec(r);if(i)return Number(i[1]);if(/^\w+$/.test(r)&&t.constants.has(r)&&!n.has(r))return n.add(r),k(t.constants.get(r),t,n)}function A(e){let t=e.trim(),n=t.indexOf(`<`);return n<0?{base:t,args:[]}:{base:t.slice(0,n).trim(),args:E(t.slice(n+1,t.lastIndexOf(`>`)))}}function j(e,t,n=0){if(n>32)return;let r=e.trim();for(;t.aliases.has(r);)r=t.aliases.get(r);let i=/^(vec[234]|mat[234]x[234])([fiuh])$/.exec(r);i&&(r=`${i[1]}<${w[i[2]]}>`);let{base:a,args:o}=A(r);if(C.has(a)){if(a===`bool`)return;let e=a===`f16`?2:4;return{name:a,kind:`scalar`,align:e,size:e,scalar:a}}if(a===`atomic`){let e=j(o[0]??``,t,n+1);return e&&{...e,name:r,kind:`atomic`}}let s=/^vec([234])$/.exec(a);if(s){let e=Number(s[1]),i=j(o[0]??``,t,n+1);if(!i||i.kind!==`scalar`)return;let a=i.size;return{name:r,kind:`vector`,align:(e===2?2:4)*a,size:e*a,scalar:i.scalar,rows:e}}let c=/^mat([234])x([234])$/.exec(a);if(c){let e=Number(c[1]),i=Number(c[2]),a=j(`vec${i}<${o[0]}>`,t,n+1);if(!a)return;let s=D(a.align,a.size);return{name:r,kind:`matrix`,align:a.align,size:e*s,scalar:a.scalar,rows:i,columns:e,stride:s}}if(a===`array`){let e=j(o[0]??``,t,n+1);if(!e)return;let i=D(e.align,e.size),a=o[1]===void 0?0:k(o[1],t);return a===void 0?void 0:{name:r,kind:`array`,align:e.align,size:a===0?i:a*i,element:e,stride:i,count:a}}let l=t.structs.get(a);if(l){let e=0,r=1,i=[];for(let a of l){let o=j(a.type,t,n+1);if(!o)return;let s=a.align??o.align;e=D(s,e),i.push({name:a.name,offset:e,layout:o}),e+=a.size??o.size,r=Math.max(r,s)}return{name:a,kind:`struct`,align:r,size:D(r,e),members:i}}}var M={"1d":`1d`,"2d":`2d`,"2d_array":`2d-array`,"3d":`3d`,cube:`cube`,cube_array:`cube-array`},ee={f32:`float`,i32:`sint`,u32:`uint`};function te(e){let{base:t,args:n}=A(e),r=/^texture_storage_(1d|2d|2d_array|3d)$/.exec(t);if(r){let e={read:`read-only`,write:`write-only`,read_write:`read-write`}[n[1]??`write`];return{viewDimension:M[r[1]],format:n[0],access:e}}let i=/^texture_depth_(multisampled_)?(2d|2d_array|cube|cube_array)$/.exec(t);if(i)return{viewDimension:M[i[2]],sampleType:`depth`,multisampled:!!i[1]};let a=/^texture_(multisampled_)?(1d|2d|2d_array|3d|cube|cube_array)$/.exec(t);if(a)return{viewDimension:M[a[2]],sampleType:ee[n[0]??`f32`]??`float`,multisampled:!!a[1]}}function ne(e){let t=T(e),n=O(t),r=[],i=[];for(let e of t.matchAll(/((?:@\w+\s*(?:\([^)]*\))?\s*)+)var\s*(?:<\s*([\w\s,]+)\s*>)?\s*(\w+)\s*:\s*([^;=]+?)\s*;/g)){let t=e[1],i=/@group\(\s*([^)]+)\)/.exec(t),a=/@binding\(\s*([^)]+)\)/.exec(t);if(!i||!a)continue;let o=k(i[1],n),s=k(a[1],n);if(o===void 0||s===void 0)throw g(`Kernel binding ${e[3]} has a group or binding that is not a constant integer`,`compute`);let c=(e[2]??``).split(`,`).map(e=>e.trim()),l=e[3],u=e[4].trim();if(c[0]===`uniform`)r.push({name:l,group:o,binding:s,resource:`uniform`,type:u,layout:j(u,n)});else if(c[0]===`storage`)r.push({name:l,group:o,binding:s,resource:c[1]===`read_write`?`storage`:`read-only-storage`,type:u,layout:j(u,n)});else if(/^sampler(_comparison)?$/.test(u))r.push({name:l,group:o,binding:s,resource:`sampler`,type:u,sampler:u===`sampler`?`filtering`:`comparison`});else{let e=te(u);if(!e)throw g(`Kernel binding ${l} has a type the kernel cannot bind: ${u}`,`compute`);r.push({name:l,group:o,binding:s,resource:e.format?`storage-texture`:`texture`,type:u,texture:e})}}for(let e of t.matchAll(/@compute\s*((?:@\w+\s*(?:\([^)]*\))?\s*)*)fn\s+(\w+)|((?:@\w+\s*(?:\([^)]*\))?\s*)+)fn\s+(\w+)/g)){let t=e[1]??e[3]??``,r=e[2]??e[4];if(e[3]!==void 0&&!/@compute\b/.test(t))continue;let a=/@workgroup_size\(([^)]*)\)/.exec(t),o=a?E(a[1]).map(e=>k(e,n)):[1];if(o.some(e=>e===void 0))throw g(`Kernel entry point ${r} has a workgroup size that is not a constant integer`,`compute`);i.push({name:r,workgroupSize:[o[0]??1,o[1]??1,o[2]??1]})}return r.sort((e,t)=>e.group-t.group||e.binding-t.binding),{bindings:r,entryPoints:i}}function N(e,t,n,r,i){let o=(t,n,r)=>{let o=typeof r==`boolean`?Number(r):r;if(typeof o!=`number`)throw g(`Uniform ${i} needs a number, got ${typeof r}`,`compute`);if(n===`f32`)e.setFloat32(t,o,!0);else if(n===`f16`)e.setUint16(t,S(o),!0);else{let[r,s]=n===`i32`?[-2147483648,2147483647]:[0,4294967295];if(!Number.isInteger(o)||o<r||o>s)throw a(`Uniform ${i} needs an integer from ${r} to ${s}, got ${o}`,`compute`);n===`i32`?e.setInt32(t,o,!0):e.setUint32(t,o,!0)}},s=(e,t)=>{if(typeof e!=`object`||!e||typeof e.length!=`number`)throw g(`Uniform ${i} needs an array of ${t} numbers`,`compute`);let n=e;if(n.length!==t)throw g(`Uniform ${i} needs ${t} numbers, got ${n.length}`,`compute`);return n},c=n.scalar===`f16`?2:4;switch(n.kind){case`scalar`:case`atomic`:return o(t,n.scalar,r);case`vector`:{let e=s(r,n.rows);for(let r=0;r<n.rows;r++)o(t+r*c,n.scalar,e[r]);return}case`matrix`:{let e=s(r,n.rows*n.columns);for(let r=0;r<n.columns;r++)for(let i=0;i<n.rows;i++)o(t+r*n.stride+i*c,n.scalar,e[r*n.rows+i]);return}case`array`:{let a=n.element,o=r;if(typeof o!=`object`||!o||typeof o.length!=`number`)throw g(`Uniform ${i} needs an array`,`compute`);if(n.count&&o.length!==n.count)throw g(`Uniform ${i} needs ${n.count} items, got ${o.length}`,`compute`);for(let r=0;r<o.length;r++)N(e,t+r*n.stride,a,o[r],`${i}[${r}]`);return}case`struct`:{if(typeof r!=`object`||!r||ArrayBuffer.isView(r)||Array.isArray(r))throw g(`Uniform ${i} needs an object with the struct's members`,`compute`);let a=r;for(let r of n.members){if(!(r.name in a))throw g(`Uniform ${i}.${r.name} is missing; pass every struct member`,`compute`);N(e,t+r.offset,r.layout,a[r.name],`${i}.${r.name}`)}}}}function re(e,t=0){return e.kind===`array`&&e.count===0?e.stride*t:e.size}function ie(e,t,n=`value`){let r=e.kind===`array`&&e.count===0?t.length:0,i=new Uint8Array(D(16,Math.max(re(e,r),4)));return N(new DataView(i.buffer),0,e,t,n),i}var P=1024,F=`fn blockIndex(wid: vec3u, nwg: vec3u) -> u32 { return wid.x + wid.y * nwg.x; }`,I=`struct Params { n: u32, inf: u32, a: u32, b: u32 }`;function L(e,t){if(typeof e==`object`){if(typeof e.combine!=`string`||typeof e.identity!=`string`)throw g(`A custom operator needs WGSL strings combine (of a and b) and identity`,`compute`);return e}let n=t===`f16`?`bitcast<vec2<f16>>((params.inf >> 16u) & 0x7c00u).x`:`bitcast<f32>(params.inf)`;switch(e){case`sum`:return{combine:`a + b`,identity:`${t}(0)`};case`product`:return{combine:`a * b`,identity:`${t}(1)`};case`min`:return{combine:`min(a, b)`,identity:t===`i32`?`i32(2147483647)`:t===`u32`?`0xffffffffu`:n};case`max`:return{combine:`max(a, b)`,identity:t===`i32`?`(-2147483647i - 1i)`:t===`u32`?`0u`:`-${n}`}}}function ae(e,t,n,r=256){let i=e.dtype,a=P/r;return`${e.enables}${e.declarations}${I}
${F}
@group(0) @binding(${e.next}) var<storage, read_write> dst: array<${i}>;
@group(0) @binding(${e.next+1}) var<storage, read_write> sums: array<${i}>;
@group(0) @binding(${e.next+2}) var<uniform> params: Params;
var<workgroup> partial: array<${i}, ${r}>;
${e.fn}
fn combine(a: ${i}, b: ${i}) -> ${i} { return ${t}; }
@compute @workgroup_size(${r})
fn main(@builtin(workgroup_id) wid: vec3u, @builtin(num_workgroups) nwg: vec3u, @builtin(local_invocation_index) lid: u32) {
  let g = blockIndex(wid, nwg);
  if (g * 1024u >= params.n) { return; }
  let base = g * 1024u + lid * ${a}u;
  var item: array<${i}, ${a}>;
  var acc: ${i} = ${n};
  for (var k = 0u; k < ${a}u; k++) {
    var v: ${i} = ${n};
    if (base + k < params.n) { v = value(base + k); }
    acc = combine(acc, v);
    item[k] = acc;
  }
  partial[lid] = acc;
  workgroupBarrier();
  for (var offset = 1u; offset < ${r}u; offset <<= 1u) {
    var v = partial[lid];
    if (lid >= offset) { v = combine(partial[lid - offset], v); }
    workgroupBarrier();
    partial[lid] = v;
    workgroupBarrier();
  }
  var before: ${i} = ${n};
  if (lid > 0u) { before = partial[lid - 1u]; }
  for (var k = 0u; k < ${a}u; k++) {
    if (base + k < params.n) {
      if (params.a == 1u) {
        var previous = before;
        if (k > 0u) { previous = combine(before, item[k - 1u]); }
        dst[base + k] = previous;
      } else {
        dst[base + k] = combine(before, item[k]);
      }
    }
  }
  if (lid == ${r-1}u) { sums[g] = partial[${r-1}]; }
}`}function oe(e,t){return`${e===`f16`?`enable f16;
`:``}${I}
${F}
@group(0) @binding(0) var<storage, read_write> data: array<${e}>;
@group(0) @binding(1) var<storage, read> sums: array<${e}>;
@group(0) @binding(2) var<uniform> params: Params;
fn combine(a: ${e}, b: ${e}) -> ${e} { return ${t}; }
@compute @workgroup_size(256)
fn main(@builtin(workgroup_id) wid: vec3u, @builtin(num_workgroups) nwg: vec3u, @builtin(local_invocation_index) lid: u32) {
  let g = blockIndex(wid, nwg);
  if (g * 1024u >= params.n) { return; }
  let prefix = sums[g];
  for (var k = 0u; k < 4u; k++) {
    let i = g * 1024u + lid * 4u + k;
    if (i < params.n) { data[i] = combine(prefix, data[i]); }
  }
}`}function se(e,t,n,r){let i=e.dtype,a=e.next;return`${e.enables}${e.declarations}${I}
${F}
@group(0) @binding(${a}) var<storage, read> flagsIn: array<u32>;
@group(0) @binding(${a+1}) var<storage, read_write> dst: array<${i}>;
@group(0) @binding(${a+2}) var<storage, read_write> seen: array<u32>;
@group(0) @binding(${a+3}) var<storage, read_write> sumFlags: array<u32>;
@group(0) @binding(${a+4}) var<storage, read_write> sumValues: array<${i}>;
@group(0) @binding(${a+5}) var<uniform> params: Params;
var<workgroup> partialFlags: array<u32, 256>;
var<workgroup> partialValues: array<${i}, 256>;
${e.fn}
fn combine(a: ${i}, b: ${i}) -> ${i} { return ${t}; }
fn flagAt(i: u32) -> u32 { ${r?`return select(0u, 1u, i % params.b == 0u);`:`return select(0u, 1u, flagsIn[i] != 0u);`} }
@compute @workgroup_size(256)
fn main(@builtin(workgroup_id) wid: vec3u, @builtin(num_workgroups) nwg: vec3u, @builtin(local_invocation_index) lid: u32) {
  let g = blockIndex(wid, nwg);
  if (g * 1024u >= params.n) { return; }
  let base = g * 1024u + lid * 4u;
  var itemFlags: array<u32, 4>;
  var itemValues: array<${i}, 4>;
  var f = 0u;
  var v: ${i} = ${n};
  for (var k = 0u; k < 4u; k++) {
    var fk = 0u;
    var vk: ${i} = ${n};
    if (base + k < params.n) { fk = flagAt(base + k); vk = value(base + k); }
    if (fk == 1u) { v = vk; } else { v = combine(v, vk); }
    f = f | fk;
    itemFlags[k] = f;
    itemValues[k] = v;
  }
  partialFlags[lid] = f;
  partialValues[lid] = v;
  workgroupBarrier();
  for (var offset = 1u; offset < 256u; offset <<= 1u) {
    var pf = partialFlags[lid];
    var pv = partialValues[lid];
    if (lid >= offset && pf == 0u) {
      pv = combine(partialValues[lid - offset], pv);
      pf = partialFlags[lid - offset];
    } else if (lid >= offset) {
      pf = 1u;
    }
    workgroupBarrier();
    partialFlags[lid] = pf;
    partialValues[lid] = pv;
    workgroupBarrier();
  }
  var beforeFlag = 0u;
  var beforeValue: ${i} = ${n};
  if (lid > 0u) { beforeFlag = partialFlags[lid - 1u]; beforeValue = partialValues[lid - 1u]; }
  for (var k = 0u; k < 4u; k++) {
    let i = base + k;
    if (i < params.n) {
      var out = itemValues[k];
      if (itemFlags[k] == 0u) { out = combine(beforeValue, out); }
      dst[i] = out;
      seen[i] = itemFlags[k] | beforeFlag;
    }
  }
  if (lid == 255u) { sumFlags[g] = partialFlags[255]; sumValues[g] = partialValues[255]; }
}`}function ce(e,t){return`${e===`f16`?`enable f16;
`:``}${I}
${F}
@group(0) @binding(0) var<storage, read_write> data: array<${e}>;
@group(0) @binding(1) var<storage, read> seen: array<u32>;
@group(0) @binding(2) var<storage, read> scanned: array<${e}>;
@group(0) @binding(3) var<uniform> params: Params;
fn combine(a: ${e}, b: ${e}) -> ${e} { return ${t}; }
@compute @workgroup_size(256)
fn main(@builtin(workgroup_id) wid: vec3u, @builtin(num_workgroups) nwg: vec3u, @builtin(local_invocation_index) lid: u32) {
  let g = blockIndex(wid, nwg);
  if (g == 0u || g * 1024u >= params.n) { return; }
  let prefix = scanned[g - 1u];
  for (var k = 0u; k < 4u; k++) {
    let i = g * 1024u + lid * 4u + k;
    if (i < params.n && seen[i] == 0u) { data[i] = combine(prefix, data[i]); }
  }
}`}function le(e,t,n){let r=t===`f16`||e.some(e=>e.type===`f16`),i=e.map((e,t)=>`@group(0) @binding(${t+1}) var<storage, read> in_${e.name}: array<${e.type}>;`).join(`
`),a=e.map(e=>`${e.name}: ${e.type}`).join(`, `),o=e.map(e=>`in_${e.name}[i]`).join(`, `),s=/\breturn\b/.test(n)?n:`return ${t}(${n});`;return`${r?`enable f16;
`:``}${I}
${F}
@group(0) @binding(0) var<storage, read_write> out: array<${t}>;
${i}
@group(0) @binding(${e.length+1}) var<uniform> params: Params;
fn f(i: u32, n: u32${a?`, `+a:``}) -> ${t} { ${s} }
@compute @workgroup_size(256)
fn main(@builtin(workgroup_id) wid: vec3u, @builtin(num_workgroups) nwg: vec3u, @builtin(local_invocation_index) lid: u32) {
  let i = blockIndex(wid, nwg) * 256u + lid;
  if (i >= params.n) { return; }
  out[i] = f(i, params.n${o?`, `+o:``});
}`}function ue(e){switch(e){case`f32`:return`let bits = bitcast<u32>(v); return select(bits | 0x80000000u, ~bits, (bits & 0x80000000u) != 0u);`;case`f16`:return`let bits = bitcast<u32>(f32(v)); return select(bits | 0x80000000u, ~bits, (bits & 0x80000000u) != 0u);`;case`i32`:return`return bitcast<u32>(v) ^ 0x80000000u;`;case`u32`:return`return v;`}}function de(e){return`${e.enables}${e.declarations}${I}
${F}
@group(0) @binding(${e.next}) var<storage, read_write> keys: array<u32>;
@group(0) @binding(${e.next+1}) var<storage, read_write> order: array<u32>;
@group(0) @binding(${e.next+2}) var<uniform> params: Params;
${e.fn}
fn toKey(v: ${e.dtype}) -> u32 { ${ue(e.dtype)} }
@compute @workgroup_size(256)
fn main(@builtin(workgroup_id) wid: vec3u, @builtin(num_workgroups) nwg: vec3u, @builtin(local_invocation_index) lid: u32) {
  let i = blockIndex(wid, nwg) * 256u + lid;
  if (i >= params.n) { return; }
  var k = toKey(value(i));
  if (params.a == 1u) { k = ~k; }
  keys[i] = k;
  if (params.b == 1u) { order[i] = i; }
}`}function fe(e){return`${e===`f16`?`enable f16;
`:``}${I}
${F}
@group(0) @binding(0) var<storage, read> keys: array<u32>;
@group(0) @binding(1) var<storage, read_write> dst: array<${e}>;
@group(0) @binding(2) var<uniform> params: Params;
fn fromKey(k: u32) -> ${e} { ${e===`f32`?`return bitcast<f32>(select(~k, k & 0x7fffffffu, (k & 0x80000000u) != 0u));`:e===`f16`?`return f16(bitcast<f32>(select(~k, k & 0x7fffffffu, (k & 0x80000000u) != 0u)));`:e===`i32`?`return bitcast<i32>(k ^ 0x80000000u);`:`return k;`} }
@compute @workgroup_size(256)
fn main(@builtin(workgroup_id) wid: vec3u, @builtin(num_workgroups) nwg: vec3u, @builtin(local_invocation_index) lid: u32) {
  let i = blockIndex(wid, nwg) * 256u + lid;
  if (i >= params.n) { return; }
  var k = keys[i];
  if (params.a == 1u) { k = ~k; }
  dst[i] = fromKey(k);
}`}var pe=`struct Radix { n: u32, shift: u32, blocks: u32, values: u32 }`,me=e=>`${pe}
${F}
@group(0) @binding(0) var<storage, read> keysIn: array<u32>;
@group(0) @binding(1) var<storage, read> valuesIn: array<u32>;
@group(0) @binding(2) var<storage, read_write> keysLocal: array<u32>;
@group(0) @binding(3) var<storage, read_write> valuesLocal: array<u32>;
@group(0) @binding(4) var<storage, read_write> counts: array<u32>;
@group(0) @binding(5) var<storage, read_write> starts: array<u32>;
@group(0) @binding(6) var<uniform> radix: Radix;
var<workgroup> sharedKeys: array<u32, ${e}>;
var<workgroup> sharedValues: array<u32, ${e}>;
var<workgroup> scan: array<u32, ${e}>;
var<workgroup> histogram: array<atomic<u32>, 16>;
@compute @workgroup_size(${e})
fn main(@builtin(workgroup_id) wid: vec3u, @builtin(num_workgroups) nwg: vec3u, @builtin(local_invocation_index) lid: u32) {
  let g = blockIndex(wid, nwg);
  if (g >= radix.blocks) { return; }
  let i = g * ${e}u + lid;
  var key = 0xffffffffu;
  var value = 0u;
  if (i < radix.n) {
    key = keysIn[i];
    if (radix.values == 1u) { value = valuesIn[i]; }
  }
  if (lid < 16u) { atomicStore(&histogram[lid], 0u); }
  for (var b = 0u; b < 4u; b++) {
    let bit = (key >> (radix.shift + b)) & 1u;
    scan[lid] = 1u - bit;
    workgroupBarrier();
    for (var offset = 1u; offset < ${e}u; offset <<= 1u) {
      var v = scan[lid];
      if (lid >= offset) { v += scan[lid - offset]; }
      workgroupBarrier();
      scan[lid] = v;
      workgroupBarrier();
    }
    let zeros = scan[${e-1}];
    let zerosBefore = scan[lid] - (1u - bit);
    var dest = zerosBefore;
    if (bit == 1u) { dest = zeros + lid - zerosBefore; }
    workgroupBarrier();
    sharedKeys[dest] = key;
    sharedValues[dest] = value;
    workgroupBarrier();
    key = sharedKeys[lid];
    value = sharedValues[lid];
    workgroupBarrier();
  }
  let valid = min(${e}u, radix.n - g * ${e}u);
  let digit = (key >> radix.shift) & 15u;
  if (lid < valid) { atomicAdd(&histogram[digit], 1u); }
  keysLocal[i] = key;
  valuesLocal[i] = value;
  workgroupBarrier();
  if (lid < 16u) {
    counts[lid * radix.blocks + g] = atomicLoad(&histogram[lid]);
    var start = 0u;
    for (var d = 0u; d < lid; d++) { start += atomicLoad(&histogram[d]); }
    starts[g * 16u + lid] = start;
  }
}`,he=e=>`${pe}
${F}
@group(0) @binding(0) var<storage, read> keysLocal: array<u32>;
@group(0) @binding(1) var<storage, read> valuesLocal: array<u32>;
@group(0) @binding(2) var<storage, read> offsets: array<u32>;
@group(0) @binding(3) var<storage, read> starts: array<u32>;
@group(0) @binding(4) var<storage, read_write> keysOut: array<u32>;
@group(0) @binding(5) var<storage, read_write> valuesOut: array<u32>;
@group(0) @binding(6) var<uniform> radix: Radix;
@compute @workgroup_size(${e})
fn main(@builtin(workgroup_id) wid: vec3u, @builtin(num_workgroups) nwg: vec3u, @builtin(local_invocation_index) lid: u32) {
  let g = blockIndex(wid, nwg);
  if (g >= radix.blocks || lid >= min(${e}u, radix.n - g * ${e}u)) { return; }
  let key = keysLocal[g * ${e}u + lid];
  let digit = (key >> radix.shift) & 15u;
  let dest = offsets[digit * radix.blocks + g] + lid - starts[g * 16u + digit];
  keysOut[dest] = key;
  if (radix.values == 1u) { valuesOut[dest] = valuesLocal[g * ${e}u + lid]; }
}`,ge=4096;function _e(e,t){let n=t?`localCounts`:`counts`;return`${e.enables}${e.declarations}struct Bins { n: u32, bins: u32, pad0: u32, pad1: u32 }
${F}
@group(0) @binding(${e.next}) var<storage, read_write> counts: array<atomic<u32>>;
@group(0) @binding(${e.next+1}) var<storage, read> range: array<f32>;
@group(0) @binding(${e.next+2}) var<uniform> params: Bins;
${t?`var<workgroup> localCounts: array<atomic<u32>, ${ge}>;`:``}
${e.fn}
@compute @workgroup_size(256)
fn main(@builtin(workgroup_id) wid: vec3u, @builtin(num_workgroups) nwg: vec3u, @builtin(local_invocation_index) lid: u32) {
  let g = blockIndex(wid, nwg);
  if (g * 1024u >= params.n) { return; }
  let lo = range[0];
  let hi = range[1];
  let scale = f32(params.bins) / (hi - lo);
  ${t?`for (var b = lid; b < params.bins; b += 256u) { atomicStore(&localCounts[b], 0u); }
  workgroupBarrier();`:``}
  for (var k = 0u; k < 4u; k++) {
    let i = g * 1024u + k * 256u + lid;
    if (i < params.n) {
      let x = f32(value(i));
      if (x >= lo && x <= hi) {
        let bin = min(u32((x - lo) * scale), params.bins - 1u);
        atomicAdd(&${n}[bin], 1u);
      }
    }
  }
  ${t?`workgroupBarrier();
  for (var b = lid; b < params.bins; b += 256u) {
    let c = atomicLoad(&localCounts[b]);
    if (c > 0u) { atomicAdd(&counts[b], c); }
  }`:``}
}`}var R=`struct Params { n: u32, inf: u32, len: u32, inner: u32 }`,z=`fn blockIndex(wid: vec3u, nwg: vec3u) -> u32 { return wid.x + wid.y * nwg.x; }`,ve=4096;function B(e,t){if(e===void 0)return Array.from({length:t},(e,t)=>t);let n=(typeof e==`number`?[e]:[...e]).map(e=>l(e,t));if(new Set(n).size!==n.length)throw a(`Reduction axes repeat: [${String(e)}]`,`compute`);return n.sort((e,t)=>e-t)}var ye=(e,t,n)=>n?e.map((e,n)=>t.includes(n)?1:e):e.filter((e,n)=>!t.includes(n));function be(e,t,n,r=256){let i=e.dtype,a=P/r;return`${e.enables}${e.declarations}${R}
${z}
@group(0) @binding(${e.next}) var<storage, read_write> dst: array<${i}>;
@group(0) @binding(${e.next+1}) var<uniform> params: Params;
var<workgroup> partial: array<${i}, ${r}>;
${e.fn}
fn combine(a: ${i}, b: ${i}) -> ${i} { return ${t}; }
@compute @workgroup_size(${r})
fn main(@builtin(workgroup_id) wid: vec3u, @builtin(num_workgroups) nwg: vec3u, @builtin(local_invocation_index) lid: u32) {
  let g = blockIndex(wid, nwg);
  if (g * 1024u >= params.n) { return; }
  var acc: ${i} = ${n};
  for (var k = 0u; k < ${a}u; k++) {
    let i = g * 1024u + lid * ${a}u + k;
    if (i < params.n) { acc = combine(acc, value(i)); }
  }
  partial[lid] = acc;
  workgroupBarrier();
  for (var offset = ${r/2}u; offset > 0u; offset >>= 1u) {
    if (lid < offset) { partial[lid] = combine(partial[lid], partial[lid + offset]); }
    workgroupBarrier();
  }
  if (lid == 0u) { dst[g] = partial[0]; }
}`}function xe(e,t,n,r){let i=e.dtype,a=`${e.enables}${e.declarations}${R}
${z}
@group(0) @binding(${e.next}) var<storage, read_write> dst: array<${i}>;
@group(0) @binding(${e.next+1}) var<uniform> params: Params;
${e.fn}
fn combine(a: ${i}, b: ${i}) -> ${i} { return ${t}; }
fn at(o: u32, k: u32) -> u32 { return ((o / params.inner) * params.len + k) * params.inner + o % params.inner; }`;return r?`${a}
@compute @workgroup_size(256)
fn main(@builtin(workgroup_id) wid: vec3u, @builtin(num_workgroups) nwg: vec3u, @builtin(local_invocation_index) lid: u32) {
  let o = blockIndex(wid, nwg) * 256u + lid;
  if (o >= params.n) { return; }
  var acc: ${i} = ${n};
  for (var k = 0u; k < params.len; k++) { acc = combine(acc, value(at(o, k))); }
  dst[o] = acc;
}`:`${a}
var<workgroup> partial: array<${i}, 256>;
@compute @workgroup_size(256)
fn main(@builtin(workgroup_id) wid: vec3u, @builtin(num_workgroups) nwg: vec3u, @builtin(local_invocation_index) lid: u32) {
  let o = blockIndex(wid, nwg);
  if (o >= params.n) { return; }
  let run = (params.len + 255u) / 256u;
  var acc: ${i} = ${n};
  for (var k = lid * run; k < min(params.len, lid * run + run); k++) { acc = combine(acc, value(at(o, k))); }
  partial[lid] = acc;
  workgroupBarrier();
  for (var offset = 128u; offset > 0u; offset >>= 1u) {
    if (lid < offset) { partial[lid] = combine(partial[lid], partial[lid + offset]); }
    workgroupBarrier();
  }
  if (lid == 0u) { dst[o] = partial[0]; }
}`}var V=2139095040;function H(e,t,r,i={}){if(e.check(),!(t instanceof n))throw g(`Reductions take a GpuArray or an Expr`,`compute`);if(typeof r==`string`&&![`sum`,`product`,`min`,`max`].includes(r))throw g(`Unknown reduce op ${r}; use sum, product, min, max or { combine, identity }`,`compute`);let a=B(i.axis,t.ndim),o=!!i.keepdims,s=ye(t.shape,a,o),{combine:c,identity:l}=L(r,t.dtype);if(a.length===t.ndim)return Se(e,t,c,l,s);let u=t,d=[...t.shape],f=[];for(let n=a.length-1;n>=0;n--){let r=a[n],i=n===0,o=d.filter((e,t)=>t!==r),p=e.empty(i?s:o,t.dtype);Ce(e,u,r,d,c,l,p),i||f.push(p),u=p,d=o}for(let e of f)e.dispose();return u}function Se(e,t,n,r,i){let a=t.size;if(a===0){let n=e.empty(i,t.dtype),a=`${t.dtype===`f16`?`enable f16;
`:``}${R}
@group(0) @binding(0) var<storage, read_write> dst: array<${t.dtype}>;
@group(0) @binding(1) var<uniform> params: Params;
@compute @workgroup_size(1) fn main() { dst[0] = ${r}; }`;return e.submit([{program:e.program(a,void 0,`reduce`),resources:{dst:n,params:new Uint32Array([0,V,0,0])},workgroups:[1,1,1]}]),n}let o=t,s=a,c=[],l=[],d;do{let a=Math.ceil(s/P),f=[],p=u(o,0,e.maxStorage(1),f);c.push(...f),d=e.empty(a===1?i:[a],t.dtype),l.push({program:e.program(e.kernelRoute?.level(p,n,r)??be(p,n,r,e.tuned.reduce),void 0,`reduce`),resources:{...p.resources,dst:d,params:new Uint32Array([s,V,0,0])},workgroups:e.grid(a)}),a>1&&c.push(d),o=d,s=a}while(s>1);e.submit(l);for(let e of c)e.dispose();return d}function Ce(e,t,n,r,i,a,o){let s=r[n],c=r.slice(n+1).reduce((e,t)=>e*t,1),l=o.size;if(l===0)return;let d=[],f=u(t,0,e.maxStorage(1),d),p=l>=ve||s<=64;e.submit([{program:e.program((p?void 0:e.kernelRoute?.axis(f,i,a))??xe(f,i,a,p),void 0,`reduce.axis`),resources:{...f.resources,dst:o,params:new Uint32Array([l,V,s,c])},workgroups:e.grid(p?Math.ceil(l/256):l)}]);for(let e of d)e.dispose()}var we=(e,t)=>t.reduce((t,n)=>t*e[n],1);function Te(e,t,n={}){let r=we(t.shape,B(n.axis,t.ndim));return Ee(H(e,h(t.dtype)&&t.dtype===`f32`?t:t.astype(`f32`),`sum`,n),r?1/r:NaN)}function Ee(e,t){let n=e.mul(t).eval();return e.dispose(),n}function De(e,t,n={}){let r=n.ddof??0;if(!Number.isFinite(r)||r<0)throw a(`ddof must be a number of at least 0, got ${r}`,`compute`);let i=t.dtype===`f32`?t:t.astype(`f32`),o=Te(e,i,{axis:n.axis,keepdims:!0}),s=we(t.shape,B(n.axis,t.ndim)),c=H(e,i.sub(o).square(),`sum`,n);return o.dispose(),Ee(c,s-r>0?1/(s-r):NaN)}function Oe(e,t,n={}){let r=De(e,t,n),i=r.sqrt().eval();return r.dispose(),i}function ke(e,t,n={}){let r=t.dtype===`f32`?t:t.astype(`f32`),i=H(e,p(r.isnan(),0,r),`sum`,n),a=H(e,r.isnan().not(),`sum`,n),o=i.div(a).eval();return i.dispose(),a.dispose(),o}function Ae(e,t,n){let r=e.dtype,i=t===`min`?`<`:`>`,a=n===`level`?`fn load(i: u32) -> Pair { return Pair(vals[i], idx[i]); }`:`fn load(i: u32) -> Pair { return Pair(value(i), i); }`,o=`${e.enables}${e.declarations}${R}
${z}
struct Pair { v: ${r}, i: u32 }
@group(0) @binding(${e.next}) var<storage, read_write> outValues: array<${r}>;
@group(0) @binding(${e.next+1}) var<storage, read_write> outIndices: array<u32>;
@group(0) @binding(${e.next+2}) var<uniform> params: Params;
${n===`level`?`@group(0) @binding(${e.next+3}) var<storage, read> vals: array<${r}>;\n@group(0) @binding(${e.next+4}) var<storage, read> idx: array<u32>;`:``}
${e.fn}
${a}
fn pick(a: Pair, b: Pair) -> Pair {
  if (b.i == 0xffffffffu) { return a; }
  if (a.i == 0xffffffffu || b.v ${i} a.v || (b.v == a.v && b.i < a.i)) { return b; }
  return a;
}
fn at(o: u32, k: u32) -> u32 { return ((o / params.inner) * params.len + k) * params.inner + o % params.inner; }`,s=`Pair(${r}(0), 0xffffffffu)`,c=`
  partial[lid] = acc;
  workgroupBarrier();
  for (var offset = 128u; offset > 0u; offset >>= 1u) {
    if (lid < offset) { partial[lid] = pick(partial[lid], partial[lid + offset]); }
    workgroupBarrier();
  }`;return n===`thread`?`${o}
@compute @workgroup_size(256)
fn main(@builtin(workgroup_id) wid: vec3u, @builtin(num_workgroups) nwg: vec3u, @builtin(local_invocation_index) lid: u32) {
  let o = blockIndex(wid, nwg) * 256u + lid;
  if (o >= params.n) { return; }
  var acc = ${s};
  for (var k = 0u; k < params.len; k++) { let p = load(at(o, k)); acc = pick(acc, Pair(p.v, k)); }
  outValues[o] = acc.v;
  outIndices[o] = acc.i;
}`:n===`group`?`${o}
var<workgroup> partial: array<Pair, 256>;
@compute @workgroup_size(256)
fn main(@builtin(workgroup_id) wid: vec3u, @builtin(num_workgroups) nwg: vec3u, @builtin(local_invocation_index) lid: u32) {
  let o = blockIndex(wid, nwg);
  if (o >= params.n) { return; }
  let run = (params.len + 255u) / 256u;
  var acc = ${s};
  for (var k = lid * run; k < min(params.len, lid * run + run); k++) { let p = load(at(o, k)); acc = pick(acc, Pair(p.v, k)); }
  ${c}
  if (lid == 0u) { outValues[o] = partial[0].v; outIndices[o] = partial[0].i; }
}`:`${o}
var<workgroup> partial: array<Pair, 256>;
@compute @workgroup_size(256)
fn main(@builtin(workgroup_id) wid: vec3u, @builtin(num_workgroups) nwg: vec3u, @builtin(local_invocation_index) lid: u32) {
  let g = blockIndex(wid, nwg);
  if (g * 1024u >= params.n) { return; }
  var acc = ${s};
  for (var k = 0u; k < 4u; k++) {
    let i = g * 1024u + lid * 4u + k;
    if (i < params.n) { acc = pick(acc, load(i)); }
  }
  ${c}
  if (lid == 0u) { outValues[g] = partial[0].v; outIndices[g] = partial[0].i; }
}`}function je(e,t,r,i={}){if(e.check(),!(t instanceof n))throw g(`arg${r} takes a GpuArray or an Expr`,`compute`);if(t.size===0)throw a(`arg${r} of an empty array has no answer`,`compute`);let o=[],s=t.dtype;if(i.axis===void 0){let n=i.keepdims?t.shape.map(()=>1):[],a=t.size,c,l,d=[],f=!0;do{let i=Math.ceil(a/P),p=i===1,m=u(f?t:c,0,e.maxStorage(4),o),h=e.empty([i],s),g=e.empty(p?n:[i],`u32`),_={...m.resources,outValues:h,outIndices:g,params:new Uint32Array([a,V,0,0])};f||Object.assign(_,{vals:c,idx:l}),d.push({program:e.program(Ae(m,r,f?`flat`:`level`),void 0,`arg${r}`),resources:_,workgroups:e.grid(i)}),c&&o.push(c),l&&o.push(l),c=h,l=g,a=i,f=!1}while(a>1);e.submit(d),o.push(c);for(let e of o)e.dispose();return l}let c=l(i.axis,t.ndim),d=t.shape[c],f=t.shape.slice(c+1).reduce((e,t)=>e*t,1),p=ye(t.shape,[c],!!i.keepdims),m=p.reduce((e,t)=>e*t,1),h=m>=ve||d<=64,_=u(t,0,e.maxStorage(2),o),v=e.empty([m],s),y=e.empty(p,`u32`);e.submit([{program:e.program(Ae(_,r,h?`thread`:`group`),void 0,`arg${r}.axis`),resources:{..._.resources,outValues:v,outIndices:y,params:new Uint32Array([m,V,d,f])},workgroups:e.grid(h?Math.ceil(m/256):m)}]),o.push(v);for(let e of o)e.dispose();return y}var U=`fn blockIndex(wid: vec3u, nwg: vec3u) -> u32 { return wid.x + wid.y * nwg.x; }`;function Me(e){if(!(e instanceof n))throw g(`Indices must be a GpuArray or an Expr`,`compute`);if(h(e.dtype))throw g(`Indices must be integers; astype('i32') first`,`compute`);return e instanceof f&&e.dtype===`i32`&&e.contiguous&&e.offset===0?{array:e,owned:!1}:{array:e.astype(`i32`).eval(),owned:!0}}function Ne(e,t,r,i={}){if(e.check(),!(t instanceof n))throw g(`take reads a GpuArray or an Expr`,`compute`);let{array:o,owned:s}=Me(r),c=i.mode??`clip`;if(c!==`clip`&&c!==`wrap`)throw g(`take mode must be 'clip' or 'wrap', got ${String(c)}`,`compute`);let d=i.axis===void 0?void 0:l(i.axis,t.ndim),f=d===void 0?t.size:t.shape[d],p=d===void 0?1:t.shape.slice(d+1).reduce((e,t)=>e*t,1),m=d===void 0?o.shape:[...t.shape.slice(0,d),...o.shape,...t.shape.slice(d+1)],h=e.empty(m,t.dtype),_=h.size;if(_>0&&f===0)throw a(`take from an empty axis has nothing to take`,`compute`);if(_>0){let n=[],r=u(t,0,e.maxStorage(2),n),i=`${r.enables}${r.declarations}struct Take { n: u32, len: u32, inner: u32, count: u32, wrap: u32 }
${U}
@group(0) @binding(${r.next}) var<storage, read> idx: array<i32>;
@group(0) @binding(${r.next+1}) var<storage, read_write> out: array<${t.dtype}>;
@group(0) @binding(${r.next+2}) var<uniform> take: Take;
${r.fn}
@compute @workgroup_size(256)
fn main(@builtin(workgroup_id) wid: vec3u, @builtin(num_workgroups) nwg: vec3u, @builtin(local_invocation_index) lid: u32) {
  let o = blockIndex(wid, nwg) * 256u + lid;
  if (o >= take.n) { return; }
  let j = o % take.inner;
  let p = (o / take.inner) % take.count;
  let outer = o / (take.inner * take.count);
  let len = i32(take.len);
  var k = idx[p];
  if (k < 0) { k += len; }
  if (take.wrap == 1u) { k = ((k % len) + len) % len; } else { k = clamp(k, 0, len - 1); }
  out[o] = value((outer * take.len + u32(k)) * take.inner + j);
}`;e.submit([{program:e.program(i,void 0,`take`),resources:{...r.resources,idx:o,out:h,take:new Uint32Array([_,f,p,Math.max(1,o.size),+(c===`wrap`),0,0,0])},workgroups:e.grid(Math.ceil(_/256))}]);for(let e of n)e.dispose()}return s&&o.dispose(),h}function Pe(e,t){let n=e=>e.kind===`leaf`?e.array.storage===t.storage:e.kind===`op`&&e.args.some(n);return n(e.node())}function Fe(e,t,i,o,c={}){if(e.check(),!(t instanceof f))throw g(`scatter writes into a GpuArray`,`compute`);if(t.check(e),!t.contiguous||t.offset)throw g(`scatter needs a contiguous target; scatter into the array the view came from`,`compute`);let l=c.op??`set`;if(![`set`,`add`,`min`,`max`].includes(l))throw g(`scatter op must be set, add, min or max, got ${l}`,`compute`);if(t.dtype===`f16`&&l!==`set`)throw g(`scatter add/min/max needs a 32-bit target; use 'f32'`,`compute`);let{array:d,owned:p}=Me(i),m=d.size,h=typeof o==`number`;if(!h&&!(o instanceof n))throw g(`scatter values must be a number, a GpuArray or an Expr`,`compute`);if(!h&&o.size!==m&&o.size!==1)throw a(`scatter has ${m} indices but ${o.size} values; pass one value or one per index`,`compute`);if(m>0){let n=t.dtype,i=[],a=h?void 0:o.astype(n);if(a&&Pe(a,t)){let e=a.eval();i.push(e),a=e}let c=a?u(a,0,e.maxStorage(2),i):void 0,f=c?.next??0,p=n===`i32`?`atomic<i32>`:`atomic<u32>`,g=h?`${s(`params.value`,n)}`:o.size===1?`value(0u)`:`value(i)`,_;_=l===`set`?`dst[j] = v;`:n===`f32`?`var old = atomicLoad(&dst[j]);
    loop {
      let swapped = atomicCompareExchangeWeak(&dst[j], old, bitcast<u32>(${l===`add`?`bitcast<f32>(old) + v`:`${l}(bitcast<f32>(old), v)`}));
      if (swapped.exchanged) { break; }
      old = swapped.old_value;
    }`:`atomic${l[0].toUpperCase()}${l.slice(1)}(&dst[j], v);`;let v=`${c?.enables??(n===`f16`?`enable f16;
`:``)}${c?.declarations??``}struct Params { n: u32, len: u32, value: u32, pad: u32 }
${U}
@group(0) @binding(${f}) var<storage, read> idx: array<i32>;
@group(0) @binding(${f+1}) var<storage, read_write> dst: array<${l===`set`?n:p}>;
@group(0) @binding(${f+2}) var<uniform> params: Params;
${c?.fn??``}
@compute @workgroup_size(256)
fn main(@builtin(workgroup_id) wid: vec3u, @builtin(num_workgroups) nwg: vec3u, @builtin(local_invocation_index) lid: u32) {
  let i = blockIndex(wid, nwg) * 256u + lid;
  if (i >= params.n) { return; }
  var k = idx[i];
  if (k < 0) { k += i32(params.len); }
  if (k < 0 || k >= i32(params.len)) { return; }
  let j = u32(k);
  let v = ${g};
  ${_}
}`;e.submit([{program:e.program(v,void 0,`scatter.${l}`),resources:{...c?.resources??{},idx:d,dst:t,params:new Uint32Array([m,t.size,h?r(o,n):0,0])},workgroups:e.grid(Math.ceil(m/256))}]);for(let e of i)e.dispose()}return p&&d.dispose(),t}function Ie(e,t,n){let r=n?.length;if(!Number.isInteger(r)||r<0)throw a(`bincount needs length (the number of bins, one past the largest value) as a whole number`,`compute`);return Fe(e,e.zeros([r],n.weights?`f32`:`u32`),t,n.weights??1,{op:`add`})}function W(e,t,r){if(e.check(),!(t instanceof n)||!(r instanceof n))throw g(`compact takes an input and a mask (GpuArrays or Exprs)`,`compute`);if(t.size!==r.size)throw a(`compact input (${t.size}) and mask (${r.size}) differ in size`,`compute`);let i=t.size,o=e.empty([i],t.dtype),s=e.empty([1],`u32`);if(i===0)return{values:o,count:s};let c=r.ne(0).eval(),l=e.empty([i],`u32`),d=[c,l],f=[];Ve(e,c,l,i,f,d);let p=u(t,0,e.maxStorage(4),d),m=`${p.enables}${p.declarations}${U}
@group(0) @binding(${p.next}) var<storage, read> flags: array<u32>;
@group(0) @binding(${p.next+1}) var<storage, read> offsets: array<u32>;
@group(0) @binding(${p.next+2}) var<storage, read_write> values: array<${t.dtype}>;
@group(0) @binding(${p.next+3}) var<storage, read_write> count: array<u32>;
@group(0) @binding(${p.next+4}) var<uniform> size: vec4u;
${p.fn}
@compute @workgroup_size(256)
fn main(@builtin(workgroup_id) wid: vec3u, @builtin(num_workgroups) nwg: vec3u, @builtin(local_invocation_index) lid: u32) {
  let i = blockIndex(wid, nwg) * 256u + lid;
  if (i >= size.x) { return; }
  if (flags[i] != 0u) { values[offsets[i]] = value(i); }
  if (i == size.x - 1u) { count[0] = offsets[i] + flags[i]; }
}`;f.push({program:e.program(m,void 0,`compact`),resources:{...p.resources,flags:c,offsets:l,values:o,count:s,size:new Uint32Array([i,0,0,0])},workgroups:e.grid(Math.ceil(i/256))}),e.submit(f);for(let e of d)e.dispose();return{values:o,count:s}}function Le(e,t,n){return W(e,t,n)}async function G(e,t,n){return(await t.read({signal:n}))[0]}async function Re(e,t,n,r={}){let i=W(e,t,n);try{let n=await G(e,i.count,r.signal),a=e.empty([n],t.dtype);return e.submit([],[[i.values.buffer,0,a.buffer,0,a.byteLength]]),a}finally{i.values.dispose(),i.count.dispose()}}async function ze(e,t,n={}){let r=e.arange(0,t.size,1,`u32`);try{return await Re(e,r,t,n)}finally{r.dispose()}}var K=2139095040;function q(e,t,n,r,i,a,o,s){let{combine:c,identity:l}=L(i,n.dtype),d=Math.ceil(r/P),f=e.empty([d],n.dtype),p=u(t,0,e.maxStorage(2),s);if(s.push(f),o.push({program:e.program(e.kernelRoute?.scan(p,c,l)??ae(p,c,l,e.tuned.scan),void 0,`scan`),resources:{...p.resources,dst:n,sums:f,params:new Uint32Array([r,K,+!!a,0])},workgroups:e.grid(d)}),d===1)return;let m=e.empty([d],n.dtype);s.push(m),q(e,f,m,d,i,!0,o,s),o.push({program:e.program(oe(n.dtype,c),void 0,`scan.add`),resources:{data:n,sums:m,params:new Uint32Array([r,K,0,0])},workgroups:e.grid(d)})}function J(e,t,n,r,i,a,o,s,c){let{combine:l,identity:d}=L(o,i.dtype),f=Math.ceil(a/P),p=e.empty([a],`u32`),m=e.empty([f],`u32`),h=e.empty([f],i.dtype),g=u(t,0,e.maxStorage(5),c),_=n?void 0:e.empty([1],`u32`);if(c.push(p,m,h),_&&c.push(_),s.push({program:e.program(se(g,l,d,!n),void 0,`scan.segmented`),resources:{...g.resources,flagsIn:n??_,dst:i,seen:p,sumFlags:m,sumValues:h,params:new Uint32Array([a,K,0,r])},workgroups:e.grid(f)}),f===1)return;let v=e.empty([f],i.dtype);c.push(v),J(e,h,m,0,v,f,o,s,c),s.push({program:e.program(ce(i.dtype,l),void 0,`scan.segmented.add`),resources:{data:i,seen:p,scanned:v,params:new Uint32Array([a,K,0,0])},workgroups:e.grid(f)})}function Be(e,t,n,r,i){let{identity:a}=L(i,t.dtype),o=`${t.dtype===`f16`?`enable f16;
`:``}struct Params { n: u32, inf: u32, a: u32, b: u32 }
@group(0) @binding(0) var<storage, read> inclusive: array<${t.dtype}>;
@group(0) @binding(1) var<storage, read> flags: array<u32>;
@group(0) @binding(2) var<storage, read_write> dst: array<${t.dtype}>;
@group(0) @binding(3) var<uniform> params: Params;
@compute @workgroup_size(256)
fn main(@builtin(workgroup_id) wid: vec3u, @builtin(num_workgroups) nwg: vec3u, @builtin(local_invocation_index) lid: u32) {
  let i = (wid.x + wid.y * nwg.x) * 256u + lid;
  if (i >= params.n) { return; }
  var start = i == 0u;
  if (params.b > 0u) { start = start || i % params.b == 0u; } else { start = start || flags[i] != 0u; }
  if (start) { dst[i] = ${a}; } else { dst[i] = inclusive[i - 1u]; }
}`,s=e.empty(t.shape,t.dtype);return e.submit([{program:e.program(o,void 0,`scan.exclusive`),resources:{inclusive:t,flags:n??t,dst:s,params:new Uint32Array([t.size,K,0,n?0:r])},workgroups:e.grid(Math.ceil(t.size/256))}]),s}function Ve(e,t,n,r,i,a){q(e,t,n,r,`sum`,!0,i,a)}function Y(e,t,r={}){if(e.check(),!(t instanceof n))throw g(`scan takes a GpuArray or an Expr`,`compute`);let i=r.op??`sum`,a=!!r.exclusive,o=t.size,s=[],c=[];if(r.axis===void 0||t.ndim<=1){let n=e.empty(r.axis===void 0?[o]:t.shape,t.dtype);if(o===0)return n;q(e,t,n,o,i,a,c,s),e.submit(c);for(let e of s)e.dispose();return n}let u=l(r.axis,t.ndim),d=[...t.shape.keys()].filter(e=>e!==u).concat(u),f=d.map((e,t)=>d.indexOf(t)),p=t instanceof n&&`transpose`in t?t:t.eval(),m=p.transpose(...d),h=t.shape[u],_=e.empty(m.shape,t.dtype);o>0&&(J(e,m,void 0,h,_,o,i,c,s),e.submit(c));let v=_;a&&o>0&&(v=Be(e,_,void 0,h,i),_.dispose());let y=v.transpose(...f).eval();v.dispose(),p!==t&&p.dispose();for(let e of s)e.dispose();return y}function He(e,t,r,i={}){if(e.check(),!(t instanceof n)||!(r instanceof n))throw g(`segmentedScan takes values and flags as GpuArrays or Exprs`,`compute`);if(t.size!==r.size)throw g(`segmentedScan values (${t.size}) and flags (${r.size}) differ in size`,`compute`);let a=i.op??`sum`,o=t.size,s=e.empty([o],t.dtype);if(o===0)return s;let c=r.ne(0).eval(),l=[c],u=[];if(J(e,t,c,0,s,o,a,u,l),e.submit(u),!i.exclusive){for(let e of l)e.dispose();return s}let d=Be(e,s,c,0,a);s.dispose();for(let e of l)e.dispose();return d}async function Ue(e,t,r,i={}){if(e.check(),t.size!==r.size)throw g(`reduceByKey keys (${t.size}) and values (${r.size}) differ in size`,`compute`);let a=t.size;if(a===0)return{keys:e.empty([0],t.dtype),values:e.empty([0],r.dtype)};let o=t instanceof n&&`storage`in t&&t.contiguous?t:t.eval(),s=o.reshape(a),c=s.slice([0,a-1]),l=s.slice([1,a]).ne(c).eval(),u=e.empty([a],`u32`),d=e.empty([a],`u32`);e.submit([],[[l.buffer,0,u.buffer,4,(a-1)*4],[l.buffer,0,d.buffer,0,(a-1)*4]]),u.write([1],0),d.write([1],a-1);let f=He(e,r,u,{op:i.op}),p=W(e,s,u),m=W(e,f,d),h=await G(e,p.count,i.signal),_=e.empty([h],t.dtype),v=e.empty([h],r.dtype);e.submit([],[[p.values.buffer,0,_.buffer,0,_.byteLength],[m.values.buffer,0,v.buffer,0,v.byteLength]]);for(let e of[l,u,d,f,p.values,p.count,m.values,m.count])e.dispose();return o!==t&&o.dispose(),{keys:_,values:v}}var X=2139095040;function Z(e,t,r,i){if(e.check(),!(t instanceof n))throw g(`sort takes a GpuArray or an Expr`,`compute`);let o=t.size,s=i.bits??32;if(!Number.isInteger(s)||s<1||s>32)throw a(`Sort bits must be a whole number from 1 to 32, got ${s}`,`compute`);if(s<32&&t.dtype!==`u32`)throw a(`Sort bits below 32 apply to u32 keys only; drop bits for other types`,`compute`);let c=e.kernelRoute||e.sortRoute?256:e.tuned.sort??256,l=Math.max(1,Math.ceil(o/c)),f=l*c,p=r!==void 0,m=[],h=t=>{let n=e.empty([t],`u32`);return m.push(n),n},_=h(f),v=h(f),y=h(p?f:1),b=h(p?f:1);if(o===0)return{keys:_,values:p?y:void 0,scratch:m};let x=[],S=[],C=u(t,0,e.maxStorage(2),m);if(x.push({program:e.program(de(C),void 0,`sort.keys`),resources:{...C.resources,keys:_,order:y,params:new Uint32Array([o,X,+!!i.descending,+(r===`index`)])},workgroups:e.grid(Math.ceil(o/256))}),r&&r!==`index`){let t=r.ascontiguous();if(t!==r&&m.push(t),d(t.dtype)!==4)throw g(`sortByKey values must be a 32-bit type; astype("f32") first`,`compute`);S.push([t.buffer,t.offset*4,y.buffer,0,o*4]),e.submit([],S.splice(0))}if(e.sortRoute){let t=Math.ceil(s/4)*4;return x.push({program:e.program(e.sortRoute,void 0,`sort.layer`),resources:{keys:_,values:y,spareKeys:v,spareValues:b,sort:new Uint32Array([o,t===32?4294967295:2**t-1,Math.ceil(t/8),+!!p])},workgroups:[1,1,1]}),e.submit(x),{keys:_,values:p?y:void 0,scratch:m}}let w=h(f),T=h(p?f:1),E=h(16*l),D=h(16*l),O=h(16*l),k=e.program(e.kernelRoute?.radixLocal??me(c),void 0,`sort.local`),A=e.program(he(c),void 0,`sort.scatter`),j=e.grid(l);for(let t=0;t<s;t+=4){let n=new Uint32Array([o,t,l,+!!p]);x.push({program:k,resources:{keysIn:_,valuesIn:y,keysLocal:w,valuesLocal:T,counts:E,starts:O,radix:n},workgroups:j}),Ve(e,E,D,16*l,x,m),x.push({program:A,resources:{keysLocal:w,valuesLocal:T,offsets:D,starts:O,keysOut:v,valuesOut:b,radix:n},workgroups:j}),[_,v]=[v,_],[y,b]=[b,y]}return e.submit(x),{keys:_,values:p?y:void 0,scratch:m}}function Q(e,t,n={}){let r=Z(e,t,void 0,n),i=t.size,a=e.empty([i],t.dtype);i>0&&e.submit([{program:e.program(fe(t.dtype),void 0,`sort.values`),resources:{keys:r.keys,dst:a,params:new Uint32Array([i,X,+!!n.descending,0])},workgroups:e.grid(Math.ceil(i/256))}]);for(let e of r.scratch)e.dispose();return a}function We(e,t,n={}){let r=Z(e,t,`index`,n),i=t.size,a=e.empty([i],`u32`);e.submit([],[[r.values.buffer,0,a.buffer,0,i*4]]);for(let e of r.scratch)e.dispose();return a}function Ge(e,t,r,i={}){if(!(r instanceof n))throw g(`sortByKey values must be a GpuArray or an Expr`,`compute`);if(t.size!==r.size)throw a(`sortByKey keys (${t.size}) and values (${r.size}) differ in size`,`compute`);let o=r.eval(),s=Z(e,t,o,i),c=t.size,l=e.empty([c],t.dtype),u=e.empty([c],r.dtype);c>0&&e.submit([{program:e.program(fe(t.dtype),void 0,`sort.values`),resources:{keys:s.keys,dst:l,params:new Uint32Array([c,X,+!!i.descending,0])},workgroups:e.grid(Math.ceil(c/256))}],[[s.values.buffer,0,u.buffer,0,c*4]]),o.dispose();for(let e of s.scratch)e.dispose();return{keys:l,values:u}}function Ke(e,t,n,r={}){if(!Number.isInteger(n)||n<0||n>t.size)throw a(`topk k must be a whole number from 0 to ${t.size}, got ${n}`,`compute`);let i=We(e,t,{descending:r.largest??!0}),o=e.empty([n],`u32`);return e.submit([],[[i.buffer,0,o.buffer,0,n*4]]),i.dispose(),{values:e.take(t,o),indices:o}}function qe(e,t,n){let r=typeof n==`number`?[n]:[...n];for(let e of r)if(!(e>=0&&e<=1))throw a(`Quantiles must be in [0, 1], got ${e}`,`compute`);let i=t.size;if(i===0)throw a(`quantile of an empty array has no answer`,`compute`);let o=Q(e,t).astype(`f32`).eval(),s=r.map(e=>Math.floor(e*(i-1))),c=s.map(e=>Math.min(e+1,i-1)),l=r.map((e,t)=>e*(i-1)-s[t]),u=e.take(o,e.array(s,`u32`)),d=e.take(o,e.array(c,`u32`)),f=e.array(l,`f32`),p=u.add(d.sub(u).mul(f)).eval();for(let e of[o,u,d,f])e.dispose();return typeof n==`number`?p.transfer([]):p}async function Je(e,t,n={}){let r=t.size;if(r===0)return{values:e.empty([0],t.dtype),...n.counts?{counts:e.empty([0],`u32`)}:{}};let i=Q(e,t),a=e.empty([r],`u32`);if(r>1){let t=i.slice([1,r]).ne(i.slice([0,r-1])).eval();e.submit([],[[t.buffer,0,a.buffer,4,(r-1)*4]]),t.dispose()}a.write([1],0);let o=W(e,i,a),s;if(n.counts){let t=e.arange(0,r,1,`u32`);s=W(e,t,a),t.dispose()}let c=await G(e,o.count,n.signal),l=e.empty([c],t.dtype);e.submit([],[[o.values.buffer,0,l.buffer,0,l.byteLength]]);let u;if(s){let t=e.empty([c+1],`u32`);e.submit([],[[s.values.buffer,0,t.buffer,0,c*4]]),t.write([r],c),u=t.slice([1,c+1]).sub(t.slice([0,c])).eval(),t.dispose(),s.values.dispose(),s.count.dispose()}for(let e of[i,a,o.values,o.count])e.dispose();return u?{values:l,counts:u}:{values:l}}var Ye=e=>`${e===`f16`?`enable f16;
`:``}struct Given { lo: f32, hi: f32, bins: u32, given: u32 }
@group(0) @binding(0) var<storage, read> low: array<${e}>;
@group(0) @binding(1) var<storage, read> high: array<${e}>;
@group(0) @binding(2) var<storage, read_write> range: array<f32>;
@group(0) @binding(3) var<storage, read_write> edges: array<f32>;
@group(0) @binding(4) var<uniform> given: Given;
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3u) {
  var lo = given.lo;
  var hi = given.hi;
  if (given.given == 0u) { lo = f32(low[0]); hi = f32(high[0]); }
  if (lo == hi) { lo -= 0.5; hi += 0.5; }
  if (id.x == 0u) { range[0] = lo; range[1] = hi; }
  if (id.x <= given.bins) { edges[id.x] = lo + (hi - lo) * f32(id.x) / f32(given.bins); }
}`;function Xe(e,t,r={}){if(e.check(),!(t instanceof n))throw g(`histogram takes a GpuArray or an Expr`,`compute`);let i=t.size,o=r.bins??64;if(!Number.isInteger(o)||o<1)throw a(`Histogram bins must be a whole number of at least 1, got ${o}`,`compute`);let s=r.range;if(s){let[e,t]=s;if(!Number.isFinite(e)||!Number.isFinite(t)||e>t)throw a(`Histogram range must be finite [min, max] with min <= max, got [${e}, ${t}]`,`compute`)}else i===0&&(s=[0,1]);let c=e.empty([o],`u32`),l=e.empty([o+1],`f32`),d=e.empty([2],`f32`),f=s?e.empty([1],`f32`):H(e,t,`min`),p=s?f:H(e,t,`max`),m=new DataView(new ArrayBuffer(16));if(m.setFloat32(0,s?.[0]??0,!0),m.setFloat32(4,s?.[1]??0,!0),m.setUint32(8,o,!0),m.setUint32(12,+!!s,!0),e.submit([{program:e.program(Ye(s?`f32`:t.dtype),void 0,`histogram.range`),resources:{low:f,high:p,range:d,edges:l,given:new Uint8Array(m.buffer)},workgroups:[Math.ceil((o+1)/64),1,1]}]),i>0){let n=[],r=u(t,0,e.maxStorage(2),n);e.submit([{program:e.program(_e(r,o<=ge),void 0,`histogram`),resources:{...r.resources,counts:c,range:d,params:new Uint32Array([i,o,0,0])},workgroups:e.grid(Math.ceil(i/P))}]);for(let e of n)e.dispose()}return f.dispose(),p!==f&&p.dispose(),d.dispose(),{counts:c,edges:l}}function Ze(e,t,n){if(n.indirect){let e=n.indirect instanceof f?n.indirect.buffer:n.indirect,t=(n.indirectOffset??0)*4+(n.indirect instanceof f?n.indirect.offset*4:0);if(!Number.isInteger(t)||t<0)throw a(`indirectOffset must be a whole number of elements`,`compute`);return{indirect:{buffer:e,offset:t}}}let r=e=>typeof e==`number`?[e,1,1]:[e[0],e[1]??1,e[2]??1],i;if(n.workgroups!==void 0)i=r(n.workgroups);else if(n.count!==void 0)i=r(n.count).map((e,n)=>Math.ceil(e/t[n]));else throw g(`Kernel run needs count (threads), workgroups or indirect`,`compute`);let o=e.device.limits.maxComputeWorkgroupsPerDimension;for(let e of i)if(!Number.isInteger(e)||e<0||e>o)throw a(`Kernel run of ${i.join(` x `)} workgroups is over ${o} per dimension; spread the work over y and z`,`compute`);return{workgroups:i}}var Qe=class{#e;#t;#n=!1;constructor(e,t){this.#e=e,this.#t=t,this.bindings=t.info.bindings,this.entryPoint=t.entry.name,this.workgroupSize=t.entry.workgroupSize}#r(){if(this.#n)throw t(`disposed`,`Kernel disposed; compile it again with gpu.kernel()`,`compute`)}run(e,t){this.#r();let n=Ze(this.#e,this.workgroupSize,t);return(n.indirect||n.workgroups.every(e=>e>0))&&this.#e.submit([{program:this.#t,resources:{...e},...n}]),this}bind(e){return this.#r(),new $e(this.#e,this.#t,e)}indirectArgs(e=[0,1,1]){return this.#r(),this.#e.indirectArgs(e)}dispose(){this.#n=!0}[Symbol.dispose](){this.dispose()}},$e=class{#e;#t;#n;#r=new Map;#i;#a=!1;constructor(e,t,n){this.#e=e,this.#t=t,this.#n={...n},this.#o()}#o(){for(let e of this.#r.values())e.destroy();this.#r.clear();let e=[],t={...this.#n};for(let e of this.#t.info.bindings){let n=t[e.name];if(!this.#s(e,n))continue;let r=this.#e.bytesFor(e,n),i=this.#e.device.createBuffer({size:r.byteLength,usage:(e.resource===`uniform`?GPUBufferUsage.UNIFORM:GPUBufferUsage.STORAGE)|GPUBufferUsage.COPY_DST});this.#e.device.queue.writeBuffer(i,0,r),this.#r.set(e.name,i),t[e.name]=i}this.#i=this.#e.scoped(()=>this.#e.bindGroups(this.#t,t,e))}#s(e,t){return e.resource!==`uniform`&&e.resource!==`read-only-storage`||t===void 0||t instanceof f||typeof GPUBuffer<`u`&&t instanceof GPUBuffer?!1:!(typeof t==`object`&&t&&`buffer`in t&&!ArrayBuffer.isView(t)&&!Array.isArray(t))}set(e,n){if(this.#a)throw t(`disposed`,`BoundKernel disposed; bind the kernel again`,`compute`);let r=this.#t.info.bindings.find(t=>t.name===e);if(!r)throw g(`Kernel has no binding named ${e}`,`compute`);let i=this.#r.get(e);if(i&&this.#s(r,n)){let t=this.#e.bytesFor(r,n);if(t.byteLength===i.size)return this.#e.device.queue.writeBuffer(i,0,t),this.#n[e]=n,this}return this.#n[e]=n,this.#o(),this}encode(e,n){if(this.#a)throw t(`disposed`,`BoundKernel disposed; bind the kernel again`,`compute`);for(let e of Object.values(this.#n))e instanceof f&&e.check(this.#e);let r=Ze(this.#e,this.#t.entry.workgroupSize,n);if(r.workgroups&&!r.workgroups.every(e=>e>0))return;let i=`beginComputePass`in e,a=i?e.beginComputePass({label:this.#t.label}):e;a.setPipeline(this.#t.pipeline),this.#i.forEach((e,t)=>a.setBindGroup(t,e)),r.indirect?a.dispatchWorkgroupsIndirect(r.indirect.buffer,r.indirect.offset):a.dispatchWorkgroups(...r.workgroups),i&&a.end()}run(e){return this.#e.check(),this.#e.scoped(()=>{let t=this.#e.device.createCommandEncoder();this.encode(t,e),this.#e.device.queue.submit([t.finish()])}),this}dispose(){if(!this.#a){this.#a=!0;for(let e of this.#r.values())e.destroy();this.#r.clear(),this.#i=void 0}}[Symbol.dispose](){this.dispose()}};function et(e,t){for(let[n,r]of Object.entries(e)){if(![`reduce`,`scan`,`sort`].includes(n))throw g(`createCompute tuned takes reduce, scan and sort, got ${n}`,`compute`);if(![64,128,256,512,1024].includes(r))throw a(`Tuned ${n} must be 64, 128, 256, 512 or 1024 threads, got ${String(r)}`,`compute`);if(r>t)throw a(`Tuned ${n} of ${r} threads is over this device's limit of ${t}; measure again on it`,`compute`)}}var tt=512,nt=e=>{let t={binding:e.binding,visibility:GPUShaderStage.COMPUTE};switch(e.resource){case`uniform`:case`storage`:case`read-only-storage`:return{...t,buffer:{type:e.resource}};case`sampler`:return{...t,sampler:{type:e.sampler}};case`storage-texture`:return{...t,storageTexture:{format:e.texture.format,access:e.texture.access,viewDimension:e.texture.viewDimension}};default:return{...t,texture:{sampleType:e.texture.sampleType,viewDimension:e.texture.viewDimension,multisampled:e.texture.multisampled}}}},$=e=>{if(e?.aborted)throw e.reason};function rt(e,t){return t?($(t),new Promise((n,r)=>{let i=()=>r(t.reason);t.addEventListener(`abort`,i,{once:!0}),e.then(n,r).finally(()=>t.removeEventListener(`abort`,i))})):e}var it=class{#e;#t;#n;#r;#i;#a;#o;constructor(t,n,r=!1){this.#e=new Set,this.#t=new Map,this.#n=new Set,this.#r=[],this.#i=!1,this.tuned={},this.device=t,this.ownsDevice=n,this.lost=t.lost,this.fastMath=r;let i=v(t,()=>e(()=>import(`./compat-YK57ZCbA-CpLc6vno.js`),[],import.meta.url));this.routeReady=(i??Promise.resolve(void 0)).then(e=>{this.sortRoute=e?.sortShader}),this.#a=i?y(this.routeReady):Promise.resolve()}get ready(){return this.#a}get disposed(){return this.#i}get backend(){return`webgpu`}get f16(){return this.device.features.has(`shader-f16`)}get subgroups(){return this.device.features.has(`subgroups`)}check(){if(this.#i)throw t(`disposed`,`ComputeContext disposed; create a new one with createCompute()`,`compute`)}#s(e){if(!i.includes(e))throw g(`dtype must be 'f32', 'f16', 'i32' or 'u32', got ${String(e)}`,`compute`);if(e===`f16`&&!this.f16)throw t(`unsupported`,`This GPU has no shader-f16 feature; use 'f32' arrays`,`compute`)}allocate(e,t,n){return this.device.createBuffer({size:e,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC|GPUBufferUsage.COPY_DST|t})}empty(e,t,n=0){this.check(),this.#s(t);let r=new f(this,t,e,void 0,n);return this.#e.add(r),r}array(e,t={}){let n=typeof t==`string`?{dtype:t}:t;if(typeof e!=`object`||!e||typeof e.length!=`number`)throw g(`gpu.array takes a TypedArray or an array of numbers; use gpu.zeros(shape) for an empty array`,`compute`);let r=e,i=n.dtype??c(r),o=n.shape??[r.length];if(m(o).reduce((e,t)=>e*t,1)!==r.length)throw a(`Shape [${o.join(`, `)}] does not hold ${r.length} elements`,`compute`);return this.empty(o,i).write(r)}indirectArgs(e=[0,1,1]){return this.empty([3],`u32`,GPUBufferUsage.INDIRECT).write(e)}drawable(e,t){return this.empty(typeof e==`number`?[e]:e,t??`f32`,GPUBufferUsage.VERTEX|GPUBufferUsage.INDIRECT)}zeros(e,t){return this.empty(typeof e==`number`?[e]:e,t??`f32`)}ones(e,t){return this.full(e,1,t)}full(e,t,n){let r=typeof e==`number`?[e]:e;return this.#c(r).astype(`f32`).mul(0).add(t).astype(n??`f32`).eval()}arange(e,t,n=1,r){if(t===void 0&&([e,t]=[0,e]),!Number.isFinite(e)||!Number.isFinite(t)||!Number.isFinite(n)||n===0)throw a(`arange needs finite start and stop and a non-zero step, got ${e}, ${t}, ${n}`,`compute`);let i=Math.max(0,Math.ceil((t-e)/n)),o=Number.isInteger(e)&&Number.isInteger(n),s=r??(o?e>=0&&n>0?`u32`:`i32`:`f32`),c=this.#c([i]);return(o&&s!==`f32`&&s!==`f16`?c.astype(`i32`).mul(n).add(e):c.astype(`f32`).mul(n).add(e)).astype(s).eval()}linspace(e,t,n=50){if(!Number.isInteger(n)||n<0)throw a(`linspace num must be a whole number, got ${n}`,`compute`);let r=n>1?(t-e)/(n-1):0;return this.#c([n]).astype(`f32`).mul(r).add(e).eval()}eye(e,t){let n=this.#c([e,e]);return n.floorDiv(e).eq(n.mod(e)).astype(t??`f32`).eval()}#c(e){return this.check(),new o(this,{kind:`index`,dtype:`u32`,shape:m(e)})}where(e,t,n){return p(e,t,n)}forget(e){this.#e.delete(e)}track(e){this.#e.add(e)}evaluate(e){this.check();let t=this.empty(e.shape,e.dtype),n=t.size;if(n===0)return t;let r=[],i=u(e,0,this.maxStorage(1),r),a=`${i.enables}${i.declarations}@group(0) @binding(${i.next}) var<storage, read_write> out: array<${i.dtype}>;
@group(0) @binding(${i.next+1}) var<uniform> size: vec4u;
${i.fn}
@compute @workgroup_size(256)
fn main(@builtin(workgroup_id) wid: vec3u, @builtin(num_workgroups) nwg: vec3u, @builtin(local_invocation_index) lid: u32) {
  let i = (wid.x + wid.y * nwg.x) * 256u + lid;
  if (i >= size.x) { return; }
  out[i] = value(i);
}`;this.submit([{program:this.program(a,void 0,`eval`),resources:{...i.resources,out:t,size:new Uint32Array([n,0,0,0])},workgroups:this.grid(Math.ceil(n/256))}]);for(let e of r)e.dispose();return t}maxStorage(e){return Math.max(1,this.device.limits.maxStorageBuffersPerShaderStage-e)}writeUnaligned(e,t,n){let r=t&-4,i=Math.ceil((t+n.length)/4)*4,a=new Uint8Array(i-r),o=(i-r)/4,s=new Uint32Array(o);a.set(n,t-r);for(let e=t-r;e<t-r+n.length;e++)s[e>>2]|=255<<(e&3)*8;let c=this.program(`@group(0) @binding(0) var<storage, read_write> dst: array<u32>;
@group(0) @binding(1) var<storage, read> src: array<u32>;
@group(0) @binding(2) var<storage, read> keep: array<u32>;
@group(0) @binding(3) var<uniform> at: vec4u;
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= at.y) { return; }
  let m = keep[id.x];
  dst[at.x + id.x] = (dst[at.x + id.x] & ~m) | (src[id.x] & m);
}`,void 0,`write`),l=this.empty([o],`u32`).write(new Uint32Array(a.buffer)),u=this.empty([o],`u32`).write(s);this.submit([{program:c,resources:{dst:e,src:l,keep:u,at:new Uint32Array([r/4,o,0,0])},workgroups:[Math.ceil(o/64),1,1]}]),l.dispose(),u.dispose()}kernel(e,t={}){if(this.check(),typeof e!=`string`)throw g(`gpu.kernel takes WGSL source text`,`compute`);return new Qe(this,this.program(e,t.entryPoint,t.label))}program(e,t,n){let r=`${t??``}\n${e}`,i=this.#t.get(r);if(i)return this.#t.delete(r),this.#t.set(r,i),i;let a=ne(e);if(!a.entryPoints.length)throw g(`Kernel WGSL has no @compute entry point`,`compute`);let o=t===void 0?a.entryPoints[0]:a.entryPoints.find(e=>e.name===t);if(!o||t===void 0&&a.entryPoints.length>1)throw g(`Kernel entry point ${t??`(none given)`} not found; pass entryPoint, one of ${a.entryPoints.map(e=>e.name).join(`, `)}`,`compute`);let s=Math.max(-1,...a.bindings.map(e=>e.group))+1,c=n??o.name,l=this.scoped(()=>{let t=Array.from({length:s},(e,t)=>this.device.createBindGroupLayout({entries:a.bindings.filter(e=>e.group===t).map(nt)}));return{pipeline:this.device.createComputePipeline({label:c,layout:this.device.createPipelineLayout({bindGroupLayouts:t}),compute:{module:this.device.createShaderModule({code:e,label:c}),entryPoint:o.name}}),layouts:t,info:a,entry:o,label:c}});return this.#t.set(r,l),this.#t.size>tt&&this.#t.delete(this.#t.keys().next().value),l}scoped(e){this.device.pushErrorScope(`validation`),this.device.pushErrorScope(`out-of-memory`),this.device.pushErrorScope(`internal`);try{return e()}finally{for(let e of[`internal error`,`out of memory`,`validation error`])this.#r.push({kind:e,error:this.device.popErrorScope()})}}bindGroups(e,t,n){let r=Object.keys(t).find(t=>!e.info.bindings.some(e=>e.name===t));if(r!==void 0)throw g(`Kernel has no binding named ${r}; its bindings are ${e.info.bindings.map(e=>e.name).join(`, `)}`,`compute`);return e.layouts.map((r,i)=>this.device.createBindGroup({layout:r,entries:e.info.bindings.filter(e=>e.group===i).map(e=>({binding:e.binding,resource:this.resource(e,t[e.name],n)}))}))}encode(e,t){let n=[],r=this.#o&&this.device.features.has(`timestamp-query`)&&t.length>0?this.device.createQuerySet({type:`timestamp`,count:t.length*2}):void 0;if(t.forEach((t,i)=>{let a=this.bindGroups(t.program,t.resources,n),o=e.beginComputePass(r?{timestampWrites:{querySet:r,beginningOfPassWriteIndex:2*i,endOfPassWriteIndex:2*i+1}}:{});o.setPipeline(t.program.pipeline),a.forEach((e,t)=>o.setBindGroup(t,e)),t.indirect?o.dispatchWorkgroupsIndirect(t.indirect.buffer,t.indirect.offset):o.dispatchWorkgroups(...t.workgroups),o.end()}),r){let i=t.length*16,a=this.device.createBuffer({size:i,usage:GPUBufferUsage.QUERY_RESOLVE|GPUBufferUsage.COPY_SRC}),o=this.device.createBuffer({size:i,usage:GPUBufferUsage.MAP_READ|GPUBufferUsage.COPY_DST});e.resolveQuerySet(r,0,t.length*2,a,0),e.copyBufferToBuffer(a,0,o,0,i),n.push(a),this.#n.add(o),this.#o.push({staging:o,queries:r,labels:t.map(e=>e.program.label)})}return n}submit(e,t=[]){this.check();let n=[];try{this.scoped(()=>{let r=this.device.createCommandEncoder();n=this.encode(r,e);for(let[e,n,i,a,o]of t)o&&r.copyBufferToBuffer(e,n,i,a,o);this.device.queue.submit([r.finish()])})}finally{for(let e of n)e.destroy()}}resource(e,t,n){if(t===void 0)throw g(`Kernel binding ${e.name} is missing; pass it in run()`,`compute`);if(t instanceof f){if(t.check(this),!t.offset)return{buffer:t.buffer};let n=t.offset*d(t.dtype),r=this.device.limits.minStorageBufferOffsetAlignment;if(n%r)throw a(`View ${e.name} starts at byte ${n}, not a multiple of ${r}; bind view.ascontiguous()`,`compute`);return{buffer:t.buffer,offset:n}}let r=typeof GPUBuffer<`u`&&t instanceof GPUBuffer;if(e.resource===`uniform`||e.resource===`storage`||e.resource===`read-only-storage`){if(r)return{buffer:t};if(typeof t==`object`&&t&&`buffer`in t&&!ArrayBuffer.isView(t)&&!Array.isArray(t))return t;if(e.resource===`storage`)throw g(`Kernel binding ${e.name} is read_write; pass a GpuArray or GPUBuffer to keep its results`,`compute`);let i=this.bytesFor(e,t),a=this.device.createBuffer({size:i.byteLength,usage:(e.resource===`uniform`?GPUBufferUsage.UNIFORM:GPUBufferUsage.STORAGE)|GPUBufferUsage.COPY_DST});return n.push(a),this.device.queue.writeBuffer(a,0,i),{buffer:a}}return e.resource===`sampler`?t:typeof GPUTexture<`u`&&t instanceof GPUTexture?t.createView({dimension:e.texture.viewDimension}):t}bytesFor(e,t){if(ArrayBuffer.isView(t)){let e=new Uint8Array(t.buffer,t.byteOffset,t.byteLength),n=new Uint8Array(Math.max(16,Math.ceil(e.length/16)*16));return n.set(e),n}if(!e.layout)throw g(`Kernel binding ${e.name} has a type (${e.type}) the kernel cannot lay out; pass bytes`,`compute`);return ie(e.layout,t,e.name)}grid(e){let t=this.device.limits.maxComputeWorkgroupsPerDimension;if(e<=t)return[Math.max(1,e),1,1];let n=Math.ceil(e/t);if(n>t)throw a(`Compute array too large: ${e} workgroups exceed ${t} x ${t}`,`compute`);return[Math.ceil(e/n),n,1]}async readBytes(e,n,r,i){if(this.check(),$(i),r===0)return await this.#l(),new ArrayBuffer(0);let a=n&-4,o=Math.ceil((n+r)/4)*4,s=this.device.createBuffer({size:o-a,usage:GPUBufferUsage.MAP_READ|GPUBufferUsage.COPY_DST});this.#n.add(s);let c=()=>s.destroy();i?.addEventListener(`abort`,c,{once:!0});try{let t=this.device.createCommandEncoder();return t.copyBufferToBuffer(e,a,s,0,o-a),this.device.queue.submit([t.finish()]),await this.#l(),await s.mapAsync(GPUMapMode.READ),s.getMappedRange().slice(n-a,n-a+r)}catch(e){throw this.#i?t(`disposed`,`ComputeContext disposed during a read; keep it alive until reads finish`,`compute`):($(i),e)}finally{i?.removeEventListener(`abort`,c),this.#n.delete(s),s.destroy()}}async#l(){this.device.pushErrorScope(`validation`);let e=[...this.#r,{kind:`validation error`,error:this.device.popErrorScope()}];this.#r=[];let n=await Promise.all(e.map(e=>e.error)),r=n.findIndex(e=>e);if(r>=0)throw t(`failed`,`GPU ${e[r].kind}: ${n[r].message.trim()}; fix the kernel WGSL or its bindings (or use smaller arrays)`,`compute`)}async done(e={}){this.check(),$(e.signal),await this.#l(),await rt(this.device.queue.onSubmittedWorkDone(),e.signal)}async profile(e,n={}){if(this.check(),this.#o)throw t(`state`,`profile() is already running; await it before profiling again`,`compute`);this.#o=[];let r=[];try{try{await e()}finally{r=this.#o,this.#o=void 0}return await this.#l(),(await rt(Promise.all(r.map(async({staging:e,labels:t})=>{await e.mapAsync(GPUMapMode.READ);let n=new BigUint64Array(e.getMappedRange().slice(0));return t.map((e,t)=>({label:e,ms:Number(n[2*t+1]-n[2*t])/1e6}))})),n.signal)).flat()}finally{for(let{staging:e,queries:t}of r)this.#n.delete(e),e.destroy(),t.destroy()}}map(e,t,r={}){this.check();let i=e instanceof n?{x:e}:e,o=Object.keys(i);if(!o.length)throw g(`gpu.map needs at least one input array`,`compute`);for(let e of o)if(!/^[A-Za-z_][A-Za-z0-9_]*$/.test(e)||[`i`,`n`,`f`,`main`,`out`,`params`].includes(e)||e.startsWith(`in_`))throw g(`gpu.map input name ${e} is not a usable WGSL name; rename it`,`compute`);if(typeof t!=`string`||!t.trim())throw g(`gpu.map needs a WGSL expression`,`compute`);let s=o.map(e=>{let t=i[e];if(!(t instanceof n))throw g(`gpu.map input ${e} must be a GpuArray or an Expr`,`compute`);return t instanceof f&&t.contiguous&&t.offset===0?t:t.eval()}),c=s[0].shape,l=s[0].size;if(s.some(e=>e.shape.length!==c.length||e.shape.some((e,t)=>e!==c[t])))throw a(`gpu.map inputs must share one shape, got ${s.map(e=>`[${e.shape.join(`, `)}]`).join(`, `)}`,`compute`);let u=r.dtype??s[0].dtype,d=this.empty(c,u);if(l>0){let e=le(o.map((e,t)=>({name:e,type:s[t].dtype})),u,t),n={out:d,params:new Uint32Array([l,2139095040,0,0])};o.forEach((e,t)=>n[`in_${e}`]=s[t]),this.submit([{program:this.program(e,void 0,r.label??`map`),resources:n,workgroups:this.grid(Math.ceil(l/256))}])}return o.forEach((e,t)=>s[t]!==i[e]&&s[t].dispose()),d}reduce(e,t=`sum`,n={}){return H(this,e,t,n)}sum(e,t){return H(this,e,`sum`,t)}prod(e,t){return H(this,e,`product`,t)}min(e,t){return H(this,e,`min`,t)}max(e,t){return H(this,e,`max`,t)}mean(e,t){return Te(this,e,t)}var(e,t){return De(this,e,t)}std(e,t){return Oe(this,e,t)}argmin(e,t){return je(this,e,`min`,t)}argmax(e,t){return je(this,e,`max`,t)}all(e,t){return H(this,e.ne(0),`min`,t)}any(e,t){return H(this,e.ne(0),`max`,t)}countNonzero(e,t){return H(this,e.ne(0),`sum`,t)}nansum(e,t){return H(this,p(e.isnan(),0,e),`sum`,t)}nanmin(e,t){return H(this,p(e.isnan(),1/0,e),`min`,t)}nanmax(e,t){return H(this,p(e.isnan(),-1/0,e),`max`,t)}nanmean(e,t){return ke(this,e,t)}scan(e,t={}){return Y(this,e,t)}cumsum(e,t={}){return Y(this,e,t)}cumprod(e,t={}){return Y(this,e,{...t,op:`product`})}segmentedScan(e,t,n={}){return He(this,e,t,n)}reduceByKey(e,t,n={}){return Ue(this,e,t,n)}sort(e,t={}){return Q(this,e,t)}argsort(e,t={}){return We(this,e,t)}sortByKey(e,t,n={}){return Ge(this,e,t,n)}topk(e,t,n={}){return Ke(this,e,t,n)}quantile(e,t){return qe(this,e,t)}median(e){return qe(this,e,.5)}unique(e,t={}){return Je(this,e,t)}take(e,t,n={}){return Ne(this,e,t,n)}scatter(e,t,n,r={}){return Fe(this,e,t,n,r)}bincount(e,t){return Ie(this,e,t)}compact(e,t){return Le(this,e,t)}filter(e,t,n={}){return Re(this,e,t,n)}nonzero(e,t={}){return ze(this,e,t)}histogram(e,t={}){return Xe(this,e,t)}dispose(){if(!this.#i){this.#i=!0;for(let e of[...this.#e])e.dispose();for(let e of this.#n)e.destroy();this.#t.clear(),this.ownsDevice&&this.device.destroy()}}[Symbol.dispose](){this.dispose()}},at=async t=>{let{cpuContext:n}=await e(async()=>{let{cpuContext:e}=await import(`./cpu-load-DZsQ-qON-zbLqq3bO.js`);return{cpuContext:e}},__vite__mapDeps([0,1]),import.meta.url);return $(t),n()};async function ot(e){return await e.routeReady,e}async function st(e={}){$(e.signal);let n=e.backend??`auto`;if(n!==`auto`&&n!==`webgpu`&&n!==`cpu`)throw g(`createCompute backend must be 'auto', 'webgpu' or 'cpu', got ${String(n)}`,`compute`);if(e.fastMath!==void 0&&typeof e.fastMath!=`boolean`)throw g(`createCompute fastMath must be true or false, got ${String(e.fastMath)}`,`compute`);let r=e.tuned??{};et(r,1024);let i=e.fastMath===!0,a=(e,t)=>{try{et(r,e.limits.maxComputeInvocationsPerWorkgroup)}catch(n){throw t&&e.destroy(),n}let n=new it(e,t,i);return n.tuned=r,n};if(e.device)return ot(a(e.device,!1));if(e.engine){let n=e.engine.gpu;if(!n)throw t(`unsupported`,`Engine has no WebGPU device (WebGL2 fallback); create the context without an engine`,`compute`);return ot(a(n,!1))}if(n===`cpu`)return at(e.signal);let o=globalThis.navigator,s=o?.gpu;if(!s){if(n===`auto`)return at(e.signal);throw t(`unsupported`,`WebGPU unavailable; use a runtime with WebGPU, or backend: 'cpu'`,`compute`)}let c=e.powerPreference??(/Win/.test(o?.userAgent??``)?void 0:`high-performance`),l=await rt(s.requestAdapter(c?{powerPreference:c}:{}),e.signal);if(!l){if(n===`auto`)return at(e.signal);throw t(`unsupported`,`WebGPU adapter unavailable; check that the GPU is enabled, or use backend: 'cpu'`,`compute`)}let u=await l.requestDevice({requiredFeatures:[`shader-f16`,`timestamp-query`,`subgroups`].filter(e=>l.features.has(e)),requiredLimits:{maxStorageBufferBindingSize:l.limits.maxStorageBufferBindingSize,maxBufferSize:l.limits.maxBufferSize,maxStorageBuffersPerShaderStage:l.limits.maxStorageBuffersPerShaderStage,maxComputeWorkgroupStorageSize:l.limits.maxComputeWorkgroupStorageSize,maxComputeInvocationsPerWorkgroup:l.limits.maxComputeInvocationsPerWorkgroup,maxComputeWorkgroupSizeX:l.limits.maxComputeWorkgroupSizeX,maxComputeWorkgroupSizeY:l.limits.maxComputeWorkgroupSizeY,maxComputeWorkgroupSizeZ:l.limits.maxComputeWorkgroupSizeZ}});if(e.signal?.aborted)throw u.destroy(),e.signal.reason;return ot(a(u,!0))}export{st as createCompute,it as n,$ as t};