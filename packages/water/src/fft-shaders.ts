// Clean room from Tessendorf 1999-2004, equations 36-45, Hasselmann et al. 1973 and Cooley/Tukey 1965.
export function oceanCompute(resolution: number, cascades: number): string {
  return `
const N=${resolution}u;
const CELLS=N*N;
const CASCADES=${cascades}u;
const TAU=6.283185307179586;
struct OceanConfig { clock:vec4f, wind:vec4f, sea:vec4f, bands:array<vec4f,4> }
@group(0) @binding(0) var<uniform> config:OceanConfig;
@group(0) @binding(1) var<storage,read> source:array<vec4f>;
@group(0) @binding(2) var<storage,read_write> outputValues:array<vec4f>;
@group(0) @binding(3) var<uniform> step:vec4u;
fn multiply(a:vec2f,b:vec2f)->vec2f {return vec2f(a.x*b.x-a.y*b.y,a.x*b.y+a.y*b.x);}
fn hash(input:u32)->u32 {
 var value=input;
 value=(value^(value>>16u))*2246822519u;
 value=(value^(value>>13u))*3266489917u;
 return value^(value>>16u);
}
fn random(input:u32)->f32 {return (f32(hash(input)>>8u)+0.5)/16777216.0;}
fn waveVector(p:vec2u,c:u32)->vec2f {
 let signed=vec2i(p)-select(vec2i(0),vec2i(i32(N)),p>=vec2u(N/2u));
 return vec2f(signed)*TAU/config.bands[c].x;
}
fn density(kv:vec2f,c:u32)->f32 {
 let k=length(kv);
 let band=config.bands[c];
 if(k<band.y || k>=band.z || k==0.0){return 0.0;}
 let alignment=dot(kv/k,config.wind.xy);
 let spread=alignment*alignment;
 let speed=config.wind.z;
 let longest=speed*speed/9.81;
 var power=0.0;
 if(config.sea.x==0.0){
  power=config.sea.y*exp(-1.0/(k*k*longest*longest))/(k*k*k*k)*spread*exp(-k*k*0.01);
 }else{
  let omega=sqrt(9.81*k);
  let peak=22.0*pow(9.81*9.81/(speed*config.sea.z),1.0/3.0);
  let alpha=0.076*pow(speed*speed/(config.sea.z*9.81),0.22);
  let sigma=select(0.09,0.07,omega<=peak);
  let r=exp(-0.5*pow((omega-peak)/(sigma*peak),2.0));
  let spectrum=alpha*9.81*9.81/pow(omega,5.0)*exp(-1.25*pow(peak/omega,4.0))*pow(config.sea.w,r);
  // d(omega)/dk / k converts S(omega)D(theta) into density per d(kx)d(kz).
  power=spectrum*(spread/3.141592653589793)*sqrt(9.81/k)*0.5/k*config.sea.y;
 }
 let dk=TAU/band.x;
 return power*dk*dk;
}
@compute @workgroup_size(64) fn initial(@builtin(global_invocation_id) id:vec3u) {
 let index=id.x;
 if(index>=CELLS*CASCADES){return;}
 let c=index/CELLS;
 let p=vec2u(index%N,(index/N)%N);
 let kv=waveVector(p,c);
 let seed=index+u32(config.wind.w)*747796405u;
 let angle=TAU*random(seed+1u);
 let gaussian=sqrt(-2.0*log(random(seed)))*vec2f(cos(angle),sin(angle));
 // Nyquist row/column is omitted: an odd horizontal derivative there cannot be Hermitian.
 let allowed=select(1.0,0.0,p.x==N/2u || p.y==N/2u);
 outputValues[index]=vec4f(gaussian*sqrt(density(kv,c)*0.5)*allowed,0,0);
}
@compute @workgroup_size(64) fn evolve(@builtin(global_invocation_id) id:vec3u) {
 let index=id.x;
 if(index>=CELLS*CASCADES){return;}
 let c=index/CELLS;
 let p=vec2u(index%N,(index/N)%N);
 let kv=waveVector(p,c);
 let k=length(kv);
 let omega=sqrt(9.81*k);
 let angle=omega*config.clock.x;
 let phase=vec2f(cos(angle),sin(angle));
 let opposite=c*CELLS+((N-p.y)%N)*N+(N-p.x)%N;
 let a=multiply(source[index].xy,phase);
 let b=multiply(source[opposite].xy*vec2f(1,-1),phase*vec2f(1,-1));
 let height=a+b;
 let velocity=vec2f(-(a-b).y,(a-b).x)*omega;
 let direction=kv/max(k,0.000001)*config.clock.z;
 let horizontal=vec2f(height.y,-height.x);
 let horizontalVelocity=vec2f(velocity.y,-velocity.x);
 outputValues[index*3u]=vec4f(height,horizontal*direction.x);
 outputValues[index*3u+1u]=vec4f(horizontal*direction.y,velocity);
 outputValues[index*3u+2u]=vec4f(horizontalVelocity*direction.x,horizontalVelocity*direction.y);
}
fn reverseIndex(value:u32)->u32 {
 var input=value;
 var output=0u;
 for(var i=0u;i<${Math.log2(resolution)}u;i++){output=output*2u+(input&1u);input=input>>1u;}
 return output;
}
@compute @workgroup_size(64) fn butterfly(@builtin(global_invocation_id) id:vec3u) {
 let index=id.x;
 if(index>=CELLS*CASCADES*3u){return;}
 let field=index%3u;
 let point=index/3u;
 let c=point/CELLS;
 let p=vec2u(point%N,(point/N)%N);
 let coordinate=select(p.x,p.y,step.y==1u);
 let halfWidth=1u<<step.x;
 let width=halfWidth*2u;
 let j=coordinate%halfWidth;
 var first=(coordinate/width)*width+j;
 var second=first+halfWidth;
 if(step.x==0u){first=reverseIndex(first);second=reverseIndex(second);}
 var a=vec2u(first,p.y);
 var b=vec2u(second,p.y);
 if(step.y==1u){a=vec2u(p.x,first);b=vec2u(p.x,second);}
 let angle=TAU*f32(j)/f32(width);
 let twiddle=vec2f(cos(angle),sin(angle));
 let inputA=source[(c*CELLS+a.y*N+a.x)*3u+field];
 let inputB=source[(c*CELLS+b.y*N+b.x)*3u+field];
 let sign=select(1.0,-1.0,coordinate%width>=halfWidth);
 outputValues[index]=inputA+vec4f(multiply(inputB.xy,twiddle),multiply(inputB.zw,twiddle))*sign;
}
fn displacement(p:vec2u,c:u32)->vec3f {
 let index=(c*CELLS+(p.y%N)*N+p.x%N)*3u;
 return vec3f(source[index].z,source[index].x,source[index+1u].x);
}
@compute @workgroup_size(64) fn finish(@builtin(global_invocation_id) id:vec3u) {
 let index=id.x;
 if(index>=CELLS*CASCADES){return;}
 let c=index/CELLS;
 let p=vec2u(index%N,(index/N)%N);
 let spacing=config.bands[c].x/f32(N);
 let dx=(displacement(p+vec2u(1,0),c)-displacement(p+vec2u(N-1u,0),c))/(2.0*spacing);
 let dz=(displacement(p+vec2u(0,1),c)-displacement(p+vec2u(0,N-1u),c))/(2.0*spacing);
 let tangentX=vec3f(1,0,0)+dx;
 let tangentZ=vec3f(0,0,1)+dz;
 let jacobian=tangentX.x*tangentZ.z-tangentX.z*tangentZ.x;
 let oldFoam=outputValues[index*3u].w*exp(-config.clock.y/max(config.clock.w,0.001));
 let foam=max(oldFoam,clamp((config.bands[c].w-jacobian)*2.0,0.0,1.0));
 outputValues[index*3u]=vec4f(displacement(p,c),foam);
 outputValues[index*3u+1u]=vec4f(source[index*3u+2u].x,source[index*3u+1u].z,source[index*3u+2u].z,jacobian);
 outputValues[index*3u+2u]=vec4f(normalize(cross(tangentZ,tangentX)),0);
}
`;
}

export function oceanSurface(resolution: number, cascades: number): string {
  return `
const N=${resolution}u;
const CELLS=N*N;
const CASCADES=${cascades}u;
struct SurfaceConfig { camera:mat4x4f, eye:vec4f, light:vec4f, radiance:vec4f, ambient:vec4f, water:vec4f, grid:vec4f, lengths:vec4f, color:vec4f }
@group(0) @binding(0) var<uniform> frame:SurfaceConfig;
@group(0) @binding(1) var<storage,read> surface:array<vec4f>;
struct SurfaceSample { displacement:vec3f, foam:f32, normal:vec3f }
fn loadSurface(point:vec2i,c:u32,field:u32)->vec4f {
 let p=vec2u((point%vec2i(i32(N))+vec2i(i32(N)))%vec2i(i32(N)));
 return surface[(c*CELLS+p.y*N+p.x)*3u+field];
}
fn sampleSurface(world:vec2f,c:u32,field:u32)->vec4f {
 let p=world/frame.lengths[c]*f32(N);
 let corner=vec2i(floor(p));
 let weight=fract(p);
 return mix(mix(loadSurface(corner,c,field),loadSurface(corner+vec2i(1,0),c,field),weight.x),
 mix(loadSurface(corner+vec2i(0,1),c,field),loadSurface(corner+vec2i(1,1),c,field),weight.x),weight.y);
}
fn oceanAt(world:vec2f)->SurfaceSample {
 var displacement=vec3f(0);
 var foam=0.0;
 var normal=vec3f(0,1,0);
 for(var c=0u;c<CASCADES;c++){
  let d=sampleSurface(world,c,0u);
  displacement+=d.xyz;
  foam=max(foam,d.w);
  normal+=sampleSurface(world,c,2u).xyz-vec3f(0,1,0);
 }
 return SurfaceSample(displacement,foam,normalize(normal));
}
struct SurfaceVertex { @builtin(position) clip:vec4f, @location(0) world:vec3f, @location(1) base:vec2f }
@vertex fn vertex(@builtin(vertex_index) id:u32)->SurfaceVertex {
 let cells=u32(frame.grid.z);
 let base=vec2f(f32(id%(cells+1u)),f32(id/(cells+1u)))/f32(cells)*frame.grid.xy-frame.grid.xy*0.5+frame.water.zw;
 let wave=oceanAt(base);
 let position=vec3f(base.x,frame.water.x,base.y)+wave.displacement;
 return SurfaceVertex(frame.camera*vec4f(position,1),position,base);
}
@fragment fn fragment(input:SurfaceVertex,@builtin(front_facing) front:bool)->@location(0) vec4f {
 let wave=oceanAt(input.base);
 let normal=select(-wave.normal,wave.normal,front);
 let view=normalize(frame.eye.xyz-input.world);
 let cosine=clamp(dot(normal,view),0.0,1.0);
 let fresnel=0.02037+0.97963*pow(1.0-cosine,5.0);
 let reflected=reflect(-view,normal);
 let sky=mix(vec3f(0.38,0.53,0.67),vec3f(0.045,0.16,0.34),clamp(reflected.y,0.0,1.0));
 let direction=normalize(frame.light.xyz);
 let halfway=normalize(view+direction);
 let roughness=0.12;
 let alpha=roughness*roughness;
 let ndh=max(dot(normal,halfway),0.0);
 let denominator=ndh*ndh*(alpha*alpha-1.0)+1.0;
 let distribution=alpha*alpha/(3.14159265*max(denominator*denominator,0.000001));
 let ndl=max(dot(normal,direction),0.0);
 let glint=frame.radiance.rgb*frame.light.w*distribution*fresnel*ndl*0.25;
 let body=frame.color.rgb*(frame.ambient.rgb+frame.radiance.rgb*frame.light.w*ndl*0.15);
 let foam=vec3f(0.8)*(frame.ambient.rgb+frame.radiance.rgb*frame.light.w*ndl/3.14159265);
 var color=mix(mix(body,sky,fresnel)+glint,foam,wave.foam);
 // The underside obeys total internal reflection at the water-air critical angle.
 if(!front){
  let internal=1.333*1.333*(1.0-cosine*cosine)>1.0;
  color=mix(sky,body,select(0.15,0.85,internal));
 }
 return vec4f(surfaceDisplay(color),1);
}
`;
}
