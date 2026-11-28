import { RawMesh, RawShaderMaterial } from '@margoengine/shader/raw';
import { glazed, windowFoot, windowHalf, windowRise, windowSpring } from './nave.js';

const radius = (windowRise**2 + windowHalf**2)/(2*windowHalf);
const offset = radius-windowHalf;
const shader = `
struct Flake {
  @builtin(position) clip:vec4f,
  @location(0) local:vec2f,
  @location(1) gain:f32,
}
fn sampleSeed(p:f32)->f32 {
  return fract(sin(p*33.437+92.26)*7631.321);
}
fn admitted(p:vec3f)->f32 {
  let sun=uniforms.sun;
  let h=p+sun*(${glazed.wallX.toFixed(5)}-p.x)/max(.05,sun.x);
  let bay=round((h.z+2.8)/5.6)*5.6-2.8;
  let u=h.z-bay;
  let absU=abs(u);
  let r=absU+${offset.toFixed(5)};
  let top=${windowSpring.toFixed(5)}+sqrt(max(0.0,${(radius**2).toFixed(7)}-r*r));
  let jamb=(1.0-smoothstep(${windowHalf.toFixed(5)}-.15,${windowHalf.toFixed(5)},absU));
  let window=smoothstep(${windowFoot.toFixed(5)},${windowFoot.toFixed(5)}+.12,h.y)*(1.0-smoothstep(top-.16,top,h.y))*jamb;
  let stile=min(abs(absU-.48),min(absU,abs(absU-.74)));
  return window*smoothstep(.029,.075,stile)*step(abs(bay),14.01);
}
@vertex fn vertex(@builtin(vertex_index) v:u32,@builtin(instance_index) id:u32)->Flake {
  let i=f32(id)*1.314+1.0;
  let position=vec3f(sampleSeed(i),sampleSeed(i+19.72),sampleSeed(i+51.2));
  let curl=vec3f(cos(camera.time*.24+i),sin(camera.time*.19+i*2.1),cos(camera.time*.13+i*1.6))*.043;
  let p=mix(vec3f(-4.43,1.0,-13.2),vec3f(5.25,8.77,14.3),position)+curl;
  let lit=admitted(p)*uniforms.amount;
  let d=distance(p,camera.position);
  if(lit<.02||d<1.6){return Flake(vec4f(-2.0,-2.0,0.0,1.0),vec2f(0.0),0.0);}
  let basis=camera.view;
  let right=vec3f(basis[0][0],basis[1][0],basis[2][0]);
  let up=vec3f(basis[0][1],basis[1][1],basis[2][1]);
  let k=array<vec2f,6>(vec2f(-1,-1),vec2f(1,-1),vec2f(1,1),vec2f(-1,-1),vec2f(1,1),vec2f(-1,1))[v];
  let size=(.012+sampleSeed(i+2.7)*.016)*smoothstep(1.6,3.8,d);
  let power=(.15+sampleSeed(i+2.28)*.42)*lit*exp(-.05*d);
  return Flake(camera.viewProjection*vec4f(p+size*(k.x*right+k.y*up),1.0),k,power);
}
@fragment fn fragment(i:Flake)->@location(0) vec4f {
  let r=dot(i.local,i.local);
  let core=exp(-4.2*r)*(1.0-smoothstep(.68,1.0,r));
  return margoDisplay(vec4f(vec3f(1.0,.67,.34)*core*i.gain,0.0));
}
`;

export function addDust(raw) {
  const material=new RawShaderMaterial({
    name:'Daylit dust in the nave',vertexShader:shader,cull:'none',blending:'additive',transparent:true,depthWrite:false,
    uniforms:{sun:{value:[1,.4,.3],type:'vec3f'},amount:{value:1}},
  });
  raw.add(new RawMesh({material,vertexCount:6,instanceCount:1550}));
  return {
    update(sun){
      material.uniforms.sun.value=sun.direction;
      material.uniforms.amount.value=sun.direct;
    },
    get error(){return material.error;},
  };
}