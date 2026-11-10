// Clean room from Hernell et al. (2010), Schott et al. (2009), Kroes et al. (2012).
// Integrate extinction in scene units; the data texture stays in unit-box coordinates.
export const cinematicShader = /* wgsl */ `
struct Lighting {
  inverse: mat4x4f, toBox: mat4x4f, model: mat4x4f,
  dims: vec4f, classification: vec4f, spacing: vec4f,
  march: vec4f, ao: vec4f, light: vec4f, transport: vec4f,
  ambient: vec4f, direct: vec4f, viewport: vec4f, planes: array<vec4f,4>
}
@group(0) @binding(0) var<uniform> u: Lighting;
@group(0) @binding(1) var data: texture_3d<f32>;
@group(0) @binding(2) var transfer: texture_2d<f32>;
@group(0) @binding(3) var linearSampler: sampler;
@group(0) @binding(4) var previous: texture_2d<f32>;
@group(0) @binding(5) var opaqueDepth:texture_2d<f32>;
@group(0) @binding(6) var history:texture_2d<f32>;
var<private> primaryLimit:f32;
struct Out { @builtin(position) position: vec4f, @location(0) ndc: vec2f }
@vertex fn vertex(@builtin(vertex_index) i: u32) -> Out {
  let p = array<vec2f,3>(vec2f(-1.0,-1.0),vec2f(3.0,-1.0),vec2f(-1.0,3.0));
  var o: Out; o.position = vec4f(p[i],0.0,1.0); o.ndc=p[i]; return o;
}
var<private> rng: u32;
var<private> cost: vec4u;
fn random() -> f32 {
  rng = rng * 1664525u + 1013904223u;
  var h = rng; h = (h ^ (h >> 16u)) * 2246822519u; h = (h ^ (h >> 13u)) * 3266489917u;
  return (f32((h ^ (h >> 16u)) >> 8u) + 0.5) / 16777216.0;
}
fn boxDirection(d: vec3f) -> vec3f { return (u.toBox * vec4f(d,0.0)).xyz; }
fn interval(p: vec3f, d: vec3f) -> vec2f {
  // Signed epsilon avoids 0 * infinity at a box face, including parallel rays.
  let safe = select(vec3f(-1e-20),vec3f(1e-20),d >= vec3f(0.0));
  let inv = 1.0 / select(d,safe,abs(d) < vec3f(1e-20));
  let a = -p * inv; let b = (1.0-p) * inv;
  let lo = min(a,b); let hi = max(a,b);
  return vec2f(max(max(max(lo.x,lo.y),lo.z),0.0),min(min(hi.x,hi.y),hi.z));
}
fn scalar(p: vec3f) -> f32 { cost.x+=1u; return textureSampleLevel(data,linearSampler,p,0.0).r; }
fn gradient(p: vec3f) -> vec3f {
  let h=1.0/u.dims.xyz;
  let a=clamp(p-h,0.5*h,1.0-0.5*h); let b=clamp(p+h,0.5*h,1.0-0.5*h);
  return vec3f(scalar(vec3f(b.x,p.y,p.z))-scalar(vec3f(a.x,p.y,p.z)),
    scalar(vec3f(p.x,b.y,p.z))-scalar(vec3f(p.x,a.y,p.z)),
    scalar(vec3f(p.x,p.y,b.z))-scalar(vec3f(p.x,p.y,a.z))) / max((b-a)*u.dims.xyz,vec3f(1.0)) / u.spacing.xyz;
}
fn classify(p: vec3f) -> vec4f {
  if (any(p < vec3f(0.0)) || any(p > vec3f(1.0))) { return vec4f(0.0); }
  for (var k=0u;k<u32(u.dims.w);k++) {
    if (dot(u.planes[k].xyz,p)+u.planes[k].w < 0.0) { return vec4f(0.0); }
  }
  let v=scalar(p); var y=0.5;
  if (u.classification.x == 1.0) { y=length(gradient(p))*u.classification.y; }
  if (u.classification.x == 2.0) { y=v; }
  let n=vec2f(textureDimensions(transfer));
  let uv=select(vec2f(v,y),(vec2f(v,y)*(n-1.0)+0.5)/n,u.classification.x>0.5);
  return textureSampleLevel(transfer,linearSampler,uv,0.0);
}
fn extinction(c: vec4f) -> f32 {
  if (u.classification.x == 2.0) {
    return -log(max(1.0-c.a,1e-6))*u.march.y/u.classification.z/u.classification.w/u.march.z;
  }
  return -log(max(1.0-clamp(c.a,0.0,0.9999),1e-6))*u.march.y/u.march.z;
}
fn transmittance(p: vec3f, direction: vec3f, distance: f32, steps: u32) -> f32 {
  let d=boxDirection(direction); let hit=interval(p,d);
  let end=min(distance,hit.y); if (end<=0.0) { return 1.0; }
  let ds=end/f32(steps); var tau=0.0;
  for (var i=0u;i<steps;i++) { tau+=extinction(classify(p+d*((f32(i)+0.5)*ds)))*ds; }
  return exp(-tau);
}
fn sphere(z: f32, angle: f32) -> vec3f {
  let r=sqrt(max(0.0,1.0-z*z)); return vec3f(r*cos(angle),r*sin(angle),z);
}
fn ambientVisibility(p: vec3f) -> f32 {
  if (u.ao.x<0.5) { return 1.0; }
  var sum=0.0; let n=u32(u.ao.x);
  for (var k=0u;k<n;k++) {
    let d=sphere(1.0-2.0*(f32(k)+0.5)/f32(n),f32(k)*2.39996323);
    cost.z+=1u; sum+=transmittance(p,d,u.ao.y*u.march.z,u32(u.ao.z));
  }
  return sum/f32(n);
}
fn shadow(p: vec3f) -> f32 {
  if (u.light.w<0.5) { return 1.0; }
  cost.y+=1u; return transmittance(p,u.light.xyz,1e20,u32(u.light.w));
}
fn phase(cosine: f32) -> f32 {
  let g=u.transport.y;
  return (1.0-g*g)/pow(max(1.0+g*g-2.0*g*cosine,1e-6),1.5);
}
fn scatter(direction: vec3f) -> vec3f {
  let g=u.transport.y; let x=random(); var z=2.0*x-1.0;
  if (abs(g)>1e-4) { let s=(1.0-g*g)/(1.0-g+2.0*g*x); z=(1.0+g*g-s*s)/(2.0*g); }
  let local=sphere(clamp(z,-1.0,1.0),6.283185307*random());
  let axis=select(vec3f(0.0,0.0,1.0),vec3f(0.0,1.0,0.0),abs(direction.z)>0.99);
  let xaxis=normalize(cross(axis,direction));
  return xaxis*local.x+cross(direction,xaxis)*local.y+direction*local.z;
}
fn march(origin: vec3f, direction: vec3f) -> vec4f {
  let d=boxDirection(direction); var hit=interval(origin,d);hit.y=min(hit.y,primaryLimit);
  if (hit.y<=hit.x) { return vec4f(0.0); }
  let n=min(2048u,u32(ceil((hit.y-hit.x)/u.march.z*u.march.x)));
  let ds=(hit.y-hit.x)/f32(max(1u,n));
  var out=vec4f(0.0);
  for (var k=0u;k<n;k++) {
    let p=origin+d*(hit.x+(f32(k)+0.5)*ds); let c=classify(p);
    let a=1.0-exp(-extinction(c)*ds);
    let lighting=u.ambient.rgb*ambientVisibility(p)+u.direct.rgb*shadow(p);
    out+=vec4f(c.rgb*lighting*a,a)*(1.0-out.a);
    if (out.a>0.9999) { break; }
  }
  return out;
}
fn trace(origin: vec3f, direction: vec3f) -> vec4f {
  var p=origin; var d=direction; var throughput=vec3f(1.0); var radiance=vec3f(0.0); var alpha=0.0;
  for (var bounce=0u;bounce<u32(u.transport.z);bounce++) {
    let bd=boxDirection(d); var hit=interval(p,bd);if(bounce==0u){hit.y=min(hit.y,primaryLimit);}
    if (hit.y<=hit.x) { if (bounce>0u) { radiance+=throughput*u.ambient.rgb; } break; }
    let n=min(2048u,u32(ceil((hit.y-hit.x)/u.march.z*u.march.x)));
    let ds=(hit.y-hit.x)/f32(max(n,1u)); let threshold=-log(random()); var tau=0.0;
    var collision=false; var c=vec4f(0.0); var distance=hit.y;
    for (var k=0u;k<n;k++) {
      c=classify(p+bd*(hit.x+(f32(k)+0.5)*ds)); let sigma=extinction(c);
      if (tau+sigma*ds>=threshold && sigma>0.0) {
        distance=hit.x+f32(k)*ds+(threshold-tau)/sigma; collision=true; break;
      }
      tau+=sigma*ds;
    }
    if (!collision) { if (bounce>0u) { radiance+=throughput*u.ambient.rgb; } break; }
    cost.w+=1u; p+=bd*distance; alpha=1.0; throughput*=c.rgb*u.transport.w;
    radiance+=throughput*u.direct.rgb*phase(dot(d,u.light.xyz))*shadow(p);
    d=scatter(d);
    // Russian roulette preserves energy and bounds low-throughput paths.
    if (bounce>=2u) {
      let survive=clamp(max(max(throughput.x,throughput.y),throughput.z),0.05,0.95);
      if (random()>survive) { break; } throughput/=survive;
    }
  }
  return vec4f(radiance,alpha);
}
struct Result { @location(0) colour: vec4f, @location(1) work: vec2u, @location(2) history:vec2f }
@fragment fn fragment(in: Out) -> Result {
  cost=vec4u(0u);
  let pixel=vec2i(in.position.xy);let z=textureLoad(opaqueDepth,pixel,0).r;
  let oldHistory=textureLoad(history,pixel,0).rg;
  let samples=select(0.0,oldHistory.x,oldHistory.y==z && u.transport.x>0.0 && u.viewport.w>0.5);
  var out:Result;
  if(samples>=u.march.w){out.colour=textureLoad(previous,pixel,0);out.work=vec2u(0u);out.history=oldHistory;return out;}
  rng=u32(in.position.x)+u32(in.position.y)*u32(u.viewport.x)+u32(u.transport.x)*747796405u+bitcast<u32>(u.viewport.z);
  let a=u.inverse*vec4f(in.ndc,1.0,1.0); let b=u.inverse*vec4f(in.ndc,0.000001,1.0);
  let world=a.xyz/a.w; let direction=normalize(b.xyz/b.w-world);
  let origin=(u.toBox*vec4f(world,1.0)).xyz;
  primaryLimit=1e30;
  if(z>0.0){let p=u.inverse*vec4f(in.ndc,z,1.0);primaryLimit=max(0.0,dot(p.xyz/p.w-world,direction));}
  var c=vec4f(0.0);
  if (u.viewport.w>0.5) { c=trace(origin,direction); } else { c=march(origin,direction); }
  if (samples>0.0) {
    let old=textureLoad(previous,vec2i(in.position.xy),0);
    c=old+(c-old)/(samples+1.0);
  }
  out.colour=c;out.work=vec2u(cost.x,select(cost.y|(cost.z<<12u),cost.y|(cost.w<<6u),u.viewport.w>0.5));
  out.history=vec2f(samples+1.0,z); return out;
}`;

export const cinematicDisplay = /* wgsl */ `
@group(1) @binding(0) var image: texture_2d<f32>;
struct Out { @builtin(position) position: vec4f }
@vertex fn vertex(@builtin(vertex_index) i:u32)->Out {
  let p=array<vec2f,3>(vec2f(-1.0,-1.0),vec2f(3.0,-1.0),vec2f(-1.0,3.0));
  var o:Out; o.position=vec4f(p[i],0.0,1.0); return o;
}
@fragment fn fragment(in:Out)->@location(0) vec4f {
  let c=textureLoad(image,vec2i(in.position.xy),0);
  return vec4f(toOutput(c.rgb/max(c.a,1e-8)),c.a);
}`;
