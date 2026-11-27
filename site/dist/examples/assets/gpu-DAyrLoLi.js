import{t as e}from"./errors-DkwPZuAq.js";import{t}from"./build-Yg6lEtrZ.js";var n=64,r=t=>{let n=t?.gpu??t;if(!n||typeof n.createBuffer!=`function`)throw new e(`unsupported`,`GPU BVH needs WebGPU; pass a GPUDevice or an Engine running on WebGPU.`);return n};function i(e){let n=e.nodeCount,r=new ArrayBuffer(n*8*4),i=new Float32Array(r),a=new Uint32Array(r),o=new Uint8Array(n),s=e.nodeBounds,c=e.nodeData;for(let e=0;e<n;e++){let n=e*8,r=c[n+6],l=c[n+7];if(i[n]=s[n],i[n+1]=s[n+1],i[n+2]=s[n+2],i[n+4]=s[n+3],i[n+5]=s[n+4],i[n+6]=s[n+5],l&2147483648){if(o[e]>=64)throw RangeError(`BVH is deeper than 64; rebuild it with a maxDepth of at most 64.`);o[e+1]=o[r]=o[e]+1,a[n+3]=e+1,a[n+7]=(r|t)>>>0}else a[n+3]=r,a[n+7]=l}return r}function a(e){let{positions:t,stride:n}=e,r=Math.floor((t.length-3)/n)+1,i=new Float32Array(r*3);for(let e=0;e<r;e++)i[e*3]=t[e*n],i[e*3+1]=t[e*n+1],i[e*3+2]=t[e*n+2];return i}var o=(e,t)=>`
struct ${t}Ray { origin: vec3f, direction: vec3f, inverse: vec3f, shear: vec3f, axes: vec3u, near: f32, far: f32 }
fn ${e}Inverse(d: f32) -> f32 {

  let m = max(abs(d), 1e-18);
  return select(1.0 / m, -1.0 / m, d < 0.0);
}



fn ${e}Edge(p: vec2f, q: vec2f) -> f32 {
  let swap = q.x < p.x || (q.x == p.x && q.y < p.y);
  let s = select(p, q, swap);
  let e = select(q, p, swap);
  let value = s.x * e.y - s.y * e.x;
  return select(value, -value, swap);
}

fn ${e}Triangle(r: ${t}Ray, a3: vec3f, b3: vec3f, c3: vec3f, side: u32, far: f32) -> vec4f {
  let a = a3 - r.origin;
  let b = b3 - r.origin;
  let c = c3 - r.origin;
  let az = a[r.axes.z];
  let bz = b[r.axes.z];
  let cz = c[r.axes.z];
  let ax = a[r.axes.x] - r.shear.x * az;
  let ay = a[r.axes.y] - r.shear.y * az;
  let bx = b[r.axes.x] - r.shear.x * bz;
  let by = b[r.axes.y] - r.shear.y * bz;
  let cx = c[r.axes.x] - r.shear.x * cz;
  let cy = c[r.axes.y] - r.shear.y * cz;
  let u = ${e}Edge(vec2f(cx, cy), vec2f(bx, by));
  let v = ${e}Edge(vec2f(ax, ay), vec2f(cx, cy));
  let w = ${e}Edge(vec2f(bx, by), vec2f(ax, ay));
  let det = u + v + w;
  let positive = u >= 0.0 && v >= 0.0 && w >= 0.0;
  let negative = u <= 0.0 && v <= 0.0 && w <= 0.0;
  if (det == 0.0 || !(positive || negative)) { return vec4f(0.0, 0.0, 0.0, -1.0); }
  if ((side == 1u && det < 0.0) || (side == 2u && det > 0.0)) { return vec4f(0.0, 0.0, 0.0, -1.0); }
  let t = (u * az + v * bz + w * cz) * r.shear.z / det;
  if (t < r.near || t > far) { return vec4f(0.0, 0.0, 0.0, -1.0); }
  return vec4f(u / det, v / det, w / det, t);
}
`,s=8,c=4,l=3e38,u=64,d=64,f={double:0,front:1,back:2};function p({group:e=0,binding:t=0,accept:n}={}){if(n!==void 0&&!/^[A-Za-z][A-Za-z0-9_]*$/.test(n))throw TypeError(`Invalid BVH candidate function; pass a WGSL identifier`);let r=n=>`@group(${e}) @binding(${t+n})`;return`
struct BVHNode { lo: vec3f, left: u32, hi: vec3f, right: u32 }
struct BVHParams { stride: u32, offset: u32, triangles: u32, nodes: u32 }
struct BVHHit { distance: f32, face: u32, barycoord: vec3f, front: bool }
${r(0)} var<storage, read> bvhNodes: array<BVHNode>;
${r(1)} var<storage, read> bvhIndex: array<u32>;
${r(2)} var<storage, read> bvhFaces: array<u32>;
${r(3)} var<storage, read> bvhPositions: array<f32>;
${r(4)} var<uniform> bvhParams: BVHParams;
const BVH_MISS = 0xffffffffu;
const BVH_INTERNAL = 0x80000000u;
const BVH_NEVER = 3.4e38;

fn bvhVertex(i: u32) -> vec3f {
  let o = i * bvhParams.stride + bvhParams.offset;
  return vec3f(bvhPositions[o], bvhPositions[o + 1u], bvhPositions[o + 2u]);
}
fn bvhRay(origin: vec3f, direction: vec3f, near: f32, far: f32) -> BVHRay {
  let d = normalize(direction);
  let a = abs(d);
  var z = 2u;
  if (a.x >= a.y && a.x >= a.z) { z = 0u; } else if (a.y >= a.z) { z = 1u; }
  var x = (z + 1u) % 3u;
  var y = (x + 1u) % 3u;
  if (d[z] < 0.0) { let swap = x; x = y; y = swap; }
  let shear = vec3f(d[x] / d[z], d[y] / d[z], 1.0 / d[z]);
  return BVHRay(origin, d, vec3f(bvhInverse(d.x), bvhInverse(d.y), bvhInverse(d.z)), shear, vec3u(x, y, z), near, far);
}

fn bvhEnter(node: u32, r: BVHRay, far: f32) -> f32 {
  let n = bvhNodes[node];
  let a = (n.lo - r.origin) * r.inverse;
  let b = (n.hi - r.origin) * r.inverse;
  let near3 = min(a, b);
  let far3 = max(a, b);
  let enter = max(max(near3.x, near3.y), max(near3.z, r.near));
  let leave = min(min(far3.x, far3.y), far3.z) * 1.0000004;
  return select(BVH_NEVER, enter, enter <= leave && enter <= far);
}
${o(`bvh`,`BVH`)}fn bvhWalk(r: BVHRay, side: u32, any: bool) -> BVHHit {
  var best = BVHHit(r.far, BVH_MISS, vec3f(0.0), false);
  var stack: array<u32, 64>;
  var entry: array<f32, 64>;
  var top = 0u;
  var node = 0u;
  if (bvhEnter(0u, r, r.far) >= BVH_NEVER) { return best; }
  loop {
    let n = bvhNodes[node];
    var next = false;
    if ((n.right & BVH_INTERNAL) != 0u) {
      let left = n.left;
      let right = n.right & ~BVH_INTERNAL;
      let tl = bvhEnter(left, r, best.distance);
      let tr = bvhEnter(right, r, best.distance);
      if (tl < BVH_NEVER && tr < BVH_NEVER) {

        stack[top] = select(right, left, tr < tl);
        entry[top] = max(tl, tr);
        top += 1u;
        node = select(left, right, tr < tl);
        next = true;
      } else if (tl < BVH_NEVER) {
        node = left;
        next = true;
      } else if (tr < BVH_NEVER) {
        node = right;
        next = true;
      }
    } else {
      for (var k = 0u; k < n.right; k += 1u) {
        let at = n.left + k;
        let i = at * 3u;
        let a = bvhVertex(bvhIndex[i]);
        let b = bvhVertex(bvhIndex[i + 1u]);
        let c = bvhVertex(bvhIndex[i + 2u]);
        let hit = bvhTriangle(r, a, b, c, side, best.distance);
        if (hit.w < 0.0) { continue; }
        let face = bvhFaces[at];
        ${n?`if (!${n}(face, hit.xyz)) { continue; }`:``}

        if (hit.w < best.distance || best.face == BVH_MISS || face < best.face) {
          best = BVHHit(hit.w, face, hit.xyz, dot(cross(b - a, c - a), r.direction) < 0.0);
          if (any) { return best; }
        }
      }
    }
    if (next) { continue; }

    var found = false;
    while (top > 0u && !found) {
      top -= 1u;
      if (entry[top] <= best.distance) {
        node = stack[top];
        found = true;
      }
    }
    if (!found) { break; }
  }
  return best;
}
fn bvhClosest(origin: vec3f, direction: vec3f, near: f32, far: f32, side: u32) -> BVHHit {
  if (dot(direction, direction) == 0.0) { return BVHHit(far, BVH_MISS, vec3f(0.0), false); }
  return bvhWalk(bvhRay(origin, direction, near, far), side, false);
}
fn bvhAny(origin: vec3f, direction: vec3f, near: f32, far: f32, side: u32) -> BVHHit {
  if (dot(direction, direction) == 0.0) { return BVHHit(far, BVH_MISS, vec3f(0.0), false); }
  return bvhWalk(bvhRay(origin, direction, near, far), side, true);
}
`}var m=`${p()}
struct TraceRay { origin: vec3f, near: f32, direction: vec3f, far: f32 }
struct Trace { count: u32, side: u32, any: u32, width: u32 }
@group(1) @binding(0) var<storage, read> rays: array<TraceRay>;
@group(1) @binding(1) var<storage, read_write> hits: array<vec4u>;
@group(1) @binding(2) var<uniform> trace: Trace;
@compute @workgroup_size(${u})
fn main(@builtin(global_invocation_id) id: vec3u) {
  let i = id.y * trace.width + id.x;
  if (i >= trace.count) { return; }
  let ray = rays[i];
  var hit: BVHHit;
  if (trace.any != 0u) {
    hit = bvhAny(ray.origin, ray.direction, ray.near, ray.far, trace.side);
  } else {
    hit = bvhClosest(ray.origin, ray.direction, ray.near, ray.far, trace.side);
  }
  if (hit.face == BVH_MISS) {
    hits[i] = vec4u(bitcast<u32>(-1.0), BVH_MISS, 0u, 0u);
    return;
  }
  let front = select(0u, BVH_INTERNAL, hit.front);
  hits[i] = vec4u(bitcast<u32>(hit.distance), hit.face | front, bitcast<u32>(hit.barycoord.y), bitcast<u32>(hit.barycoord.z));
}
`,h=new WeakMap;function g(e){let t=h.get(e);return t||(t=e.createComputePipelineAsync({label:`bvh trace`,layout:`auto`,compute:{module:e.createShaderModule({label:`bvh trace`,code:m}),entryPoint:`main`}}),h.set(e,t),t.catch(()=>h.delete(e))),t}function _(e,{near:t=0,far:n=1/0}={}){if(!(t>=0)||!(n>=t))throw RangeError(`Invalid near or far; pass 0 <= near <= far.`);let r=new Float32Array(e.length*8),i=Math.min(n,l);return e.forEach(({origin:e,direction:n},a)=>{let o=a*8;for(let t=0;t<3;t++)r[o+t]=e[t],r[o+4+t]=n[t];r[o+3]=t,r[o+7]=i}),r}var v=class t{#e;#t;#n;#r=new Map;#i=!1;static async create(e,n){let i=r(e);return new t(i,n,await g(i))}static forShader(e,n){return new t(r(e),n,null)}static async follow(e,n){let i=r(e);return new t(i,n.bvh,await g(i),n)}constructor(e,t,n,r=null){this.device=e,this.bvh=t,this.#e=!!r,this.#t=n;let o=t&&i(t),s=r?null:a(t),c=r?.triangles??t.triangleCount,l=r?.nodes??t.nodeCount,u=Math.min(e.limits.maxStorageBufferBindingSize,e.limits.maxBufferSize);for(let[e,t]of[[`nodes`,l*8*4],[`positions`,s?.byteLength??r.vertices.size],[`indices`,c*12]])if(t>u)throw RangeError(`BVH ${e} take ${t} bytes, over this device's ${u}; request a higher maxStorageBufferBindingSize or split the mesh.`);let d=(t,n,r,i)=>{let a=e.createBuffer({label:t,size:r,usage:i|GPUBufferUsage.COPY_DST});return n&&e.queue.writeBuffer(a,0,n),a},f=GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC;this.nodes=d(`bvh nodes`,o,l*8*4,f),this.index=d(`bvh index`,t?.index??null,c*12,f),this.faces=d(`bvh faces`,t?.triangles??null,c*4,f),this.positions=r?.vertices??d(`bvh positions`,s,s.byteLength,f),this.params=d(`bvh params`,new Uint32Array([r?.stride??3,r?.offset??0,c,l]),16,GPUBufferUsage.UNIFORM),this.#n=n&&e.createBindGroup({label:`bvh tree`,layout:n.getBindGroupLayout(0),entries:this.bindings()})}get disposed(){return this.#i}bindings(e=0){return[this.nodes,this.index,this.faces,this.positions,this.params].map((t,n)=>({binding:e+n,resource:{buffer:t}}))}update(){if(this.#o(),this.#e||!this.bvh)throw new e(`state`,`This tree follows a GPU buffer; update it with encode on its GPUDynamicBVH.`);this.device.queue.writeBuffer(this.nodes,0,i(this.bvh)),this.device.queue.writeBuffer(this.positions,0,a(this.bvh))}encodeTrace(t,n,r,i,{mode:a=`closest`,side:o=`double`}={}){if(this.#o(),!Number.isInteger(i)||i<0)throw RangeError(`Invalid ray count; pass a non-negative integer.`);if(a!==`closest`&&a!==`any`)throw TypeError(`Invalid trace mode; use closest or any.`);if(!Object.hasOwn(f,o))throw TypeError(`Invalid side; use front, back or double.`);if(!i)return;if(n.size<i*8*4||r.size<i*4*4)throw RangeError(`Ray or hit buffer is too small for ${i} rays; size them with GPU_RAY_FLOATS and GPU_HIT_WORDS.`);let s=Math.ceil(i/u),c=this.device.limits.maxComputeWorkgroupsPerDimension,l=Math.min(s,c),d=Math.ceil(s/l);if(d>c)throw RangeError(`${i} rays are more than one dispatch holds; trace them in parts.`);let p=this.#t;if(!p)throw new e(`state`,`This tree is for your own shader; make one with GPUMeshBVH.create to trace rays.`);let m=t.beginComputePass({label:`bvh trace`});m.setPipeline(p),m.setBindGroup(0,this.#n),m.setBindGroup(1,this.device.createBindGroup({label:`bvh rays`,layout:p.getBindGroupLayout(1),entries:[{binding:0,resource:{buffer:n}},{binding:1,resource:{buffer:r}},{binding:2,resource:{buffer:this.#a(i,f[o],+(a===`any`),l*u)}}]})),m.dispatchWorkgroups(l,d),m.end()}async raycast(e,t={}){this.#o();let{signal:n}=t;n?.throwIfAborted();let r=e instanceof Float32Array?e:_(e,t);if(r.length%8)throw RangeError(`Incomplete ray buffer; pass whole rays of GPU_RAY_FLOATS floats.`);let i=r.length/8,a=this.device;for(let e=0;e<r.length;e++)if(!Number.isFinite(r[e]))throw RangeError(`Ray ${Math.floor(e/8)} is not finite; far must be at most GPU_FAR.`);let o={count:i,distance:new Float32Array(i),faceIndex:new Int32Array(i),barycoord:new Float32Array(i*3),frontFace:new Uint8Array(i)};if(!i)return o;let s=a.limits.maxStorageBufferBindingSize;if(r.byteLength>s)throw RangeError(`${i} rays take ${r.byteLength} bytes, over this device's ${s}; trace them in parts.`);let c=i*4*4,l=a.createBuffer({label:`bvh rays`,size:r.byteLength,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST}),u=a.createBuffer({label:`bvh hits`,size:c,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC}),d=a.createBuffer({label:`bvh read`,size:c,usage:GPUBufferUsage.MAP_READ|GPUBufferUsage.COPY_DST});try{a.queue.writeBuffer(l,0,r);let e=a.createCommandEncoder({label:`bvh raycast`});this.encodeTrace(e,l,u,i,t),e.copyBufferToBuffer(u,0,d,0,c),a.queue.submit([e.finish()]),await d.mapAsync(GPUMapMode.READ),n?.throwIfAborted();let s=d.getMappedRange(),f=new Float32Array(s),p=new Uint32Array(s);for(let e=0;e<i;e++){let t=e*4,n=p[t+1];if(n===4294967295){o.distance[e]=1/0,o.faceIndex[e]=-1;continue}let r=f[t+2],i=f[t+3];o.distance[e]=f[t],o.faceIndex[e]=n&2147483647,o.frontFace[e]=n>>>31,o.barycoord[e*3]=1-r-i,o.barycoord[e*3+1]=r,o.barycoord[e*3+2]=i}return o}finally{l.destroy(),u.destroy(),d.destroy()}}dispose(){if(!this.#i){this.#i=!0;for(let e of[this.nodes,this.index,this.faces,this.params])e.destroy();this.#e||this.positions.destroy();for(let e of this.#r.values())e.destroy();this.#r.clear()}}[Symbol.dispose](){this.dispose()}#a(e,t,n,r){let i=`${e},${t},${n},${r}`,a=this.#r.get(i);return a||(this.#r.size>=d&&this.#r.delete(this.#r.keys().next().value),a=this.device.createBuffer({label:`bvh trace`,size:16,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST}),this.device.queue.writeBuffer(a,0,new Uint32Array([e,t,n,r])),this.#r.set(i,a)),a}#o(){if(this.#i)throw new e(`disposed`,`GPUMeshBVH is disposed; create a new one to trace rays.`)}};export{v as GPUMeshBVH,l as GPU_FAR,c as GPU_HIT_WORDS,n as GPU_MAX_DEPTH,s as GPU_RAY_FLOATS,p as bvhWGSL,_ as packRays};