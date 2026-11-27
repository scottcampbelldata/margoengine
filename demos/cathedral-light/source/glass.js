import { addDust } from './dust.js';
import { RawMesh, RawShaderMaterial, RawShaders } from '@margoengine/shader/raw';
import { bayCenters, glazed, pointed, windowFoot, windowHalf, windowRise, windowSpring } from './nave.js';

const vertex=`
struct Varying {
  @builtin(position) clip:vec4f,
  @location(0) uv:vec2f,
  @location(1) face:f32,
  @location(2) world:vec3f,
}
@vertex fn vertex(a:Attributes)->Varying {
  let p=mesh.world*vec4f(a.position,1.0);
  return Varying(camera.viewProjection*p,a.uv,a.kind,p.xyz);
}
`;
const fragment=`
struct Varying {
  @builtin(position) clip:vec4f,
  @location(0) uv:vec2f,
  @location(1) face:f32,
  @location(2) world:vec3f,
}
fn fleck(x:f32,y:f32)->f32 {
  return fract(sin(x*12.9898+y*28.4827)*46295.11);
}
fn field(p:vec2f)->f32 {
  let b=floor(p);let f=fract(p);
  let w=f*f*(3.0-2.0*f);
  return mix(mix(fleck(b.x,b.y),fleck(b.x+1.0,b.y),w.x),
    mix(fleck(b.x,b.y+1.0),fleck(b.x+1.0,b.y+1.0),w.x),w.y);
}
fn cames(p:vec2f)->f32 {
  let bands=abs(fract(p)-.5);
  return 1.0-smoothstep(.432,.490,max(bands.x,bands.y));
}
fn palette(selector:f32)->vec3f {
  var rgb=vec3f(.53,.238,.044);
  if(selector<.31){rgb=vec3f(.051,.205,.375);}
  else if(selector<.48){rgb=vec3f(.059,.37,.303);}
  else if(selector<.61){rgb=vec3f(.570,.107,.059);}
  else if(selector<.81){rgb=vec3f(.726,.424,.129);}
  return rgb;
}
@fragment fn fragment(i:Varying)->@location(0) vec4f {
  let q=i.uv;
  let framed=select(.53,1.0,i.world.x>0.0);
  let shot=uniforms.daylight*framed;
  var lead=1.0;
  var tint=vec3f(.31,.19,.10);
  if(i.face<.5){
    let p=vec2f((q.x+q.y*1.8)*5.4,(q.x-q.y*1.8)*5.4);
    let tile=floor(p);
    tint=palette(fleck(tile.x,tile.y+floor(i.world.z*.138)));
    let central=1.0-smoothstep(.11,.76,abs(q.x));
    let floret=abs(cos(q.y*151.0+sin(q.x*39.0)*2.2));
    tint=mix(tint,vec3f(.73,.49,.199),central*.22+floret*.096);
    let border=smoothstep(.78,.90,abs(q.x));
    tint=mix(tint,vec3f(.063,.200,.371),border*.72);
    lead=cames(p)*mix(1.0,.36,smoothstep(.88,.98,abs(q.x)));
  }else{
    let radius=length(q);
    let angle=atan2(q.y,q.x);
    let sector=(angle/6.28318531+.5)*12.0;
    let petals=cos((sector-floor(sector)-.5)*6.28318531);
    let row=radius*(5.3+.75*petals)-.11*petals;
    let lobe=smoothstep(.012,.085,abs(fract(row)-.5));
    let lens=smoothstep(.045,.089,abs(fract(sector)-.5));
    let inner=1.0-smoothstep(.02,.19,radius);
    tint=palette(fleck(floor(sector),floor(row+1.5)));
    tint=mix(tint,vec3f(.90,.57,.22),inner);
    let margin=smoothstep(.83,.93,radius);
    tint=mix(tint,vec3f(.28,.075,.065),margin*.71);
    lead=mix(.09+lobe*.91,1.0,inner)*(.15+.85*lens)*(1.0-smoothstep(.93,.995,radius));
  }
  let a=field(q*34.0);
  let texture=field(q*150.0);
  let body=tint*(.65+a*.50+texture*.14);
  let dark=vec3f(.036,.031,.028)*(1.0+a*.28);
  let visible=mix(dark,body*(.72+shot*2.6),lead);
  return margoDisplay(vec4f(visible,1.0));
}
`;

export function glazings(engine) {
  const position=[],uv=[],kind=[],index=[];
  function vertexAt(p,t,face) {
    position.push(...p);
    uv.push(...t);
    kind.push(face);
    return kind.length-1;
  }
  for(const side of [-1,1]) {
    for(const z of bayCenters) {
      const x=side*glazed.wallX;
      const apex=windowSpring+windowRise;
      const scale=apex-windowFoot;
      const center=vertexAt([x,windowSpring,z],[0,(windowSpring-windowFoot)/scale],0);
      const left=vertexAt([x,windowFoot,z-windowHalf],[-1,0],0);
      let prior=left;
      for(let i=0;i<=36;i++){
        const along=-windowHalf*Math.cos(Math.PI*i/36);
        const y=windowSpring+pointed(along,windowHalf,windowRise);
        const curr=vertexAt([x,y,z+along],[along/windowHalf,(y-windowFoot)/scale],0);
        index.push(center,prior,curr);
        prior=curr;
      }
      const corner=vertexAt([x,windowFoot,z+windowHalf],[1,0],0);
      index.push(center,prior,corner,center,corner,left);
    }
  }
  const center=vertexAt([0,glazed.roseY,glazed.roseZ],[0,0],1);
  for(let i=0;i<96;i++){
    const p=2*Math.PI*i/96;
    const x=Math.cos(p),y=Math.sin(p);
    vertexAt([x*glazed.roseRadius,glazed.roseY+y*glazed.roseRadius,glazed.roseZ],[x,y],1);
    index.push(center,center+i+1,center+(i+1)%96+1);
  }
  const material=new RawShaderMaterial({
    name:'Hand-cut colored glass',vertexShader:vertex,fragmentShader:fragment,cull:'none',depthWrite:true,
    uniforms:{daylight:{value:1}},
  });
  const raw=RawShaders.attach(engine);
  raw.add(new RawMesh({
    mesh:engine.createMesh(),material,index,
    attributes:{
      position:{data:new Float32Array(position),type:'vec3f'},
      uv:{data:new Float32Array(uv),type:'vec2f'},
      kind:{data:new Float32Array(kind),type:'f32'},
    },
  }));
  const dust=addDust(raw);
  return {
    update(sun){material.uniforms.daylight.value=sun.direct;dust.update(sun);},
    async ready(){await raw.ready();if(material.error||dust.error)throw material.error??dust.error;},
  };
}
