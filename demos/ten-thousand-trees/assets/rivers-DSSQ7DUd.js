import{M as e,j as t}from"./index-OO1e78gK.js";import{n,r}from"./errors-D8rc8kzg-DREbrEsS.js";import{i,l as a,n as o,o as s}from"./query-state-bmQwt1Q1-N7FwNYnI.js";var c=16,l=(e,t)=>a+`
@group(0) @binding(1) var state:texture_2d<f32>;
@group(0) @binding(2) var previous:texture_2d<f32>;
@group(0) @binding(3) var next:texture_storage_2d<rgba32float,write>;
@compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) id:vec3u){
 let size=vec2i(textureDimensions(state));let p=vec2i(id.xy);if(any(p>=size)){return;}
 let v=textureLoad(state,p,0);let surface=v.x+v.y;let dt=frame.flow.x*${e};
 let offsets=array<vec2i,4>(vec2i(-1,0),vec2i(1,0),vec2i(0,-1),vec2i(0,1));
 let lengths=vec4f(frame.flow.y,frame.flow.y,frame.flow.z,frame.flow.z);
 let old=textureLoad(previous,p,0)*exp(-dt*0.12);var q=vec4f(0);
 for(var k=0;k<4;k++){
  let n=p+offsets[k];if(any(n<vec2i(0))||any(n>=size)){continue;}
  let w=textureLoad(state,n,0);let brink=max(v.y,w.y);
  let a=max(0.0,surface-brink);let b=max(0.0,w.x+w.y-brink);let l=lengths[k];
  q[k]=clamp(old[k]+dt*9.81*a*(a-b)/l,0.0,a*min(${t}*sqrt(9.81*a),0.5*l/dt));
 }

 let outgoing=(q.x+q.y)/frame.flow.y+(q.z+q.w)/frame.flow.z;
 q*=min(1.0,v.x/max(0.000001,dt*outgoing));textureStore(next,p,q);
}`,u=`
@group(0) @binding(5) var<uniform> sources:array<vec4f,17>;
fn inflow(p:vec2i,size:vec2i)->f32 {
 let cell=frame.flow.yz;var rate=0.0;
 for(var i=0u;i<u32(sources[0].x);i++){let s=sources[i+1u];
  let c=floor((s.xy-frame.coast.xy)/cell);
  let lo=max(min(ceil((s.xy-s.w-frame.coast.xy)/cell-0.5),c),vec2f(0));let hi=min(max(floor((s.xy+s.w-frame.coast.xy)/cell-0.5),c),vec2f(size-1));
  let at=vec2f(p);if(all(at>=lo)&&all(at<=hi)){rate+=s.z/((hi.x-lo.x+1.0)*(hi.y-lo.y+1.0)*cell.x*cell.y);}
 }return rate;
}`,d=class a{constructor(e,t={}){if(this.water=e,this.disposed=!1,!i.has(e)||typeof e.setWaveHeight!=`function`)throw r(`state`,`Rivers needs a Water; pass the Water whose coast terrain the river runs on`);if(!t||typeof t!=`object`)throw r(`state`,`Rivers options must be an object`);let a=t.substeps??8,c=t.maxFroude??4;if(!Number.isInteger(a)||a<1||a>64)throw n(`Rivers substeps must be an integer in 1..64; raise it for finer cells or faster falls`,`geometry`);if(!Number.isFinite(c)||c<.1||c>20)throw n(`Rivers maxFroude must be finite in 0.1..20`,`geometry`);if(o.has(e))throw r(`attached`,`This Water already has Rivers; dispose it or call setSources on it`,`state`);this.kernels={flow:l(3/a,c),integrate:s(`frame.flow.x*${3/a}`,u),substeps:a,sources:new Float32Array(68)},this.setSources(t.sources??[]),o.set(e,this.kernels)}static attach(n,r={}){return t(n,e(`1.0.0`,import.meta.url)),new a(n,r)}setSources(e){if(this.disposed)throw r(`disposed`,`Rivers is disposed; create another Rivers`);if(!Array.isArray(e)||e.length>c)throw n(`Rivers takes at most ${c} sources in an array`,`geometry`);let t=new Float32Array(this.kernels.sources.length);e.forEach((e,r)=>{let i=e?.radius??0;if(!e||!Array.isArray(e.position)||e.position.length!==2||!e.position.every(Number.isFinite)||!Number.isFinite(e.discharge)||e.discharge<0||e.discharge>1e5||!Number.isFinite(i)||i<0||i>1e4)throw n(`Rivers source needs a finite [x, z] position, discharge 0..100000 m^3/s and radius 0..10000 m`,`geometry`);t.set([e.position[0],e.position[1],e.discharge,i],(r+1)*4)}),t[0]=e.length,this.kernels.sources.set(t)}dispose(){this.disposed||(this.disposed=!0,o.get(this.water)===this.kernels&&o.delete(this.water))}[Symbol.dispose??Symbol()](){this.dispose()}};export{d as Rivers};