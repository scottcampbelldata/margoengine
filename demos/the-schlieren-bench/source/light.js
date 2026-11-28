import { RawMesh, RawShaderMaterial, RawShaders } from '@margoengine/shader/raw';
import { focalLength, plumeWGSL } from './optics.js';

const vertex=`
struct Varying {
  @builtin(position) clip:vec4f,
  @location(0) uv:vec2f,
  @location(1) mode:f32,
  @location(2) world:vec3f,
  @location(3) normal:vec3f,
}
@vertex fn vertex(a:Attributes)->Varying {
  let pos=mesh.world*vec4f(a.position,1.0);
  return Varying(camera.viewProjection*pos,a.uv,a.mode,pos.xyz,mesh.normal*a.direction);
}`;
const fragment=`
struct Varying {
  @builtin(position) clip:vec4f,
  @location(0) uv:vec2f,
  @location(1) mode:f32,
  @location(2) world:vec3f,
  @location(3) normal:vec3f,
}
${plumeWGSL()}
@fragment fn fragment(i:Varying)->@location(0) vec4f {
  let uv=i.uv;
  var color=vec3f(.51,.83,1.0);
  var opacity=1.0;
  if (i.mode<1.5) {
    let z=uv.x*uv.x;
    opacity=(.84*exp(-27.0*z)+.16*exp(-4.9*z))*.89;
    if (i.mode>.5){opacity=opacity*.43;}
    color=mix(vec3f(.12,.61,.97),vec3f(.78,.94,1.0),exp(-16.0*z));
  } else if (i.mode<2.5) {
    let reflection=reflect(-normalize(camera.position-i.world),normalize(i.normal));
    let bands=(reflection.z+.36*reflection.y)*1.25;
    let key=exp(-28.0*(bands-.36)*(bands-.36));
    let panel=exp(-8.0*abs(reflection.y+.44));
    let radial=dot(uv,uv);
    let cold=vec3f(.038,.091,.129)+key*vec3f(.41,.49,.53);
    color=cold+panel*vec3f(.21,.18,.14)+.12*radial;
  } else if (i.mode<3.5) {
    let rr=dot(uv,uv);
    let sample=vec2f(uv.x*.102,(uv.y+1.0)*.094);
    let flux=imageTransmission(sample.x,sample.y,uniforms.time,uniforms.cut);
    let rimlight=1.0-.17*rr;
    let glass=vec3f(.024,.037,.047)+rimlight*flux*vec3f(.64,.73,.76);
    let heater=(1.0-smoothstep(.087,.111,abs(uv.x)))*(1.0-smoothstep(-.82,-.777,uv.y));
    let marks=(1.0-smoothstep(.012,.022,abs(uv.y)))*smoothstep(.884,.932,abs(uv.x));
    color=mix(glass,vec3f(.05,.079,.095),heater)+marks*.10;
    if(rr>1.0){discard;}
  } else {
    let variant=dot(uv,uv);
    color=mix(vec3f(.41,.72,.97),vec3f(.88,1.0,1.0),exp(-1.44*variant));
  }
  return vec4f(margoEncode(vec4f(clamp(color,vec3f(0.0),vec3f(1.0)),1.0)).rgb,opacity);
}`;

export function installLight(engine){
  const material=new RawShaderMaterial({
    name:'Schlieren fields and parabolic mirror faces',
    vertexShader:vertex,fragmentShader:fragment,uniforms:{cut:{value:.5},time:{value:0}},
    blending:'normal',transparent:true,depthWrite:false,cull:'none',
  });
  const raw=RawShaders.attach(engine);
  function mount(parent,position,uv,mode,index,normal=position.map((_,i)=>i%3===2?1:0)){
    return raw.add(new RawMesh({
      mesh:parent,material,index,
      attributes:{
        position:{data:new Float32Array(position),type:'vec3f'},
        uv:{data:new Float32Array(uv),type:'vec2f'},
        direction:{data:new Float32Array(normal),type:'vec3f'},
        mode:{data:new Float32Array(position.length/3).fill(mode),type:'f32'},
      },
    }));
  }
  const quadUV=[-1,-1,1,-1,1,1,-1,1];
  function plate(parent,w,h,mode){
    return mount(parent,[-w,-h,0,w,-h,0,w,h,0,-w,h,0],quadUV,mode,[0,1,2,0,2,3]);
  }
  function mirror(parent,radius){
    const pos=[0,0,0],uv=[0,0],normal=[0,0,1],index=[];
    const rings=10, sides=72;
    for(let row=1;row<=rings;row++)for(let i=0;i<sides;i++){
      const phase=2*Math.PI*i/sides;
      const u=row/rings*Math.cos(phase),v=row/rings*Math.sin(phase);
      const x=u*radius,y=v*radius;
      pos.push(x,y,(x*x+y*y)/(4*focalLength));
      uv.push(u,v);
      normal.push(-x/(2*focalLength),-y/(2*focalLength),1);
      const at=1+(row-1)*sides+i,next=1+(row-1)*sides+(i+1)%sides;
      if(row===1)index.push(0,at,next);
      else index.push(at-sides,at,next,at-sides,next,next-sides);
    }
    mount(parent,pos,uv,2,index,normal);
  }
  return {
    plate,mirror,
    async ready(){await raw.ready();if(material.error)throw material.error;},
    update(time,cut){material.uniforms.time.value=time;material.uniforms.cut.value=cut;},
    beam(parent,weak){
      return mount(parent,[-1,0,0,1,0,0,1,0,1,-1,0,1,0,-1,0,0,1,0,0,1,1,0,-1,1],
        [-1,0,1,0,1,1,-1,1,-1,0,1,0,1,1,-1,1],Number(weak),[0,1,2,0,2,3,4,5,6,4,6,7]);
    },
  };
}
