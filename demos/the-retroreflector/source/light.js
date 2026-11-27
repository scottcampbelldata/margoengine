import { RawMesh, RawShaderMaterial, RawShaders } from '@margoengine/shader/raw';

const vertex=`
struct Varying {
  @builtin(position) clip:vec4f,
  @location(0) uv:vec2f,
  @location(1) style:f32,
  @location(2) position:vec3f,
  @location(3) normal:vec3f,
}
@vertex fn vertex(a:Attributes)->Varying {
  let p=mesh.world*vec4f(a.position,1.0);
  return Varying(camera.viewProjection*p,a.uv,a.style,p.xyz,mesh.normal*a.direction);
}`;
const fragment=`
struct Varying {
  @builtin(position) clip:vec4f,
  @location(0) uv:vec2f,
  @location(1) style:f32,
  @location(2) position:vec3f,
  @location(3) normal:vec3f,
}
fn tint(id:f32)->vec3f {
  if(id<0.5){return vec3f(1.0,.50,.16);}
  if(id<1.5){return vec3f(.36,1.0,.81);}
  return vec3f(.43,.70,1.0);
}
@fragment fn fragment(i:Varying)->@location(0) vec4f {
  let uv=i.uv;
  let style=round(i.style);
  var color=tint(style);
  var opacity=1.0;
  if(style<3.0){
    let d=uv.x*uv.x;
    let core=exp(-25.0*d);
    color=mix(color,vec3f(1.0,.96,.83),.37*core);
    opacity=.87*core+.13*exp(-4.0*d);
  } else if(style<6.0) {
    let N=normalize(i.normal);
    let reflected=reflect(-normalize(camera.position-i.position),N);
    let panel=exp(-10.0*abs(reflected.y-.21));
    let highlight=exp(-11.0*abs(reflected.x+.36*reflected.y+.41));
    let dark=vec3f(.051,.078,.096);
    color=dark+vec3f(.245,.306,.316)*panel+tint(style-3.0)*(.032+.21*highlight);
  } else if(style<9.0) {
    let d=dot(uv,uv);
    color=tint(style-6.0);
    color=mix(color,vec3f(1.0,.97,.88),.52*exp(-7.0*d));
    opacity=.86*exp(-8.0*d)+.17*exp(-2.6*d);
  } else {
    let d=dot(uv,uv);
    let core=1.0-smoothstep(.035,.13,d);
    color=mix(tint(style-9.0),vec3f(1.0,.98,.91),core);
    opacity=.87*core+.34*exp(-4.8*d);
  }
  let brightness=clamp(color,vec3f(0.0),vec3f(1.0));
  return vec4f(margoEncode(vec4f(brightness,1.0)).rgb,min(1.0,opacity));
}`;

export function installLight(engine){
  const raw=RawShaders.attach(engine);
  const glow=new RawShaderMaterial({
    vertexShader:vertex,fragmentShader:fragment,blending:'normal',transparent:true,depthWrite:false,cull:'none',
  });
  const mirrors=new RawShaderMaterial({
    vertexShader:vertex,fragmentShader:fragment,cull:'none',
  });
  function mount(parent,position,uv,style,index,normal,material=glow){
    return raw.add(new RawMesh({
      mesh:parent,material,index,
      attributes:{
        position:{data:new Float32Array(position),type:'vec3f'},
        uv:{data:new Float32Array(uv),type:'vec2f'},
        style:{data:new Float32Array(position.length/3).fill(style),type:'f32'},
        direction:{data:new Float32Array(normal??position.map((_,i)=>i%3===2?1:0)),type:'vec3f'},
      },
    }));
  }
  return {
    async ready(){await raw.ready();for(const material of [glow,mirrors])if(material.error)throw material.error;},
    mirror(parent,points,normal,face){
      mount(parent,points.flat(),[0,0,1,0,0,1],3+face,[0,1,2],[...normal,...normal,...normal],mirrors);
    },
    plate(parent,radius,style){
      return mount(parent,[-radius,-radius,0,radius,-radius,0,radius,radius,0,-radius,radius,0],
        [-1,-1,1,-1,1,1,-1,1],6+style,[0,1,2,0,2,3]);
    },
    beam(parent,style){
      return mount(parent,[-1,0,0,1,0,0,1,0,1,-1,0,1,0,-1,0,0,1,0,0,1,1,0,-1,1],
        [-1,0,1,0,1,1,-1,1,-1,0,1,0,1,1,-1,1],style,[0,1,2,0,2,3,4,5,6,4,6,7]);
    },
  };
}
