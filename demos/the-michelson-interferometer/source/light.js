import { RawMesh, RawShaderMaterial, RawShaders } from '@margoengine/shader/raw';
import { carrierMeters, fringeCount, visibility } from './optics.js';

const vertex=`
struct Varying {
  @builtin(position) clip:vec4f,
  @location(0) uv:vec2f,
  @location(1) mode:f32,
}
@vertex fn vertex(a:Attributes)->Varying{
  return Varying(camera.viewProjection*mesh.world*vec4f(a.position,1.0),a.uv,a.mode);
}`;
const fragment=`
struct Varying {
  @builtin(position) clip:vec4f,
  @location(0) uv:vec2f,
  @location(1) mode:f32,
}
@fragment fn fragment(i:Varying)->@location(0) vec4f {
  let uv=i.uv;
  var color=vec3f(.96,.34,.11);
  var alpha=1.0;
  if(i.mode<1.5){
    let d=uv.x*uv.x;
    let falloff=1.0-0.18*abs(2.0*uv.y-1.0);
    color=mix(vec3f(.86,.137,.040),vec3f(1.0,.65,.26),exp(-28.0*d));
    alpha=falloff*(.925*exp(-24.0*d)+.075*exp(-4.5*d));
    if(i.mode>0.5){alpha=alpha*.83;}
  } else if(i.mode<3.5){
    let rim=smoothstep(.62,1.0,max(abs(uv.x),abs(uv.y)));
    let band=uv.x-uv.y*.85-.12;
    color=mix(vec3f(.28,.45,.58),vec3f(.77,.64,.55),.42*exp(-18.0*band*band));
    alpha=.12+.32*rim+.18*exp(-49.0*band*band);
    if(i.mode>2.5){color=vec3f(.79,.59,.40);alpha=.19+.28*rim;}
  } else if(i.mode<4.5){
    let rr=dot(uv,uv);
    let angle=6.28318530718*(uv.x*uniforms.halfWidth/${carrierMeters}+uniforms.cycles);
    let contrast=${visibility}*cos(angle);
    let field=0.5+0.5*contrast;
    let beam=field*exp(-1.52*rr);
    let body=vec3f(.041,.028,.051)+vec3f(.030,.021,.013)*exp(-rr);
    let core=mix(vec3f(.88,.105,.036),vec3f(.98,.72,.45),pow(beam,.76));
    let tickAxis=(1.0-smoothstep(.007,.016,abs(uv.x)))*smoothstep(.75,.86,uv.y);
    color=body+beam*core*1.75+tickAxis*.22;
    if(rr>1.0){discard;}
  } else {
    let rr=dot(uv,uv);
    color=mix(vec3f(.47,.039,.019),vec3f(.99,.57,.31),exp(-rr*4.5));
    alpha=1.0-smoothstep(.62,1.0,rr);
  }
  let brightness=clamp(color,vec3f(0.0),vec3f(1.0));
  return vec4f(margoEncode(vec4f(brightness,1.0)).rgb,alpha);
}`;

export function installLight(engine){
  const halfWidth=.106;
  const material=new RawShaderMaterial({
    name:'Interferometer light and glass',vertexShader:vertex,fragmentShader:fragment,
    uniforms:{cycles:{value:0},halfWidth:{value:halfWidth}},
    blending:'normal',transparent:true,depthWrite:false,cull:'none',
  });
  const raw=RawShaders.attach(engine);
  function mount(parent,positions,uv,mode,index){
    return raw.add(new RawMesh({
      mesh:parent,material,index,
      attributes:{
        position:{data:new Float32Array(positions),type:'vec3f'},
        uv:{data:new Float32Array(uv),type:'vec2f'},
        mode:{data:new Float32Array(positions.length/3).fill(mode),type:'f32'},
      },
    }));
  }
  const uv=[-1,-1,1,-1,1,1,-1,1];
  const quad=[0,1,2,0,2,3];
  function plate(parent,w,h,mode){
    return mount(parent,[-w,-h,0,w,-h,0,w,h,0,-w,h,0],uv,mode,quad);
  }
  return {
    plate,
    async ready(){await raw.ready();if(material.error)throw material.error;},
    update(distance){material.uniforms.cycles.value=fringeCount(distance)%1;},
    detector(parent){plate(parent,halfWidth,halfWidth,4);},
    beam(parent,mode){
      return mount(parent,[-1,0,0,1,0,0,1,0,1,-1,0,1,0,-1,0,0,1,0,0,1,1,0,-1,1],
        [-1,0,1,0,1,1,-1,1,-1,0,1,0,1,1,-1,1],mode,[0,1,2,0,2,3,4,5,6,4,6,7]);
    },
  };
}
